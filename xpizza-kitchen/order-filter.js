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
//   La Musa KDS: strict — only restaurant_id === 'la_musa'.
//   X. Pizza KDS: everything that ISN'T explicitly la_musa (x_pizza, absent, '', any legacy) →
//                 airtight no-op on today's data.
// Unknown selector → x_pizza (explicit fail-safe, no throw). Null order values pass through
// (preserves the current callback contract; RTDB can't store null anyway).
export function filterLiveOrders(orders, restaurantId = 'x_pizza') {
  const pin = restaurantId === 'la_musa' ? 'la_musa' : 'x_pizza';
  const out = {};
  for (const id of Object.keys(orders || {})) {
    const o = orders[id];
    if (o && NON_LIVE_ORDER_STATUSES.has(o.status)) continue;       // status filter (unchanged)
    if (o && (pin === 'la_musa' ? o.restaurant_id !== 'la_musa' : o.restaurant_id === 'la_musa')) continue;
    out[id] = o;
  }
  return out;
}

// Held/scheduled orders (NOT operationally live, but paid+confirmed) for the Programados view.
// Deliberately EXCLUDES pending_payment (an unpaid online order must never appear as prep-worthy).
export const SCHEDULED_ORDER_STATUSES = new Set(['scheduled', 'releasing']);

// Filter a /orders snapshot to the scheduled/held orders for one restaurant. Mirrors filterLiveOrders'
// restaurant match exactly (la_musa strict; x_pizza = everything not-la_musa). Read-only, pure.
export function filterScheduledOrders(orders, restaurantId = 'x_pizza') {
  const pin = restaurantId === 'la_musa' ? 'la_musa' : 'x_pizza';
  const out = {};
  for (const id of Object.keys(orders || {})) {
    const o = orders[id];
    if (!o || !SCHEDULED_ORDER_STATUSES.has(o.status)) continue;
    if (pin === 'la_musa' ? o.restaurant_id !== 'la_musa' : o.restaurant_id === 'la_musa') continue;
    out[id] = o;
  }
  return out;
}
