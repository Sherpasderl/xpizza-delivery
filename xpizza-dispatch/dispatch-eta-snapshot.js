// xpizza-dispatch/dispatch-eta-snapshot.js
/**
 * Session-scoped first-observed-ETA store (dispatch Phase 1 delivery-risk).
 * Holds only the FIRST ETA this dispatcher session observed per order, so a
 * browser opened mid-delivery honestly has no baseline until it observes one.
 * Pure — a fresh instance per page load; no globals.
 */
export function createEtaSnapshotStore() {
  const first = new Map(); // orderId -> arrivalMs
  return {
    observe(orderId, arrivalMs) {
      if (!first.has(orderId) && Number.isFinite(arrivalMs)) first.set(orderId, arrivalMs);
    },
    baseline(orderId) { return first.has(orderId) ? first.get(orderId) : null; },
    clear(orderId) { first.delete(orderId); },
    has(orderId) { return first.has(orderId); },
  };
}
