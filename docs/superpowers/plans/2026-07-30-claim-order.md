# claimOrder — retro-credit a guest order's earn on profile-claim (build plan)

_MONEY-PATH (grants loyalty points) → **money-gate** (codex). Design codex-gated APPROVE-WITH-CHANGES (thread 019fb197 — all fixes folded in). Prerequisite for the honest reward card: once earn is actually credited on claim, "este pedido suma X pts al crear tu perfil" is TRUE. Branch `feat/claim-order` off `feat/track-a-profile-claim` (`b9cdc65`) — needs Track A's `claim-prefill.js` guards, `order_tracking.has_profile`, and the client claim path._

## What it does
A guest places an order (no `customer_uid`); Track A gives them a claim card / deep-link. On creating their profile, `claimOrder` binds THAT ONE token-bound order to the new uid and credits its loyalty earn — retroactively, safely, once. Scope: **only the single token-bound order** (not all past guest orders by phone).

## New function `claimOrder` — `onRequest`, ID-token authenticated, input `{ order_id, token }`

Reuses: `claim-prefill.js` path guards · the attribution guards (index.js:547-557) · `OTP.phoneHash` / `OTP.normalizePhone` · `creditEarnForOrder` (idempotent, rewards-earn.js:47) · `shouldEarnOnStatus` (rewards-core) · the `orders/{id}.transaction` pattern (cancel-order-core.js `claimDecision`) · the `claim_token` rate bucket.

**Order of operations (fail-closed; no write before every gate passes):**
1. **Auth + account guards** — `getAuth().verifyIdToken(req.get('x-firebase-id-token'))` → require `dec.customer === true && dec.uid` (else 401). `user_profiles/{uid}` exists with a stored `phone_hash` (else 403). `deleted_uids/{uid}` absent (tombstoned → 403). Mirrors index.js:547-557.
2. **Path-safe validation** — `order_id` `/^[A-Za-z0-9_-]{1,64}$/`, `token` `/^[A-Za-z0-9]{1,64}$/` (the EXACT `claim-prefill.js` guards) BEFORE any DB path. Fail → 403.
3. **Rate-limit** — `checkRateLimit(db, 'claim_token', token, RATE_LIMIT_BUCKETS.claim_token)` (+ optionally per-uid) BEFORE reads → 429. (Reuse Track A's per-token bucket — the token is the spoof-proof key.)
4. **Token↔order bind** — `order_tracking/{token}.order_id === order_id` (strict string compare). Fail → 403.
5. **Phone-match (pre-tx capture)** — `h1 = OTP.phoneHash(order.customer_phone)` (read `orders/{order_id}` once), `h2 = user_profiles/{uid}.phone_hash`; require **both truthy AND `h1 === h2`** (never `null === null`). Fail → 403.
6. **Atomic bind (the critical anti-double-credit gate)** — a **transaction on `orders/{order_id}`** with a pure decision `bindDecision(cur, uid, h2, now)` that RE-CHECKS inside the tx: `cur` exists · `!cur.customer_uid` · `OTP.phoneHash(cur.customer_phone) === h2` (truthy) · `cur.status !== 'cancelled'` · no cancel-in-progress (`!cur.cancel_in_progress`/`payment_status` not refunding — match cancel-order-core's fields) → set `cur.customer_uid = uid`, return `cur`; else return `undefined` (abort). Only ONE uid can win the bind → the losing uid's tx aborts → no second `earn_${orderId}` with a uid. Committed=false (already bound / cancelled / mismatch) → return a typed non-credit (`{ok:true, credited:false, reason}`), NOT a 500.
7. **Attribution** — on a committed bind, write `user_orders/{uid}/{order_id}` (mirror `attachCustomerAttribution`'s shape: ts/total/order_type/items_text/restaurant/status/items via `normalizeReorderItems`).
8. **Credit — from the COMMITTED post-tx snapshot** (`tx.snapshot.val()`, never a stale pre-tx read): if `shouldEarnOnStatus(committed.status)` (terminal: delivered/completed) → `creditEarnForOrder(db, { orderId, order: committed, now })` (idempotent on `earn_${orderId}` — belt-and-suspenders with the bind). Else **bind-only** → the existing `earnRewardsOnCompletion` (status trigger, index.js:2100) credits at completion, now that `customer_uid` is set.
9. **Flip `order_tracking/{token}/has_profile = true`** (the tracker hides the guest card post-claim).
10. **Return** `{ ok:true, credited:<bool>, delta:<int>, unit:<'punch'|'point'> }` (or the typed non-credit reason).

**Cancel-after-claim → reverses AUTOMATICALLY** — `cancelOrderCore` already calls `reverseEarnForOrder` (cancel-order-core.js:175), keyed on `earn_${orderId}.delta`. So a claim-then-cancel reverses the exact credited amount; no new wiring. (A cancel racing the bind is excluded by step-6's `status/cancel-in-progress` re-check.)

## Why no double-credit (the money-safety argument)
- The **bind transaction** admits exactly one uid (`!cur.customer_uid` gate) → only one uid ever owns the order → only one `earn_${orderId}` is ever credited-with-a-uid.
- `creditEarnForOrder` writes the `earn_${orderId}` ledger **idempotently** (`creditNode`) → even if `claimOrder` AND `earnRewardsOnCompletion` both fire (terminal order claimed), the second is a no-op.
- The credit reads the **post-tx committed snapshot** → the status/redemption used for `computeEarn` can't be stale.
- Guests can't redeem → for the claimed (formerly-guest) order the redemption adjustment is absent, and even if a logged-in edge existed, `creditEarnForOrder` applies the same `−1` adjustment as the authoritative path.

## Client — call `claimOrder` after a claim-context signup (account.js, fail-open)
- **Stash the claim context** `{ order_id, token }` when a claim flow starts: the tracker deep-link already has it in `window.__claimParams` (Track A); the **success card** has `order_id = currentOrder.order_id` + needs the `tracking_token` — **capture it from the createOrder response** in `submitOrder` (`const j = await res.json(); currentOrder.tracking_token = j.tracking_token`) so the success-card claim can pass the token. Thread `{order_id, token}` into `startProfileClaim`/`openLoginSheet` alongside the Track A phone/name prefill.
- **After profile creation** (the `saveName`/`verifyCode` success path where the new ID token exists): if a claim context is stashed, `fetch(CLAIMORDER_URL, { headers: {'X-Firebase-ID-Token': idTok}, body: {order_id, token} })`. **Fail-open: a claim-credit failure NEVER blocks signup** (try/catch, no await-throw). One-shot (clear the stash).
- Both order forms (byte-identical past CONFIG) + a `CLAIMORDER_URL` const.

## Rate-limit / infra
`claimOrder`: `onRequest` region us-central1, cors, `maxInstances` low, `timeoutSeconds:10`. Reuse `claim_token` bucket (per-token) — optionally add a per-uid bucket. No new RTDB rules (all Admin-SDK writes; `user_orders`/`user_rewards`/`orders` are server-written).

## Tests (money-gate — emulator)
- **double-claim same uid** → single credit (idempotent replay).
- **double-claim different uid** (race two binds on one order) → exactly ONE binds + credits; the other → typed non-credit (403/already-bound).
- **completion-race** — claim a non-terminal order (bind-only) then it completes → `earnRewardsOnCompletion` credits once (not twice with claimOrder).
- **phone-mismatch** → 403, no bind.
- **cancelled order** → no bind / no credit.
- **cancel-after-claim** → `reverseEarnForOrder` reverses the credited delta (balance back to 0).
- **tombstoned uid** → no bind (403).
- **token/order mismatch** → 403.
- **path-injection** guards (order_id/token) → 403.
- **terminal-order claim** → credits immediately from the post-tx snapshot; **bind-only (non-terminal)** → credits at completion.

## Sequence (each SHA → gate)
1. **`claimOrder` (functions, MONEY-GATE)** — the function + `bindDecision` pure fn + emulator tests.
2. **Client `claimOrder` call** (account.js claim/signup path + `submitOrder` token capture + `CLAIMORDER_URL`) — code-gate.
3. → then the reward card (`feat/reward-led-claim`) resumes with the now-honest copy.

## Open questions for the gate
1. **`bindDecision` cancel-in-progress fields** — confirm the exact `orders/{id}` fields that mark "cancel in progress / refunding" (match cancel-order-core.js so the bind can't race a refund). Flagged for the build read.
2. **Per-uid rate bucket** in addition to per-token — worth adding, or is per-token sufficient (the token is the capability)?
3. **Success-card token capture** — capturing `tracking_token` from the createOrder response onto `currentOrder` (small `submitOrder` change) — confirm that's the cleanest source vs. a `paymentStatus`-style lookup.
