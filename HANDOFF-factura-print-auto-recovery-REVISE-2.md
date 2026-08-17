# REVISE-2 → EXECUTOR — factura print auto-recovery (one tightening)

**Context:** Gate 2 (advisor) APPROVED `1fe512e`; a follow-up codex pass surfaced that the `printed_ack_failed` marker Fix A writes is currently **inert** — `decidePrintClaim` ignores `print_error`, so on an agent restart a record we already physically printed (but couldn't record) is still `printed:false` and **auto-reprints**. The marker reads as "handled (manual check)" but nothing enforces it. This round makes the marker an actual **skip-guard** so a known-printed factura is NOT auto-reprinted on restart. Everything else about `1fe512e` stands. Branch `feat/factura-print-auto-recovery` @ `1fe512e`.

**Scope:** `xpizza-factura/src/print-recovery.js` (+ its test) and `xpizza-factura/print_agent.js` only. **Do NOT modify `decidePrintClaim`** (the guard goes in `handle()`, not in `print-claim.js`). No other files.

**Residual we are NOT closing (by design):** a true CRASH after the physical print but before *either* write lands leaves no marker → a restart still reprints. That needs a durable *pre-print* marker (heavier) and stays the documented irreducible residual. This round only closes the case where the `printed_ack_failed` flag WAS written (the likely variant).

---

## Fix — make `printed_ack_failed` a real skip-guard

### 1. Pure predicate (TDD) — `src/print-recovery.js`
- [ ] Add + export:
```js
// True when a record is flagged as already-printed-on-paper-but-not-recorded (Fix A's marker).
// Such a record must NOT be auto-(re)printed — it waits for a manual decision.
function printedAckFailed(record) {
  return !!record && typeof record.print_error === 'string' && record.print_error.startsWith('printed_ack_failed');
}
```
Export it alongside the others: `module.exports = { retryCandidate, reprintDecision, printedAckFailed };`
- [ ] Test (append to `src/print-recovery.test.js`):
```js
const { printedAckFailed } = require('./print-recovery');
assert.equal(printedAckFailed({ print_error:'printed_ack_failed: EPIPE' }), true); ok('marker → true');
assert.equal(printedAckFailed({ print_error:'printer not found' }), false);        ok('other error → false');
assert.equal(printedAckFailed({ printed:false }), false);                          ok('no error → false');
assert.equal(printedAckFailed(null), false);                                       ok('null → false');
```

### 2. Wire the guard into `handle()` — `print_agent.js`
- [ ] Import it: `const { printedAckFailed } = require('./src/print-recovery');` (this legitimately re-introduces a print-recovery import into the agent — now actually used).
- [ ] Inside the transaction updater, **before** `decidePrintClaim`, skip a marked record so it is never claimed/printed:
```js
    const tx = await ref.transaction((rec) => {
      const r = rec == null ? known : rec;
      // Already printed on paper but we couldn't record it (Fix A marker) → do NOT auto-(re)print;
      // leave for manual resolution. Makes printed_ack_failed a real guard, not just a log line.
      if (printedAckFailed(r)) { decision = { action: 'skip', reason: 'printed_ack_failed' }; return undefined; }
      decision = decidePrintClaim(r, { owner: OWNER, now, ttlMs: TTL });
      if (decision.action !== 'claim') return undefined; // abort cleanly (no write/delete)
      return { ...r, print_claim: decision.nextClaim };
    });
```
The existing skip block then drops it from retry and returns (reason `printed_ack_failed` ≠ `claimed_by_other` → `pendingRetry.delete(orderId)`), so it neither prints nor re-queues. **Leave `decidePrintClaim` byte-unchanged.**

### 3. Manual override stays intact (verify, no code needed)
`tools/reprint.js` clears `print_error` (→ null) when it reprints, so the guard doesn't trip — a human who deliberately runs `reprint.js` on a `printed_ack_failed` record still forces the reprint (their judgment: the paper was bad/missing). That's the intended manual path.
- [ ] *(Optional, nice-to-have)* have `reprint.js` print a one-line notice when the current `print_error` starts with `printed_ack_failed` (e.g. `note: this factura was flagged as already-printed — confirm before reprinting.`). Skip if it complicates the transactional flow.

---

## Definition of done
Guard added; `node xpizza-factura/src/print-recovery.test.js` green (now includes `printedAckFailed`); `node --check` clean on `print_agent.js` + `print-recovery.js`; `decidePrintClaim`/`print-claim.js` still byte-unchanged; forbidden files untouched. Bench: mark a record `print_error:"printed_ack_failed: X", printed:false` → restart the agent → it is **skipped, not printed** (log/skip), and a `reprint.js` on it still forces a print. Handback (new SHA, files, test count, bench note) → advisor light re-verify of the delta + a final codex pass → owner deploys on the Surface (git pull + restart `XPizzaFacturaAgent`).
