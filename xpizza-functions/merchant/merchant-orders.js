'use strict';
// H1a T4 — the order-action runner behind merchantAccept / MoreTime / Ready / Handed / Reject, plus merchantOrderState.
// Dependencies are injected ({db, resolveBrand, now, HttpsError}) so the interleavings are unit-testable; index.js wires them.
//
// Flow: validate → surface === 'handheld' (else failed-precondition) → authorizeHandheld → receipt pre-check (a matching
// receipt returns its stored result BEFORE any mutable read, so a lost-response replay never turns into driver_assigned)
// → más tiempo only: a fresh delivery-task read that fails CLOSED (missing / malformed / unreadable = assigned)
// → ONE runTransaction(orders/{oid}) over the pure applyAction → the result.
// Gate, auth and input problems THROW HttpsError; business outcomes (stale_state, op_conflict, …) are RETURNED.
const crypto = require('crypto');
const V = require('./merchant-validate');
const { surfaceOf } = require('./merchant-gate');
const { authorizeHandheld } = require('./merchant-scope');
const { txnUpdate } = require('./merchant-transitions');

const AUTH_CODE = { unauthenticated: 'unauthenticated', forbidden: 'permission-denied', unavailable: 'unavailable' };

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const hashOf = (payload) => crypto.createHash('sha256').update(canonical(payload)).digest('hex');

// Validate the request into { rid, oid, op_id, payload } or throw invalid-argument.
function parse(action, data, HttpsError) {
  const d = data || {};
  const bad = (what) => { throw new HttpsError('invalid-argument', `bad ${what}`); };
  const rid = V.vRid(d.rid) || bad('rid');
  const oid = V.vOid(d.oid) || bad('oid');
  const op_id = V.vOpId(d.op_id) || bad('op_id');
  let payload;
  switch (action) {
    case 'accept': { const n = V.vPrep(d.prep_min); if (n === null) bad('prep_min'); payload = { prep_min: n }; break; }
    case 'more': { const a = V.vAdd(d.add_min); if (a === null) bad('add_min'); payload = { add_min: a }; break; }
    case 'ready': case 'handed': payload = {}; break;
    case 'reject': {
      const reason = V.vReason(d.reason) || bad('reason');
      const note = V.vNote(d.note); if (note === undefined) bad('note');
      const gone_items = V.vItems(d.gone_items); if (gone_items === undefined) bad('gone_items');
      payload = { reason, note, gone_items };
      break;
    }
    default: bad('action');
  }
  return { rid, oid, op_id, payload };
}

async function gateAndAuth({ db, resolveBrand, HttpsError }, auth, rid) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'sign in');
  let surface;
  try { surface = await surfaceOf(db, rid); } catch (_) { throw new HttpsError('unavailable', 'surface unreadable'); }
  if (surface !== 'handheld') throw new HttpsError('failed-precondition', 'not_enabled');
  const a = await authorizeHandheld(db, auth, rid, { resolveBrand });
  if (!a.ok) throw new HttpsError(AUTH_CODE[a.code] || 'permission-denied', a.code);
  return a.uid;
}

async function readVal(db, path) { return (await db.ref(path).once('value')).val(); }

// true unless the delivery task is a readable object whose assigned_driver_id is null/absent (fail closed).
async function driverAssigned(db, oid) {
  try {
    const t = await readVal(db, `tasks/${oid}_delivery`);
    if (!t || typeof t !== 'object' || Array.isArray(t)) return true;
    return t.assigned_driver_id != null;
  } catch (_) { return true; }
}

// Advisor (H1b copy rulings): what the handheld may know about THIS order's pickup driver — the first name, whether they are at the
// restaurant, and their fresh location (the device computes a traffic-aware ETA client-side, like the tracker). Only the driver
// assigned to THIS order's OPEN pickup; never other drivers or orders; no phone. Every unknown fails closed (null / false).
const STALE_PING_MS = 90 * 1000;                                   // = index.js STALE_PING_MS / dispatch STALE_PING_THRESHOLD_S
const PICKUP_OPEN = new Set(['assigned', 'accepted', 'in_progress']);
const NO_DRIVER = Object.freeze({ driver_first_name: null, driver_at_restaurant: false, driver_location: null, pickup_location: null });
async function pickupDriver(db, oid, now) {
  try {
    const pickup = await readVal(db, `tasks/${oid}_pickup`);
    const id = pickup && typeof pickup === 'object' ? pickup.assigned_driver_id : null;
    if (typeof id !== 'string' || !id || !PICKUP_OPEN.has(pickup.status)) return NO_DRIVER;
    const d = await readVal(db, `drivers/${id}`);
    if (!d || typeof d !== 'object' || Array.isArray(d)) return NO_DRIVER;
    const first = typeof d.name === 'string' ? (d.name.trim().split(/\s+/)[0] || null) : null;
    const onThisPickup = d.current_task_id === `${oid}_pickup`;
    const nowMs = now();                              // codex r2 P2: the clock is read AFTER the reads, never before them
    const fresh = typeof d.last_ping === 'number' && Number.isFinite(d.last_ping) && nowMs - d.last_ping >= 0 && nowMs - d.last_ping <= STALE_PING_MS;
    const coords = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    const location = fresh && coords(d.lat, d.lng) ? { lat: d.lat, lng: d.lng, at: d.last_ping } : null;
    // advisor: the ETA destination = THIS order's own pickup hub (the task's destination), only together with a live location
    const dest = location && coords(pickup.destination_lat, pickup.destination_lng) ? { lat: pickup.destination_lat, lng: pickup.destination_lng } : null;
    return {
      driver_first_name: first ? first.slice(0, 40) : null,
      driver_at_restaurant: d.status === 'at_restaurant' && onThisPickup,
      driver_location: location,
      pickup_location: dest,
    };
  } catch (_) { return NO_DRIVER; }
}

// { outcome, fresh }: fresh = THIS call committed the order transaction (false for a receipt replay or an abort). A-R1's
// runReject runs the cancel core only on a fresh reject, so a replay never re-executes it.
async function runOrderActionDetailed(deps, auth, action, data) {
  const { db, now, HttpsError } = deps;
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'sign in');
  const { rid, oid, op_id, payload } = parse(action, data, HttpsError);
  const uid = await gateAndAuth(deps, auth, rid);
  const payloadHash = hashOf(payload);

  let prior;
  try { prior = await readVal(db, `orders/${oid}/handheld_ops/${op_id}`); } catch (_) { throw new HttpsError('unavailable', 'receipt unreadable'); }
  if (prior) {
    return { fresh: false, outcome: (prior.by === uid && prior.action === action && prior.payload_hash === payloadHash) ? prior.result : { ok: false, code: 'op_conflict' } };
  }
  if (action === 'more') {
    let type;
    try { type = await readVal(db, `orders/${oid}/order_type`); } catch (_) { throw new HttpsError('unavailable', 'order unreadable'); }
    if (type !== 'pickup' && await driverAssigned(db, oid)) return { fresh: false, outcome: { ok: false, code: 'driver_assigned' } };
  }

  const box = { outcome: null, committed: false };
  const req = { action, op_id, rid, payload };
  const ctx = { uid, nowMs: now(), payloadHash };
  const tx = await db.ref(`orders/${oid}`).transaction((node) => txnUpdate(node, req, ctx, box));
  return { fresh: !!(tx && tx.committed && box.committed), outcome: box.outcome };
}
async function runOrderAction(deps, auth, action, data) {
  return (await runOrderActionDetailed(deps, auth, action, data)).outcome;
}
// The updater (merchant-transitions.txnUpdate) is null-first safe; see its comment.

async function orderState(deps, auth, data) {
  const { db, HttpsError } = deps;
  const d = data || {};
  const rid = V.vRid(d.rid); const oid = V.vOid(d.oid);
  if (!rid || !oid) throw new HttpsError('invalid-argument', 'bad rid/oid');
  await gateAndAuth(deps, auth, rid);
  let o;
  try { o = await readVal(db, `orders/${oid}`); } catch (_) { throw new HttpsError('unavailable', 'order unreadable'); }
  if (!o || o.restaurant_id !== rid || typeof o.routing_reason !== 'string') throw new HttpsError('failed-precondition', 'not_served');
  // the location's prep base, refreshed on every detail open (advisor ruling); invalid or unreadable → null (the device keeps its
  // persisted base — pairing guaranteed one)
  let base = null;
  try { base = V.vPrepBase(await readVal(db, `restaurants/${rid}/identity/prep_default_min`)); } catch (_) { base = null; }
  const pickupOrder = o.order_type === 'pickup';
  const driver = pickupOrder ? NO_DRIVER : await pickupDriver(db, oid, deps.now);
  return { driver_assigned: pickupOrder ? false : await driverAssigned(db, oid), prep_default_min: base, ...driver };
}

module.exports = { runOrderAction, runOrderActionDetailed, orderState, gateAndAuth, hashOf, canonical };
