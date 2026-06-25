# Factura allocation fires at the Sale moment (createOrder + materialize), and fails closed on range exhaustion

**Status:** accepted (2026-06-25)

## Context

Honduras law requires a [[Factura]] for every [[Sale]]. The original handoff
(`FACTURA_INTEGRATION_HANDOFF.md`, pre-PixelPay) hooked allocation into a single path —
`createOrder` — and on any failure did `console.error` and nothing else ("orders take
priority over fiscal documents").

Two facts from the live code break that:

1. There are **three** [[order-creation path]]s, not one. `createOrder` only handles
   `cash`/`card_delivery`. Online card Sales go `chargeOnlineOrder` (writes a hidden
   `pending_payment` Order) → `confirmOnlinePayment`/`materialize` (promotes to live after
   capture). Hooking only `createOrder` would leave **every online Sale with no factura**.
2. `console.error`-and-forget means a transient RTDB blip silently produces a completed
   Sale with no fiscal document and no record that one is owed — a compliance hole.

Separately, La Musa's external POS has for years handled range exhaustion by **printing the
next number anyway** (095 → 096), i.e. issuing fiscally-invalid numbers that get reconciled
later. We had to decide whether to copy that.

## Decision

- **Allocation fires from ONE DB trigger** (`allocateFacturaOnSale` on `/orders/{orderId}`,
  mirroring the existing `materializeOnConfirm`) that runs when an Order becomes a [[Sale]]:
  `status:'new'` AND (`payment_method != 'online'` OR `payment_status:'confirmed'`) AND not
  already issued/cancelled. One trigger uniformly covers `cash`/`card_delivery`, **every**
  online materialize route (`confirmAndMaterialize`, `resolveManualReconciliation`,
  `materializeOnConfirm`), and the dispatcher direct-create path — so no individual code
  path needs a hook, and `createOrder`'s early-idempotent-return cannot leave a Sale
  unissued. Online Sales are issued only post-capture; `pending_payment` carts
  (`factura_status:'not_due'`) are never issued, so abandoned/declined cards burn no number.
- **`allocateFacturaNumber` is race-safe and idempotent:** Phase A claims
  `/facturas/{rid}/{orderId}` by transaction (existing record ⇒ return, no new number);
  only the winner runs Phase B. The factura node carries an explicit `state`
  (`claim|reserved|issued|failed`); **only `issued` counts as idempotent success** — a stale
  `claim`/`failed` stub is reclaimable, so a fail-closed abort never masquerades as an
  existing factura.
- **Number assignment is concurrency-safe and crash-atomic.** Phase B is one transaction on
  the sequence node `{ last_reserved, pending:{} }` that, in the SAME transaction, advances
  the single monotonic high-water counter `last_reserved = last_reserved + 1` AND records
  `pending[orderId] = last_reserved`. Because the counter moves inside the transaction, two
  concurrent allocators can never read the same value or reserve the same number; the number
  is tied to its order before any separate write. A reserved number is **permanently
  consumed** — `last_reserved` is never moved backward and numbers are never reused; the
  reconciler reconciles each orphaned `pending[orderId]` to a terminal audit record
  (issued/void/abandoned). No number is ever consumed without an audit trail tying it to an
  order.
- **Cancelled-before-issuance gets no factura; cancelled-after-issuance is voided.** A
  factura documents a consummated Sale, so an Order cancelled before its number is issued is
  handled as a plain cancellation — no number reserved (`factura_status:'cancelled'`). This
  holds across payment types: cash/`card_delivery` collect money at delivery (after the
  factura would print), and a paid `online` Order cancelled is refunded by `cancelPaidOrder`.
  Only an **already-issued** number is `void:true` (a consumed SAR number can't be
  un-issued); a number race-issued into a just-cancelled Order is likewise voided. (Domain-
  owner rule; to be confirmed with Honduran fiscal counsel — if a pre-issuance cancellation
  is deemed a reportable Sale, switch to issue-and-void.)
- **The customer is never blocked**, but failure is never silent. Every Order carries
  [[Factura status]], defaulted to `not_due` at order write; the allocation trigger sets
  `pending` → `issued` once the order is a Sale (so `pending_payment` carts are never
  reconciled as owed). Failures stamp `failed` + reason. A scheduled reconciler (mirroring
  `refundReconciler`), filtered to Sale state, retries and re-issues.
- **Fail closed on exhaustion / past `fecha_limite`:** the allocation transaction refuses
  to issue a number past `range_end` or after the expiry date. It never prints an invalid
  fiscal number. This is the *opposite* of La Musa's over-range practice.
- **Proactive renewal is the primary defense:** low-range and near-expiry alerts fire well
  before the range ends, so a fresh CAI is loaded in time and fail-closed is only ever a
  last-resort safety net. Principle: *never run out of valid facturas.*

## Considered options

- **Copy La Musa (print over-range anyway).** Hands the customer a document immediately,
  but the number is fiscally invalid and creates audit liabilities. Rejected: a delayed-but-
  valid factura (pending → auto-issued on renewal) beats an immediate-but-invalid one.
- **Block the order when a factura can't be issued.** Rejected: an RTDB blip must not cost a
  Sale; the customer-facing order must survive.

## Consequences

- `factura_status` becomes the queryable source of truth for "which Sales lack a factura."
- Allocation lives in ONE DB trigger calling one idempotent helper; the helper, not any
  caller, owns the reservation transaction and the range/expiry guards. The trigger predicate
  is narrow — Sale state (`status:'new'` + online-capture-confirmed) AND
  `factura_status in [not_due,pending,failed]` AND a launch-cutoff timestamp — so legacy
  pre-launch orders are never retro-issued. **Required fiscal-field presence is checked
  *inside* the handler, not in the predicate** (an order missing them is marked `failed` +
  alerted, never silently excluded).
- Operational dependency: someone must act on low-range / near-expiry alerts. If ignored
  long enough, Sales complete with `factura_status: pending` (recoverable) rather than with
  invalid numbers (not).
