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

/**
 * Send one web-push and, on a TERMINAL (dead-subscription) error, clean it up — WITHOUT ever
 * rejecting. Codex 2b REVISE fix: the terminal-cleanup remove() sits in the catch, so if IT rejects
 * (RTDB hiccup) the send would reject and throw up into notifyStaffOnNewOrder / flushStaffPushQueue —
 * and flushStaffPushQueue clears its pending buffer BEFORE sending, so a throw there would DROP the
 * already-cleared grouped ping. Here the cleanup is swallowed so this never rejects: a dead/failed
 * send becomes a logged no-op ({sent:false}), never a thrown trigger.
 *
 * Deps injected (send / removeSub / isTerminal) so it unit-tests with no firebase/web-push. The
 * index.js sendStaffPush wrapper composes this over webpush.sendNotification + a real db remove().
 * @returns {sent:true} | {sent:false, reason:'no_sub'|'failed', statusCode?}
 */
async function pushWithCleanup({ send, removeSub, isTerminal }, sub, payload) {
  if (!sub || !sub.endpoint) return { sent: false, reason: 'no_sub' };
  try {
    await send(sub, payload);
    return { sent: true };
  } catch (err) {
    if (isTerminal(err)) {
      try { await removeSub(); } catch (_) { /* cleanup MUST NOT reject the send — swallow */ }
    }
    return { sent: false, reason: 'failed', statusCode: err && err.statusCode };
  }
}

// Statuses that count as an active, on-the-board order for stuck detection (mirrors dispatch's
// board-model sectionForOrder: excludes pending_payment/scheduled/releasing pre-live AND the
// delivered/completed/cancelled terminals). Only these can be "aging" or "unassigned"-stuck.
const STUCK_LIVE_STATUSES = new Set(['new', 'preparing', 'ready', 'out_for_delivery']);

// Age anchor: when the order was placed. created_at (cash/online); materialized_at / released_at as
// fallbacks (mirrors allocateDisplayNumberOnSale's liveTs). 0 ⇒ can't age it → never stuck.
function orderAgeAnchor(order) {
  return Number(order && order.created_at) || Number(order && order.materialized_at) || Number(order && order.released_at) || 0;
}

/**
 * Is an order stuck, and how? PURE (no firebase). The caller pairs each order with its `_delivery`
 * task (dispatch's assignedDriverId keys off that task) and passes thresholds from config/push.
 *   unassigned = a DELIVERY order at 'ready' with no assigned driver, older than unassignedMs.
 *   aging      = any live (non-terminal) order older than agingMs.
 *   unassigned takes precedence (a ready unassigned delivery reports 'unassigned', not 'aging').
 * @returns { stuck:boolean, kind:'unassigned'|'aging'|null, minutes:number }
 */
function isStuck(order, deliveryTask, now, thresholds) {
  const anchor = orderAgeAnchor(order);
  if (!order || !STUCK_LIVE_STATUSES.has(order.status) || !anchor) return { stuck: false, kind: null, minutes: 0 };
  const ageMs = now - anchor;
  const minutes = Math.max(0, Math.floor(ageMs / 60000));
  const isDelivery = !order.order_type || order.order_type === 'delivery';   // absent order_type ⇒ delivery (mirror autoAssign)
  const hasDriver = !!(deliveryTask && deliveryTask.assigned_driver_id);
  if (isDelivery && order.status === 'ready' && !hasDriver && ageMs > thresholds.unassignedMs) {
    return { stuck: true, kind: 'unassigned', minutes };   // precedence
  }
  if (ageMs > thresholds.agingMs) {
    return { stuck: true, kind: 'aging', minutes };
  }
  return { stuck: false, kind: null, minutes };
}

/**
 * Alert-once state machine for the per-order stuck marker (staff_push_alerted/<id>).
 *   not-alerted + stuck  → 'alert' (fire once, then mark)
 *   alerted     + stuck  → 'skip'  (already told them)
 *   alerted     + !stuck → 'clear' (recovered → drop the marker)
 *   not-alerted + !stuck → 'skip'  (nothing to do)
 */
function stuckDedupe(prevAlerted, stuckNow) {
  if (stuckNow) return prevAlerted ? 'skip' : 'alert';
  return prevAlerted ? 'clear' : 'skip';
}

/**
 * Stuck notification text. `⚠️ Pedido #<n>` / `Lleva <m> min sin repartidor` (unassigned) or
 * `… sin completar` (aging). ⚠️ lives only in OS notification text (matches the desktop alert
 * language), never in the PWA's own UI. #<n> omitted if display_number isn't stamped.
 */
function formatStuck(order, result) {
  const n = (order && Number.isFinite(order.display_number)) ? ` #${order.display_number}` : '';
  const tail = result.kind === 'unassigned' ? 'sin repartidor' : 'sin completar';
  return { title: `⚠️ Pedido${n}`, body: `Lleva ${result.minutes} min ${tail}` };
}

module.exports = {
  coalesceDecision, formatNewOrder, formatGrouped, brandLabel, pushWithCleanup,
  isStuck, stuckDedupe, formatStuck,
};
