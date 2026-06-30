# Proposal C — Consumer-phase grounding + decomposition (post-creation order lifecycle)

_Executor → Auditor + Codex. Grounding-first audit of the post-creation lifecycle (dispatch /
auto-assign / driver / tracker / WhatsApp / KDS): what is already `restaurant_id`-aware vs
x_pizza-assuming. Sizes the remaining work and answers deploy timing. Propose-first — gate the
decomposition against the real bundles before building. La Musa stays dark until the end._

---

## Audit — restaurant-awareness of each consumer surface (grounded)

| Surface | Status | Evidence | Gap | Layer |
|---|---|---|---|---|
| **Order → tasks hub** | ✅ aware | `create-order-build.js:39,72` — pickup task `destination_lat/lng` + order `hub_lat/lng` from `hubSnapshot` | none (server orders already carry the La Musa hub) | — |
| **Driver geofence / location** | ✅ mostly | `index.js:2212-2222` — `current_restaurant_id`, `isHubResolvable`, `current_hub_lat ?? RESTAURANT_LAT` | benign x_pizza fallback when hub unresolvable | minor |
| **KDS** | ✅ aware | `order-filter.js` `filterLiveOrders(orders, restaurantId)` + host pin; la_musa KDS built | **deploy only** (`840150f` unpushed) | ops |
| **Auto-assign** | ❌ x_pizza-assuming | `index.js:2844` `haversineKm(d.lat, d.lng, RESTAURANT_LAT, RESTAURANT_LNG)` — distance to the **hardcoded x_pizza hub** (`:2656`), not the order's | use the order's `hub_lat/hub_lng` (already stamped) | **SERVER** |
| **WhatsApp** | ❌ x_pizza-assuming | `whatsapp.js:27-28` — single global `ULTRAMSG_INSTANCE_ID`/`TOKEN` from env (x_pizza's `instance170156`) | per-restaurant instance from `identity.whatsapp_instance` | **SERVER** + ops |
| **Dispatcher view** | ❌ agnostic | `xpizza-dispatch/xpizza-delivery.js:106` `filterLiveOrders(orders)` — **no `restaurantId`**, shows all live orders unlabeled | label/group by restaurant (unified dispatcher) | **CLIENT** |
| **Tracker** | ❌ static x_pizza | `xpizza-track/index.html` — "X Pizza Tracking" + brand colors, **no `restaurant_name`/`restaurant_id` read** | dynamic restaurant branding, or a separate la_musa tracker site | CLIENT |

**Same pattern as `createOrderWithTasks`:** the *creation* path is restaurant-aware (hub stamped on the order/tasks), but two *post-creation server* consumers (auto-assign, WhatsApp) still read x_pizza-hardcoded globals.

## Decomposition (gated phases — each X. Pizza byte-identical)

- **C1 — Auto-assign per-restaurant hub (SERVER).** At `:2844`, compute driver distance to the
  **order's** `hub_lat/hub_lng` instead of `RESTAURANT_LAT/LNG`. **Byte-identity hinge (verified):**
  the seeded x_pizza hub (`seed_identity.js:26-27`) equals `RESTAURANT_LAT/LNG` (`:2656-2657`) to
  full float precision (`15.507489753573818` / `-88.0398486953722`), so an x_pizza order's stamped
  hub gives the identical distance. **Binding constraint:** **fall back to `RESTAURANT_LAT/LNG` when
  the order lacks a stamped hub** (legacy/pre-Phase-0 orders still in the queue) — mirror the
  existing `?? RESTAURANT_LAT` pattern at `:2212-2213`. **The C1 golden must prove all three:**
  (a) x_pizza-with-hub → identical, (b) x_pizza-legacy-no-hub → fallback → identical, (c) la_musa →
  La Musa hub. Small; *HARD pre-launch*.
- **C2 — WhatsApp per-restaurant instance + tracker link (SERVER + ops).** `whatsapp.js` selects
  instance/token by the order's restaurant (`identity.whatsapp_instance`) rather than the single
  global env. **Coupled gap (refinement):** `TRACKING_BASE` is also hardcoded
  `https://xpizzatrack.netlify.app` (`whatsapp.js:37`, used at `:138`) — a la_musa confirmation
  would link the customer to the **X. Pizza tracker**. Make `TRACKING_BASE` restaurant-aware too
  (its value depends on the C4 tracker decision below). X. Pizza byte-identical (resolves to its
  instance + tracker). **Ops:** provision the La Musa UltraMsg instance, then
  `la_musa.whatsapp_enabled=true`. *HARD pre-launch* (else la_musa notifications send from X. Pizza's
  number/tracker — or, while `whatsapp_enabled:false`, not at all).
- **C3 — Unified dispatcher view (CLIENT).** Make the dispatch `filterLiveOrders` + UI
  restaurant-aware (label/group la_musa vs x_pizza). The dispatcher sees both; no server change.
  UX, not safety — can trail launch if needed.
- **C4 — Tracker branding (CLIENT).** Resolved: `xpizza-track/index.html` is **statically
  X. Pizza-branded** ("X Pizza Tracking" + brand colors) with **no `restaurant_name`/`restaurant_id`
  read** — a la_musa order tracked there shows X. Pizza branding. Real work: either render
  `restaurant_name`/brand **dynamically from the order**, or stand up a **separate la_musa tracker
  site**. **That choice determines the restaurant-aware `TRACKING_BASE` value used in C2.**
- **C5 — KDS la_musa deploy (OPS).** Push `840150f` + deploy the la_musa KDS Netlify site (code done).

## Deploy timing (the question this audit answers)
**Consumer phases DO add server code** (C1 + C2). So per the batching logic, **fold C1 + C2 into the
batched server deploy** — one off-hours deploy (Phase 1 + B1 + B2-server + C1 + C2), behind the
emulator-e2e gate (incl. the la_musa mode), then FF to main. Fewer live-path touches than deploying
the already-committed server now and again later. The client phases (C3/C4, the order form, C5 KDS)
are independent Netlify deploys. `active:true` is the final discrete step after C1/C2 land + deploy +
the ops gates clear.

## Open items / verify-at-implementation
- **WhatsApp** — confirm the per-restaurant token model (one UltraMsg account multi-instance vs
  per-restaurant token) + provision the la_musa instance (ops).
- **Tracker** — confirm whether it already renders `restaurant_name` or hardcodes X. Pizza.
- **Driver geofence fallback** (`:2212`) — confirm la_musa drivers always have `current_hub`
  resolvable, else the `?? RESTAURANT_LAT` fallback mis-geofences a la_musa driver to the x_pizza hub.

## Out of scope
The integration code (Phase 1 + B1 + B2-* + Finding-J — done); the ops/config launch gates already
tracked; `active:true` (launch). Each C-phase is its own propose→gate→implement cycle.
