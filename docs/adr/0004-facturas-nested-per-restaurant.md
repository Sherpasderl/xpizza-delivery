# Facturas are nested under `/facturas/{restaurant_id}/{order_id}`, deviating from the flat-orders model

**Status:** accepted (2026-06-25)

## Context

[[ADR-0001]] keeps Orders (and tasks/drivers/tracking) in flat top-level collections keyed
by a `restaurant_id` field, rejecting nesting under `/restaurants/{id}/…`. Its reasons: a
unified dispatcher reading all Orders in one subscription, a shared driver pool, and "all
devices are trusted internal tablets."

The [[Factura]] print agent is a *different* kind of consumer. It is hardware physically
located at one [[Hub]] (a Surface Pro + Epson printer at X. Pizza), and it should print
**only that Restaurant's** facturas. A flat `/facturas/{order_id}` keyed by field would
force every hub's agent to subscribe to all facturas and filter client-side — downloading
the other Restaurant's fiscal documents onto a device that has no business printing them.

## Decision

Store facturas nested: `/facturas/{restaurant_id}/{order_id}`. Each Hub's print agent
watches exactly `/facturas/{its_restaurant_id}` via `child_added`/`child_changed`. The
per-Restaurant fiscal config (CAI, range, `current_sequence`) likewise lives at
`/restaurants/{restaurant_id}/factura_config` — the sequence transaction is naturally
scoped per Restaurant (see [[CAI]]: ranges are per-establecimiento, never shared).

## Considered options

- **Flat `/facturas/{order_id}` + `restaurant_id` field (ADR-0001 consistency).** Rejected:
  it puts a Hub's print agent in the position of reading and filtering another Hub's fiscal
  records, the opposite of the print-locality the agent needs.

## Consequences

- The boundary matches physical reality: one Hub, one printer, one factura subtree, one
  sequence counter — no cross-Restaurant contention on `current_sequence`.
- Deviation from ADR-0001 is deliberate and scoped to facturas only; Orders stay flat. The
  unified dispatcher does not read `/facturas`, so ADR-0001's single-subscription goal is
  unaffected.
- For the X. Pizza launch `restaurant_id` is hardcoded `'x_pizza'` in the factura paths,
  since Orders do not yet carry `restaurant_id` and the config plane is not yet built; the
  factura system introduces the identifier ahead of the broader multi-tenant migration.
