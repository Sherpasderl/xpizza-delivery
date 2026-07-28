# Rewards Phase A — Earn Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** The backend earn engine + server-only ledger for the per-brand rewards program — points/punches accrue on completed orders, a welcome bonus is credited once per phone, and refunds reverse earn. **No money-path, no UI, hidden balances.**

**Architecture:** A pure `rewards-core.js` (config + earn math + ledger-entry builders, unit-tested) drives an impure `rewards-earn.js` (mark-before-credit ledger writes). A new `earnRewardsOnCompletion` RTDB status trigger credits on the real terminal state (delivery=`delivered`, pickup=`completed`). Welcome bonus is credited in `verifyOtp`, guarded by a **phone-hash tombstone** (`reward_welcome/{phone_hash}/{rid}`) so it can't be farmed. Points live in a new **server-only `user_rewards/{uid}/{restaurant_id}`** node. Earn reverses idempotently on refund via `cancelOrderCore`.

**Tech Stack:** Node 22 Firebase gen2 functions, RTDB, Admin SDK; the codebase's existing mark-before-send pattern (`notifyPickupReady`, order-received), emulator tests (`firebase emulators:exec --only database`), pure-module unit tests (`node x.test.js`).

## Global Constraints
- **Design:** `docs/superpowers/specs/2026-07-27-rewards-loyalty-design.md` (codex design-gate APPROVED R1→R3). This plan is Phase A only.
- **`user_rewards` + `reward_welcome` are Admin-SDK-written ONLY** — clients never write them (the whole fraud surface). Rules: `user_rewards/$uid` read-own + `.write:false`; `reward_welcome` read+write false.
- **Earn is additive, NOT money-path** — mutates only a points number + append-only ledger. No order total, no payment, no discount (that's Phase B).
- **Locked earn config (owner):** X. Pizza = **1 punch per pizza**, **welcome 2 punches**. La Musa = **10 points per 25 Lempiras** (i.e. 0.4 pts/L, from `subtotal_cents`), **welcome 100 points**. (Redemption thresholds — 9 punches/free pizza, La Musa tiers — are Phase B; NOT in Phase A.)
- **Idempotency everywhere:** earn once per order (marker), welcome once per phone_hash (tombstone), reversal once per order.
- **No prune:** any new export keeps ALL existing functions. Both driver + payment code present on deploy.
- **Ships hidden:** no UI, no marketing (Phase C). Immutable append-only ledger + `config_version` on every entry.
- Run the full functions suite (`npm test`) green; emulator tests need Java on PATH (`export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"`).

## File Structure
- **Create `xpizza-functions/rewards-core.js`** — pure: `REWARDS_CONFIG` (per-brand), `REWARDS_CONFIG_VERSION`, `computeEarn({items, subtotalCents, restaurantId})`, `ledgerEntry({type, delta, ...})`. Zero deps, unit-tested.
- **Create `xpizza-functions/rewards-earn.js`** — impure: `creditEarnForOrder(db, {orderId, order, now})` (mark-before-credit + ledger + balance), `creditWelcome(db, {uid, phoneHash, restaurantId, now})`, `reverseEarnForOrder(db, {orderId, order, now})`. Admin-SDK writes only.
- **Modify `xpizza-functions/index.js`** — new export `earnRewardsOnCompletion` (status trigger); welcome credit call in `verifyOtp`.
- **Modify `xpizza-functions/account-lib.js`** — `accountDeleteUpdates` nulls `user_rewards/{uid}`.
- **Modify `xpizza-functions/cancel-order-core.js`** — call `reverseEarnForOrder` in the shared cancel/refund path (idempotent).
- **Modify `xpizza-reference/database.rules.json`** — `user_rewards` + `reward_welcome` rules.
- **Tests:** `rewards-core.test.js`, `rewards-earn.emulator.test.js`, `rewards-rules.emulator.test.js`; extend `account-lifecycle.test.js`.

---

## Task 1: `rewards-core.js` — pure config + earn math + ledger builder
**Files:** Create `xpizza-functions/rewards-core.js`, `xpizza-functions/rewards-core.test.js`.

**Interfaces — Produces:**
- `REWARDS_CONFIG_VERSION` (number, start `1`).
- `REWARDS_CONFIG` = `{ x_pizza: { kind:'punch', welcome:2 }, la_musa: { kind:'points', pointsPer:10, perCents:3000, welcome:100 } }`.
- `computeEarn({ items, subtotalCents, restaurantId }) → { delta:<int>, unit:'punch'|'point' }` — x_pizza: `delta = Σ item.qty` (every x_pizza line is a pizza), unit 'punch'; la_musa: `delta = Math.floor(subtotalCents / perCents) * pointsPer`, unit 'point'. Unknown restaurant → `{delta:0}`. Non-array items / non-finite subtotal → `{delta:0}` (fail-safe, never throws).
- `ledgerEntry({ type, delta, orderId=null, redemptionId=null, now, note=null }) → { type, delta, order_id, redemption_id, ts, config_version, note }` (drops null keys except ts/type/delta/config_version).

- [ ] **Step 1: failing tests** (`rewards-core.test.js`):
```js
const assert = require('assert');
const { computeEarn, ledgerEntry, REWARDS_CONFIG_VERSION } = require('./rewards-core');
// x_pizza: 1 punch per pizza (sum of qty)
assert.deepStrictEqual(computeEarn({ items:[{qty:2},{qty:3}], restaurantId:'x_pizza' }), { delta:5, unit:'punch' });
assert.deepStrictEqual(computeEarn({ items:[], restaurantId:'x_pizza' }), { delta:0, unit:'punch' });
// la_musa: 10 pts / 3000 cents (30 L); L700 order = 70000 cents → floor(70000/3000)=23 → 230
assert.deepStrictEqual(computeEarn({ subtotalCents:70000, restaurantId:'la_musa' }), { delta:230, unit:'point' });
assert.deepStrictEqual(computeEarn({ subtotalCents:2900, restaurantId:'la_musa' }), { delta:0, unit:'point' }); // < 30 L → 0
// fail-safe
assert.deepStrictEqual(computeEarn({ restaurantId:'unknown' }), { delta:0, unit:'point' });
assert.deepStrictEqual(computeEarn({ items:'x', restaurantId:'x_pizza' }), { delta:0, unit:'punch' });
// ledger entry drops nulls, stamps version
const e = ledgerEntry({ type:'earn', delta:5, orderId:'O1', now:100 });
assert.strictEqual(e.type,'earn'); assert.strictEqual(e.delta,5); assert.strictEqual(e.order_id,'O1');
assert.strictEqual(e.ts,100); assert.strictEqual(e.config_version, REWARDS_CONFIG_VERSION);
assert.ok(!('redemption_id' in e) && !('note' in e));
console.log('rewards-core OK');
```
- [ ] **Step 2:** `node xpizza-functions/rewards-core.test.js` → fails (module missing).
- [ ] **Step 3: implement** `rewards-core.js`:
```js
const REWARDS_CONFIG_VERSION = 1;
const REWARDS_CONFIG = {
  x_pizza: { kind: 'punch', welcome: 2 },
  la_musa: { kind: 'points', pointsPer: 10, perCents: 3000, welcome: 100 },
};
function computeEarn({ items, subtotalCents, restaurantId } = {}) {
  const cfg = REWARDS_CONFIG[restaurantId];
  if (!cfg) return { delta: 0, unit: 'point' };
  if (cfg.kind === 'punch') {
    if (!Array.isArray(items)) return { delta: 0, unit: 'punch' };
    let n = 0; for (const it of items) { const q = Number(it && it.qty); if (Number.isInteger(q) && q > 0) n += q; }
    return { delta: n, unit: 'punch' };
  }
  const c = Number(subtotalCents);
  if (!Number.isFinite(c) || c <= 0) return { delta: 0, unit: 'point' };
  return { delta: Math.floor(c / cfg.perCents) * cfg.pointsPer, unit: 'point' };
}
function ledgerEntry({ type, delta, orderId = null, redemptionId = null, now, note = null }) {
  const e = { type, delta, ts: now, config_version: REWARDS_CONFIG_VERSION };
  if (orderId != null) e.order_id = orderId;
  if (redemptionId != null) e.redemption_id = redemptionId;
  if (note != null) e.note = note;
  return e;
}
module.exports = { REWARDS_CONFIG, REWARDS_CONFIG_VERSION, computeEarn, ledgerEntry };
```
- [ ] **Step 4:** `node xpizza-functions/rewards-core.test.js` → `rewards-core OK`.
- [ ] **Step 5: commit** — `feat(rewards): pure earn config + computeEarn + ledger builder (Phase A)`.

## Task 2: RTDB rules — `user_rewards` (read-own, server-write) + `reward_welcome` (server-only)
**Files:** Modify `xpizza-reference/database.rules.json` (beside `user_orders`); Create `xpizza-functions/test/rewards-rules.emulator.test.js`.

- [ ] **Step 1:** add, next to `user_orders`:
```json
"user_rewards": { "$uid": { ".read": "auth != null && auth.uid === $uid", ".write": false, ".validate": "!newData.isString() && !newData.isNumber() && !newData.isBoolean()" } },
"reward_welcome": { ".read": false, ".write": false },
```
(container `.validate` rejects a scalar write to the node — the addresses-node lesson; admin object writes still pass.)
- [ ] **Step 2: emulator test matrix** (`test/rewards-rules.emulator.test.js`, mirror `user-profiles-rules.emulator.test.js`): admin seeds `user_rewards/uidA/x_pizza`; assert (a) uidA authed READ own ALLOWED; (b) uidB READ uidA DENIED; (c) unauth READ DENIED; (d) uidA client WRITE to own `user_rewards/uidA/...` (balance/ledger/scalar) DENIED; (e) any client READ/WRITE `reward_welcome` DENIED. Run: `firebase emulators:exec --only database --project demo-xpizza "node test/rewards-rules.emulator.test.js"` (Java on PATH; `npm run sync:rules` first). Expect all assertions pass (permission_denied on the negative cases is expected).
- [ ] **Step 3:** `npm run check:rules` (structural guards + parity). **Commit** — `feat(rewards): user_rewards read-own + reward_welcome server-only rules (emulator-verified)`.

## Task 3: `rewards-earn.js` — mark-before-credit earn + welcome + reversal
**Files:** Create `xpizza-functions/rewards-earn.js`, `xpizza-functions/test/rewards-earn.emulator.test.js`.

**Interfaces — Consumes:** `computeEarn`, `ledgerEntry` (Task 1). **Produces:**
- `creditEarnForOrder(db, { orderId, order, now }) → Promise<{credited:boolean, delta:number}>` — NO-OP (credited:false) if no `order.customer_uid`, or delta 0. Else: **mark-before-credit** — transaction-claim `orders/{orderId}/rewards_earned_at` (present ⇒ abort/no-op; absent ⇒ win), then atomically bump `user_rewards/{uid}/{rid}/balance` + `lifetime` (transaction) and push a `ledgerEntry({type:'earn',delta,orderId})`. Restaurant from `order.restaurant_id||'x_pizza'`. Fail-open (log, never throw).
- `creditWelcome(db, { uid, phoneHash, restaurantId, now }) → Promise<{credited:boolean}>` — transaction-claim `reward_welcome/{phoneHash}/{restaurantId}` (present ⇒ no-op); on win, bump balance+lifetime by `REWARDS_CONFIG[restaurantId].welcome` + push `ledgerEntry({type:'welcome',delta})`.
- `reverseEarnForOrder(db, { orderId, order, now }) → Promise<{reversed:boolean}>` — idempotent by a `orders/{orderId}/rewards_reversed_at` claim; only if the order actually earned (`rewards_earned_at` present); debits the earned delta back (reads the earn ledger/marker amount) + pushes `ledgerEntry({type:'clawback',delta:-earned,orderId})`. No-op if never earned or already reversed.

- [ ] **Step 1: emulator test** (`test/rewards-earn.emulator.test.js`) — scenarios, each asserting balance + ledger + markers:
  1. delivery order `customer_uid:'uidA', restaurant_id:'x_pizza', items:[{qty:2}]` → `creditEarnForOrder` credits **2 punches**; `rewards_earned_at` set; second call NO-OP (balance stays 2).
  2. la_musa order `subtotal_cents:70000` → credits **280 points**.
  3. guest order (no `customer_uid`) → NO-OP, no `user_rewards` node.
  4. `creditWelcome(uidA, phoneHashX, 'x_pizza')` → +2 punches + welcome ledger; second call same phoneHash NO-OP.
  5. `reverseEarnForOrder` on the Task-1 earned order → debits 2, clawback ledger, `rewards_reversed_at` set; second call NO-OP; reversing a never-earned order NO-OP.
- [ ] **Step 2:** run it → fails (module missing).
- [ ] **Step 3: implement** `rewards-earn.js` using the `notifyPickupReady` mark-before-send pattern (transaction claim on the marker BEFORE crediting; balance bump via `ref.transaction`; ledger via `push`). All three functions fail-open (try/catch, log). Read the earned amount for reversal from the `earn` ledger entry (query by order_id) or store the earned delta on the marker (`rewards_earned_at` as `{ts, delta}`) — prefer storing `{at, delta}` on the marker so reversal is a single read.
- [ ] **Step 4:** run the emulator test → all pass.
- [ ] **Step 5: commit** — `feat(rewards): earn/welcome/reverse credit (mark-before-credit, fail-open)`.

## Task 4: `earnRewardsOnCompletion` trigger — wire earn on the terminal state
**Files:** Modify `xpizza-functions/index.js` (new export near the other `onValueWritten('/orders/{orderId}/status')` triggers).

**Interfaces — Consumes:** `creditEarnForOrder` (Task 3).
- [ ] **Step 1:** add the trigger — `onValueWritten('orders/{orderId}/status')`: read `after`; **earn only on the real terminal state** — `if (!((after==='delivered') || (after==='completed'))) return;` (delivery completes at `delivered`, pickup at `completed`; `ready` is pre-collection and must NOT earn). Load the order; `await creditEarnForOrder(db, { orderId, order, now: Date.now() })`. Fail-open. (A sibling of `/status`; the marker write can't re-trigger.)
- [ ] **Step 2:** confirm the export is ADDED, pruning nothing — `grep -cE "^exports\." xpizza-functions/index.js` before/after; the count increases by exactly 1 and all prior exports remain.
- [ ] **Step 3:** extend the emulator test (or a new one) to write `orders/O/status='delivered'` on a seeded order and assert the balance credited once; a `status='ready'` write earns nothing. **Commit** — `feat(rewards): earnRewardsOnCompletion trigger (delivered/completed, at-most-once)`.

## Task 5: Welcome bonus in `verifyOtp`
**Files:** Modify `xpizza-functions/index.js` (the `verifyOtp` handler, where the profile is established ~L900–925; `phone_hash` is available from the OTP flow).

**Interfaces — Consumes:** `creditWelcome` (Task 3).
- [ ] **Step 1:** in `verifyOtp`, AFTER the profile/token is successfully established, credit the welcome for the CUSTOMER's restaurant context. **Open detail to confirm in-build:** the OTP flow is per-restaurant (`?restaurant=` / brand) — credit welcome for that `restaurantId` only (a customer earns each brand's welcome the first time they log in via that brand). Call `await creditWelcome(db, { uid, phoneHash, restaurantId, now })` — fail-open (never block login/token issuance). The `reward_welcome/{phoneHash}/{rid}` tombstone makes it once-per-phone-per-brand, surviving profile deletion (account-lib does NOT delete `reward_welcome`).
- [ ] **Step 2:** unit/emulator test: first verifyOtp for a phone credits welcome once; a second login (same phone) does NOT re-credit; deleting the account then re-verifying does NOT re-credit (tombstone persists). **Commit** — `feat(rewards): welcome bonus on first login, phone-hash tombstoned (un-farmable)`.

## Task 6: Account deletion nulls `user_rewards`
**Files:** Modify `xpizza-functions/account-lib.js` (`accountDeleteUpdates`); extend `account-lifecycle.test.js`.
- [ ] **Step 1: test-first** — assert `accountDeleteUpdates(uid, phoneHash, ts)` now includes `[user_rewards/${uid}]: null` (alongside `user_profiles`/`user_orders`/`phone_index`/`deleted_uids`), and does NOT null `reward_welcome/*` (anti-farm — the tombstone stays).
- [ ] **Step 2:** add `updates[\`user_rewards/${uid}\`] = null;` to `accountDeleteUpdates`. Tests green. **Commit** — `feat(rewards): account deletion purges user_rewards (welcome tombstone retained)`.

## Task 7: Earn reversal on refund/cancel (shared state machine)
**Files:** Modify `xpizza-functions/cancel-order-core.js` (`cancelOrderCore`, the shared core — NOT the HTTP wrapper); extend `cancel-order.test.js` or an emulator test.

**Interfaces — Consumes:** `reverseEarnForOrder` (Task 3).
- [ ] **Step 1:** in `cancelOrderCore`, on a cancel/refund of an order that COMPLETED-then-refunded, call `await reverseEarnForOrder(db, { orderId, order, now })` — idempotent (its own `rewards_reversed_at` claim), fail-open, so refund-reconciliation retries / `recoverStaleCancel` / `refund_pending` re-entry can't double-reverse. (Redemption reversal is Phase B; Phase A reverses only EARN.)
- [ ] **Step 2:** test: an earned order that is refunded → earn debited once; a retry does not double-debit; a never-earned cancelled order → no-op. **Commit** — `feat(rewards): reverse earn on refund via cancelOrderCore (idempotent)`.

## Task 8: Suite green + push + report
- [ ] **Step 1:** `cd xpizza-functions && npm test` (all green — rewards-core + existing suite). Run the emulator tests (Java on PATH): rewards-rules, rewards-earn, and the trigger/welcome cases.
- [ ] **Step 2:** confirm exports: exactly ONE new (`earnRewardsOnCompletion`), all prior present (no prune). `node --check` touched files.
- [ ] **Step 3:** push `feat/rewards-phase-a` (branch off `feat/rewards-design`/main); report tip SHA + per-task commits + emulator + suite results + the exports before/after list. **No deploy/merge.**

---

## Self-Review
- **Spec coverage (Phase A slice):** data model `user_rewards`+`reward_welcome` (T2), server-only rules + emulator (T2), earn on per-type terminal state + at-most-once (T3/T4), amount from server record x_pizza-punches/la_musa-subtotal (T1/T3), welcome phone-hash tombstone un-farmable (T3/T5), immutable ledger + config_version (T1/T3), account-deletion coverage (T6), earn refund-reversal idempotent (T3/T7), hidden balances/no-UI (whole phase), no-prune (T4/T8). Redemption (money-path), redemption tiers/9-punches, and UI are correctly DEFERRED to Phase B/C.
- **Placeholder scan:** the two "confirm in-build" notes (verifyOtp restaurantId source; storing earned delta on the marker for reversal) are real, bounded implementation choices with the recommended resolution stated — not open TODOs.
- **Type consistency:** `computeEarn`/`ledgerEntry`/`creditEarnForOrder`/`creditWelcome`/`reverseEarnForOrder` signatures are consistent across tasks; markers `rewards_earned_at`(with delta)/`rewards_reversed_at`; config keys `x_pizza`/`la_musa`.

## Handoff
Advisor is sole gate-runner. Executor builds on `feat/rewards-phase-a`, pushes, reports SHA + results. Advisor runs codex-on-diff (heavy on: server-only rules close the tamper surface, at-most-once earn, guest no-op, welcome un-farmable, reversal idempotency, no-prune, no money-path touched) → owner deploys **functions + rules** (rules via `sync:rules`+emulator+`deploy:rules`; functions complete-env/both-code/zero-prune; verify the new trigger's revision). Build model: **Opus 4.8**.
