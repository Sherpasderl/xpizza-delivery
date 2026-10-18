// Dependency-free single source of truth for order-status vocab + the live/restaurant order filter
// + the KDS host→restaurant classifier. Pure (no firebase/browser globals) so it's node-testable.
// Re-exported by xpizza-delivery.js (import-then-export) for the browser SDK.

export const ORDER_STATUS = {
  PENDING_PAYMENT: 'pending_payment',   // online order awaiting payment — NOT operationally live
  NEW: 'new',
  PREPARING: 'preparing',
  READY: 'ready',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
};

// Statuses hidden from every /orders reader (an unpaid online order never appears as a real order).
export const NON_LIVE_ORDER_STATUSES = new Set([ORDER_STATUS.PENDING_PAYMENT, 'scheduled', 'releasing']);

// Classify a KDS host to its pinned restaurant. Exact La Musa site OR a Netlify preview/branch host
// (deploy-preview-N--lamusakitchendisplay.netlify.app) → la_musa; anything else (the X. Pizza KDS
// host, localhost, unknown) → x_pizza. FAIL-SAFE: a misconfigured host can only ever show X. Pizza.
export function kdsRestaurantFromHost(host) {
  const h = host || '';
  return (h === 'lamusakitchendisplay.netlify.app' || h.endsWith('--lamusakitchendisplay.netlify.app'))
    ? 'la_musa' : 'x_pizza';
}

// Filter a /orders snapshot to the operationally-live orders for one restaurant.
// PLATFORM F2 Q2 (PLAN-F2-query-rules §2): an EXACT location match — the same predicate as the KDS feed's
// orderByChild('restaurant_id').equalTo(rid) query, so filter and query can never disagree. (Before F2 the X. Pizza KDS
// was a catch-all for every order that wasn't la_musa; access-census (a)+(b) prove no absent / unknown / third-location
// order exists before the switch.) Unknown selector → x_pizza (explicit fail-safe, no throw).
export function filterLiveOrders(orders, restaurantId = 'x_pizza') {
  const pin = restaurantId === 'la_musa' ? 'la_musa' : 'x_pizza';
  const out = {};
  for (const id of Object.keys(orders || {})) {
    const o = orders[id];
    if (!o || o.restaurant_id !== pin) continue;                     // exact location
    if (NON_LIVE_ORDER_STATUSES.has(o.status)) continue;            // status filter (unchanged)
    out[id] = o;
  }
  return out;
}

// Held/scheduled orders (NOT operationally live, but paid+confirmed) for the Programados view.
// Deliberately EXCLUDES pending_payment (an unpaid online order must never appear as prep-worthy).
export const SCHEDULED_ORDER_STATUSES = new Set(['scheduled', 'releasing']);

// Filter a /orders snapshot to the scheduled/held orders for one restaurant. Mirrors filterLiveOrders'
// EXACT location match (F2 Q2). Read-only, pure.
export function filterScheduledOrders(orders, restaurantId = 'x_pizza') {
  const pin = restaurantId === 'la_musa' ? 'la_musa' : 'x_pizza';
  const out = {};
  for (const id of Object.keys(orders || {})) {
    const o = orders[id];
    if (!o || o.restaurant_id !== pin) continue;                     // exact location
    if (!SCHEDULED_ORDER_STATUSES.has(o.status)) continue;
    out[id] = o;
  }
  return out;
}
