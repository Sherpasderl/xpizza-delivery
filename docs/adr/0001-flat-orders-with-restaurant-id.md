# Flat `/orders` collection keyed by `restaurant_id`, not nested per-restaurant paths

**Status:** accepted (2026-06-10)

## Context

Integrating a second Restaurant (La Musa) into a platform that was single-tenant by
design. The two architectural commitments already made — a **unified dispatcher** (one
console across both Restaurants) and a **shared driver pool** (`/drivers` and `/tasks`
are inherently cross-Restaurant) — both pull toward keeping one flat namespace.

## Decision

Keep a single flat `/orders` (and `/tasks`, `/drivers`, `/order_tracking`) collection.
Multi-tenancy is expressed by a required `restaurant_id` field on every Order, with
consumers filtering by it. We do **not** nest under `/restaurants/{id}/orders`.

## Considered options

- **Nested `/restaurants/{id}/orders`** — gives structural (path-level) isolation and
  easy security-rule walling, but makes the unified dispatcher a two-subscription merge,
  makes cross-hub tasks/drivers awkward, and requires physically moving every existing
  X. Pizza order. Rejected.

## Consequences

- **No structural isolation.** A KDS/dispatcher device reads all Orders and filters in
  JS; one Restaurant's order data is present on the other's device. Accepted because
  **all devices are trusted internal tablets** — if that ever changes, revisit.
- **Total blast radius.** A bad write or rule on `/orders` hits both Restaurants at once.
  Mitigation is procedural (careful deploys, fallbacks defined before cutover), not
  structural.
- **`restaurant_id` becomes load-bearing.** Because isolation is field-based, every one
  of the three [[order-creation paths]] must stamp AND validate `restaurant_id` against
  the [[config plane]]; a missing/typo'd value is a wrong-Restaurant order, not an error.
