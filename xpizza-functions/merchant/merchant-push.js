'use strict';
// H1c-server (PLAN-H1c r3 + codex r4, APPROVED) — the PURE half of the handheld push. No I/O: the callables (S1, S1b) and the two
// triggers (S2, S3) in the h1 block compose these with the registry / order reads, the merchant_push_log transactions and
// admin.messaging().sendEach().
//   messages are DATA-ONLY {type: 'new_order' | 'resolved', order_id, rid, at, epoch}:
//     at    = the triggering write's event.time — the commit time of THAT transition (a stalled / retried handler keeps it)
//     epoch = the target row's push_epoch — native drops a message for another pairing (incl. a same-location re-pair)
//   high priority, 5 min TTL (TTL bounds delivery only; the native 10-min ring bound bounds ringing).
//   dead tokens: a HANDHELD-ONLY classifier (driver-push's list is NOT reused: invalid-argument is retained), cleared by a
//   compare-and-clear against the exact token sent.
const PUSH_TTL_MS = 5 * 60 * 1000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// an FCM registration token as the device reports it: a non-empty, whitespace-free string ≤ 4096
const vToken = (t) => (typeof t === 'string' && t.length >= 1 && t.length <= 4096 && !/\s/.test(t) ? t : null);
// the per-pairing push epoch native mints (a random nonce)
const vEpoch = (e) => (typeof e === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(e) ? e : null);

// restaurants/{rid}/handhelds → [{uid, token, epoch}] for registered, unrevoked handhelds holding a valid token AND epoch (uid-sorted)
function pushTargets(handhelds) {
  if (!isObj(handhelds)) return [];
  return Object.keys(handhelds).sort().map((uid) => ({ uid, row: handhelds[uid] }))
    .filter(({ row }) => isObj(row) && row.kind === 'handheld' && row.revoked === false && vToken(row.fcm_token) && vEpoch(row.push_epoch))
    .map(({ uid, row }) => ({ uid, token: row.fcm_token, epoch: row.push_epoch }));
}

// S2: the status became 'new' (a fresh intake or a scheduled release)
const becameNew = (before, after) => after === 'new' && before !== 'new';
// S3 (status): it left 'new' for a NON-NULL value (deletion is not pushed — reconcile + the feed cover it)
const leftNewTo = (before, after) => before === 'new' && after !== 'new' && after !== null && after !== undefined;
// S3 (marker): handheld_answered was created
const answeredNow = (before, after) => !isObj(before) && isObj(after);
// both: a served order at a handheld location (re-read at handler time)
const servedAtHandheld = (order, surface) => isObj(order) && typeof order.restaurant_id === 'string' && typeof order.routing_reason === 'string' && surface === 'handheld';
// S2 suppression at handler time: still new and still unanswered
const stillPending = (order) => isObj(order) && order.status === 'new' && !isObj(order.handheld_answered);

// merchant_push_log/{oid} transaction updaters (codex r4: TRANSACTIONAL and timestamp-conditional; null-first safe)
//   S2: set new_at = at only if absent or stored < at          S3: delete only if stored new_at ≤ the resolution's at
function logNewUpdate(node, at) {
  if (!isNum(at)) return undefined;
  if (node === null) return { new_at: at };
  if (!isObj(node) || !isNum(node.new_at)) return { new_at: at };
  return node.new_at < at ? { ...node, new_at: at } : undefined;
}
function logResolveUpdate(node, at) {
  if (node === null) return null;
  if (!isObj(node) || !isNum(node.new_at)) return null;
  return node.new_at <= at ? null : undefined;
}

function buildDataMessage(target, type, orderId, rid, at) {
  if (type !== 'new_order' && type !== 'resolved') throw new Error(`bad push type ${type}`);
  if (!isNum(at)) throw new Error('bad push at');
  return { token: target.token, data: { type, order_id: String(orderId), rid: String(rid), at: String(at), epoch: String(target.epoch) }, android: { priority: 'high', ttl: PUSH_TTL_MS } };
}

// HANDHELD dead-token classifier: only these two prove the TOKEN is dead (invalid-argument may be a payload problem → retained)
const HANDHELD_DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
const isDeadHandheldToken = (err) => !!(err && HANDHELD_DEAD.has(err.code));
// compare-and-clear updater on restaurants/{rid}/handhelds/{uid}: clear ONLY if the row still holds the exact token sent
function clearTokenUpdate(row, sentToken) {
  if (row === null) return null;
  if (!isObj(row) || row.fcm_token !== sentToken) return undefined;
  const { fcm_token, fcm_updated_at, ...rest } = row; void fcm_token; void fcm_updated_at;
  return rest;
}

// reconcile (S1b): the pending view of the location's orders, ids + transition times only
function pendingOf(orders, rid, surface, log) {
  if (surface !== 'handheld' || !isObj(orders)) return [];
  const L = isObj(log) ? log : {};
  return Object.keys(orders).sort().filter((oid) => {
    const o = orders[oid];
    return isObj(o) && o.restaurant_id === rid && typeof o.routing_reason === 'string' && stillPending(o);
  }).map((oid) => {
    const e = L[oid]; const o = orders[oid];
    const at = isObj(e) && isNum(e.new_at) ? e.new_at : (isNum(o.created_at) ? o.created_at : 0);
    return { order_id: oid, at };
  });
}

module.exports = { vToken, vEpoch, pushTargets, becameNew, leftNewTo, answeredNow, servedAtHandheld, stillPending, logNewUpdate, logResolveUpdate,
  buildDataMessage, isDeadHandheldToken, clearTokenUpdate, pendingOf, PUSH_TTL_MS };
