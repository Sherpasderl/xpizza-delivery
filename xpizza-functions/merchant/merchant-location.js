'use strict';
// H1a — the location-level handheld callables (surface-gated, device-scoped, actor/principal derived server-side):
//   setBusy        {rid, add_min ∈ {10,15,20}, dur_min ∈ {30,60,90}} | {rid, clear:true}   → order_control/{rid}/busy
//   setPause       {rid, op:'pause', dur_min ∈ {30,60,null}, reason ∈ prototype chips} | {rid, op:'resume'}
//                  → order_control/{rid}/current via the CLI transaction (merchant-control.writePause)
//   setAvailability {rid, item_key_raw, available:boolean} → the KDS's exact two-record atomic map (agotado)
const { gateAndAuth } = require('./merchant-orders');
const { writePause, writeBusy, BUSY_ADD, BUSY_DUR } = require('./merchant-control');
const { availKey } = require('../avail-key');
const V = require('./merchant-validate');

const PAUSE_REASONS = new Set(['Cocina llena', 'Falta personal', 'Problema técnico', 'Otro']);   // the prototype's chips
const PAUSE_DUR = new Map([[30, 30 * 60000], [60, 60 * 60000], [null, null]]);

function ridOr(data, HttpsError) {
  const rid = V.vRid(data && data.rid);
  if (!rid) throw new HttpsError('invalid-argument', 'bad rid');
  return rid;
}

async function setBusy(deps, auth, data) {
  const { HttpsError } = deps;
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'sign in');
  const rid = ridOr(data, HttpsError);
  if (data.clear !== true && !(BUSY_ADD.has(data.add_min) && BUSY_DUR.has(data.dur_min))) throw new HttpsError('invalid-argument', 'bad busy');
  const uid = await gateAndAuth(deps, auth, rid);
  return data.clear === true
    ? writeBusy(deps, rid, { clear: true, actor: `handheld:${uid}` })
    : writeBusy(deps, rid, { add_min: data.add_min, dur_min: data.dur_min, actor: `handheld:${uid}` });
}

async function setPause(deps, auth, data) {
  const { HttpsError } = deps;
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'sign in');
  const rid = ridOr(data, HttpsError);
  let spec;
  if (data.op === 'resume') spec = { op: 'resume', forMs: null, reason: 'reanudar' };
  else if (data.op === 'pause' && PAUSE_DUR.has(data.dur_min === undefined ? undefined : data.dur_min) && PAUSE_REASONS.has(data.reason)) spec = { op: 'pause', forMs: PAUSE_DUR.get(data.dur_min), reason: data.reason };
  else throw new HttpsError('invalid-argument', 'bad pause');
  const uid = await gateAndAuth(deps, auth, rid);
  return writePause(deps, rid, { ...spec, actor: `handheld:${uid}`, principal: uid });
}

async function setAvailability(deps, auth, data) {
  const { db, HttpsError, timestamp } = deps;
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'sign in');
  const rid = ridOr(data, HttpsError);
  const raw = data.item_key_raw;
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 120 || typeof data.available !== 'boolean') throw new HttpsError('invalid-argument', 'bad item');
  const uid = await gateAndAuth(deps, auth, rid);
  const key = availKey(raw);
  const ts = timestamp();
  await db.ref().update({
    [`restaurants/${rid}/item_availability/${key}`]: { available: data.available, updated_at: ts },
    [`restaurants/${rid}/availability_audit/${key}`]: { available: data.available, updated_at: ts, updated_by: `handheld:${uid}` },
  });
  return { ok: true, key };
}

module.exports = { setBusy, setPause, setAvailability, PAUSE_REASONS };
