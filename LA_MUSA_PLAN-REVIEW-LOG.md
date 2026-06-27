# Plan Review Log: Integrate La Musa Gastropub into the X. Pizza delivery platform
Act 1 (grill-with-docs) complete — plan locked, CONTEXT.md + ADR-0001/0002 written. MAX_ROUNDS=5.
PLAN_FILE=LA_MUSA_PLAN.md.

## Round 1 — Codex
thread_id: 019eb344-530b-7921-bd62-53dd7554ab9f · VERDICT: REVISE

Findings:
1. `active=false` not fail-closed under stale warm cache — a warm instance can keep accepting orders for a deactivated restaurant. Fix: TTL/version-bounded cache; fail closed on routing-critical fields when freshness unprovable.
2. Hub moves silently misroute when config reads fail (stale cache stamps old coords). Fix: hub coords routing-critical with short max-age → 503/alert past bound.
3. Ambiguous charge-vs-confirm snapshot ownership — config change between auth and capture can materialize to a different hub. Fix: stamp snapshot on pending order at charge time; materialize uses ONLY that immutable snapshot.
4. Deleting `RESTAURANT` breaks pre-config consumers: confirmDeps() (index.js:990), driver geofence (xpizza-delivery.js:237), dispatcher map pins, createOrderWithTasks(). Fix: rewrite each consumer first / remove dead helpers.
5. [CRITICAL] Server price validator single-restaurant: `computeServerTotal()`/`MENU_PRICES` (index.js:151,191) only knows X. Pizza items → La Musa orders rejected. Fix: menu/price tables keyed by restaurant_id.
6. Server tax hardcoded 15% inclusive in `priceBreakdownCents` (index.js:225) — La Musa has 18% alcohol. Fix: recompute from restaurant-aware per-item tax; reject client tax totals.
7. `orderFingerprint()` (pixelpay-charge.js:19) excludes restaurant_id + customer_phone → collision with identical cart text/total reuses wrong restaurant attempt. Fix: include both in fingerprint + mismatch check.
8. Flat namespace is more than /orders: /tasks, /order_tracking, payment_attempts, alerts, incoming_messages. Fix: stamp restaurant_id on all; cross-check parent order's restaurant_id on derived lookups.
9. `confirmOnlinePayment` takes only {order_id, payment_uuid} → public secret can cross-restaurant materialize any known pending id. Fix: require restaurant_id on confirm + verify against pending order.
10. WhatsApp inbound status lookup scans all active orders by phone → returns newest across both restaurants (wrong-line tracking link). Fix: map inbound instanceId→restaurant_id first, filter lookup/replies by it.
11. `sendMessage(to, body)` has no order context to enforce brand/instance match. Fix: `sendMessageForOrder(order, body)` (or pass restaurant_id), fail closed before template generation.
12. Global `/config/whatsapp_enabled` not restaurant-aware. Fix: per-restaurant enablement.
13. Driver geofence + driver UI pickup target still use `XPD.RESTAURANT` (xpizza-driver/index.html:1760) → driver routed to wrong hub even if auto-assign correct. Fix: use order hub snapshot/pickup task for every pickup target/geofence.
14. Stacking can stack across restaurants without hub check (pickupComplete). Fix: only stack same restaurant_id unless dispatcher overrides.
15. KDS pinning client-side only — stale KDS can setOrderStatus on any restaurant's order. Fix: verify order's restaurant_id against KDS deploy constant before status writes.
16. `order_tracking` omits restaurant_id; pickup copy hardcoded "Recoger en X. Pizza" (materialize.js:82). Fix: stamp restaurant_id/name + restaurant-aware pickup text.
17. Dispatcher map centers/bounds on X. Pizza constant. Fix: one hub marker per active restaurant; fit bounds per order's hub snapshot.
18. Observability too weak ("log" only). Fix: structured logs with restaurant_id, config_version/fetched_at, cache source; alert on stale-cache/mismatch/collision/inactive-rejection/wrong-brand-suppression.
19. CONTEXT.md merchant ambiguity (says each restaurant has its own payment merchant, then says one Merchant). Fix: glossary — restaurant has menu/hub/hours/WhatsApp; merchant shared.

### Claude's response
ACCEPTED 1-2 (TTL/version-bounded cache; hub + active are routing-critical → fail-closed when freshness unprovable), 3 (charge-time immutable snapshot; materialize never re-reads config), 4 (enumerate + rewrite all RESTAURANT consumers before deletion), 5 (CRITICAL — restaurant-keyed server menu/prices; was the biggest miss), 6 (restaurant-aware per-item tax; reject client tax), 7 (fingerprint includes restaurant_id + customer_phone), 8 (stamp restaurant_id across tasks/tracking/attempts/alerts/incoming + cross-check), 9 (confirm requires + verifies restaurant_id — security), 10 (inbound instance→restaurant filter), 11 (sendMessageForOrder with order context), 12 (per-restaurant whatsapp_enabled), 13 (all pickup targets/geofences from order snapshot), 14 (same-restaurant stacking guard), 15 (KDS verifies restaurant_id before status write — defensive, not security rules per ADR-0001), 16 (tracking restaurant_id + restaurant-aware pickup copy), 17 (per-restaurant dispatcher map markers/bounds), 18 (observability section added), 19 (CONTEXT glossary fixed).
REJECTED: the "3 SDK copies" claim — verified 5 byte-identical copies (dashboard, dispatch, driver, kitchen, reference). Plan's count stands. All other findings folded into LA_MUSA_PLAN.md.

## Round 2 — Codex
VERDICT: REVISE — "Most Round 1 issues are materially addressed." Remaining (all second-order):
1. `confirmOnlinePayment` requires restaurant_id, but internal callers (pixelPayWebhook, sweepStalePending, resolveManualReconciliation, materializeOnConfirm @ index.js:1001) have no client restaurant_id. Fix: split external (validated) vs internal (derive from pending order, same checked path).
2. Public tracker `xpizza-track` omitted — branded X. Pizza, reads /order_tracking/{token} (index.html:641). Fix: add to Phase 2; render restaurant_name/pickup copy from snapshot.
3. RTDB rules not updated: database.rules.json has /config, no /restaurants. Fix: add /restaurants read/write rules (dispatcher-only write).
4. `active` kill-switch has TTL-bounded lag if reads fail. Fix: document concrete TTL or add out-of-band immediate disable.
5. `version` semantics undefined. Fix: monotonic, required on routing-critical edits, alert/reject if missing.
6. Unknown-instance vs "stamp restaurant_id on incoming_messages" conflict. Fix: allow restaurant_id:null + reason:'unknown_instance'.
7. X. Pizza form must emit x_pizza before strict flip. Fix: add X. Pizza form update gating the flip.
8. `createOrderWithTasks()` (dispatch SDK:852) is a 4th client-write path bypassing pricing/tax/idempotency. Fix: make restaurant-aware + dispatcher-gated, or delete.
9. No tests called out for load-bearing changes. Fix: add tests (pricing/tax, collision, snapshot immutability, confirm mismatch, internal confirm, wrong-brand suppression).

### Claude's response
ACCEPTED all 9 (none rejected). Verified the three code-fact claims: createOrderWithTasks IS a client-side dispatch SDK write path (xpizza-delivery.js:852, used by reference test-harness); xpizza-track IS a 6th app reading /order_tracking, branded X. Pizza; database.rules.json has NO /restaurants node. Plan updated: step 10 split external/internal confirm; 10a createOrderWithTasks restaurant-aware+gated; 15a xpizza-track; 1+1a version-monotonic+/restaurants rules; TTL=30s with documented active-lag; 21 unknown-instance restaurant_id:null+reason; 23a X. Pizza form emits x_pizza before flip; 26 test coverage. CONTEXT.md updated (createOrderWithTasks caveat to the "zero writes" note). ADR-0002 already carried TTL/version + charge-time-immutable-snapshot.

## Round 3 — Codex
VERDICT: REVISE — findings narrowing (5, fine-grained):
1. `active=false` undefined for in-flight pending_payment: an auth started pre-flip can still capture/materialize post-deactivation. Fix: confirm rechecks current active before capture; void/abandon if inactive; use charge-time snapshot if active.
2. createOrderWithTasks still a collision/clobber risk even when gated. Fix: same order_id existence/collision transaction as server paths, or delete.
3. createOrderWithTasks manual-pricing bypass lacks audit fields. Fix: created_via:'dispatcher_manual', created_by, price_override:true; visibly manual in reporting.
4. Server-side hours not enforced — bypassed form can submit La Musa orders outside hours. Fix: validate hours server-side in createOrder + chargeOnlineOrder; 400/closed with retry time.
5. ADR-0002 behind the plan (says "short max-age", no version-bump semantics). Fix: write TTL=30s, <=30s active lag, monotonic version into the ADR.

### Claude's response
ACCEPTED all 5 (none rejected). Plan: 10b confirm rechecks active before capture (void if inactive, else charge-time snapshot); 10a createOrderWithTasks now requires the server collision transaction + audit fields (created_via/created_by/price_override) or deletion; 6a server-side hours enforcement in createOrder + chargeOnlineOrder. ADR-0002 tightened: TTL=30s, <=30s active kill-switch lag, monotonic-required version.

## Round 4 — Codex
VERDICT: REVISE — 3 findings (consistency/edge, converging):
1. Hours acceptance-critical (step 6a) contradicts ADR-0002 ("hours display may serve stale"). Fix: mark hours acceptance-critical, OR state ad-hoc closures use active=false and hours = regular schedule only.
2. Step 10b covers pre-capture active=false but not the already-captured recovery case (confirmed, no materialized_at, deactivated after capture): blocking = paid invisible order; allowing = live order post-deactivation. Fix: define policy (materialize+alert, or refund/queue).
3. Test list not updated for Round 3 behaviors. Fix: add hours enforcement, active-before-capture void, inactive confirmed-but-unmaterialized recovery, createOrderWithTasks collision/audit.

### Claude's response
ACCEPTED all 3 (none rejected). (1) Resolved as: hours = regular weekly schedule (may serve stale, low-risk); ad-hoc/emergency closures use active=false (routing-critical, 30s TTL) — written into BOTH plan step 6a and ADR-0002, removing the contradiction. (2) Policy defined in step 10b: pre-capture active=false -> void/abandon; post-capture (money taken) -> always materialize+alert dispatcher, never strand a paid order. (3) Test list (step 26) extended with hours enforcement, active-before-capture void, post-capture materialize+alert recovery, createOrderWithTasks collision/audit.

## Round 5 — Codex
VERDICT: APPROVED — converged.
"No blocking findings remain. The plan now has explicit policies for the previously unsafe edges: stale routing config, charge-time vs confirm-time hub snapshots, inactive Restaurant behavior before and after capture, direct dispatcher writes, hours semantics, namespace stamping, messaging isolation, and test coverage. Residual risks are documented tradeoffs rather than contradictions: trusted-tablet client filtering, a <=30s active kill-switch lag during RTDB read outage, and server/menu drift until the menu source is consolidated — acceptable within the architecture the ADRs lock in."

Converged in 5 rounds (1 finding rejected by Claude: the "3 SDK copies" miscount; all others accepted and folded in). Deliverables: LA_MUSA_PLAN.md, CONTEXT.md, docs/adr/0001, docs/adr/0002.
