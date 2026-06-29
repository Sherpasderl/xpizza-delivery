# Restaurant identity: config plane is sole authored source; cache + per-order snapshot are the only copies

**Status:** accepted (2026-06-10)

## Context

Restaurant hub coordinates live today as in-code constants (`RESTAURANT` in the driver
SDK, `RESTAURANT_LAT/LNG` in functions). The [[config plane]] (`/restaurants/{id}`) is
meant to replace them so config changes don't require redeploying six app folders. The
concern: a config-plane read in the order hot path could block order creation on an RTDB
blip, and naive solutions duplicate the coordinate literal in code (which drifts).

## Decision

There is **one authored source of truth** for hub coordinates: the `/restaurants/{id}`
seed. The in-code `RESTAURANT` constant and `RESTAURANT_LAT/LNG` are **deleted**, not
extended into a fallback map.

- Order-creation paths read the config plane and **cache last-known-good in warm
  instance memory**, tagged with `fetched_at` + a config `version` (a cache of the same
  source, not a second authored copy). `version` is **monotonic and required** on every
  routing-critical edit (hub/active); a write that doesn't bump it is rejected/alerted.
- Each Order carries a **denormalized hub snapshot** (`hub_lat`, `hub_lng`,
  `restaurant_name`, `restaurant_phone`). Driver app / KDS / tracker read the snapshot
  off the Order and never read the config plane themselves.
- **Freshness is bounded for routing-critical fields.** `hub_lat/lng` and `active` are
  routing-critical: a stale cache is served only within a short max-age (**TTL = 30s**).
  Past TTL, or when freshness cannot be proven, those fields **fail closed** (reject/
  retryable 503 + alert) rather than stamp a possibly-moved hub or accept an order for a
  deactivated Restaurant. Consequence: the `active` kill switch has a **bounded lag of
  ≤30s** under an RTDB read outage (accepted; use an out-of-band disable if an instant
  intake-stop is ever needed). Non-critical fields (phone, and `hours` as the *regular
  weekly schedule*) may serve stale — **ad-hoc/emergency closures go through `active=false`**,
  which is routing-critical, so a stale regular schedule can't keep a truly-closed Restaurant open.
- On the rare cold-instance-AND-config-outage (empty cache, unreadable) → **retryable
  503**; the order form auto-retries. We deliberately do NOT fabricate a default hub.
- **Charge-time snapshot is immutable.** For online orders, the Restaurant snapshot is
  stamped on the `pending_payment` Order at `chargeOnlineOrder` time; `materialize`
  reuses *only* that snapshot and never re-reads config — so a config change between auth
  and capture cannot move the Order to a different hub.

## Consequences

- Model is **source → cache → snapshot**; never two competing authored literals, so no
  drift.
- The per-Order snapshot is intentionally immutable history: editing a hub later does not
  rewrite live Orders.
- Secrets (WhatsApp token, PixelPay keys) do NOT go in the config plane — it holds
  non-secret identity only (name, hub, phone, whatsapp instance id, hours, active).

## Amendment — 2026-06-28: config-plane identity nests at `/restaurants/{id}/identity`

Phase 0 Step 1 established that `/restaurants/{id}` is a **mixed-sensitivity node**: the factura
system (ADR-0004) stores sensitive fiscal config at `/restaurants/{id}/factura_config` (CAI,
range, sequence), which must stay Admin-SDK-only, while config-plane identity must be
client-readable by authenticated internal apps. RTDB rules **cascade and cannot be revoked at a
child** — a `.read`/`.write` grant at `/restaurants` or `$restaurant_id` would expose
`factura_config`. Therefore identity is nested under its own readable wrapper:

- `/restaurants/{id}/identity/*` — `name`, `hub_lat`, `hub_lng`, `phone`, `whatsapp_instance`,
  `whatsapp_enabled`, `hours`, `delivery_radius_km`, `active`, `version`. Rules: `.read` = any
  authenticated user, `.write` = dispatcher-only (mirrors `/config`). Canonical path for Steps 2
  (seed) and 3 (reads). **Step 2 must add `.validate` under `/restaurants/{id}/identity` for the
  routing-critical identity constraints — monotonic `version`, numeric hub fields, boolean
  `active` — which is where this ADR's original "`version` monotonic and required" enforcement now
  lives.**
- `/restaurants/{id}/factura_config` — unchanged, no ancestor grant (Admin-SDK-only).

**Invariant:** no `.read`/`.write` grant at the `/restaurants` or `$restaurant_id` level —
enforced by an offline guard test (Step 1).

### Rejected alternatives

- **Flat identity at `/restaurants/{id}/*`** (siblings of `factura_config`): cascade forces
  per-field `.read` *and* `.write` on every field; a missed field silently breaks or exposes fiscal
  data. Brittle.
- **Separate top-level `/restaurant_public/{id}`**: fragments restaurant config across two trees;
  nesting keeps one cohesive node per Restaurant.

### Reconciliation

The config **plane** (non-secret identity) is the `/restaurants/{id}/identity` subtree; the
`/restaurants/{id}` **node** also hosts the sensitive `factura_config` subtree owned by the factura
system. The original "non-secret identity only" describes the identity subtree, not the whole node.
