'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./_fake-db');
const L = require('./merchant-location');
const { availKey } = require('../avail-key');

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const T0 = 1_700_000_000_000;
let n = 0;
const resolveBrand = async (_db, rid) => (rid.startsWith('tb_') ? 'tb' : 'unknown');
const world = () => ({ restaurants: { tb_norte: { order_surface: 'handheld', handhelds: { hh_n1: { kind: 'handheld', revoked: false } } }, tb_centro: { handhelds: { hh_c1: { kind: 'handheld', revoked: false } } } } });
const deps = (db) => ({ db, resolveBrand, HttpsError, now: () => T0, timestamp: () => T0, newOpId: () => `oc_loc_${++n}` });
const dev = (uid = 'hh_n1', rid = 'tb_norte') => ({ uid, token: { handheld: true, rid } });
const rejectsCode = (p, c) => assert.rejects(p, (e) => e.code === c);

test('setBusy: validated add/dur; actor derived server-side; clear', async () => {
  const db = createFakeDb(world());
  await L.setBusy(deps(db), dev(), { rid: 'tb_norte', add_min: 15, dur_min: 60 });
  assert.deepStrictEqual(db.get('order_control/tb_norte/busy'), { add_min: 15, until: T0 + 3600000, since: T0, by: 'handheld:hh_n1' });
  await L.setBusy(deps(db), dev(), { rid: 'tb_norte', clear: true });
  assert.strictEqual(db.get('order_control/tb_norte/busy'), null);
  for (const bad of [{ add_min: 25, dur_min: 60 }, { add_min: 15, dur_min: 120 }, { add_min: 15 }]) await rejectsCode(L.setBusy(deps(db), dev(), { rid: 'tb_norte', ...bad }), 'invalid-argument');
});

test('setPause: prototype durations and reasons; principal = device uid; resume', async () => {
  const db = createFakeDb(world());
  const r = await L.setPause(deps(db), dev(), { rid: 'tb_norte', op: 'pause', dur_min: 30, reason: 'Falta personal' });
  assert.strictEqual(r.ok, true);
  const cur = db.get('order_control/tb_norte/current');
  assert.deepStrictEqual([cur.paused, cur.until, cur.by, cur.principal, cur.reason], [true, T0 + 1800000, 'handheld:hh_n1', 'hh_n1', 'Falta personal']);
  await L.setPause(deps(db), dev(), { rid: 'tb_norte', op: 'resume' });
  assert.strictEqual(db.get('order_control/tb_norte/current/paused'), false);
  await L.setPause(deps(db), dev(), { rid: 'tb_norte', op: 'pause', dur_min: null, reason: 'Otro' });
  assert.strictEqual(db.get('order_control/tb_norte/current/until'), null);
  for (const bad of [{ op: 'pause', dur_min: 45, reason: 'Otro' }, { op: 'pause', dur_min: 30, reason: 'sin respuesta' }, { op: 'stop' }]) await rejectsCode(L.setPause(deps(db), dev(), { rid: 'tb_norte', ...bad }), 'invalid-argument');
});

test('setAvailability: the exact KDS two-record map; updated_by only in the audit record; no compat', async () => {
  const db = createFakeDb(world());
  await L.setAvailability(deps(db), dev(), { rid: 'tb_norte', item_key_raw: 'Pollo frito 3 piezas', available: false });
  const k = availKey('Pollo frito 3 piezas');
  assert.deepStrictEqual(db.get(`restaurants/tb_norte/item_availability/${k}`), { available: false, updated_at: T0 });
  assert.deepStrictEqual(db.get(`restaurants/tb_norte/availability_audit/${k}`), { available: false, updated_at: T0, updated_by: 'handheld:hh_n1' });
  await rejectsCode(L.setAvailability(deps(db), dev(), { rid: 'tb_norte', item_key_raw: '', available: false }), 'invalid-argument');
  await rejectsCode(L.setAvailability(deps(db), dev(), { rid: 'tb_norte', item_key_raw: 'x', available: 'no' }), 'invalid-argument');
});

test('all three are surface-gated and location-scoped', async () => {
  const db = createFakeDb(world());
  await rejectsCode(L.setBusy(deps(db), dev('hh_c1', 'tb_centro'), { rid: 'tb_centro', add_min: 15, dur_min: 60 }), 'failed-precondition');
  await rejectsCode(L.setPause(deps(db), dev('hh_c1', 'tb_centro'), { rid: 'tb_norte', op: 'resume' }), 'permission-denied');
  await rejectsCode(L.setAvailability(deps(db), null, { rid: 'tb_norte', item_key_raw: 'x', available: true }), 'unauthenticated');
});
