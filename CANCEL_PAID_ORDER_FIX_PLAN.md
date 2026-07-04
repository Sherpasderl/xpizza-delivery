# Plan: centralize dispatcher cancellation server-side (paid online cancels must refund)

_Design gate (grill-with-docs-codex), rev-5 (Codex R1-R4 folded, APPROVED R5). Terms per manual-resolve.js._

## Problem (found by the 2026-07-04 live smoke test)
A dispatcher cancelled a paid card order (L251) from dispatch; it went `status=cancelled` but
`payment_status=confirmed` — the charge was never voided. Dispatch "Cancelar pedido" calls the
client-side `cancelOrder` (RTDB-only: status+tasks+driver, no PixelPay). `cancelPaidOrder` (the
refunding fn, index.js ~1460) exists but nothing calls it, and its `already_cancelled` guard
(index.js:1483) fires before the refund logic → a paid+cancelled order is stranded. Same client
`cancelOrder` also ships in `xpizza-dashboard` (:841) and `xpizza-driver` (:862) — same latent bug.
(L251 recovered via manual PixelPay void + RTDB payment_status=refunded.)

## Goal
ONE authenticated server endpoint is the single source of truth for dispatcher cancellation. It runs a
uniform, atomic, phase-aware, money-safe flow for EVERY order: it voids the charge iff there is captured
money, finalizes the cancel honestly, heals an already-cancelled-but-still-paid order, never
double-voids, and needs no manual PixelPay step. Clients stop writing order cancellations to RTDB.

## Approach

### A. Generalize the EXISTING `cancelPaidOrder` in place (deploy-safe, F10-r2)
Do NOT add a new `exports.cancelOrder` (that would be 32 fns / an endpoint migration). Repurpose the
already-deployed `cancelPaidOrder` (keep its name + URL → stays **31→31 zero-prune**) into the universal
cancel: remove its `payment_method!=='online'` 409 guard so it handles all methods. Name is now a
documented misnomer — alias/rename is a non-urgent follow-up. Extract the decision logic into a PURE
`cancel-order.js` (goldens, no I/O) reusing manual-resolve.js primitives; DB/PixelPay wiring stays a
thin deps-injected adapter.

### B. ONE uniform money-aware path for ALL methods (kills the branch-misroute risk, F11-r1/F5-r2)
No cash-vs-online client branch. Every order runs the same steps; `cash`/`card_delivery` simply have no
captured-money evidence, so the void is skipped and it degrades to a plain finalize:
1. **Auth**: `authorizeDispatcherAction` (global dispatcher — attested; scope-hook noted for future
   per-restaurant dispatch). **Read order** by `order_id`; 404 if absent.
2. **Allowed-state gate (F8-r2)** BEFORE any mutation:
   - `status==='delivered'` (or other terminal-success) → 409 "pedido entregado, no cancelable".
   - `isResolving(payment_status)` → 409 "en reconciliación (en proceso)".
   - `payment_status==='manual_reconciliation'`: if the order is still visible in the recon surface
     (`status==='pending_payment'`) → 409 "resuélvelo en Reconciliación de pagos"; otherwise (cancelled/
     other, NOT in that surface, F7-r2) → `manual_review` + `paymentAlert`, never a silent path.
3. **Evidence, split predicates (F3/F4-r2)** — add to manual-resolve.js:
   - `hasCapturedMoneyEvidence(order,attempt)` = `paid_during_resolve===true || attempt.capture_verified
     ===true || attempt.hosted_callback_verified===true || attempt.hosted_state==='paid' ||
     order.payment_status==='confirmed'` (F4-r3 — include the durable `hosted_callback_verified` the
     webhook writes at :91/:105). This — NOT a bare `payment_uuid` (declined auths carry UUIDs) — is the
     ONLY void gate.
   - keep broad `hasPaidEvidence` for ambiguity routing: a UUID-only / `pending`+UUID attempt →
     `manual_review` + alert (verify in PixelPay), never an auto-void.
4. **Idempotency — applies ONLY to an order ALREADY `status==='cancelled'` (F1-r4).** A LIVE order (any
   non-cancelled status) NEVER returns `already_cancelled` — it proceeds to claim + finalize (void iff
   captured evidence; a live cash order with no evidence → plain finalize/cancel). For an
   already-cancelled order (F6-r2 contract):
   - `payment_status==='refunded'` OR no captured-money evidence at all → 200 `already_cancelled` (no-op).
   - `payment_status==='refund_pending'` (reversal attempted, not confirmed `anulada`) → 409
     `{outcome:'refund_pending'}` (still pending in PixelPay), NOT already_cancelled. UI copy matches.
   - captured evidence + no completed reversal (incl. `status==='cancelled'` from the old client path) →
     **heal**: proceed to the void path.
   - captured evidence at order level but NO resolvable active_attempt_id/uuid (F8-r1) → `manual_review`
     + alert.
5. **Claim (F1-r2, F5-r2)** — order-level cancellation claim FIRST for every order: null-first-safe
   transaction stamping a UNIQUE `cancel_claim_id` + `resolving_action='cancel'` +
   `resolving_phase=PHASE.CLAIMED` from an allowed pre-side-effect state; abort (→409) for a loser;
   verify the committed snapshot carries OUR claim id. Reuse the EXISTING `PHASE.CLAIMED`/
   `SIDE_EFFECT_STARTED` (generic — no new enum needed, F2-r2); the cancel is distinguished by
   `resolving_action='cancel'`. An attempt-level side-effect claim is taken ONLY when a resolvable
   attempt exists.
6. **Capture-in-flight — close BOTH callback paths (F2-r1, F1-r3)**: the claim sets the attempt's
   `cancelling:true` AND `cancel_pending:true`. `cancelling` is what `confirmOnlinePayment` checks (a
   concurrent confirm defers); `cancel_pending` is what `pixelpay-hosted-webhook.js:77` checks — so a
   PAID callback landing after the claim but before finalize is **auto-voided by the webhook, never
   materialized**. Without `cancel_pending`, that window re-materializes a cancelled order.
7. **Void (F3/F4-r2)** — only the claim owner, only if `hasCapturedMoneyEvidence && payment_status ∉
   {refunded,refund_pending}`. Stamp `resolving_phase=SIDE_EFFECT_STARTED` durably BEFORE the PixelPay
   call (move the marker into `voidOrRefund` ahead of the external call). Non-`anulada` response →
   `refund_pending`/`manual_review`, never fake `refunded`.
8. **Finalize (F1-r2 — transactions can't span nodes; F2-r3 claim cleanup)**: a transaction on the ORDER
   node re-verifies our claim + attempt + payment state, writes the money-critical `status=cancelled` +
   `payment_status` + `cancelled_at/_by/_reason`, AND **clears the cancel-claim metadata**
   (`cancel_claim_id`, `resolving_action`, `resolving_phase`) so a completed cancel never looks like a
   stale in-flight claim to the recovery sweep. Task cancels + driver release are a SEPARATE idempotent
   best-effort atomic multi-location update (already-cancelled task = no-op; driver release checks
   current_task_id match) — non-money.
9. **Task/driver cleanup backstop (F3-r3, F2-r4)**: the inline update is NOT self-healing on failure
   (existing `onOrderCancelled` only *notifies*, it does not release the driver → a failed inline write
   leaves a driver busy on a cancelled order). Make cleanup durable: idempotently cancel the pickup/
   delivery tasks and release the assigned driver's `current_task_id`/status on status→cancelled. **This
   cleanup MUST run FIRST — never behind `onOrderCancelled`'s `KDS_SHEET_ID` early-return or its Google
   Sheets try/catch (F2-r4).** Executor's choice: reorder the existing trigger so cleanup precedes any
   Sheets/KDS work, OR add a dedicated cancellation-cleanup trigger. The inline update is the fast path;
   the trigger guarantees eventual consistency.
10. **Phase-aware recovery (F3-r1)**: extend the existing stale-resolve reconciler to `resolving_action=
   'cancel'` claims — pre-side-effect stale → safe revert; post-side-effect unknown → `manual_review` +
   alert, NEVER blind re-void.
11. **Honest contract**: 2xx only for genuinely final (`cancelled`+`refunded`, `cancelled` no-money,
    `already_cancelled`); `refund_pending`/`manual_review`/claim-lost → 409 `{outcome}`.

### C. Clients — migrate ALL THREE surfaces (F9-r2)
1. New `cancelOrderRemote(orderId, reason)` in each bundle's xpizza-delivery.js (mirror
   `resolveReconciliation`: functionUrl('cancelPaidOrder'), getIdToken, Bearer POST, `err.outcome` on
   non-ok). `confirmCancelOrder` (and the dashboard/driver equivalents) call it for ALL orders; **disable
   the per-order cancel until it settles (F12-r1)**; toast the real outcome.
2. RETIRE the direct-RTDB `cancelOrder` in dispatch/dashboard/driver once no non-money caller remains
   (audit complete: only these cancel UIs call it). Driver-initiated cancel, if it exists, gets the same
   server path — flag any driver-cancel policy question to the owner before wiring.
2b. **Dashboard parity (F5-r3)**: `xpizza-dashboard/index.html:1704` already calls `cancelPaidOrder` but
   ONLY for `online && confirmed && !cancelled`. Broaden it to route ALL orders (cash + online +
   heal-already-cancelled-paid) through the universal endpoint — remove the narrow guard so dashboard and
   dispatch share one cancel semantics. Include in the client checklist/tests.
3. pending_payment orders are filtered out of the dispatch list (d0e236d) so there's no UI to cancel one
   by id — server SUPPORTS it; a pending-payment cancel surface is a separate, out-of-scope item.

## Key decisions & tradeoffs
- **Generalize cancelPaidOrder in place** (not a new fn) → zero-prune 31→31, no endpoint migration.
- **One uniform path, void gated on captured-money evidence** → no cash/online client branch to
  misroute; cash/card_delivery degrade to a plain finalize.
- **Tight `hasCapturedMoneyEvidence` for the void gate**, broad `hasPaidEvidence` only to route ambiguity
  to manual_review → declined-auth UUIDs never trigger a void.
- **Order-node transaction for money/status; best-effort idempotent tasks/drivers** → respects RTDB's
  single-node transaction limit while keeping money atomic.
- **manual_reconciliation/resolving_* never travel the cancel money logic** → no duplication of the
  recon panel's refund path.

## Risks / open questions
- Driver-app cancel: does the driver bundle actually expose a cancel UI, and should drivers be allowed to
  cancel paid orders at all? (owner policy — may narrow C.2.)
- `card_delivery` is DORMANT (owner: not used now — only `cash` + `online`). No special handling: the
  uniform evidence-gated path treats it exactly like cash (no captured money → no void → plain
  finalize), and would safely cover it via `hasCapturedMoneyEvidence` if ever re-enabled. Not a blocker.
- Fold cancel-claim recovery into the existing stale-resolve reconciler vs a new sweep (executor's call
  at build, emulator-proven either way).

## Out of scope
- Refunding historical stranded orders beyond the recovered L251.
- A pending-payment cancellation UI surface.
- Renaming the cancelPaidOrder endpoint (alias later).

## Build discipline (executor, post-approval)
Pure `cancel-order.js` + goldens; deps-injected wiring; emulator F-matrix: two concurrent cancels → one
voids/one 409/single terminal; heal already-cancelled-paid; cash & card_delivery no-money finalize;
delivered → 409; missing-attempt-but-paid → manual_review; UUID-only/declined → manual_review (no void);
void anulada→refunded, 412/false/throw→refund_pending; capture-in-flight defers; recovery pre/post phase.
Gated **31→31 zero-prune** server deploy + clients via Netlify git-CD. Owner runs the prod deploy.
