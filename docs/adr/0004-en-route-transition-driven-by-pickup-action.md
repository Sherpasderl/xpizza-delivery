# The stacking-cap `en_route_delivery` transition is driven by the pickup action, not the geofence

**Status:** accepted (2026-06-10)

## Context

A Driver's `en_route_delivery` status is what closes the order-stacking window: the
auto-assignment engine treats `available | assigned | at_restaurant` as stackable and
`en_route_delivery | returning` as full (cap = 2 pizzas/car). Investigation found that the
**only live writer** of `en_route_delivery` is the client-side geofence
(`checkGeofenceTransition`, fired on leaving the [[Hub]] radius). The manual pickup swipe
(`pickupComplete`, the only pickup action wired in the UI) sets the *Order* to
`out_for_delivery` but never touches Driver status, and `markTaskInProgress` — the one
function that would set `en_route_delivery` manually — is dead code (no caller). A code
comment claiming "Driver still needs to manually tap Picked Up to advance to
en_route_delivery" is stale; the code does not implement it.

This is load-bearing on the geofence, which is exactly the signal that **freezes when a
[[Native driver app]] Driver is backgrounded**. A backgrounded Driver who picks up and
leaves stays `at_restaurant` forever → still stackable → a 3rd order stacks onto a full car,
and the `at_restaurant: 0` priority makes them win assignments even across town.

## Decision

`pickupComplete` (the mandatory "Recogí pedido" swipe) **also sets
`drivers/{uid}/status = en_route_delivery`** in its existing atomic write. The stacking
window then closes at the moment the Driver picks up the pizza — a definite, foreground,
native-safe action — independent of the geofence or background state.

The geofence keeps its remaining, non-safety-critical job (auto `at_restaurant` for
dispatcher observability); for native Drivers that job moves server-side into
[[0003-native-location-ingest-bypasses-webview]], with the manual `arriveAtRestaurant()`
button and the now-fresh GPS pin as the degraded-mode fallbacks.

## Consequences

- The cap holds regardless of platform or backgrounding — this also fixes a latent PWA bug
  (geofence mis-fire / GPS off could over-stack today).
- `en_route_delivery` now fires at pickup-swipe rather than at physical hub-exit (slightly
  earlier, semantically "has the pizza, leaving" — the correct moment for the cap).
- This is a one-line change in the SDK, which is duplicated across six folders — it must
  land in all six (or via the shared-SDK fix) to avoid version drift.
