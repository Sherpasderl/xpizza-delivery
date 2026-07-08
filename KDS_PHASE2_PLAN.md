# Plan: KDS Phase 2 — full-Square paradigm + item-86 + pickup-ready notify

_Design synthesis, 2026-07-07 (Claude + Xavier), grounded in the Square KDS video/transcript + Xavier's live annotated frames + Codex Round 1. Follows [[kds-redesign]] Phase 1 (SHIPPED). Governance: this session designs; grill+Codex gate; executor builds; advisor gates; owner deploys._

## Goal

Move the KDS from Phase 1's **3-status-column** model to **Square's interaction paradigm**: one flat **Open** pool of stationary tickets, progress tracked *inside* the ticket (explicit start + per-item check), an **Open/Completed** tab model with **recall**, a **left sidebar** (all-day + item availability), **flex-rail + pagination**, plus two cross-surface capabilities — **86 / item availability** (KDS→order form) and a **pickup-ready WhatsApp** (functions). Keeps all Phase-1 visuals.

## The lifecycle contract (the load-bearing rule — Codex R1 #1-3,16)

**The KDS writes ONLY `/orders/{id}/status`, and only via `XPD.setOrderStatus`.** It never writes `order_timelines` — `preparing_at`/`ready_at` are **server instrumentation** stamped by `logOrderLifecycle` on the status transition (index.js). The ready-nudge + ready-time predictor anchor on that server `preparing_at`; the KDS must not create a second writer or drift it.

- `preparing_at` comes from the **first** `→preparing` transition (triggers skip `before===after`), so a missing timeline is **NOT** repairable by re-tapping — repair is server/admin out-of-band only.
- **Completed / bump / recall is a KDS-LOCAL concept** (same pattern as today's `Archivado`: local state, no Firebase status write). **Recall never reverts `/orders.status`** after `ready` (else tracking regresses + `order_events` bounces).

## Per-ticket state model (replaces the columns)

Ticket lives in the flat **Open** pool; state is a per-ticket property changed by deliberate actions:

| KDS state | Action | Effect |
|---|---|---|
| **NUEVO** | lands on board | `status:new`; big **"Empezar"** affordance (large target, misclick-resistant) |
| **EN PREPARACIÓN** | tap **Empezar** | `XPD.setOrderStatus(id,'preparing')` **only** → server stamps `preparing_at`. Card flips to preparing look **only after the write resolves** (optimistic tap → pending state → rollback on failure; never look preparing while the write failed) |
| *(per-item ✓)* | tap item → spinner → grey+✓ | **LOCAL ephemeral, NON-authoritative** visual progress. Does NOT write status; **never auto-fires ready.** May only enable/highlight the explicit Listo button. Un-checkable |
| **LISTO / bump** | tap top-bar **"Listo"** (always explicit) | `setOrderStatus(id,'ready')` — **commit the local bump ONLY after the write resolves** (failure → visible error/retry, never hide the ticket). Then band Completing→Completed → local-bump to Completed tab. **Pickup → WhatsApp** (2c) |
| **RECALL** | Completed tab → "Recall ticket" | local un-bump back to Open. **No `/orders.status` write.** Single-station: no expeditor/all-stations dialog |
| **CANCELADO** | (server) | stays visible in Open pool with strong **stop-cooking** treatment until acknowledged/archived (preserve the stop-prep signal the columns gave) |

**Confirmed-write rule (Codex R2 #2,3):** every local state transition (preparing look, ready/Completed bump) commits **only after its `setOrderStatus` write resolves**; a failed write shows a visible error/retry and never diverges the local UI from canonical `/orders.status`. Item checks are the sole exception (purely local, non-authoritative).

Ready is **explicit** (Listo tap), never auto-derived from ephemeral local per-item state. Band precedence: **completed > completing > cancelado > listo > scheduled-pre-slot > aging(fresh/warn/late)**.

## Data-source & rendering invariants (Codex R1 #7-10)

- **All tabs (Open + Completed) source ONLY from `subscribeToOrders(filterLiveOrders(...))`** — never raw `/orders`. Scheduled/`releasing`/`pending_payment` exclusion stays centralized in `order-filter.js`. Golden test: those stay excluded from both tabs.
- **`renderItems` preserved byte-for-byte** (bracket-aware extras, red `↳`, `Pizza N:`/`todas`). Per-item checkbox boundaries use the **bracket-aware parser** (reuse/extract `rail-count.js`'s splitter, tested) — never naive `split(' | ')`.
- **Aging + nudge eligibility computed over the FULL filtered set**, not just mounted DOM cards — so a ticket on page 2 still crosses warn/late on time. Surface an **off-page late/overdue count** in the pager.
- **Scheduled aging anchor `released_at || created_at`** is a **golden test** (rendered elapsed + band class) — flex-rail/pagination must not regress it to `created_at`.

## Sub-phases (Phase 2 outgrows Phase 1's client-only scope)

**2a — KDS interaction paradigm (client-only).** Flat Open pool; NUEVO→Empezar→preparando→per-item ✓→explicit Listo→ready/local-bump; Open/Completed tabs; recall (local); prioritize (`↑≡`→"Prioritizado", reorder only); flex-rail + pagination; left sidebar (all-day + click-highlight). Writes **only** `new`/`preparing`/`ready` via `XPD.setOrderStatus` — lifecycle contract unchanged, only UI/interaction changes. Regression tests: both host classifiers + La Musa guarded write.

**2b — 86 / item availability (KDS + order form + Firebase).** Prerequisites first:
1. **X Pizza order form must send a stable menu `id`** on each structured item (La Musa already does; X Pizza sends name/qty only today) — pricing-validation-compatible.
2. **Shared per-restaurant menu manifest** consumed by BOTH the KDS availability panel and the order forms (no duplicated menu data).
3. Availability stored at **`/restaurants/{restaurantId}/item_availability/{menuItemId}`** (per-restaurant, host/order-derived — never a global `/availability/{itemId}`).
4. **Server fail-safe, in the SHARED intake path (Codex R2 #4):** availability validation lives in the shared order-intake validate/build path used by **all** routes — cash `createOrder`, online `chargeOnlineOrder`, AND pending-payment materialization — so a paid online cart can't bypass 86. A line is rejected **only** on an explicit `available === false` read for that restaurant+item; **missing flag or read error ⇒ available** (never block sales on error).
5. **RTDB rules + emulator tests (Codex R2 #6):** `/restaurants/{rid}/item_availability/**` — KDS staff may write **only their own restaurant's** subtree; order forms read fail-safely; cross-restaurant writes denied.
Then: a KDS "Disponibilidad" panel toggles items agotado/available → shows in the sidebar + disables the item on the order form.

**2c — pickup-ready notification (functions).** On `after === 'ready' && order.order_type === 'pickup'`, send the customer a WhatsApp "listo para recoger" via the per-restaurant UltraMsg instance. **Durable at-most-once — mark-before-send, never auto-reclaim (Codex R3):** transactionally set a durable `/order_notifications/{orderId}/pickup_ready_claimed_at` (abort if already claimed/sent) **before** calling UltraMsg → send → set `pickup_ready_sent_at`. **No automatic stale-claim reclaim.** A claim without a matching `sent_at` (crashed after UltraMsg accepted but before the mark — rare, and UltraMsg has no idempotency key) is **NOT auto-resent** — it surfaces as a logged / dispatcher-visible "pickup-ready unconfirmed" for **manual** retry. Rationale: a **duplicate** "listo para recoger" to a customer is the failure mode we refuse; a missed send is rare and manually recoverable. Marker **never cleared on recall** → recall→re-ready never re-sends. Strictly no task/factura/driver/money writes; delivery + existing notify paths untouched.

## Keep from Phase 1 (do not regress)
Hanken font, dark board / white tickets, aging bands, scheduled gold identity + slot line + `released_at` anchor, red `↳` extras (`renderItems` verbatim), all-day make-count, `prefers-reduced-motion`, host-agnostic (`KDS_RESTAURANT_ID`/`applyKdsBrand`, one folder both restaurants), the dispatch/driver scheduled badge.

## Explicitly SKIP
Multi-station routing (Line/Expo) + the recall expeditor/all-stations dialog, coursing, printer-on-complete (we have the factura printer), per-device settings, layout-mode toggles (pick one: flex-rail responsive), POS-vs-online + dining-option source filters, ingredient/topping-level 86 (deferred).

## Already ahead of Square (validation, nothing to build)
Scheduled/future orders — Square's "show 15 min before pickup" is a client display filter; ours is a **server-authoritative held→materialize release sweep** (slot − 30 pickup / 60 delivery). Possible low-priority add: user-editable lead.

## Risks / open questions for the gate
- Confirm **no KDS write to `order_timelines`** anywhere (test).
- Recall after a pickup-ready send: **no re-notify** on re-ready (the durable marker guarantees it).
- Per-item completion: **local ephemeral, non-authoritative** (chosen); durable per-item deferred (would need canonical item-id keying).
- 2b sequencing: the X Pizza item-id + shared-manifest prerequisites must land + be verified before availability is enforced; keep pricing/idempotency byte-compatible (see [[lamusa-integration-plan]] server re-pricing).
- Cancel treatment in the flat pool must be unmissable (stop-cooking) yet not block the board.

## Out of scope
Phase-1 items (shipped); the assignment engine; the ready-time predictor itself (Phase 2 only feeds it clean `preparing_at`); anything under SKIP.

## Next
Finish the Codex gate → sub-phase 2a/2b/2c, each its own build + advisor gate + owner deploy.
