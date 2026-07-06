# Scheduled Orders — propose-first design (Step 1)

_rev-3 (Codex R1+R2 folded, APPROVED R3, thread 019f386b). Advisor-authored, NOT built. Governance: advisor designs +
Codex-gates; executor builds; owner runs prod. Enables customers to place orders during CLOSED hours (and
"order for later" while open), HELD off the kitchen until their slot. Owner-confirmed: pickup+delivery
both; closed-at-release = hold+alert._

## Problem
Both order forms hard-block when closed (`isOpen()` false → `closed-overlay`) → zero orders captured
outside hours. The existing "Schedule pickup" UI is a SOFT label (`pickup_time`) that still materializes
immediately. Naively lifting the block fires real orders onto a DARK kitchen (no cook/driver; card charged
for food nobody makes). Capture that demand safely.

## Goal
A customer places a scheduled order for a future open slot; it is HELD — invisible to kitchen/dispatch/
driver/tracker, no factura, no assignment, no notifications — until ~prep-lead before its slot, when it is
RELEASED into the normal live flow exactly as if placed then. Zero change to ASAP-order behavior.

## State machine (the money-safe spine — mirrors the shipped atomic-claim/reversal discipline)
```
CASH:    createOrder ──► scheduled ─────────────[release claim]──► releasing ──► new (live)
ONLINE:  createOrder ──► pending_payment ──(pay+confirm HOLD)──► scheduled ──[release claim]──► releasing ──► new
                                                    │ (paid, held; NOT materialized)
cancel (any held state) ──► cancelled  (online → cancelPaidOrder reversal machine refunds)
closed/invalid @release ──► stays scheduled + `scheduled_blocked:true` + dispatcher alert (owner: hold+alert)
```
`scheduled` and `releasing` are BOTH non-live. Live materialization (status:new + materialized_at + tasks +
tracking) happens ONLY at release, by exactly one claim owner.

## Approach

### A. Non-live status across ALL surfaces (R1-#3, #13)
- Add `SCHEDULED:'scheduled'` (+ `RELEASING:'releasing'`) to `NON_LIVE_ORDER_STATUSES`. **This set is COPIED
  in 4 bundles** — order-filter.js (KDS), xpizza-dispatch/dashboard/driver xpizza-delivery.js (~:106-108).
  Update ALL FOUR, or (preferred) dedupe to one shared status module first. Otherwise dispatch/dashboard/
  driver leak held orders.
- **No `tracking_token`/`order_tracking` until release** (R1-#13): `sendOrderStatusNotifications` mirrors
  every status→order_tracking if a token exists, and the public tracker reads order_tracking directly. So a
  held order must have NO tracking token created, and the notifier must skip non-live statuses. Create the
  token + first tracking state at release.
- **Paid-return UX must not claim "in the kitchen" (R2-#4):** `paymentStatus` returns `state:'paid'` for any
  `payment_status:'confirmed'` even with null tracking_token, and both forms then show "ya está en cocina".
  A paid SCHEDULED order would falsely tell the customer it's cooking. Add a `scheduled_paid` paymentStatus
  state (confirmed + status:scheduled + no token) carrying `scheduled_for`; both forms show a **scheduled
  confirmation** ("programado para <slot>") with NO kitchen/tracker claim until release.

### B. createOrder — write held, zero live side-effects (R1-#4)
- **Cash scheduled** → branch BEFORE `buildCreateOrderUpdates`; write ONLY the held order record
  (`status:'scheduled'`, scheduled_for, release_at, no tasks, no tracking, no order-received WhatsApp). Send
  a distinct "pedido programado" confirmation message instead (optional v1).
- **Online scheduled** → the existing writer creates `pending_payment` (+ scheduled_for/release_at) → pay →
  `confirmOnlinePayment`. **NEW hold-confirm path** (R1-#1): a `confirmAndHoldScheduled` that sets
  `payment_status:'confirmed'` + `scheduled_confirmed_at` but does NOT set `materialized_at`, tasks, or
  tracking, and leaves `status:'scheduled'`. `confirmAndMaterialize` stays live-only.
- **`materializeOnConfirm` gated to `status:'pending_payment'` ONLY** (R1-#2) — today it fires on
  payment_status:confirmed + no materialized_at + non-cancelled; a paid scheduled order matches that and
  would auto-release. Restrict it so it never touches `scheduled`.
- **Fingerprint must bind the slot (R2-#3):** `orderFingerprint(orderId, total_cents, items_text)` today
  ignores fulfillment time, so retry/reuse could bind the SAME cart to a DIFFERENT slot's pending order.
  Include `scheduled_for` (+ fulfillment type) in the immutable fingerprint, OR reject an existing pending
  order whose stored slot differs from the submitted slot.
- Server RE-VALIDATES scheduled_for at create AND confirm (see F).

### C. Release — atomic-claim sweep (`onSchedule` ~2 min) (R1-#5, #6, #8, #9)
- **Query shape (R1-#9):** RTDB has no compound index; query `status=='scheduled'` (indexed) and filter
  `release_at <= now` in memory (bounded volume) — or maintain a `/scheduled_order_releases/{r}/{ts}_{id}`
  queue if volume grows.
- **Claim (R1-#5, #6):** transaction on `orders/{id}` from `scheduled → releasing` stamping a unique
  `release_claim_id` (null-first-safe, per the shipped pattern); abort if not `scheduled`, or
  `resolving_action:'cancel'` present, or `active_attempt_id` mismatch (cancel/confirm race). Only the claim
  owner performs the live materialization; verify the claim landed before/after.
- **Materialize:** the claim owner does `releasing → new` via the LIVE materialize (reuse
  buildMaterializeUpdates → autoAssign/factura/tracking/notifications all fire now, as if placed now).
- **Recovery (R1-#8):** the same sweep recovers stale `releasing` claims (claim older than a threshold →
  re-drive or alert) and alerts when `now > scheduled_for` (missed window) or `now > release_at + SLA` — a
  paid order can never sit forever.
- **Skip already-blocked (R2-#1):** the release query MUST exclude `scheduled_blocked === true` (else every
  sweep re-alerts a blocked order). A blocked order only re-enters the sweep after a dispatcher clears the
  flag via the override function (D).

### D. Closed-at-release — HOLD + ALERT + audited manual release (owner-confirmed; R1-#10, R2-#1, R2-#2)
- At release, re-validate open hours + slot validity SERVER-SIDE. If closed/invalid → do NOT materialize;
  set `scheduled_blocked:true` + `blocked_reason` + raise a dispatcher alert (reuse `paymentAlert`/
  dispatcher surface). Never auto-refund, never dump onto a closed kitchen.
- **Manual release goes through the SAME single-claim materialization, never a raw status write (R2-#2):**
  add an audited **dispatcher-only `releaseScheduledOrder` function** — it clears `scheduled_blocked` and
  runs the identical release claim (scheduled→releasing→new via buildMaterializeUpdates), so tasks/tracking/
  factura are created correctly. A dashboard direct edit of `status` to `new` is FORBIDDEN (would skip the
  materialize shape). The dispatcher's other options (contact customer, refund) use cancelPaidOrder.

### E. Reconciliation + payment SLA (R1-#7, #14)
- **`reconcilePayments` must know paid-scheduled is valid** (R1-#7): a verified-paid `status:'scheduled'`
  order is legitimate until `release_at`; do NOT flag it by charged_at age. Beyond `release_at + SLA` (still
  unreleased) → `scheduled_release_overdue` alert.
- **Service-window SLA (R1-#14):** captured-now money with no service is a liability. Past `scheduled_for +
  grace` (never released/served) → auto-alert; past a hard deadline → dispatcher must refund (cancelPaidOrder
  reversal) or release, with audit. Define grace/deadline as config.

### F. Server-authoritative hours + slot validation (R1-#10)
- Move HOURS + open/closed + slot generation into a SERVER helper (per-restaurant config, Honduras UTC-6
  local calendar math, MIN_LEAD, MAX_HORIZON, 15-min granularity, slots only within open windows). Validate
  scheduled_for at **create, confirm, AND release** (reject past/stale/out-of-window). The client form's
  HOURS/isOpen stays for UX only; the server is authoritative. (Client + server share the same config source.)

### G. Order form (both restaurants)
- `!isOpen()` → replace the dead `closed-overlay` with an "order for later" slot picker fed by the server-
  validated slots. Also offer "order for later" while open. Reuse the schedule-sheet scaffolding but wire a
  REAL `scheduled_for` submission (not the soft `pickup_time`).

### H. Delivery-at-release supply (R1-#11)
- Owner-confirmed delivery is schedulable. Because many scheduled orders can release in the same minute
  (worse than organic live load): **v1 adds release JITTER** (spread releases over a few minutes) + an alert
  when a scheduled delivery releases with no eligible driver. Per-slot delivery CAP is v2.

### I. Factura timing (R1-#12)
- Sale/allocation fires ONLY at `status:'new'`. A paid-scheduled order MUST keep `factura_status:'not_due'`
  with no allocation until release; a scheduled cancellation owes no factura. Golden/emulator tests prove it.

## Key decisions & tradeoffs
1. **Payment captured at order time** (recommended) — reuses pending_payment→confirm; money secured;
   refund-on-cancel is the shipped cancelPaidOrder path. Charge-at-release (stored creds + release-time
   charge + failure handling) is far riskier — rejected for v1. SLA (E) covers the capture-now liability.
2. **Both pickup + delivery — ✅ owner-confirmed** (H covers the supply risk).
3. **Release lead = per-restaurant constant v1**; ready-time-predictor-driven v2 (ties to Phase-1, now live).
4. **Closed-at-release = HOLD + ALERT — ✅ owner-confirmed** (D).
5. **`scheduled`+`releasing` are non-live everywhere**; live materialization is release-only, single-claim.

## Risks / open questions
- Timezone/calendar correctness (UTC-6, no DST) across client + server + release re-validation — one shared
  helper (F) is the mitigation.
- Editing a placed scheduled order — out of scope v1 (cancel + re-order).
- Volume: in-memory release_at filter is fine at current scale; graduate to the release queue (C) if it grows.
- Delivery burst supply beyond jitter — per-slot cap deferred to v2 (H).

## Out of scope (v1)
Predictor-driven release lead; customer scheduled-ETA display; editing a scheduled order; per-window
capacity caps.

## Gate flow
propose-first (this doc) → Codex adversarial design gate → owner sign-off → executor build → advisor
read-only + emulator F-matrix (held-not-live on ALL surfaces; hold-confirm doesn't materialize;
materializeOnConfirm ignores scheduled; atomic release claim + double-release/cancel-race idempotency;
closed-at-release hold+alert; online paid-held→cancel refunds; reconcile leaves paid-scheduled valid till
release_at then alerts; factura not_due till release; server slot validation UTC-6/bounds; recovery of
stale releasing + overdue) + Codex-on-diff → gated deploy (functions ADD + all-4-client git-CD).

## Open questions for the gate
1. ✅ RESOLVED — v1 fulfillment = pickup + delivery both (owner).
2. ✅ RESOLVED — closed-at-release = hold + alert dispatcher (owner).
3. MIN_LEAD / MAX_HORIZON / slot-granularity / release-jitter / SLA grace+deadline starting values.
