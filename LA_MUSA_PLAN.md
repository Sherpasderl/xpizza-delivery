# Plan: Integrate La Musa Gastropub into the X. Pizza Last Mile Delivery platform
_Locked via grill-with-docs — by Claude + Xavier. Terms per CONTEXT.md. ADRs: 0001, 0002._
_Revised after Codex Round 1 (server-side pricing/tax, immutable charge-time snapshot, full-namespace restaurant_id, messaging order-context, observability)._

## Goal

Make the single delivery platform serve two Restaurants — X. Pizza and La Musa Gastropub —
where every Order carries a `restaurant_id` that routes it to the correct hub, KDS, WhatsApp
line, server-side menu/pricing, and (for reporting only) P&L bucket. Both Restaurants are
owned by one Merchant (Sherpa S. de R.L.), so they share one PixelPay account, one driver
pool, and one unified dispatcher console. La Musa has **never launched**, so this is a
*first-time launch on the unified platform*, not a migration or cutover. The integration must
be safe to ship into a platform that has not yet proven itself in production (the 30-day gate
is dropped; launch ASAP), so blast radius is treated as live, not deferred.

## Approach

**Phase 0 — Config plane (foundation; blocks everything).** Per ADR-0002.
1. Create `/restaurants/{x_pizza,la_musa}` in RTDB holding **non-secret identity only**:
   `name`, `hub_lat`, `hub_lng`, `phone`, `whatsapp_instance` (id, not token),
   `whatsapp_enabled` (per-Restaurant kill switch — replaces global `/config/whatsapp_enabled`),
   `hours`, `delivery_radius_km`, `active`, `version`. Seed La Musa (hub `15.50414,-88.03848`;
   Wed/Thu/Sun 17:00–20:45, Fri/Sat 17:00–21:45, Mon/Tue closed; radius 9.66km) and X. Pizza
   (from today's constant). `version` is **monotonic and required on every routing-critical
   edit** (hub/active); a config write missing/not-bumping `version` is rejected/alerted, so
   stale-cache detection and logs stay meaningful.
1a. **RTDB rules for the new node.** `database.rules.json` has `/config` but no `/restaurants`.
   Add `/restaurants`: authenticated read (dispatcher/KDS/functions need it), **dispatcher-only
   write**. (Inter-Restaurant *walling* stays out of scope per ADR-0001; this is just basic
   access control for the new node so it isn't world-open or unreadable.)
2. The lat/lng literal now lives in exactly **one** authored place (the seed). Before deleting
   the in-code `RESTAURANT`/`RESTAURANT_LAT/LNG`, **enumerate and rewrite every consumer**:
   `confirmDeps()` (`index.js:990`), `createOrderWithTasks()`, driver geofence
   (`xpizza-delivery.js:237`), driver UI pickup target (`xpizza-driver/index.html:1760`),
   dispatcher map center/bounds/pins, `materialize.js` task fields. Delete the constant only
   once no consumer references it (or the helper is dead).
3. **Warm cache is TTL/version-bounded.** Cache config with `fetched_at`+`version`.
   `hub_lat/lng` and `active` are routing-critical: serve stale only within a short max-age
   (**concrete TTL = 30s**); past it (or freshness unprovable) → **fail closed** (retryable
   503 + alert), never stamp a possibly-moved hub or accept an order for a deactivated
   Restaurant. Consequence: the `active` kill switch has a **bounded lag of ≤30s** under an
   RTDB read outage — accepted; if an instant intake-stop is ever needed, use an out-of-band
   disable, not just `active=false`.

**Phase 1 — `restaurant_id` + restaurant-aware pricing on all three order-creation paths.**
   Per ADR-0001.
4. Stamp + validate `restaurant_id` in **all three** [[order-creation paths]]: (a) `createOrder`
   (`index.js:550`), (b) `chargeOnlineOrder` → `pixelpay-charge.js` (`acquireOnlineAttempt`),
   (c) `confirmOnlinePayment` → `materialize.js:201`.
5. **[CRITICAL] Server-side menu/pricing becomes restaurant-keyed.** `MENU_PRICES` +
   `computeServerTotal()` (`index.js:151,191`) today only know X. Pizza items and **reject
   unknown items** — so La Musa orders would be rejected outright. Make the server menu/price
   table keyed by `restaurant_id`; `computeServerTotal` validates against the order's
   Restaurant menu. This is a security control (anti price-tampering), not just the form.
6. **Server-side tax becomes restaurant/item-aware.** `priceBreakdownCents()` (`index.js:225`)
   hardcodes ISV 15% inclusive; La Musa has 18% alcohol. Recompute subtotal/tax server-side
   from per-item `tax_rate` keyed by Restaurant; reject client-supplied tax totals.
6a. **Enforce Restaurant hours server-side** in `createOrder` + `chargeOnlineOrder` (today hours
    are seeded in config but only the form checks them — a bypassed/replayed submit could place a
    La Musa order Mon/Tue when it's closed). Validate the order's Restaurant `hours` (from the
    cached config plane); if closed → `400`/closed with a clear next-open time. `hours` is the
    **regular weekly schedule** (low-risk if cache is stale); **ad-hoc/emergency closures use
    `active=false`** (routing-critical, 30s TTL) — consistent with ADR-0002, so hours need not be
    treated as acceptance-critical for freshness.
7. Each path **denormalizes the immutable hub snapshot** (`hub_lat`, `hub_lng`,
   `restaurant_name`, `restaurant_phone`) onto the order/tasks. For online orders the snapshot
   is stamped on the `pending_payment` order at **charge time**; `materialize` reuses only that
   snapshot and never re-reads config (per ADR-0002 — no auth-to-capture hub drift).
8. **Validation policy:** unknown `restaurant_id` → reject (`400`). Missing → default→`x_pizza`
   +log **only during the pre-La-Musa backfill window**, then **flip to fail-closed (`400`) at
   La Musa launch**. Config-read failure / cold-cache → retryable `503`; never fabricate a hub.
9. **Restaurant-aware idempotency + fingerprint.** In each path's existence guard
   (`index.js:415`; `acquireOnlineAttempt`), on a pre-existing `order_id` compare incoming
   `restaurant_id` (+`customer_phone`): match → idempotent retry; **mismatch → retryable error**
   (form regenerates id). Fold `restaurant_id`+`customer_phone` into `orderFingerprint()`
   (`pixelpay-charge.js:19`) so a collision with identical cart text/total cannot reuse the
   wrong Restaurant's attempt.
10. **`confirmOnlinePayment`: split external vs internal confirm.** The *external* (form-facing)
    confirm requires a client `restaurant_id` and verifies it matches the pending order before
    capture/materialize (closes the cross-Restaurant materialize hole via the public secret).
    But `runConfirm()`/`confirmAndMaterialize()` are *also* reached internally by `pixelPayWebhook`,
    `sweepStalePending`, `resolveManualReconciliation`, `materializeOnConfirm` (`index.js:1001`)
    — which have no client `restaurant_id`. Those **load the pending order, derive its
    `restaurant_id`, and pass it through the same checked materialization path**. Do not force a
    client-supplied id on internal recovery callers.
10b. **Confirm rechecks `active` before capture** (both external and internal paths). A card auth
    started before an `active=false` flip must not be captured/materialized into a deactivated
    Restaurant: on confirm, recheck current `active`; if inactive → **void/abandon the auth, do not
    materialize**; if active → proceed using the immutable charge-time hub snapshot (not a re-read).
    **Post-capture is different:** once money is captured (`payment_status:'confirmed'`, e.g. a
    `materializeOnConfirm`/webhook/sweep recovery finding no `materialized_at`), a later
    `active=false` must **not** strand a paid order — **always materialize + alert dispatcher**
    (the customer paid; we owe fulfillment). So: pre-capture → void; post-capture → materialize+alert.
10a. **`createOrderWithTasks()` (4th write path).** This dispatcher-only SDK helper
    (`xpizza-delivery.js:852`, test harness + manual entry) writes Orders client-side, bypassing
    server pricing/tax/idempotency/config validation. Audit its real usage; if unused outside the
    harness, **delete it**. If kept: make it **restaurant-aware** (stamp `restaurant_id` + hub
    snapshot), keep it **dispatcher-gated** by rules, require the **same `order_id` existence/
    collision transaction as the server paths** (so it can't clobber an existing order/task across
    Restaurants), and stamp **audit fields** — `created_via:'dispatcher_manual'`, `created_by`,
    `price_override:true` — so its hand-entered totals/tax are visibly manual in reporting once two
    menu/tax regimes exist.
11. **Stamp `restaurant_id` across the whole flat namespace, not just `/orders`:** `/tasks`,
    `/order_tracking`, `payment_attempts`, `dispatcher_alerts`, `incoming_messages`. Every
    derived lookup cross-checks the parent order's `restaurant_id`. Tracking records also carry
    `restaurant_name` and restaurant-aware pickup copy (replace hardcoded `'Recoger en X. Pizza'`,
    `materialize.js:82`).

**Phase 2 — Consumer apps (Track C).**
12. Driver app + functions read hub/pickup/geofence/`destination_address`/`recipient_phone`
    from the **order's hub snapshot** for *every* pickup target and geofence check
    (`index.js:500-504`, `materialize.js:53-55`, driver geofence, `xpizza-driver/index.html:1760`)
    — so a driver is never routed to the wrong hub even if auto-assign picked correctly.
13. `subscribeToOrders` (shared SDK) gains an **optional `restaurant_id` filter**: unified
    dispatcher passes none (sees both via a Restaurant badge/column); each KDS passes its id.
14. **KDS pinning = per-deploy constant**, and `setOrderStatus` **verifies the order's
    `restaurant_id` matches the deploy's pinned id before writing** (defensive cross-tenant
    write guard; client-side, consistent with ADR-0001's no-security-rules stance).
15. **Dispatcher map renders one hub marker per active Restaurant** and fits bounds using each
    order's hub snapshot (today it centers/bounds on the X. Pizza constant).
15a. **Public tracker (`xpizza-track`)** is a sixth app (own `index.html`, no SDK copy), branded
    "X. Pizza", reading `/order_tracking/{token}` (`xpizza-track/index.html:641`). Render
    `restaurant_name` + restaurant-aware pickup copy from the tracking snapshot (which now carries
    them, step 11) — not hardcoded X. Pizza brand.
16. Apply Phases 0–2 SDK edits to **all 5 byte-identical copies** of `xpizza-delivery.js`
    (`dashboard, dispatch, driver, kitchen, reference`); gate on md5-equality. **SDK
    consolidation deferred to post-launch.**

**Phase 3 — Auto-assign + stacking (Track D).**
17. `pickEligibleDriver` (`index.js:2176-2269`) computes distance from the **order's hub**;
    keep the status-check-before-assign guard. **`last_hub` preference bias dropped from scope**
    (hubs ~400m apart). But **stacking only stacks Orders with the same `restaurant_id`** unless
    a dispatcher explicitly overrides (`pickupComplete`, `xpizza-delivery.js:729`) — proximity
    doesn't make a cross-Restaurant auto-stack safe (wrong KDS/pickup).

**Phase 4 — Notifications (Track E).**
18. Parameterize the 4 hardcoded `"X. Pizza"` brand literals (`whatsapp.js:145,170,211`;
    `whatsapp_inbound.js:20`) to use the order's `restaurant_name`.
19. Replace `sendMessage(to, body)` with **`sendMessageForOrder(order, body)`** (or pass
    `restaurant_id`) so the sender has order context. It resolves the UltraMsg `instance_id`
    (config plane) + `token` (**Functions secret keyed by Restaurant**: `ULTRAMSG_TOKEN_X_PIZZA`,
    `ULTRAMSG_TOKEN_LA_MUSA`, never in RTDB) and the per-Restaurant `whatsapp_enabled` flag.
20. **Wrong-brand guard = fail-closed**, enforced *before* template generation: assert resolved
    instance + brand match `order.restaurant_id`; on mismatch / missing instance/token /
    disabled → **do not send** (log). No message beats a wrong-brand message.
21. **Inbound webhook: one `onIncomingWhatsApp` endpoint**, maps the UltraMsg payload's instance
    id → Restaurant **first**, then filters the status lookup + replies by that `restaurant_id`
    (today it scans all active orders by phone and can return the newest across both
    Restaurants). Unknown instance → operator queue, no reply; its `incoming_messages` record is
    stored with `restaurant_id: null` + `reason: 'unknown_instance'` (an unknown instance has no
    Restaurant by definition — don't force a fake id).
22. Build prerequisite: connect an UltraMsg instance to La Musa's (already-owned) number via QR;
    store its token as the per-Restaurant secret.

**Phase 5 — La Musa front-of-house (launch vehicle).**
23. **Re-fork the La Musa order form from the *current* X. Pizza form** (`xpizza-orders/index.html`)
    — single payment-flow lineage — then re-apply La Musa's menu JSON, branding (Playfair Display
    + DM Sans, 9-token palette), hours, hub, and per-item `tax_rate` (18% alcohol / 15% food).
    Form emits `restaurant_id='la_musa'`, sends `restaurant_id` on confirm (step 10), and drives
    the same `chargeOnlineOrder`/`confirmOnlinePayment` endpoints. The La Musa menu must match the
    server-side restaurant-keyed `MENU_PRICES` (step 5) exactly, or orders reject.
23a. **Update the existing X. Pizza form to emit `restaurant_id='x_pizza'`** (and send it on
    confirm) *before* the write-path strictness flip (step 8). Otherwise flipping missing-id →
    `400` rejects live X. Pizza orders. This update gates the flip.

**Phase 6 — Schema migration (Track A tail).** Per decision 5.
24. Eager one-time backfill `restaurant_id:'x_pizza'` on existing `/orders` (+ `/tasks`,
    `/order_tracking`, `payment_attempts`) — trivial, only test orders exist pre-launch.
    Defensive **default-missing→`x_pizza` on READ** in consumers for legacy/test records
    (distinct from the write-path fail-closed in step 8: creates strict, historical reads lenient).

**Phase 7 — Observability + launch.**
25. **Structured logs + alerts** (load-bearing routing demands it): every order/payment log line
    carries `restaurant_id`, `config_version`/`fetched_at`, and cache source. Alert on:
    default-`x_pizza` usage post-launch, stale-cache serves of routing-critical fields,
    inactive-Restaurant rejections, wrong-brand send suppression, and `order_id` idempotency
    collisions.
26. **Tests for the load-bearing changes** (existing payment tests assert X.-Pizza-only tracking
    copy + constant restaurant deps and will break): restaurant-aware pricing/tax, `order_id`
    idempotency collision (mismatched `restaurant_id`), charge-time snapshot immutability,
    external-confirm `restaurant_id` mismatch rejection, internal webhook/sweep confirm deriving
    `restaurant_id` from the pending order, and wrong-brand WhatsApp suppression. Also: server-side
    hours enforcement (closed → 400), active-before-capture void/abandon, the confirmed-but-
    unmaterialized-after-deactivation materialize+alert policy, and (if kept) `createOrderWithTasks`
    collision + audit fields.
27. First-time La Musa go-live: no parallel run, no fork retirement. Define rollback/fallback
    (per-Restaurant `active` flag is the kill switch, ≤30s lag) before flipping `la_musa.active=true`.

## Key decisions & tradeoffs

- **Flat `/orders` + `restaurant_id` field, not nested** — ADR-0001. Isolation is field-based
  (trusted internal tablets), which makes `restaurant_id` load-bearing across the *entire*
  namespace (orders, tasks, tracking, attempts, alerts, messages), server-side pricing/tax, the
  idempotency fingerprint, the confirm endpoint, messaging, stacking, and KDS writes.
- **Config plane = sole authored source; TTL/version-bounded cache + immutable per-order
  snapshot** — ADR-0002. Routing-critical fields (hub, active) fail closed when freshness can't
  be proven; online snapshot is stamped at charge time and never re-read.
- **One Merchant (Sherpa), one PixelPay account.** Per-Restaurant P&L is reporting (tag
  attempts/orders with `restaurant_id`), not a payment-rail change. The plan's "PixelPay per
  restaurant" (line 102) and "Make.com clone vs branch" (line 129) are **dropped as
  false-premise** (no per-Restaurant credentials; Make.com sends no messages).
- **Validation flips strict at launch**, **`last_hub` dropped**, **SDK consolidation deferred**,
  **cutover collapses to first-launch** — all justified by facts found during the grill/review.

## Risks / open questions

- **Blast radius is live.** Shared `createOrder`/dispatcher/`/orders` means a bad deploy hits
  both Restaurants. Mitigation is procedural (careful deploys, per-Restaurant `active` kill
  switch, defined fallbacks).
- **Server-side menu drift.** La Musa menu prices are **finalized** (2026-06-10) — seed the
  restaurant-keyed server `MENU_PRICES` (step 5) from those, and the La Musa form menu (step 23)
  must match it exactly or valid orders reject. (The "cut-off `PREVIEW` item" from the source plan
  was a dangling truncation artifact, not a real menu item — closed; finalized menu is the source
  of truth.)
- **Honduras dual-ISV factura** issuance is **out of scope** — per-item `tax_rate` flows through
  on the order; factura generation is separate.
- UltraMsg instance for La Musa must be provisioned (QR + secret) before WhatsApp works; until
  then the fail-closed guard suppresses La Musa sends (ships dark, safe).

## Out of scope

- SDK consolidation (post-launch cleanup); `last_hub` preference bias.
- Per-Restaurant P&L/accounting beyond `restaurant_id` tagging (single bank account
  reconciliation is a finance problem, deferred by the owner).
- RTDB security-rule walling between Restaurants (trusted devices — ADR-0001); KDS write guard
  is defensive client-side, not rules.
- Factura/ISV document generation; any parallel-run / fork-retirement machinery.
