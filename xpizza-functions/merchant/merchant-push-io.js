'use strict';
// H1c-server (PLAN-H1c r3 + codex r4, APPROVED) — the I/O half of the handheld push. Deps are injected:
//   {db, resolveBrand, HttpsError, now, newClaim, messaging: {sendEach(messages)}, queryLocationOrders(db, rid)}
// S1   registerPush({rid, token, epoch})   device-auth; ONE transaction on merchant_push_tokens/{sha256(token)} writes the whole
//      registration {rid, uid, epoch, token, claim, at} (codex r2): `claim` is random and unique per registration; `at` is the server
//      time the REQUEST began, so a stale request landing late loses to a newer one ('aborted'). A token re-paired to another device
//      moves in that same transaction. Returns the hash native verifies before it reports push-ready.
//      unregisterPush({rid, epoch})         removes this device's entries under THIS pairing's epoch, each by an exact-claim
//      compare-and-clear (a newer pairing has another epoch / claim and is never touched).
// S1b  pendingOrders({rid})                 device-auth reconcile read: fence F = the server clock BEFORE the read; pending ids with
//      their transition `at` (merchant_push_log new_at, else created_at).
// S2/S3 onStatusWritten / onAnsweredWritten: re-read guards, the timestamp-conditional push-log transaction, then a data push to
//      the location's registered devices; a dead token clears only the exact registration (claim) it was sent under.
const crypto = require('crypto');
const P = require('./merchant-push');
const V = require('./merchant-validate');
const { authorizeHandheld } = require('./merchant-scope');

const AUTH_CODE = { unauthenticated: 'unauthenticated', forbidden: 'permission-denied', unavailable: 'unavailable' };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const newClaim = () => crypto.randomBytes(12).toString('hex');                // 96 random bits per registration
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
const idxRef = (db, hash) => db.ref(`merchant_push_tokens/${hash}`);
// a location's registrations, by the indexed rid query (".indexOn": "rid" on the server-only node)
const entriesOf = async (db, rid) => (await db.ref('merchant_push_tokens').orderByChild('rid').equalTo(rid).once('value')).val();
const clearClaim = (db, hash, claim) => idxRef(db, hash).transaction((cur) => P.clearClaimUpdate(cur, claim));
// codex r1 P2-5: structured diagnostics — reason codes and counts, NEVER a token or its hash
const logOf = (deps) => (deps.log && typeof deps.log.warn === 'function' ? deps.log : console);
const warn = (deps, fields) => { try { logOf(deps).warn(JSON.stringify({ event: 'merchant_push', ...fields })); } catch (_) { /* logging never breaks a send */ } };

async function registerPush(deps, auth, data) {
  const { db, HttpsError, now } = deps;
  const at = now();                                                           // the REQUEST's start — before any await
  onlyKeys(data, ['rid', 'token', 'epoch'], HttpsError);
  const rid = V.vRid(data.rid); const token = P.vToken(data.token); const epoch = P.vEpoch(data.epoch);
  if (!rid || !token || !epoch) throw new HttpsError('invalid-argument', 'bad rid/token/epoch');
  const uid = await asDevice(deps, auth, rid);
  const hash = sha(token);
  const entry = { rid, uid, epoch, token, claim: deps.newClaim(), at };
  const tx = await idxRef(db, hash).transaction((cur) => P.claimUpdate(cur, entry));   // THE registration: one path, one transaction
  if (!tx || !tx.committed) throw new HttpsError('aborted', 'superseded');           // a newer registration of this token stands
  return { ok: true, registered_token_hash: hash };
}

async function unregisterPush(deps, auth, data) {
  const { db, HttpsError } = deps;
  onlyKeys(data, ['rid', 'epoch'], HttpsError);
  const rid = V.vRid(data.rid); const epoch = P.vEpoch(data.epoch);
  if (!rid || !epoch) throw new HttpsError('invalid-argument', 'bad rid/epoch');
  const uid = await asDevice(deps, auth, rid);
  let entries;
  try { entries = await entriesOf(db, rid); } catch (_) { throw new HttpsError('unavailable', 'registrations unreadable'); }
  let cleared = 0;
  for (const m of P.unregisterMatches(entries, rid, uid, epoch)) {
    const t = await clearClaim(db, m.hash, m.claim);
    if (t && t.committed && t.snapshot.val() === null) cleared++;
  }
  return { ok: true, cleared: cleared > 0 };
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
  let entries; let rows;
  try { [entries, rows] = await Promise.all([entriesOf(db, rid), val(db, `restaurants/${rid}/handhelds`)]); }
  catch (e) { warn(deps, { reason: 'targets_unreadable', rid, order_id: orderId, type }); throw e; }
  const targets = P.targetsOf(entries, rows, rid);
  if (!targets.length) return { sent: 0, failed: 0, cleared: 0 };
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
      const t = await clearClaim(db, targets[i].hash, targets[i].claim);              // only THAT registration; a newer one stays
      if (t && t.committed && t.snapshot.val() === null) cleared++;
    } else {
      const code = String((r && r.error && r.error.code) || 'no_response');                // retained (e.g. invalid-argument)
      codes[code] = (codes[code] || 0) + 1;
    }
  }
  if (Object.keys(codes).length) warn(deps, { reason: 'send_failed', rid, order_id: orderId, type, codes, retained: failed - cleared, cleared });
  return { sent: targets.length - failed, failed, cleared };
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

module.exports = { registerPush, unregisterPush, pendingOrders, sendTo, onStatusWritten, onAnsweredWritten, queryLocationOrders, sha, newClaim };
