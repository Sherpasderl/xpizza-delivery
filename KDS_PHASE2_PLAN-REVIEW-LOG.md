# Plan Review Log: KDS Phase 2 — full-Square paradigm + item-86 + pickup-ready notify
Started 2026-07-07 (session). MAX_ROUNDS=3. PLAN_FILE=KDS_PHASE2_PLAN.md.
Codex read-only every round. Bigger/cross-surface plan (retires columns; touches functions + order form).

## Round 1 — Codex
**Material Flaws**

1. `preparing_at` is not a client stamp today. KDS writes only `/orders/{id}/status` ([xpizza-kitchen/index.html](/Users/xavierlacayo/xpizza-lamusa/xpizza-kitchen/index.html:1451)); `order_timelines/{id}/preparing_at` is first-entry server instrumentation on status transition ([xpizza-functions/index.js](/Users/xavierlacayo/xpizza-lamusa/xpizza-functions/index.js:2627)). The plan’s “Empezar stamps `preparing_at`” invites a second writer and timestamp drift.
Fix: Empezar must only call `setOrderStatus(id, 'preparing')`; leave timeline stamps exclusively to `logOrderLifecycle`, with tests proving no client write to `order_timelines`.

2. Rewriting `preparing` when already `preparing` will not repair a missing `preparing_at` because both status triggers skip `before === after` ([xpizza-functions/index.js](/Users/xavierlacayo/xpizza-lamusa/xpizza-functions/index.js:2428), [xpizza-functions/index.js](/Users/xavierlacayo/xpizza-lamusa/xpizza-functions/index.js:2597)), and ready-nudge fails closed without it ([xpizza-kitchen/ready-nudge.js](/Users/xavierlacayo/xpizza-lamusa/xpizza-kitchen/ready-nudge.js:42)).
Fix: specify that missing timeline repair is out-of-band/admin/server-only, not a KDS re-tap side effect.

3. Recall is underspecified and can corrupt customer-visible lifecycle. If recall writes `ready -> preparing/new`, tracking regresses and `order_events` records a bounce; if it is local-only, KDS Open can disagree with canonical `/orders.status`.
Fix: introduce a separate KDS bump/completed flag for Open/Completed/Recall; recall must not revert `/orders.status` after `ready`.

4. Pickup-ready WhatsApp idempotency is not solved by “once per transition.” Existing trigger ignores `ready` ([xpizza-functions/index.js](/Users/xavierlacayo/xpizza-lamusa/xpizza-functions/index.js:2471)); adding `ready` there would double-send on `ready -> preparing -> ready` recall.
Fix: guard pickup-ready send with a durable transactional marker such as `/order_notifications/{orderId}/pickup_ready_sent_at`, and never clear it on recall.

5. Pickup-ready scope can easily leak into delivery and existing driver/money paths. The current trigger also mirrors tracking for every status and sends delivery/cancel messages from the same function.
Fix: add a narrowly gated branch: `after === 'ready' && order.order_type === 'pickup'`, no task writes, no factura writes, no driver notification changes.

6. Per-item completion persistence is a lifecycle risk. Local-only checks disappear on reload and differ across tablets; Firebase checks can become stale if keyed by rendered index while `items_text` formatting changes.
Fix: choose one model explicitly; for any auto-ready behavior, persist completion in Firebase keyed by canonical line id/item id, not DOM index or parsed display text.

7. Item checks may break `renderItems` extras. Current KDS relies on verbatim `renderItems(order.pedido)` with bracket-aware extras and red `↳` rendering ([xpizza-kitchen/index.html](/Users/xavierlacayo/xpizza-lamusa/xpizza-kitchen/index.html:1429)); rail parsing explicitly warns against naive `itemsText.split(' | ')` ([xpizza-kitchen/rail-count.js](/Users/xavierlacayo/xpizza-lamusa/xpizza-kitchen/rail-count.js:1)).
Fix: preserve `renderItems` output byte-for-byte or extract its parser under tests before adding checkboxes.

8. Flat pagination can hide overdue behavior. Current aging tick only mutates mounted DOM cards ([xpizza-kitchen/index.html](/Users/xavierlacayo/xpizza-lamusa/xpizza-kitchen/index.html:1559)); ready-nudge also has DOM-miss behavior, so off-page tickets may not alert when they cross threshold.
Fix: compute aging/nudge eligibility over the full filtered order set and surface off-page late/overdue counts in pagination/rail.

9. Scheduled filtering is easy to regress. Non-live `pending_payment`, `scheduled`, and `releasing` are centrally excluded in `filterLiveOrders` ([xpizza-kitchen/order-filter.js](/Users/xavierlacayo/xpizza-lamusa/xpizza-kitchen/order-filter.js:15)); a new Completed tab must not re-read raw `/orders`.
Fix: keep all KDS tabs sourced only from `subscribeToOrders(filterLiveOrders(...))`, with tests for scheduled/releasing exclusion.

10. Scheduled aging anchor is load-bearing. Released scheduled cards use `released_at || created_at` ([xpizza-kitchen/index.html](/Users/xavierlacayo/xpizza-lamusa/xpizza-kitchen/index.html:1677)); flex-rail/pagination refactors can easily regress to `created_at`.
Fix: make `released_at` anchoring a golden test for rendered elapsed time and band class.

11. 86 propagation lacks a canonical menu-id contract for X Pizza. La Musa sends item ids in `currentOrder.items` ([la-musa-orders/index.html](/Users/xavierlacayo/xpizza-lamusa/la-musa-orders/index.html:2681)); X Pizza currently sends name/qty only, no menu id ([xpizza-orders/index.html](/Users/xavierlacayo/xpizza-lamusa/xpizza-orders/index.html:2227)).
Fix: add stable `id` to X Pizza structured `items` before using availability flags, and keep pricing validation compatible.

12. 86 cannot rely on duplicated KDS menu data. The KDS currently only receives `items_text`, while order forms own their `MENU` arrays.
Fix: create a shared per-restaurant menu manifest or generated availability list consumed by both KDS and order forms.

13. 86 fail-safe is incomplete without server behavior. Client-only disable does not stop stale tabs; server-side rejection can accidentally block sales on availability read errors.
Fix: server accepts unless it can read an explicit `available === false` for that restaurant/item; read error or missing flag means available.

14. 86 scoping must be per restaurant. A global `/availability/{itemId}` risks cross-brand collisions and accidental La Musa/X Pizza blocking.
Fix: store under `/restaurants/{restaurantId}/item_availability/{menuItemId}` and derive `restaurantId` from host/order context.

15. Retiring columns loses cancellation placement semantics. Today cancelled orders preserve prior local column so cooks know whether to stop prep ([xpizza-kitchen/index.html](/Users/xavierlacayo/xpizza-lamusa/xpizza-kitchen/index.html:1654)).
Fix: define cancel rendering in the flat pool explicitly: cancelled active tickets stay visible in Open with strong stop-cooking treatment until acknowledged/archived.

16. Host-agnostic KDS can regress during the refactor. Current `KDS_RESTAURANT_ID` and La Musa write guard prevent stale La Musa tabs from mutating X Pizza orders ([xpizza-kitchen/xpizza-delivery.js](/Users/xavierlacayo/xpizza-lamusa/xpizza-kitchen/xpizza-delivery.js:304)).
Fix: keep status writes through the existing `XPD.setOrderStatus` path and add regression tests for both host classifiers and La Musa guarded writes.

VERDICT: REVISE
### Claude's response (Round 1) — ACCEPTED all 16
- (1,2) preparing_at is SERVER instrumentation (logOrderLifecycle on status transition), not a client stamp → Empezar ONLY calls setOrderStatus(id,'preparing'); KDS never writes order_timelines; missing-timeline repair is server/admin out-of-band, not a re-tap.
- (3,15) Completed/bump/recall = KDS-LOCAL flag (same pattern as today's 'Archivado', local-only, no Firebase status write); recall NEVER reverts /orders.status after ready (no tracking bounce / order_events regression). Cancelled tickets stay in the Open pool with strong stop-cooking treatment until acknowledged/archived (preserve the stop-prep semantics the columns gave).
- (4,5) pickup-ready guarded by a durable transactional marker /order_notifications/{orderId}/pickup_ready_sent_at (never cleared on recall); branch strictly after==='ready' && order_type==='pickup' — no task/factura/driver/money writes; delivery + existing notify paths untouched.
- (6) per-item checks = LOCAL ephemeral, NON-authoritative visual progress; ready is an EXPLICIT action (Listo top-bar or all-checked-in-session) → setOrderStatus('ready'); no auto-ready from local state. Durable per-item (if ever) keyed by canonical item id, not DOM index / parsed text — deferred.
- (7) renderItems preserved byte-for-byte; per-item checkbox boundaries use the bracket-aware parser (reuse rail-count/extract), tested — never naive split(' | ').
- (8) aging + nudge eligibility computed over the FULL filtered order set (not just mounted DOM); off-page late/overdue count surfaced in the pager.
- (9,10) ALL tabs (Open+Completed) sourced only from subscribeToOrders(filterLiveOrders(...)) — never raw /orders; scheduled/releasing/pending_payment exclusion + released_at||created_at aging anchor become golden tests.
- (11,12,13,14) 86 prerequisites made explicit: (a) add stable menu id to X Pizza structured items (order form) — pricing-compatible; (b) shared per-restaurant menu manifest consumed by BOTH KDS + order forms (no duplicated menu data); (c) store availability under /restaurants/{restaurantId}/item_availability/{menuItemId} (per-restaurant, host/order-derived); (d) server fail-safe: reject a line ONLY on an explicit available===false read; missing flag or read error ⇒ available (never block sales on error).
- (16) all KDS status writes stay through XPD.setOrderStatus; regression tests for both host classifiers (kdsRestaurantFromHost + nudgeRestaurantFromHost) + the La Musa guarded-write path.
- NET: reframes the lifecycle contract (KDS writes ONLY status; timeline is server; completed/recall is KDS-local; status never reverts) and turns 2b (86) into a properly-sequenced cross-surface feature with an id contract + shared manifest + fail-safe.

## Round 2 — Codex
**Remaining Material Flaws**

1. The per-item rule still contradicts itself. The table says `Listo` can happen when “all items ✓ in-session,” but the next line says ready is explicit and never auto-derived from ephemeral checks. Since checks are local/non-authoritative, auto-ready from them can still misfire.
Fix: remove “or all items ✓ in-session”; item checks may only enable/highlight the explicit `Listo` button.

2. Local bump can hide a failed lifecycle write. The plan says `setOrderStatus('ready') → local-bump to Completed`, but does not require awaiting/confirming the Firebase write. If the write fails, KDS hides the ticket while tracking/dispatch/functions never see `ready`.
Fix: only move to Completing/Completed after `XPD.setOrderStatus(id,'ready')` resolves, and show a retry/error state on failure.

3. Same issue exists for `Empezar`. The plan says tap Empezar flips the card to preparing look, but if `setOrderStatus('preparing')` fails, the KDS can locally look preparing while `preparing_at` is never stamped and ready-nudge/predictor fail.
Fix: make Empezar optimistic only with a visible pending/error rollback, or wait for the Firebase status echo before committing local preparing state.

4. 86 server enforcement names only `createOrder`, but online orders use `chargeOnlineOrder`/pending-payment materialization paths too. If availability is checked only in `createOrder`, paid online carts can bypass 86 entirely.
Fix: put availability validation in the shared order-intake validation/build path used by both cash/card-delivery and online checkout, preserving allow-on-read-error.

5. Pickup-ready idempotency marker flow is under-specified. A simple `pickup_ready_sent_at` transaction can either mark before send and suppress a failed message forever, or mark after send and risk duplicate sends on retry/concurrent function instances.
Fix: define the exact transaction protocol, e.g. claim `pickup_ready_state: sending` atomically, send once, then mark `sent_at`, with stale-claim behavior explicitly chosen.

6. Availability writes need rules coverage. The plan adds `/restaurants/{rid}/item_availability/{menuItemId}` but does not say Firebase rules permit KDS staff to write only their restaurant and order forms to read fail-safely.
Fix: add RTDB rules and emulator tests for staff-scoped writes, public/order-form reads, and cross-restaurant denial.

VERDICT: REVISE
### Claude's response (Round 2) — ACCEPTED all 6
1. Removed 'all items ✓ in-session' auto-ready → Listo is ALWAYS an explicit tap; item checks may only enable/highlight it, never auto-fire.
2,3. Confirmed-write rule: local transitions (preparing look, ready/Completed bump) commit ONLY after the setOrderStatus write resolves; failure → visible error/retry; never diverge local UI from canonical status. Item checks are the sole local exception.
4. 86 validation moved to the SHARED order-intake path (cash createOrder + online chargeOnlineOrder + pending-payment materialize) so paid online can't bypass; allow-on-read-error preserved.
5. Pickup-ready now an ATOMIC CLAIM protocol: claim pickup_ready_state=sending (abort if sending/sent) → send → set sent_at+sent; stale sending claim reclaimable (no forever-suppress, no dup); never cleared on recall.
6. Added RTDB rules + emulator tests for /restaurants/{rid}/item_availability: staff write own-restaurant-only, order-form fail-safe read, cross-restaurant denial.

## Round 3 — Codex
One material flaw remains.

The pickup-ready “stale `sending` reclaim” still cannot guarantee once-per-order delivery. If the function claims `sending`, UltraMsg accepts the message, then the function crashes before writing `sent_at`, a later stale-claim reclaim will send the same WhatsApp again. Without an UltraMsg idempotency key, this is not exactly-once.

Fix: choose no-duplicate semantics explicitly: transactionally write a durable `pickup_ready_attempted_at`/`sent_claimed_at` before calling UltraMsg and never reclaim for resend automatically; failures become logged/manual retry only.

VERDICT: REVISE
### Claude's response (Round 3) — ACCEPTED (single finding)
Pickup-ready made explicit AT-MOST-ONCE: durable pickup_ready_claimed_at set BEFORE the UltraMsg call (mark-before-send), then pickup_ready_sent_at on success; NO automatic stale-claim reclaim — a claim without sent_at (crash mid-send, rare; UltraMsg has no idempotency key) surfaces as a logged/dispatcher 'pickup-ready unconfirmed' for MANUAL retry. Rationale: a duplicate customer 'listo' is the refused failure mode; a missed send is rare + manually recoverable. Never cleared on recall.

## Round 4 — Codex (confirming)
No material blockers remain. The plan now preserves the status/timeline contract, keeps recall local, prevents automatic pickup-ready duplicates, covers 86 across all intake paths, and carries forward the Phase-1 rendering/filtering anchors.

Minor editorial cleanup only: the `CANCELADO` row is currently outside the markdown table after the confirmed-write paragraph, but the behavior itself is specified clearly enough.

VERDICT: APPROVED
### FINAL RESOLUTION
APPROVED after 4 rounds (R1 REVISE 16 findings → R2 REVISE 6 → R3 REVISE 1 → R4 APPROVED). Every finding accepted + incorporated; zero unresolved disagreements. Fixed the trivial CANCELADO markdown-row placement. Plan ready to sub-phase (2a client interaction / 2b 86 cross-surface / 2c pickup-ready functions), each its own build → advisor gate → owner deploy.
