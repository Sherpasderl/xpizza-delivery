'use strict';
// H1c-server (PLAN-H1c S1–S3) — the PURE half of the handheld push: which devices get a message, when, and its exact shape.
// No I/O: the callables and the two triggers (h1 block) compose these with the registry read and admin.messaging().
//   data-only messages {type: 'new_order' | 'resolved', order_id, rid}: the native HandheldMessagingService rings / stops the
//   alarm itself, so delivery never depends on the WebView or on a system notification being shown. High priority, 5 min TTL.
const { isTerminalFcmError } = require('../driver-push');

const PUSH_TTL_MS = 5 * 60 * 1000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// an FCM registration token as the device reports it: a non-empty, whitespace-free string ≤ 4096
const vToken = (t) => (typeof t === 'string' && t.length >= 1 && t.length <= 4096 && !/\s/.test(t) ? t : null);

// restaurants/{rid}/handhelds → [{uid, token}] for registered, unrevoked handhelds holding a valid token (uid-sorted)
function pushTargets(handhelds) {
  if (!isObj(handhelds)) return [];
  return Object.keys(handhelds).sort().map((uid) => ({ uid, row: handhelds[uid] }))
    .filter(({ row }) => isObj(row) && row.kind === 'handheld' && row.revoked === false && vToken(row.fcm_token))
    .map(({ uid, row }) => ({ uid, token: row.fcm_token }));
}

// S2: the status became 'new' (a fresh intake or a scheduled release), at a location whose surface is the handheld, for a served order
const becameNew = (before, after) => after === 'new' && before !== 'new';
const servedAtHandheld = (order, surface) => isObj(order) && typeof order.restaurant_id === 'string' && typeof order.routing_reason === 'string' && surface === 'handheld';
// S3: the order stopped needing an answer — its status left 'new', or a handheld answer was recorded (a reject keeps 'new')
const leftNew = (before, after) => before === 'new' && after !== 'new';
const answeredNow = (before, after) => !isObj(before) && isObj(after);

function buildDataMessage(token, type, orderId, rid) {
  if (type !== 'new_order' && type !== 'resolved') throw new Error(`bad push type ${type}`);
  return { token, data: { type, order_id: String(orderId), rid: String(rid) }, android: { priority: 'high', ttl: PUSH_TTL_MS } };
}

module.exports = { vToken, pushTargets, becameNew, servedAtHandheld, leftNew, answeredNow, buildDataMessage, isTerminalFcmError, PUSH_TTL_MS };
