'use strict';
// H1c-server (PLAN-H1c r3 + codex r4, APPROVED) — the I/O half of the handheld push. Deps are injected:
//   {db, resolveBrand, HttpsError, now, messaging: {sendEach(messages)}, queryLocationOrders(db, rid)}
// S1   registerPush({rid, token, epoch})   device-auth; CLAIMS the token in a transaction on its index
//      merchant_push_tokens/{sha256} = {rid, uid, epoch, seq} (the single owner of record, codex r1 P1-1), compare-and-clears the
//      previous owner's row, writes the row's fcm_token / fcm_updated_at / push_epoch / push_seq, then re-reads the index: a claim
//      superseded meanwhile clears its own row and fails 'aborted' (native retries). Returns the hash native verifies.
//      unregisterPush({rid, epoch})         clears this row's token ONLY while its push_epoch still equals epoch (a stale cleanup can
//      never unregister a newer pairing), then the index entry only while it names this exact (rid, uid, seq) (codex r1 P1-2).
//      The fan-out sends to a row only while the index names its exact (rid, uid, seq): a late superseded row write never receives.
// S1b  pendingOrders({rid})                 device-auth reconcile read: fence F = the server clock BEFORE the read; pending ids with
//      their transition `at` (merchant_push_log new_at, else created_at).
// S2/S3 onStatusWritten / onAnsweredWritten: re-read guards, the timestamp-conditional push-log transaction, then a data push to
//      the location's eligible devices; dead tokens are compare-and-cleared against the exact token sent.
const crypto = require('crypto');
const P = require('./merchant-push');
const V = require('./merchant-validate');
const { authorizeHandheld } = require('./merchant-scope');

const AUTH_CODE = { unauthenticated: 'unauthenticated', forbidden: 'permission-denied', unavailable: 'unavailable' };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const val = async (db, p) => (await db.ref(p).once('value')).val();

function onlyKeys(data, allowed, HttpsError) {
  if (!isObj(data)) throw new HttpsError('invalid-argument', 'bad request');
  const extra = Object.keys(data).filter((k) => !allowed.includes(k));
  if (extra.length) throw new HttpsError('invalid-argument', `unexpected fields: ${extra.sort().join(', ')}`);
}
async function asDevice({ db, resolveBrand, HttpsError }, auth, rid) {
  const a = await authorizeHandheld(db, auth, rid, { resolveBrand });
  if (!a.ok) throw new HttpsError(AUTH_CODE[a.code] || 'permission-denied', a.code);
  return a.uid;
}
// the index entry is cleared only while it still names this EXACT registration (rid, uid, seq)
const clearIndexIfOwned = (db, hash, rid, uid, seq) => db.ref(`merchant_push_tokens/${hash}`).transaction((cur) => P.clearIndexUpdate(cur, rid, uid, seq));
// codex r1 P2-5: structured diagnostics — reason codes and counts, NEVER a token or its hash
const logOf = (deps) => (deps.log && typeof deps.log.warn === 'function' ? deps.log : console);
const warn = (deps, fields) => { try { logOf(deps).warn(JSON.stringify({ event: 'merchant_push', ...fields })); } catch (_) { /* logging never breaks a send */ } };

async function registerPush(deps, auth, data) {
  const { db, HttpsError, now } = deps;
  onlyKeys(data, ['rid', 'token', 'epoch'], HttpsError);
  const rid = V.vRid(data.rid); const token = P.vToken(data.token); const epoch = P.vEpoch(data.epoch);
  if (!rid || !token || !epoch) throw new HttpsError('invalid-argument', 'bad rid/token/epoch');
  const uid = await asDevice(deps, auth, rid);
  const hash = sha(token);
  const idx = db.ref(`merchant_push_tokens/${hash}`);
  let prev = null; let mine = null;
  await idx.transaction((cur) => { prev = cur; mine = P.claimIndex(cur, rid, uid, epoch); return mine; });   // THE serialization point
  if (isObj(prev) && (prev.rid !== rid || prev.uid !== uid) && V.vRid(prev.rid) && typeof prev.uid === 'string') {
    // ownership moves: the previous owner's row loses this token only if it still holds it under ITS claim
    await db.ref(`restaurants/${prev.rid}/handhelds/${prev.uid}`).transaction((row) => P.clearTokenUpdate(row, token, P.vSeq(prev.seq) || undefined));
  }
  const rowRef = db.ref(`restaurants/${rid}/handhelds/${uid}`);
  let old = null;
  const w = await rowRef.transaction((row) => {
    old = isObj(row) && row.fcm_token !== token && P.vToken(row.fcm_token) ? { token: row.fcm_token, seq: row.push_seq } : null;
    return P.registerRowUpdate(row, token, epoch, mine.seq, now());
  });
  if (!w || !w.committed || !isObj(w.snapshot && w.snapshot.val())) throw new HttpsError('permission-denied', 'forbidden');   // the row vanished
  if (old) await clearIndexIfOwned(db, sha(old.token), rid, uid, old.seq);                                     // this row's previous token
  if (!P.ownsIndex(await val(db, `merchant_push_tokens/${hash}`), rid, uid, mine.seq)) {
    await rowRef.transaction((row) => P.clearTokenUpdate(row, token, mine.seq));                               // superseded meanwhile
    throw new HttpsError('aborted', 'superseded');
  }
  return { ok: true, registered_token_hash: hash };
}

async function unregisterPush(deps, auth, data) {
  const { db, HttpsError } = deps;
  onlyKeys(data, ['rid', 'epoch'], HttpsError);
  const rid = V.vRid(data.rid); const epoch = P.vEpoch(data.epoch);
  if (!rid || !epoch) throw new HttpsError('invalid-argument', 'bad rid/epoch');
  const uid = await asDevice(deps, auth, rid);
  let cleared = null; let clearedSeq = null;
  await db.ref(`restaurants/${rid}/handhelds/${uid}`).transaction((row) => {
    cleared = null; clearedSeq = null;
    if (row === null) return null;
    if (!isObj(row) || row.push_epoch !== epoch) return undefined;           // a newer pairing owns the row: never touched
    const { fcm_token, fcm_updated_at, push_epoch, push_seq, ...rest } = row; void fcm_updated_at; void push_epoch;
    cleared = typeof fcm_token === 'string' ? fcm_token : ''; clearedSeq = push_seq;
    return rest;
  });
  if (cleared) await clearIndexIfOwned(db, sha(cleared), rid, uid, clearedSeq);   // never a NEWER claim of the same token
  return { ok: true, cleared: cleared !== null };
}

async function pendingOrders(deps, auth, data) {
  const { db, HttpsError, now, queryLocationOrders } = deps;
  onlyKeys(data, ['rid'], HttpsError);
  const rid = V.vRid(data.rid);
  if (!rid) throw new HttpsError('invalid-argument', 'bad rid');
  await asDevice(deps, auth, rid);
  const fence = now();                                                        // BEFORE the read (codex r3 P1-2)
  let orders; let surface;
  try { [orders, surface] = await Promise.all([queryLocationOrders(db, rid), val(db, `restaurants/${rid}/order_surface`)]); }
  catch (_) { throw new HttpsError('unavailable', 'orders unreadable'); }
  const ids = P.pendingOf(orders, rid, surface, {}).map((p) => p.order_id);
  const log = {};
  // codex r1 P2-3: only a genuinely ABSENT entry falls back to created_at; an unreadable one fails the call (native retries)
  try { await Promise.all(ids.map(async (oid) => { log[oid] = await val(db, `merchant_push_log/${oid}`); })); }
  catch (_) { throw new HttpsError('unavailable', 'push log unreadable'); }
  return { fence, pending: P.pendingOf(orders, rid, surface, log) };
}

// fan-out to the location's eligible devices; each dead token is compare-and-cleared against the token actually sent
async function sendTo(deps, rid, type, orderId, at) {
  const { db, messaging } = deps;
  const rows = await val(db, `restaurants/${rid}/handhelds`);
  // only rows the token index still names with the same (rid, uid, seq) — a superseded row never receives (codex r1 P1-1)
  const targets = []; let notOwned = 0; let indexUnreadable = 0;
  for (const t of P.pushTargets(rows)) {
    let entry;
    try { entry = await val(db, `merchant_push_tokens/${sha(t.token)}`); } catch (_) { indexUnreadable++; continue; }
    if (P.ownsIndex(entry, rid, t.uid, t.seq)) targets.push(t); else notOwned++;
  }
  if (indexUnreadable) warn(deps, { reason: 'index_unreadable', rid, order_id: orderId, type, count: indexUnreadable });
  if (!targets.length) return { sent: 0, failed: 0, cleared: 0, not_owned: notOwned };
  let res;
  try { res = await messaging.sendEach(targets.map((t) => P.buildDataMessage(t, type, orderId, rid, at))); }
  catch (e) { warn(deps, { reason: 'send_threw', rid, order_id: orderId, type, code: String((e && e.code) || 'unknown'), count: targets.length }); throw e; }
  let failed = 0; let cleared = 0; const codes = {};
  const responses = (res && Array.isArray(res.responses)) ? res.responses : [];
  for (let i = 0; i < targets.length; i++) {
    const r = responses[i];
    if (r && r.success) continue;
    failed++;
    if (r && P.isDeadHandheldToken(r.error)) {
      const t = targets[i];
      const tx = await db.ref(`restaurants/${rid}/handhelds/${t.uid}`).transaction((row) => P.clearTokenUpdate(row, t.token, t.seq));
      if (tx && tx.committed) { cleared++; await clearIndexIfOwned(db, sha(t.token), rid, t.uid, t.seq); }
    } else {
      const code = String((r && r.error && r.error.code) || 'no_response');                // retained (e.g. invalid-argument)
      codes[code] = (codes[code] || 0) + 1;
    }
  }
  if (Object.keys(codes).length) warn(deps, { reason: 'send_failed', rid, order_id: orderId, type, codes, retained: failed - cleared, cleared });
  return { sent: targets.length - failed, failed, cleared, not_owned: notOwned };
}

const atOf = (event) => { const t = Date.parse(event && event.time); return Number.isFinite(t) ? t : null; };
async function guardServed(db, order) {
  if (!isObj(order) || typeof order.restaurant_id !== 'string' || !V.vRid(order.restaurant_id)) return null;
  const surface = await val(db, `restaurants/${order.restaurant_id}/order_surface`);
  return P.servedAtHandheld(order, surface) ? order.restaurant_id : null;
}

// S2 + S3(status): /orders/{orderId}/status written
async function onStatusWritten(deps, event) {
  const { db } = deps;
  const oid = event.params.orderId;
  const before = event.data.before.val(); const after = event.data.after.val();
  const at = atOf(event);
  if (at === null) return { skipped: 'no_time' };
  if (P.becameNew(before, after)) {
    const order = await val(db, `orders/${oid}`);
    if (!P.stillPending(order)) return { skipped: 'not_pending' };            // answered / moved on before the handler ran
    const rid = await guardServed(db, order);
    if (!rid) return { skipped: 'not_served' };
    await db.ref(`merchant_push_log/${oid}`).transaction((n) => P.logNewUpdate(n, at));
    return { type: 'new_order', ...(await sendTo(deps, rid, 'new_order', oid, at)) };
  }
  if (P.leftNewTo(before, after)) {
    const order = await val(db, `orders/${oid}`);
    const rid = await guardServed(db, order);
    if (!rid) return { skipped: 'not_served' };
    await db.ref(`merchant_push_log/${oid}`).transaction((n) => P.logResolveUpdate(n, at));
    return { type: 'resolved', ...(await sendTo(deps, rid, 'resolved', oid, at)) };
  }
  return { skipped: 'no_transition' };
}

// S3(marker): /orders/{orderId}/handheld_answered created — resolves ONLY a marker-only reject (status still 'new'); an accept's
// status change is resolved by onStatusWritten (one logical resolution)
async function onAnsweredWritten(deps, event) {
  const { db } = deps;
  const oid = event.params.orderId;
  if (!P.answeredNow(event.data.before.val(), event.data.after.val())) return { skipped: 'no_transition' };
  const at = atOf(event);
  if (at === null) return { skipped: 'no_time' };
  const order = await val(db, `orders/${oid}`);
  if (!isObj(order) || order.status !== 'new') return { skipped: 'status_resolves' };
  const rid = await guardServed(db, order);
  if (!rid) return { skipped: 'not_served' };
  await db.ref(`merchant_push_log/${oid}`).transaction((n) => P.logResolveUpdate(n, at));
  return { type: 'resolved', ...(await sendTo(deps, rid, 'resolved', oid, at)) };
}

// the production location query (the indexed path the A-2 feed uses)
const queryLocationOrders = async (db, rid) => (await db.ref('orders').orderByChild('restaurant_id').equalTo(rid).once('value')).val();

module.exports = { registerPush, unregisterPush, pendingOrders, sendTo, onStatusWritten, onAnsweredWritten, queryLocationOrders, sha };
