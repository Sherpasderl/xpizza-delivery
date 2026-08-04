/**
 * Pure decision + formatting helpers for the STAFF web-push lane (Phase 2b).
 *
 * Deliberately free of any Firebase Admin / db / web-push calls so they unit-test
 * with plain `node --test staff-push.test.js` — same idiom as driver-push.js. The
 * thin db / webpush wrappers (sendStaffPush / fanoutStaffPush) and the triggers
 * (notifyStaffOnNewOrder / flushStaffPushQueue) live in index.js and compose these.
 *
 * The driver push lane (driver-push.js + sendDriverPush) is untouched — this is a
 * purely additive, parallel lane.
 */

const BRAND_LABEL = { x_pizza: 'X. Pizza', la_musa: 'La Musa' };

function brandLabel(restaurantId) {
  return BRAND_LABEL[restaurantId === 'la_musa' ? 'la_musa' : 'x_pizza'];
}

/**
 * Immediate-vs-buffer coalesce decision. The FIRST new order in a quiet period
 * pings immediately; further orders within `windowMs` of the last send buffer
 * into one grouped follow-up (sent by flushStaffPushQueue).
 *
 * `lastSentAt` null/0 means "never sent" → always immediate (quiet period).
 * The window is inclusive on the far edge (elapsed >= windowMs → immediate).
 */
function coalesceDecision({ lastSentAt, now, windowMs }) {
  if (!lastSentAt) return 'immediate';                       // never sent → quiet period
  return (now - lastSentAt >= windowMs) ? 'immediate' : 'buffer';
}

/**
 * Single new-order notification: `🔔 Nuevo pedido` / `<brand> #<n> · <customer>`.
 * The 🔔 lives only in OS notification text (matches the desktop alert language) —
 * never in the PWA's own UI. `#<n>` (display_number) and the customer degrade
 * gracefully: display_number may not be stamped yet when this fires (the stamp
 * trigger runs on the same transition, concurrently), so it's omitted if absent.
 */
function formatNewOrder(order) {
  const n = (order && Number.isFinite(order.display_number)) ? `#${order.display_number}` : null;
  const who = ((order && order.customer_name) || '').trim() || null;
  const body = [brandLabel(order && order.restaurant_id), n, who].filter(Boolean).join(' · ');
  return { title: '🔔 Nuevo pedido', body };
}

/**
 * Grouped coalesced notification from the pending buffer
 * `{ x_pizza, la_musa, ids }`: `🔔 N pedidos nuevos` / `2 X. Pizza · 1 La Musa`.
 */
function formatGrouped(pending) {
  const x = (pending && pending.x_pizza) || 0;
  const m = (pending && pending.la_musa) || 0;
  const total = x + m;
  const parts = [];
  if (x) parts.push(`${x} X. Pizza`);
  if (m) parts.push(`${m} La Musa`);
  const noun = total === 1 ? 'pedido nuevo' : 'pedidos nuevos';
  return { title: `🔔 ${total} ${noun}`, body: parts.join(' · ') };
}

module.exports = { coalesceDecision, formatNewOrder, formatGrouped, brandLabel };
