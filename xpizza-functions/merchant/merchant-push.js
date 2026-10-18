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
const vSeq = (v) => (Number.isInteger(v) && v >= 1 ? v : null);
// candidate rows only: the fan-out sends to a candidate ONLY while the token index still names it with the same seq (ownsIndex)
function pushTargets(handhelds) {
  if (!isObj(handhelds)) return [];
  return Object.keys(handhelds).sort().map((uid) => ({ uid, row: handhelds[uid] }))
    .filter(({ row }) => isObj(row) && row.kind === 'handheld' && row.revoked === false && vToken(row.fcm_token) && vEpoch(row.push_epoch) && vSeq(row.push_seq))
    .map(({ uid, row }) => ({ uid, token: row.fcm_token, epoch: row.push_epoch, seq: row.push_seq }));
}

// ── token ownership (codex H1c-server r1 P1-1/P1-2): merchant_push_tokens/{sha256(token)} = {rid, uid, epoch, seq} is the ONE owner
// of record. A claim is a transaction that bumps seq; the row carries the same push_seq; every send and every index clear compares
// the EXACT (rid, uid, seq), so a superseded registration can neither receive pushes nor erase a newer owner's entry.
function claimIndex(cur, rid, uid, epoch) {
  const prevSeq = isObj(cur) && vSeq(cur.seq) ? cur.seq : 0;
  return { rid, uid, epoch, seq: prevSeq + 1 };
}
const ownsIndex = (entry, rid, uid, seq) => isObj(entry) && entry.rid === rid && entry.uid === uid && vSeq(seq) !== null && entry.seq === seq;
// index compare-and-clear: null when absent (no-op) or owned by exactly (rid, uid, seq); otherwise abort (a newer owner stays)
function clearIndexUpdate(cur, rid, uid, seq) {
  if (cur === null) return null;
  return ownsIndex(cur, rid, uid, seq) ? null : undefined;
}
// the row write of a winning claim. null-first safe: a null read proposes null (RTDB re-runs with the real value when the row
// exists; a truly absent row stays absent and the caller refuses); a malformed row aborts
function registerRowUpdate(row, token, epoch, seq, at) {
  if (row === null) return null;
  if (!isObj(row)) return undefined;
  return { ...row, fcm_token: token, fcm_updated_at: at, push_epoch: epoch, push_seq: seq };
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
// clears the row's token only while it is still the token sent AND (when given) the same registration seq
function clearTokenUpdate(row, sentToken, seq) {
  if (row === null) return null;
  if (!isObj(row) || row.fcm_token !== sentToken) return undefined;
  if (seq !== undefined && row.push_seq !== seq) return undefined;
  const { fcm_token, fcm_updated_at, push_seq, ...rest } = row; void fcm_token; void fcm_updated_at; void push_seq;
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

module.exports = { vToken, vEpoch, vSeq, claimIndex, ownsIndex, clearIndexUpdate, registerRowUpdate, pushTargets, becameNew, leftNewTo, answeredNow, servedAtHandheld, stillPending, logNewUpdate, logResolveUpdate,
  buildDataMessage, isDeadHandheldToken, clearTokenUpdate, pendingOf, PUSH_TTL_MS };
