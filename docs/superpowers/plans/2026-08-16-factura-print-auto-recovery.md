# Factura print auto-recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The print agent self-heals — a factura that failed to print (paper-out / USB drop / power) reprints automatically once the printer recovers, with no manual step; plus a guarded CLI to force-reprint a stranded factura.

**Architecture:** An in-memory `pendingRetry` set in the always-on `print_agent.js` (the Surface NSSM service), driven by a timer that re-runs the existing idempotent `handle()`. Startup's `child_added` sweep rehydrates the set after any restart. Double-print is impossible — the unchanged transactional `decidePrintClaim` still guards every print. A small `tools/reprint.js` clears the print flags for a stranded factura (refusing already-printed/void records).

**Tech Stack:** Node, `firebase-admin` RTDB, the `usb` library (existing), node `assert` tests.

**Spec:** `docs/superpowers/specs/2026-08-16-factura-print-auto-recovery-design.md`

## Global Constraints
- **NOT money-path.** Reprints only the *identical already-issued* document — **no número allocation, no change to what the factura asserts.** Do not touch the renderer, pricing, or número/CAI logic.
- **Blast radius = two files only:** `xpizza-factura/print_agent.js` + new `xpizza-factura/tools/reprint.js` (+ pure helpers in `xpizza-factura/src/print-recovery.js` and their test). **No `xpizza-functions/index.js`, no `database.rules.json`, no functions deploy, no rules deploy.**
- **Do NOT modify `decidePrintClaim`** (`src/print-claim.js`) — it is the double-print guard; the retry re-invokes the existing idempotent `handle()`.
- **Guarded reprint:** `tools/reprint.js` MUST refuse `printed:true` (fiscal-copy case, out of scope) and `void` records; only acts on `printed:false`/absent.
- **Retry-until-success, fail-safe:** retries continue at `PRINT_RETRY_INTERVAL_MS` (default **60000**) until the record prints or is voided; the timer body must never crash the service.
- Deploy = Surface `git pull` + restart the `XPizzaFacturaAgent` NSSM service. No cloud deploy.

## File Structure
- Create: `xpizza-factura/src/print-recovery.js` — pure `retryCandidate` + `reprintDecision` (Task 1–2)
- Create: `xpizza-factura/src/print-recovery.test.js` (Task 1–2)
- Modify: `xpizza-factura/print_agent.js` — `pendingRetry` map + membership in `handle()` + retry timer (Task 3)
- Create: `xpizza-factura/tools/reprint.js` — guarded manual reprint CLI (Task 4)

**Interfaces produced:**
- `retryCandidate(record) → boolean` — record needs a (re)print attempt (present, not printed, not void) (T1)
- `reprintDecision(record) → { action: 'reprint' | 'refuse', reason? }` (T2)

---

### Task 1: Pure `retryCandidate`

**Files:** Create `xpizza-factura/src/print-recovery.js` · Test `xpizza-factura/src/print-recovery.test.js`

**Interfaces:** Produces `retryCandidate(record)`.

- [ ] **Step 1: Failing test** (create the test file)
```js
const assert = require('assert');
const { retryCandidate } = require('./print-recovery');
let n=0; const ok=(l)=>console.log(`  ✓ ${++n} ${l}`);
assert.equal(retryCandidate({ printed:false }), true);  ok('printed:false → candidate');
assert.equal(retryCandidate({}), true);                 ok('no printed field → candidate');
assert.equal(retryCandidate({ printed:true }), false);  ok('printed:true → no');
assert.equal(retryCandidate({ void:true }), false);     ok('void → no');
assert.equal(retryCandidate({ printed:false, void:true }), false); ok('void wins over unprinted');
assert.equal(retryCandidate(null), false);              ok('null → no');
console.log(`print-recovery(retryCandidate): OK (${n} cases)`);
```
- [ ] **Step 2: Run — FAIL** — `node xpizza-factura/src/print-recovery.test.js` → "Cannot find module" / not a function
- [ ] **Step 3: Implement** (create `print-recovery.js`)
```js
'use strict';
// Pure, write-free recovery decisions for the factura print agent + reprint tool.

// A record needs a (re)print attempt when it exists, is not yet printed, and is not void.
function retryCandidate(record) {
  return !!record && !record.printed && !record.void;
}

module.exports = { retryCandidate };
```
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(factura): pure retryCandidate for print auto-recovery"`

---

### Task 2: Pure `reprintDecision` (guards the manual tool)

**Files:** Modify `xpizza-factura/src/print-recovery.js` · `xpizza-factura/src/print-recovery.test.js`

**Interfaces:** Consumes nothing. Produces `reprintDecision(record) → { action, reason? }`. Refuses `void` and `printed:true` (the fiscal-copy case) and `not_found`.

- [ ] **Step 1: Failing test** (append to the test file)
```js
const { reprintDecision } = require('./print-recovery');
assert.deepEqual(reprintDecision({ printed:false, factura_number:'X' }), { action:'reprint' }); ok('stranded → reprint');
assert.deepEqual(reprintDecision({}), { action:'reprint' });                    ok('absent-flags → reprint');
assert.deepEqual(reprintDecision({ printed:true }), { action:'refuse', reason:'already_printed' }); ok('printed → refuse (fiscal copy)');
assert.deepEqual(reprintDecision({ void:true }),   { action:'refuse', reason:'void' });            ok('void → refuse');
assert.deepEqual(reprintDecision(null),            { action:'refuse', reason:'not_found' });        ok('missing → refuse');
console.log('print-recovery(reprintDecision): OK');
```
- [ ] **Step 2: Run — FAIL** — `reprintDecision is not a function`
- [ ] **Step 3: Implement** (add to `print-recovery.js` and export)
```js
// Manual reprint gate. Refuses the fiscal-copy case (already printed) and void/missing records.
function reprintDecision(record) {
  if (record == null) return { action: 'refuse', reason: 'not_found' };
  if (record.void)    return { action: 'refuse', reason: 'void' };
  if (record.printed) return { action: 'refuse', reason: 'already_printed' };
  return { action: 'reprint' };
}
module.exports = { retryCandidate, reprintDecision };
```
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(factura): pure reprintDecision gate (refuses fiscal-copy case)"`

---

### Task 3: Wire the retry set + timer into the print agent

**Files:** Modify `xpizza-factura/print_agent.js` (the `handle()` fn ~67-94, the requires ~17-18, and `start()` ~96-103)

**Interfaces:** Consumes `retryCandidate` (T1). Manages a module-level `pendingRetry: Map<orderId, record>`, authoritative in `handle()`.

- [ ] **Step 1:** Add the require + the map + interval constant near the top (after the existing requires / `TTL`):
```js
const { retryCandidate } = require('./src/print-recovery');
const RETRY_MS = parseInt(process.env.PRINT_RETRY_INTERVAL_MS || '60000', 10);
// Facturas seen as not-yet-printed → retried on a timer until they print (printer recovery self-heal).
const pendingRetry = new Map();
```

- [ ] **Step 2:** Make `handle()` authoritative over `pendingRetry` membership. In the existing skip/print branches, add:
  - At the skip return (`if (!decision || decision.action !== 'claim') return;`) — first drop it from retry if it's terminal (printed/void/absent), but keep it if another owner holds a live claim:
```js
    if (!decision || decision.action !== 'claim') {
      if (decision && decision.reason !== 'claimed_by_other') pendingRetry.delete(orderId); // printed/void/absent → done
      return;
    }
```
  - On print **success** (after the `printed:true` update): `pendingRetry.delete(orderId);`
  - On print **failure** (in the `catch`, after the `print_error` update): `pendingRetry.set(orderId, record);`

- [ ] **Step 3:** Start the retry timer in `start()` (after the listeners). Fail-safe — a retry error never crashes the service:
```js
  setInterval(() => {
    for (const [orderId, rec] of pendingRetry) {
      handle(orderId, rec).catch((e) => console.error('[retry]', orderId, e && e.message));
    }
  }, RETRY_MS);
  console.log(`[agent] retry sweep every ${RETRY_MS}ms`);
```
(`handle()`'s existing `inFlight` guard + the transactional claim make overlapping ticks safe — no double-print. `retryCandidate` is imported for parity/consistency with the tool and any future seeding; membership itself is driven by the success/failure paths above.)

- [ ] **Step 4:** Sanity: `node --check xpizza-factura/print_agent.js` → clean. **Bench test (hardware):** start the agent with the printer detached → create/leave a `printed:false` factura → confirm it lands in `pendingRetry` and logs a retry each interval with `print_error`; reattach the printer → within one interval it prints and `printed:true`, and stops retrying. Restart the agent with a stranded record present → startup `child_added` re-adds it (prints or re-queues). Confirm a `printed:true` record is never reprinted across ticks.
- [ ] **Step 5: Commit** — `git commit -m "feat(factura): agent self-heals stranded prints via retry sweep"`

---

### Task 4: Guarded manual reprint CLI

**Files:** Create `xpizza-factura/tools/reprint.js`

**Interfaces:** Consumes `reprintDecision` (T2).

- [ ] **Step 1:** Create `tools/reprint.js`:
```js
'use strict';
// Force a reprint of a STRANDED factura (printed:false). Refuses already-printed (fiscal-copy case) + void.
// Clears the print flags → the running print agent re-fires and prints the SAME número/CAI (not a new factura).
require('dotenv').config();
const admin = require('firebase-admin');
const { reprintDecision } = require('../src/print-recovery');

const RID = process.env.RESTAURANT_ID || 'x_pizza';
const orderId = process.argv[2];
if (!orderId) { console.error('usage: node tools/reprint.js <orderId>'); process.exit(2); }

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: process.env.FB_DATABASE_URL,
});
const db = admin.database();

(async () => {
  const ref = db.ref(`facturas/${RID}/${orderId}`);
  const rec = (await ref.once('value')).val();
  const d = reprintDecision(rec);
  if (d.action !== 'reprint') {
    console.error(`refuse: ${d.reason} (${orderId})` +
      (d.reason === 'already_printed' ? ' — a reprint of an ISSUED+printed factura needs a fiscal COPIA decision; not done here.' : ''));
    process.exit(1);
  }
  await ref.update({ printed: false, printed_at: null, print_error: null, print_claim: null });
  console.log(`reprint queued: ${rec.factura_number} (${orderId}) — the print agent will print it shortly.`);
  process.exit(0);
})().catch((e) => { console.error('error:', e && e.message); process.exit(1); });
```
- [ ] **Step 2:** `node --check xpizza-factura/tools/reprint.js` → clean. **Bench:** `node tools/reprint.js <printed:false orderId>` → clears flags + agent prints; `node tools/reprint.js <printed:true orderId>` → `refuse: already_printed …`, no write; `node tools/reprint.js` (no arg) → usage + exit 2.
- [ ] **Step 3:** Add a one-line usage note to `xpizza-factura/SETUP.md` (or SERVICE-DEPLOY-LOG.md) under a "Reprint a stranded factura" heading.
- [ ] **Step 4: Commit** — `git commit -m "feat(factura): guarded reprint.js CLI for stranded facturas"`

---

## Self-Review
- Spec coverage: auto-recovery retry set + timer (T3) · pure candidate/decision helpers (T1–2) · guarded manual tool refusing the fiscal-copy case (T2, T4) · no rules/functions change (constraints) — all mapped. ✅
- No placeholders: real helper code + tests + concrete agent edits + full CLI. ✅
- Types: `retryCandidate`/`reprintDecision` signatures identical across test, agent, and tool. ✅
- Safety: `decidePrintClaim` untouched (double-print guard intact); timer fail-safe; tool refuses printed/void. ✅

## Gate & deploy (post-build)
Advisor + light **codex integrity** glance (retry idempotent/claim-guarded/fail-safe; tool refuses fiscal-copy; no money/assert/número change). Then deploy on the Surface: `git pull` the branch + restart `XPizzaFacturaAgent`. Verify: kill paper mid-order → refill → factura prints within ~1 min unattended; `printed:true` records never reprint.

## Out of scope (separate fiscal decision)
Reprinting an already-printed factura as a customer **copy** (needs a renderer "REIMPRESIÓN/COPIA" marker + owner sign-off — [[fiscal-representation-owner-gate]]). The tool deliberately refuses it.
