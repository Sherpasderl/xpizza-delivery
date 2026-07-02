# Ready-Time Phase 0 — lifecycle-event instrumentation (propose-first)

_Status: DRAFT rev-2 — Codex Act-2 round 1 = REVISE (8 findings, all accepted); this rev addresses them, re-gate pending._
_Auditor-drafted proposal; the EXECUTOR session builds it after sign-off + a green re-gate._
_Prime directive: additive + observer-only. MUST NOT change any current X. Pizza / La Musa behavior. Proven by tests._

## Why this exists (grounded in the OFD literature)

The `/downloads/lmd algorithm docs/` corpus is unanimous:

- **Food-preparation time is the dominant _stochastic_ input to the whole dispatch.** Meituan (Informs 2024): *"extended food preparation time of the merchants … uncertainties further intensified by couriers' on-hand workload."* OrderStacking models customer wait (driven by prep) as the utility-determining quantity; processes-13-03211 and Sheng/Liu treat prep/service time as the key random variable.
- **Formal model** (Genetic-bundling paper): `ready_time = order_placement_time + preparation_time`, prep being a per-order, per-restaurant attribute. The quantity to predict is `prep_time = ready_at − new_at` (both server timestamps).
- **Its predictors are ephemeral.** Prep time is driven by kitchen congestion (concurrent orders / on-hand workload), order composition, and temporal load. **Kitchen congestion at the moment of an order is UNRECOVERABLE after the fact.** It must be logged _live_ — every day without instrumentation is training data permanently lost. That is the whole argument for the robust version now. The predictor itself (Option C) is a later, separate workstream.

## Current lifecycle (grounded in code, verified 2026-07-01)

| transition | writer | file | timestamp today |
|---|---|---|---|
| `pending_payment` → `new` | server (materialize) | `materialize.js:37,39` | stamps `orders/{id}/materialized_at` (NOT `created_at`) |
| `new` → `preparing` → `ready` | **KDS only** | `xpizza-kitchen/xpizza-delivery.js:304` `setOrderStatus` | none (writes `{status}` only) |
| → `out_for_delivery` / `delivered` | driver SDK | `xpizza-delivery.js` | none |
| → `confirmed` / `cancelled` | server | `index.js` | various |

**Correction from rev-1 (Codex #2):** `orders/{id}/created_at` is *pending-payment creation time* for online orders, not the `new`-transition time (`materialized_at` is the new-transition stamp; `order_tracking/{token}/created_at` at `materialize.js:104` is a different node). Therefore **`new_at` is defined solely from this instrumentation's own `new`-transition timestamp** — we never rely on `orders.created_at` for the prep-time label.

## Design — server-authoritative lifecycle event log (rev-2)

**One new Cloud Function**, `logOrderLifecycle` = `onValueWritten('orders/{orderId}/status')`. On each _real_ status change it does two **fully decoupled, top-level** writes (nothing under `/orders`):

### 0. No-op guard (Codex #3)
If `event.data.before.val() === event.data.after.val()` (a re-write with no status change), **return immediately** — no event, no timeline. (Compare `.val()`, NOT the `DataSnapshot` objects — v2 RTDB `before`/`after` are snapshots; object equality never matches. Existing pattern: `index.js:2371`.)

### 1. Immutable event (the audit spine) — records EVERY real transition
```
order_events/{orderId}/{pushId} = {
  from:                 <prev status | null>,
  to:                   <new status>,
  at:                   ServerValue.TIMESTAMP,     // server-authoritative
  restaurant_id:        <string>,
  kitchen_load_ahead:   <int>,   // EPHEMERAL: OTHER {new,preparing} orders for this restaurant, excluding self
  drivers_online:       <int>    // EPHEMERAL: coarse supply proxy — see decision 6
}
```

### 2. First-entry timeline (the clean label source) — top-level, NOT under /orders (Codex #1,#3,#7)
```
order_timelines/{orderId}/{to}_at   // written TRANSACTIONALLY, only if absent (first entry wins)
```
Written to a **separate top-level tree**, so it fires **no** existing `orders/{orderId}` trigger (`autoAssignOnOrderCreate` :3133, `onOrderCancelled` :1884, `sendOrderStatusNotifications` :2365, materialize/factura triggers). First-write-only means a `ready→preparing→ready` bounce, dispatcher override, or stale-tab re-write cannot corrupt the label — the append log still records the bounce for audit.

**Everything else is joined, not copied** — `items_text`, `items`, `subtotal_cents`, `order_type`, geo persist on the order and join by `orderId` at ETL. The event log stores only the target timestamps + the two ephemeral, unrecoverable context values.

### Derived at ETL (computed, not stored)
`prep_time = order_timelines.ready_at − order_timelines.new_at` (both first-entry, from OUR log); `hour_of_day`/`day_of_week` from `at`; `item_count` from `items`/`items_text`. → clean `(features, prep_time)` rows.

## Key design decisions (rev-2)

1. **Server trigger, not client field-stamp** — server-authoritative timestamps; catches all writers; immutable append-only log. Cost: +1 function.
2. **Two decoupled top-level trees (`order_events`, `order_timelines`)** — nothing written under `/orders`, so **zero** existing-trigger fanout. This is what makes "no existing write path touched" actually true (rev-1 got this wrong).
3. **Timeline is first-entry-only + transactional; events skip `before===after`** — protects the training label from duplicate/out-of-order/no-op transitions while the audit log stays complete.
4. **`kitchen_load_ahead` = count of OTHER `{new,preparing}` orders for the same restaurant, EXCLUDING the order being logged** (queue-ahead-at-arrival — the prep-time predictor). Explicitly exclusive; computed as two status queries minus self.
5. **Load counts = TWO indexed `orderByChild('status').equalTo()` reads** (`new`, then `preparing`), restaurant-filtered in memory — RTDB can't `IN`-query (Codex #5). Requires `.indexOn:["status"]` on `orders` (present) **and `drivers`** (ADD — currently absent, `database.rules.json:10`).
6. **`drivers_online` is a coarse, honestly-named supply proxy — NOT eligibility.** Real assignability (`pickEligibleDriver` :2862) weighs push reachability, cooldown, stacking capacity, task-derived active count (Codex #6). Phase 0 captures only the cheap `status ∈ {online,available}` count and labels it as such. Eligibility-accurate supply is a Phase-0.1 enhancement that reuses `pickEligibleDriver` — deferred to avoid coupling instrumentation to live assignment logic.
7. **Separate follow-up deploy**, not bundled into the frozen S3 deploy. +1 function → prune denominator **30 → 31**. Ships after S3 on its own gate.

## Behavior-preservation proof plan (the prime directive)

- **Static:** the function only READS existing data (`orders/{id}`, indexed `orders`/`drivers` status queries) and WRITES to two NEW top-level trees (`order_events/*`, `order_timelines/*`). No write under `/orders` → no existing order-trigger fires. `setOrderStatus`, materialize, autoAssign, sweeper, factura, KDS/dispatch filters all untouched.
- **Emulator (this machine's authority):** seed both restaurants; drive `new→preparing→ready→out_for_delivery→delivered` + a `cancelled` path + a `ready→preparing→ready` bounce + a `before===after` no-op; assert (a) one event per REAL transition, correct `from/to`, monotonic `at`; (b) `order_timelines.{status}_at` set once (bounce does NOT overwrite); (c) no-op write produces neither event nor timeline; (d) `kitchen_load_ahead` == hand-counted concurrent `{new,preparing}` minus self; (e) `drivers_online` matches seeded supply; (f) **no existing `orders/{id}` trigger fires from the timeline/event writes** (assert factura/autoAssign/cancel side-effects absent); (g) `npm test`, `check:rules`, `test:rules` still green.
- **Rules (Codex #8):** add explicit `order_events` and `order_timelines` as `{".read": false, ".write": false}` for Phase 0 (the admin trigger bypasses rules; no client access, no dispatcher read until a UI needs it). Add `".indexOn":["status"]` under `drivers`. Equality gate: `diff xpizza-functions/database.rules.json xpizza-reference/database.rules.json` empty.

## Cost / perf

Trigger fires ~5–7×/order (real transitions only, after the no-op guard). Two indexed status reads + one drivers read per fire, restaurant-filtered in memory — O(matches), not O(table), via `.indexOn`. Cheap at current volume. **Graduate to maintained per-restaurant counters (Phase 0.1) before volume makes the reads expensive** — noted, not needed now.

## Open questions (resolve at sign-off)

- **Q1:** confirm `kitchen_load_ahead` exclusive-of-self is the wanted signal (vs also storing an inclusive `_after`). Rec: exclusive-only for Phase 0; add `_after` only if the model wants post-arrival congestion.
- **Q2:** keep the coarse `drivers_online` in Phase 0, or omit supply entirely until Phase 0.1's eligibility-accurate version? Rec: keep the coarse honest count (ephemeral, unrecoverable, cheap) with the clear caveat.
- **Q3:** own deploy (rec) vs bundle into S3 (forces S3 re-gate — not recommended).

## Out of scope (later)

The predictor/model (Option C), any dispatch behavior change, backfilling history (impossible for the ephemeral features — the point), maintained aggregate counters, eligibility-accurate supply.
