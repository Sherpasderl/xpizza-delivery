# Pickup-order Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the KDS "Completar" fires on a **pickup** order (`order_type==='pickup'`), publish `status='completed'` — which earns rewards + consumes redemption (already wired), clears the dispatch queue, and closes the order in every stats/history/tracker surface — while the delivery/driver path stays byte-untouched.

**Architecture:** One KDS write (the trigger) + wire the reused terminal status `completed` into every consumer that currently only knows `delivered` (spec §3A: 15 client sites + 2 functions in `index.js`) + a pickup-scoped backfill. `completed` is de-facto pickup-unique (nothing else writes it); the rewards/terminal machinery already handles it (`shouldEarnOnStatus`, cancel-gate, sweeper). LEAVE-list (SDK live-filter, ready-time-quality, auto-assign, scheduled, nudge) verified already-correct.

**Tech Stack:** Vanilla JS in HTML (`xpizza-kitchen`/`-dashboard`/`-dispatch`/`-track`/`xpizza-orders`/`la-musa-orders`), Firebase RTDB, Cloud Functions (`xpizza-functions/index.js`), Node for the backfill + its test. Build on worktree `feat/pickup-completion` (off `origin/main c09fe12`). Spec: `docs/superpowers/specs/2026-07-31-pickup-order-completion-design.md`.

**Verify-only note:** these are edits to large inline-script HTML files (on-device-verified in this codebase, not unit-tested) + `index.js`. Per-task verification = `node --check` on the extracted module for JS files where possible, a targeted `grep` confirming the edit, and the consolidated **on-device test (Task 9)**. The backfill (Task 8) is a new module with a pure, unit-tested core (TDD).

---

## Task 1: KDS — publish pickup completion (K1)

**Files:**
- Modify: `xpizza-kitchen/index.html` (`startCompletion(id)`, ~:2076)

- [ ] **Step 1: Make `startCompletion` write `completed` for pickups, gated on the write (mirror `commitStatusWrite`).** Replace the function header (currently `function startCompletion(id) {\n  completionSeq[id] = 'completing';`) with:

```js
async function startCompletion(id) {
  // Pickup orders have no driver/delivery-task, so nothing else ever writes a terminal ORDER status
  // (the only 'delivered' transition is driver delivery-task completion). When the kitchen completes a
  // PICKUP, publish it as status='completed' — earns rewards + consumes redemption (already wired), and
  // dispatch/stats/tracker read it. Gate the local completion beat on the write, exactly like
  // commitStatusWrite. Delivery orders are UNTOUCHED — the driver owns their 'delivered' transition.
  const order = lastOrders.find(o => o.id === id) || allOrders.find(o => o.id === id);
  if (order && order.order_type === 'pickup'
      && !['completed', 'delivered', 'cancelled'].includes(order.status)) {   // idempotent: skip terminal
    let wrote;
    try { wrote = await XPD.setOrderStatus(id, 'completed'); }
    catch (e) { wrote = false; console.error('startCompletion: pickup complete write failed', id, e && e.message); }
    if (wrote !== true) {   // ownership-skip / failure → NON-success: do NOT run the local completion beat
      pendingWrites[id] = { from: opState(order), action: 'completar', skip: true, msg: 'No se pudo completar' };
      renderCurrentTab();
      return;
    }
  }
  completionSeq[id] = 'completing';
```

Leave the rest of the function body (the two `setTimeout` beats) unchanged. `startCompletion` is only ever called un-awaited (`commitStatusWrite`, `listo`), so making it `async` is safe.

- [ ] **Step 2: Verify the edit is present and syntactically sane.**

Run: `grep -n "async function startCompletion" xpizza-kitchen/index.html && grep -n "order.order_type === 'pickup'" xpizza-kitchen/index.html`
Expected: both match; `startCompletion` is now `async`.

- [ ] **Step 3: Commit.**

```bash
git add xpizza-kitchen/index.html
git commit -m "feat(kds): pickup Completar publishes status='completed' (K1)"
```

---

## Task 2: KDS — completed → Archivado in the status→estado map (K2)

**Files:**
- Modify: `xpizza-kitchen/index.html:2752`

- [ ] **Step 1: Add `completed` to the `delivered→Archivado` branch.** Current:

```js
  } else if (o.status === 'delivered') {
```

Replace with:

```js
  } else if (o.status === 'delivered' || o.status === 'completed') {
```

(A server-`completed` pickup then maps to `Archivado` → `deriveTab` classifies it to the Completed tab. Else it falls to the `else → 'Nuevo'` catch-all and **reappears as a NEW ticket** on any device without the local `completedSet`.)

- [ ] **Step 2: Verify.** Run: `grep -n "o.status === 'delivered' || o.status === 'completed'" xpizza-kitchen/index.html`. Expected: one match (~:2752).

- [ ] **Step 3: Commit.**

```bash
git add xpizza-kitchen/index.html
git commit -m "fix(kds): map status='completed' → Archivado so pickups don't reappear as new (K2)"
```

---

## Task 3: Functions — inbound status-check (F1) + queryPaymentStatus (F2)

**Files:**
- Modify: `xpizza-functions/index.js:3738` (F1), `:1569` (F2)

- [ ] **Step 1: F1 — exclude `completed` from the inbound "active order" filter.** Current (`:3738`):

```js
          return o.status !== 'delivered' && o.status !== 'cancelled';
```

Replace with:

```js
          return o.status !== 'delivered' && o.status !== 'cancelled' && o.status !== 'completed';
```

(Else a customer texting after collecting a pickup gets an "active order, here's tracking" reply.)

- [ ] **Step 2: F2 — count `completed` as paid in `queryPaymentStatus`.** Current (`:1569`):

```js
    if (ps === 'confirmed' || ['new', 'preparing', 'ready', 'out_for_delivery', 'delivered'].includes(st)) state = 'paid';
```

Replace with:

```js
    if (ps === 'confirmed' || ['new', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'completed'].includes(st)) state = 'paid';
```

(A completed order IS paid/fulfilled; without this a **cash** completed pickup — `payment_status` not `'confirmed'` — reads not-paid. No-op for online orders.)

- [ ] **Step 3: Verify syntax + edits.**

Run: `node --check xpizza-functions/index.js && grep -n "o.status !== 'completed'" xpizza-functions/index.js && grep -n "'delivered', 'completed'\]" xpizza-functions/index.js`
Expected: `node --check` exits 0; both greps match.

- [ ] **Step 4: Commit.**

```bash
git add xpizza-functions/index.js
git commit -m "fix(functions): treat completed as inactive (F1) + paid (F2) for pickups"
```

---

## Task 4: Dashboard — the 8 sites (D1–D8)

**Files:**
- Modify: `xpizza-dashboard/index.html` (:1718 D1, :1446 D2, :897 D3, :911 D4, :920 D5, :957 D6, :1595 D7, :560 D8)

- [ ] **Step 1: D1 [MONEY] — `actionConfig` must not offer cancel/refund on `completed`.** Current (:1718):

```js
  if (o.status !== 'delivered' && !inReconFlow) {
```

Replace with:

```js
  if (o.status !== 'delivered' && o.status !== 'completed' && !inReconFlow) {
```

- [ ] **Step 2: D2 — `statusBucket` returns a terminal bucket for `completed`.** Current (:1446, inside `statusBucket`):

```js
  if (s === 'delivered') return 'delivered';
  return 'active'; // new / preparing / ready / out_for_delivery
```

Replace with:

```js
  if (s === 'delivered') return 'delivered';
  if (s === 'completed') return 'completed';
  return 'active'; // new / preparing / ready / out_for_delivery
```

- [ ] **Step 3: D3–D6 — include `completed` in the completed/aggregate filters, exclude from active.**
  - D3 (:897) `const completed = todayOrders.filter(o => o.status === 'delivered').length;` → `.filter(o => o.status === 'delivered' || o.status === 'completed').length;`
  - D4 (:911) `const active = todayOrders.filter(o => !['delivered', 'cancelled'].includes(o.status));` → `!['delivered', 'cancelled', 'completed'].includes(o.status)`
  - D5 (:920) `const completedOrders = todayOrders.filter(o => o.status === 'delivered');` → `.filter(o => o.status === 'delivered' || o.status === 'completed');`
  - D6 (:957) the `completedSeries` filter `&& o.status === 'delivered'` → `&& (o.status === 'delivered' || o.status === 'completed')`

- [ ] **Step 4: D7 — close label for `completed`.** Current (:1595):

```js
  const closeLabel = o.status === 'cancelled' ? 'Cancelado' : (o.status === 'delivered' ? 'Entregado' : null);
```

Replace with:

```js
  const closeLabel = o.status === 'cancelled' ? 'Cancelado' : (o.status === 'delivered' ? 'Entregado' : (o.status === 'completed' ? 'Recogido' : null));
```

- [ ] **Step 5: D8 — add the filter option.** After the `<option value="delivered">Entregados</option>` line (:560), add:

```html
          <option value="completed">Recogidos</option>
```

- [ ] **Step 6: Verify.** Run: `grep -cE "o.status !== 'completed'|s === 'completed'|'delivered', 'cancelled', 'completed'|'delivered' \|\| o.status === 'completed'|=== 'completed' \? 'Recogido'|value=\"completed\"" xpizza-dashboard/index.html`. Expected: ≥ 7 matches (D1,D2,D3/D5/D6 pattern, D4, D7, D8).

- [ ] **Step 7: Commit.**

```bash
git add xpizza-dashboard/index.html
git commit -m "feat(dashboard): count/label completed pickups + block cancel (D1-D8)"
```

---

## Task 5: Dispatch — closed list, count, detail pill, topbar (DI1–DI4)

**Files:**
- Modify: `xpizza-dispatch/index.html` (:4001 DI1, :4030 DI2, :4228 DI3, :3122 DI4)

- [ ] **Step 1: DI1 — include `completed` in the closed/history list.** Current (:4001):

```js
    o.status === 'delivered' || o.status === 'cancelled'
```

Replace with:

```js
    o.status === 'delivered' || o.status === 'cancelled' || o.status === 'completed'
```

- [ ] **Step 2: DI2 — count `completed` in the ✓ (`dCount`), not ✕.** Current (:4030):

```js
    const dCount = orders.filter(o => o.status === 'delivered').length;
```

Replace with:

```js
    const dCount = orders.filter(o => o.status === 'delivered' || o.status === 'completed').length;
```

(`cCount = orders.length - dCount` then correctly leaves only cancelled as ✕.)

- [ ] **Step 3: DI3 — detail-modal status pill for `completed`.** Current (:4228):

```js
    : order.status === 'delivered'
      ? '<span class="od-status-pill delivered">Entregado</span>'
      : `<span class="od-status-pill">${escapeHtml(order.status || '—')}</span>`;
```

Replace with:

```js
    : order.status === 'delivered'
      ? '<span class="od-status-pill delivered">Entregado</span>'
      : order.status === 'completed'
        ? '<span class="od-status-pill delivered">Recogido</span>'
        : `<span class="od-status-pill">${escapeHtml(order.status || '—')}</span>`;
```

- [ ] **Step 4: DI4 — topbar done-count includes `completed`.** Current (:3122, in `getDeliveredTodayCount`):

```js
    o.status === 'delivered' && o.created_at >= dayStart.getTime()
```

Replace with:

```js
    (o.status === 'delivered' || o.status === 'completed') && o.created_at >= dayStart.getTime()
```

- [ ] **Step 5: Verify.** Run: `grep -cE "o.status === 'completed'" xpizza-dispatch/index.html`. Expected: ≥ 5 (the pre-existing done-set/cancellable at :3417/:4390 plus DI1–DI4).

- [ ] **Step 6: Commit.**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): completed pickups in closed list/count/pill/topbar (DI1-DI4)"
```

---

## Task 6: Tracker — terminal for pickup completion (T1–T3)

**Files:**
- Modify: `xpizza-track/index.html` (:728 T1, :732 T2, :783 T3)

- [ ] **Step 1: T1 — `completed` reaches progress step 4.** Current (:728):

```js
      else if (status === 'delivered') progressStep = 4;
```

Replace with:

```js
      else if (status === 'delivered' || status === 'completed') progressStep = 4;
```

- [ ] **Step 2: T2 — `completed` counts as pickup-done.** Current (:732):

```js
      const pickupDone = isPickup && (status === 'ready' || status === 'delivered');
```

Replace with:

```js
      const pickupDone = isPickup && (status === 'ready' || status === 'delivered' || status === 'completed');
```

- [ ] **Step 3: T3 — `completed` shows the terminal success banner.** Current (:783):

```js
      } else if (status === 'delivered') {
```

Replace with:

```js
      } else if (status === 'delivered' || status === 'completed') {
```

(That branch already reads `isPickup ? 'Recogido' : 'Entregado'`, so a completed pickup correctly shows "Recogido".)

- [ ] **Step 4: Verify.** Run: `grep -cE "status === 'delivered' \|\| status === 'completed'" xpizza-track/index.html`. Expected: ≥ 2 (T1, T3); plus T2's three-way `grep -n "|| status === 'completed'" xpizza-track/index.html`.

- [ ] **Step 5: Commit.**

```bash
git add xpizza-track/index.html
git commit -m "fix(tracker): completed pickup shows terminal Recogido, not step-1 (T1-T3)"
```

---

## Task 7: "Mis pedidos" pill — both account.js (A1, A2)

**Files:**
- Modify: `xpizza-orders/account.js:1376` (A1), `la-musa-orders/account.js:1380` (A2)

- [ ] **Step 1: A1 — add the `completed` case.** In `xpizza-orders/account.js`, after `case 'delivered': return { label: 'Entregado', cls: 'ok' };` add:

```js
      case 'completed': return { label: 'Recogido', cls: 'ok' };
```

- [ ] **Step 2: A2 — same in `la-musa-orders/account.js`** (after its `case 'delivered':`):

```js
      case 'completed': return { label: 'Recogido', cls: 'ok' };
```

- [ ] **Step 3: Verify.** Run: `grep -c "case 'completed': return { label: 'Recogido'" xpizza-orders/account.js la-musa-orders/account.js`. Expected: 1 in each.

- [ ] **Step 4: Commit.**

```bash
git add xpizza-orders/account.js la-musa-orders/account.js
git commit -m "fix(account): Mis pedidos shows 'Recogido' for completed pickups (A1,A2)"
```

---

## Task 8: Backfill script (pickup-scoped, dry-run-first, TDD core)

**Files:**
- Create: `scripts/backfill-pickup-completion.mjs`
- Create: `scripts/backfill-pickup-completion.test.mjs`

- [ ] **Step 1: Write the failing test for the pure candidate selector.**

```js
// scripts/backfill-pickup-completion.test.mjs
import { strict as assert } from 'node:assert';
import { selectBackfillCandidates } from './backfill-pickup-completion.mjs';

const orders = {
  a: { order_id: 'a', order_type: 'pickup',   status: 'ready' },      // ✓ candidate
  b: { order_id: 'b', order_type: 'pickup',   status: 'completed' },  // ✗ already terminal
  c: { order_id: 'c', order_type: 'pickup',   status: 'cancelled' },  // ✗ terminal
  d: { order_id: 'd', order_type: 'delivery', status: 'ready' },      // ✗ NOT pickup (never touch delivery)
  e: { order_id: 'e', order_type: 'pickup',   status: 'preparing' },  // ✓ candidate
};
const ids = selectBackfillCandidates(orders).map(o => o.order_id).sort();
assert.deepEqual(ids, ['a', 'e']);
console.log('ok: selectBackfillCandidates picks only non-terminal pickups, never delivery');
```

- [ ] **Step 2: Run it — verify it fails.** Run: `node scripts/backfill-pickup-completion.test.mjs`. Expected: FAIL (`selectBackfillCandidates` not exported / not found).

- [ ] **Step 3: Write the script (pure core + a guarded dry-run/apply runner).**

```js
// scripts/backfill-pickup-completion.mjs
// One-off: mark already-collected PICKUP orders (stuck non-terminal) as status='completed'.
// STRICTLY pickup + non-terminal → physically cannot touch a delivery order. Dry-run by default.
// Each applied write fires earnRewardsOnCompletion (retroactive earn/consume, idempotent via earn_${id}).
const TERMINAL = new Set(['completed', 'delivered', 'cancelled']);

export function selectBackfillCandidates(orders) {
  return Object.values(orders || {}).filter(
    (o) => o && o.order_type === 'pickup' && !TERMINAL.has(o.status)
  );
}

// Runner is only executed when invoked directly (not on import → tests stay pure).
if (import.meta.url === `file://${process.argv[1]}`) {
  const admin = await import('firebase-admin');
  const apply = process.argv.includes('--apply');   // default = DRY RUN
  admin.default.initializeApp();
  const db = admin.default.database();
  const snap = await db.ref('orders').get();
  const candidates = selectBackfillCandidates(snap.val());
  console.log(`Pickup backfill: ${candidates.length} candidate(s) [${apply ? 'APPLY' : 'DRY RUN'}]:`);
  for (const o of candidates) console.log(`  ${o.order_id}  (${o.status} → completed)  [fires retroactive earn/consume]`);
  if (!apply) { console.log('DRY RUN — no writes. Re-run with --apply after reviewing the list.'); process.exit(0); }
  for (const o of candidates) { await db.ref(`orders/${o.order_id}/status`).set('completed'); console.log(`  wrote ${o.order_id} → completed`); }
  console.log(`Done: ${candidates.length} written.`);
  process.exit(0);
}
```

- [ ] **Step 4: Run the test — verify it passes.** Run: `node scripts/backfill-pickup-completion.test.mjs`. Expected: `ok: selectBackfillCandidates picks only non-terminal pickups, never delivery`.

- [ ] **Step 5: Commit.**

```bash
git add scripts/backfill-pickup-completion.mjs scripts/backfill-pickup-completion.test.mjs
git commit -m "feat(backfill): pickup-scoped dry-run completion backfill (tested core)"
```

---

## Task 9: On-device verification (the real test) + delivery-path proof

**No code.** Run through the spec §9 checklist against a real pickup order and a real delivery order.

- [ ] **Step 1: Pickup completion end-to-end.** In the KDS, take a real **pickup** order → tap **Completar**. Confirm in RTDB `orders/{id}/status === 'completed'`. Then confirm: (a) it **leaves dispatch En Fila → Recoger**, appears in dispatch closed-search, detail pill reads **"Recogido"**, topbar done-count +1; (b) dashboard: completed aggregate +1, label **"Recogido"**, NOT in active, **no cancel/refund action**; leaderboard + prep metrics unchanged; (c) KDS on a **second device** shows it **Archivado** (Completed tab), not a new "Nuevo" ticket; (d) customer tracker shows the terminal **"Recogido / ¡Gracias por tu compra!"** banner, not step-1; (e) "Mis pedidos" shows **"Recogido"**, not "En preparación"; (f) the customer texting WhatsApp does **not** get an "active order" reply; **no** WhatsApp status message was sent on completion.

- [ ] **Step 2: Rewards.** Confirm the completed pickup **earned** rewards (`earn_${orderId}` in the ledger) and **consumed** any pending redemption. Re-tap Completar (or re-run backfill) → confirm **idempotent** (no double-earn).

- [ ] **Step 3: Delivery path untouched (the hard invariant).** Take a real **delivery** order → KDS **Completar** behaves exactly as before (local bump only; `orders/{id}/status` is whatever the driver flow set, NOT rewritten). A driver "¡Entregado!" still writes `status='delivered'` + `delivered_at`. Driver leaderboard/metrics count it as before.

- [ ] **Step 4: Backfill dry-run.** Run `node scripts/backfill-pickup-completion.mjs` (dry run). Confirm the printed candidate list is **pickup order_ids only** (no delivery). Review, then `--apply`; confirm the stuck pickups clear from En Fila and earn retroactively.

---

## Post-build gate & deploy (not a task — the process after Task 9)

1. **codex-on-diff money-gate** on the full diff (`origin/main c09fe12` → HEAD) — the real remaining gate (first code). It re-confirms: the KDS `completed` write correctly triggers earn/consume + is idempotent; D1 cancel-gate; F1/F2 are the only functions changes; delivery path byte-untouched; backfill pickup-scoped.
2. **Deploy** (after gate + `git fetch` re-confirming `origin/main`): Netlify per-folder for `xpizza-kitchen` (**both** lamusakitchendisplay + X. Pizza sites, explicit `--site`), `xpizza-dashboard`, `xpizza-track`, `xpizza-orders`, `la-musa-orders`; **functions deploy** for `index.js` F1/F2 ([[prod-functions-deployed-state]] — deploy the FULL fn set; [[functions-env-management]] — env care). Run the backfill once post-deploy. **Fold into the rewards launch** — ship pickup earning before/with the redemption flip.

---

## Self-Review

**Spec coverage:** K1→Task1, K2→Task2, F1/F2→Task3, D1–D8→Task4, DI1–DI4→Task5, T1–T3→Task6, A1/A2→Task7, backfill→Task8, on-device §9→Task9, gate+deploy→post-build. LEAVE-list (§3B) requires no task by definition. ✅ complete.
**Placeholder scan:** every step shows the exact current→new code or exact command; no TBD/"handle errors"/"similar to". ✅
**Type consistency:** the reused value is the literal string `'completed'` everywhere; labels are `'Recogido'`; `setOrderStatus(id,'completed')` matches the existing signature; `selectBackfillCandidates` name consistent between test and impl. ✅
