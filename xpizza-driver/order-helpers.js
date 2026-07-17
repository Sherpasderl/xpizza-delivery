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
