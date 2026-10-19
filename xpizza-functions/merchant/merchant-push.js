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
// ── registration (codex H1c-server r2/r3): ONE record per token — merchant_push_tokens/{sha256(token)} =
//    {rid, uid, epoch, token, claim, gen}. It is the only registration record (rows carry no token), so every registration change is
//    ONE transaction on ONE path: nothing is ever half-written across paths.
//      claim  a random id unique per registration (never reused, so a delayed cleanup of an old registration can never match a new one)
//      gen    the device's server-issued pair_gen (pairDevice's counter), read from the registry row by authorization — the
//             AUTHORITATIVE pairing order. An older pairing's request never replaces a newer pairing's registration, whatever the
//             clocks or arrival order; the same generation (the same device re-registering) replaces.
const CLAIM_RE = /^[a-f0-9]{24}$/;
const vClaim = (v) => (typeof v === 'string' && CLAIM_RE.test(v) ? v : null);
const vGen = (v) => (Number.isSafeInteger(v) && v >= 1 ? v : null);   // safe integers only (codex r4)
// does the stored entry belong to a NEWER pairing than generation `gen`?
function isNewer(cur, gen) {
  return isObj(cur) && vGen(cur.gen) !== null && cur.gen > gen;
}
// the register transaction: a newer pairing's registration stands (abort); otherwise this entry replaces whatever was there
function claimUpdate(cur, entry) {
  return isNewer(cur, entry.gen) ? undefined : entry;
}
// compare-and-clear: only the EXACT registration (its claim) is removed; absent → no-op
function clearClaimUpdate(cur, claim) {
  if (cur === null) return null;
  return isObj(cur) && vClaim(claim) !== null && cur.claim === claim ? null : undefined;
}
// the fan-out targets of a location: valid entries for this rid whose uid is a registered, unrevoked handheld row; uid then hash order
function targetsOf(entries, rows, rid) {
  if (!isObj(entries)) return [];
  const R = isObj(rows) ? rows : {};
  return Object.keys(entries).map((hash) => ({ hash, e: entries[hash] }))
    .filter(({ e }) => isObj(e) && e.rid === rid && typeof e.uid === 'string' && vToken(e.token) && vEpoch(e.epoch) && vClaim(e.claim))
    .filter(({ e }) => { const row = R[e.uid]; return isObj(row) && row.kind === 'handheld' && row.revoked === false; })
    .sort((a, b) => (a.e.uid < b.e.uid ? -1 : a.e.uid > b.e.uid ? 1 : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
    .map(({ hash, e }) => ({ hash, uid: e.uid, token: e.token, epoch: e.epoch, claim: e.claim }));
}
// unregister: this device's entries under THIS pairing's epoch (a newer pairing's entry has another epoch and is never matched)
function unregisterMatches(entries, rid, uid, epoch) {
  if (!isObj(entries)) return [];
  return Object.keys(entries).sort().filter((h) => { const e = entries[h]; return isObj(e) && e.rid === rid && e.uid === uid && e.epoch === epoch && vClaim(e.claim); })
    .map((h) => ({ hash: h, claim: entries[h].claim }));
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

module.exports = { vToken, vEpoch, vClaim, vGen, isNewer, claimUpdate, clearClaimUpdate, targetsOf, unregisterMatches, becameNew, leftNewTo, answeredNow, servedAtHandheld, stillPending, logNewUpdate, logResolveUpdate,
  buildDataMessage, isDeadHandheldToken, pendingOf, PUSH_TTL_MS };
