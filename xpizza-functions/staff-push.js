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

// B3 (PLAN-brand-agnostic-convergence r9, audit G4): every restaurant is counted and labelled FROM DATA — no restaurant id or name here.
// The label is the restaurant's identity display_name, else its name, else a neutral word: an unknown / unreadable identity never
// borrows another restaurant's name.
const { brandText } = require('./pickup-label');
const NEUTRAL_LABEL = 'Restaurante';
const RID_RE = /^[a-z0-9_]{1,40}$/;
const pushRidOf = (order) => (order && typeof order.restaurant_id === 'string' && RID_RE.test(order.restaurant_id) ? order.restaurant_id : 'unknown');
// the pending buffer is FLAT — { <rid>: n, …, ids: [...] } — exactly the shape written before B3 (Codex #421 ruling, 6c): every numeric
// top-level key is a restaurant's count, so an older flusher still reads the founders' counts during a mixed-version deploy.
function pendingCounts(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  const add = (k, v) => { if (Number.isSafeInteger(v) && v > 0 && RID_RE.test(k)) out[k] = (out[k] || 0) + v; };
  for (const [k, v] of Object.entries(p)) if (k !== 'ids') add(k, v);
  return out;
}
function addPending(p, rid, orderId) {
  const by = pendingCounts(p); by[rid] = (by[rid] || 0) + 1;
  return { ...by, ids: [...((p && Array.isArray(p.ids)) ? p.ids : []), orderId] };
}
// { rid → label } from identity: display_name → name → NEUTRAL_LABEL (a read failure or an unshowable text never fails the push)
async function staffLabels(db, rids) {
  const out = {};
  await Promise.all([...new Set(rids)].map(async (rid) => {
    let label = null;
    if (RID_RE.test(rid)) {
      try {
        const id = (await db.ref(`restaurants/${rid}/identity`).once('value')).val() || {};
        label = brandText(id.display_name) || brandText(id.name);
      } catch (_) { label = null; }
    }
    out[rid] = label || NEUTRAL_LABEL;
  }));
  return out;
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
 * Single new-order notification: `Nuevo pedido` / `<label> · #<n> · <customer>` (no emoji: rule 8, Codex #421). `#<n>` (display_number) and the customer degrade
 * gracefully: display_number may not be stamped yet when this fires (the stamp
 * trigger runs on the same transition, concurrently), so it's omitted if absent.
 */
function formatNewOrder(order, label) {
  const n = (order && Number.isFinite(order.display_number)) ? `#${order.display_number}` : null;
  const who = ((order && order.customer_name) || '').trim() || null;
  const body = [label || NEUTRAL_LABEL, n, who].filter(Boolean).join(' · ');
  return { title: 'Nuevo pedido', body };   // no emoji (rule 8, Codex #421)
}

/**
 * Grouped coalesced notification from the FLAT pending buffer ({ <rid>: n, ids }) and the { rid → label } map:
 * `N pedidos nuevos` / `2 Casa A · 1 Casa B` — most orders first, then by label (no emoji: rule 8, Codex #421).
 */
function formatGrouped(pending, labels = {}) {
  const by = pendingCounts(pending);
  const rows = Object.entries(by).map(([rid, k]) => ({ k, label: labels[rid] || NEUTRAL_LABEL })).sort((a, b) => b.k - a.k || a.label.localeCompare(b.label));
  const total = rows.reduce((t, r) => t + r.k, 0);
  const noun = total === 1 ? 'pedido nuevo' : 'pedidos nuevos';
  return { title: `${total} ${noun}`, body: rows.map((r) => `${r.k} ${r.label}`).join(' · ') };
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

/**
 * Compare-and-delete updater for a dead-subscription cleanup, run inside an RTDB transaction on
 * `staff_push/<uid>`. Dead-sub cleanup must NOT unconditionally remove the node: a concurrent client
 * refresh may have ROTATED to a fresh endpoint between the send's read and this cleanup, and that
 * replacement must survive. So delete (return null) ONLY when the node still holds the exact
 * subscription we sent to (same endpoint); otherwise abort the transaction (return undefined), leaving
 * whatever is there — a replacement, or an already-removed node — intact.
 */
function staffPushCleanupUpdater(sentEndpoint) {
  return (cur) => {
    // RTDB runs the updater FIRST with the locally-CACHED value, which is null for an existing-but-uncached
    // record. Returning undefined there ABORTS the transaction (no retry), so a dead sub would never be cleaned.
    // Return null on the null case so the transaction proceeds and re-runs against the REAL server value, where
    // the endpoint check below decides. (A genuinely-absent record commits a harmless no-op null.)
    if (cur == null) return null;
    if (cur.subscription && sentEndpoint && cur.subscription.endpoint === sentEndpoint) return null; // dead → delete
    return undefined;   // a populated record with a DIFFERENT endpoint = a concurrent replacement → abort, keep it
  };
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
 *   aging      = a live order older than agingMs that NOBODY IS CURRENTLY MOVING — i.e. anything
 *                except a delivery already out_for_delivery in a driver's hands.
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
  // An order a driver already has, and is out delivering, is not stuck — it is being delivered.
  // Ageing it anyway fired "⚠️ lleva N min sin completar" at the owner for orders that were moving
  // normally, which is how the alert became noise. Everything else past agingMs still stands: an
  // order the kitchen has not finished, a pickup nobody collected, a ready order whose assigned
  // driver never showed up.
  const enRoute = isDelivery && hasDriver && order.status === 'out_for_delivery';
  if (ageMs > thresholds.agingMs && !enRoute) {
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
 * `… sin salir` (aging). "sin salir" — not "sin completar" — because the aging alert now only fires
 * for orders that have NOT left yet; one already out for delivery no longer alerts at all. ⚠️ lives
 * only in OS notification text (matches the desktop alert language), never in the PWA's own UI.
 * #<n> omitted if display_number isn't stamped.
 */
function formatStuck(order, result) {
  const n = (order && Number.isFinite(order.display_number)) ? ` #${order.display_number}` : '';
  const tail = result.kind === 'unassigned' ? 'sin repartidor' : 'sin salir';
  return { title: `⚠️ Pedido${n}`, body: `Lleva ${result.minutes} min ${tail}` };
}

/**
 * S2 (PLAN-brand-agnostic-convergence r9 §3-S, #334-4; Codex #414): the fan-out RECIPIENTS = the subscribed uids that are CURRENT
 * dispatchers at send time — `dispatchers/{uid}` exists, the predicate of index.js authorizeDispatcherActionWithUid and of the
 * dispatchers rules. A staff push carries a customer's name, so:
 *   yes      (exists)          → a recipient
 *   no       (confirmed absent) → not a recipient, and its staff_push/{uid} is PRUNED (revocation) — compare-and-delete on the exact
 *                                 record the fan-out read, so a concurrent replacement / re-subscribe (any change) is kept
 *   unknown  (the read failed)  → not a recipient, never deleted (fail closed both ways)
 * `subs` is the staff_push map the fan-out read. Logs carry a fixed category and counts only (no uid, no order id).
 */
async function staffRecipients(db, subs) {
  const uids = Object.keys(subs || {});
  const m = await Promise.all(uids.map((uid) => db.ref(`dispatchers/${uid}`).once('value').then((sn) => (sn.exists() ? 'yes' : 'no'), () => 'unknown')));
  const absent = uids.filter((_, i) => m[i] === 'no');
  if (absent.length) {
    const r = await Promise.allSettled(absent.map((uid) => db.ref(`staff_push/${uid}`).transaction(staffPushRevokeUpdater(subs[uid]))));
    const pruned = r.filter((x) => x.status === 'fulfilled' && x.value && x.value.committed).length;
    try { console.log('staff_push_revoked', JSON.stringify({ confirmed_absent: absent.length, pruned })); } catch (_) { /* logging never blocks the fan-out */ }
  }
  return uids.filter((_, i) => m[i] === 'yes');
}

// Compare-and-delete for a CONFIRMED non-dispatcher: delete only while the node still holds exactly the record the fan-out read.
// RTDB runs the updater first on the local cache (null for an uncached node): returning null there lets the transaction proceed to the
// server value, where the comparison decides (the staffPushCleanupUpdater pattern); any difference aborts and keeps the record.
function staffPushRevokeUpdater(readRecord) {
  const want = JSON.stringify(readRecord === undefined ? null : readRecord);
  return (cur) => {
    if (cur == null) return null;
    return JSON.stringify(cur) === want ? null : undefined;
  };
}

module.exports = {
  coalesceDecision, formatNewOrder, formatGrouped, pushWithCleanup, staffPushCleanupUpdater,
  pushRidOf, pendingCounts, addPending, staffLabels, NEUTRAL_LABEL,
  isStuck, stuckDedupe, formatStuck, staffRecipients, staffPushRevokeUpdater,
};
