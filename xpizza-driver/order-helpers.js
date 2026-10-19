/**
 * Pure order-display helpers for the driver app. No DOM, no Firebase —
 * unit-tested with `node order-helpers.test.js` + assert (repo idiom).
 */

/**
 * The human-friendly order label shown to the driver (`#47`) so they can reference
 * an order verbally with kitchen/dispatch. Server stamps a per-restaurant daily
 * `display_number` (see the order-display-number design). DISPLAY ONLY — never a key:
 * `order_id` stays the functional id for data-attrs, sets, cache, and SDK/accept/settle calls.
 * Fallback (order created before the feature, or the brief pre-stamp window) → the `order_id`,
 * never blank, never throws.
 */
export function displayOrderLabel(o) {
  if (!o) return '';
  const n = Number(o.display_number);
  if (o.display_number != null && o.display_number !== '' && Number.isFinite(n) && n > 0) return '#' + n;
  const id = o.order_id || o.orderId;
  return id ? String(id) : '';
}

/**
 * O4 — the end-of-shift confirmation prompt. Given the driver's orders (the getDriverOrders result),
 * return the confirmation content when the driver still has orders OUT FOR DELIVERY ("en camino"), or
 * null when there are none (N = 0 → no sheet, the shift ends through the usual cuadre flow unchanged).
 * Pure: the caller (index.html) renders + escapes. `label`/`name`/`address` mirror the active card and
 * queue — same fallbacks — so the data is the live feed's, never hardwired.
 */
export function endShiftPrompt(driverOrders) {
  const pending = (driverOrders || []).filter((o) => o && o.phase === 'delivery');
  if (pending.length === 0) return null;
  const n = pending.length;
  return {
    n,
    title: `Todavía tenés ${n} ${n === 1 ? 'pedido' : 'pedidos'} en camino`,
    question: '¿Terminar turno igual?',
    orders: pending.map((o) => {
      const order = o.order || {};
      const dt = o.deliveryTask || {};
      return {
        label: displayOrderLabel({ display_number: order.display_number, order_id: order.order_id || o.orderId }),
        name: order.customer_name || dt.recipient_name || '—',
        address: order.address_detected || dt.destination_address || '—',
      };
    }),
  };
}
