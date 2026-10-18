'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./_fake-db');
const C = require('./merchant-control');
const OCC = require('../tools/order-control-core');

const T0 = 1_700_000_000_000;
let seq = 0;
const deps = (db, nowMs = T0) => ({ db, now: () => nowMs, timestamp: () => nowMs, newOpId: () => `oc_test_${++seq}` });

test('writePause runs the CLI transaction unchanged: version, current, event row, op id; busy preserved', async () => {
  const db = createFakeDb({ order_control: { tb_norte: { busy: { add_min: 15, until: T0 + 3600000, since: T0, by: 'x' } } } });
  const r = await C.writePause(deps(db), 'tb_norte', { op: 'pause', forMs: 30 * 60000, reason: 'Cocina llena', actor: 'handheld:hh_n1', principal: 'hh_n1' });
  assert.strictEqual(r.ok, true); assert.ok(r.op_id);
  const n = db.get('order_control/tb_norte');
  assert.deepStrictEqual({ paused: n.current.paused, until: n.current.until, version: n.current.version, op_id: n.current.op_id }, { paused: true, until: T0 + 1800000, version: 1, op_id: r.op_id });
  assert.deepStrictEqual(n.events[r.op_id].to, { paused: true, until: T0 + 1800000 });
  assert.deepStrictEqual(n.busy, { add_min: 15, until: T0 + 3600000, since: T0, by: 'x' });
  // the same state again → no-op, nothing written
  const again = await C.writePause(deps(db), 'tb_norte', { op: 'pause', forMs: 30 * 60000, reason: 'x', actor: 'a', principal: 'p' });
  assert.strictEqual(again.noop, true);
  assert.strictEqual(db.get('order_control/tb_norte/current/version'), 1);
});

test('indefinite pause (forMs null) and resume', async () => {
  const db = createFakeDb({});
  await C.writePause(deps(db), 'tb_norte', { op: 'pause', forMs: null, reason: 'Falta personal', actor: 'a', principal: 'p' });
  assert.strictEqual(db.get('order_control/tb_norte/current/until'), null);
  assert.strictEqual(db.get('order_control/tb_norte/current/paused'), true);
  await C.writePause(deps(db), 'tb_norte', { op: 'resume', forMs: null, reason: 'reanudar', actor: 'a', principal: 'p' });
  assert.strictEqual(db.get('order_control/tb_norte/current/paused'), false);
  assert.strictEqual(db.get('order_control/tb_norte/current/version'), 2);
});

test('concurrent: a CLI pause lands between our read and commit → we refuse (superseded), no double event', async () => {
  const db = createFakeDb({});
  db.hooks.onTxn = async () => {
    const node = db.get('order_control/tb_norte');
    const plan = OCC.planChange({ node, args: { op: 'pause', rid: 'tb_norte', forMs: 3600000, untilMs: null, expectVersion: null }, serverNow: T0 });
    await db.ref('order_control/tb_norte').transaction(OCC.txnCallback({ expectedVersion: plan.expectedVersion, to: plan.to, opId: 'oc_cli_1', actor: 'owner', principal: 'owner@x', reason: 'cli', timestamp: T0 }));
  };
  const r = await C.writePause(deps(db), 'tb_norte', { op: 'pause', forMs: 1800000, reason: 'Cocina llena', actor: 'handheld:hh', principal: 'hh' });
  assert.deepStrictEqual([r.ok, r.code], [false, 'superseded']);
  const n = db.get('order_control/tb_norte');
  assert.strictEqual(n.current.op_id, 'oc_cli_1');
  assert.deepStrictEqual(Object.keys(n.events), ['oc_cli_1']);
});

test('concurrent: a busy write and a pause both survive (separate children, same node transaction)', async () => {
  const db = createFakeDb({});
  db.hooks.onTxn = async () => { await C.writeBusy(deps(db), 'tb_norte', { add_min: 20, dur_min: 90, actor: 'handheld:hh2' }); };
  await C.writePause(deps(db), 'tb_norte', { op: 'pause', forMs: null, reason: 'x', actor: 'a', principal: 'p' });
  const n = db.get('order_control/tb_norte');
  assert.strictEqual(n.current.paused, true);
  assert.deepStrictEqual(n.busy, { add_min: 20, until: T0 + 90 * 60000, since: T0, by: 'handheld:hh2' });
});

test('writeBusy: validated values only; preserves current+events byte-identically; clear removes only busy', async () => {
  const db = createFakeDb({});
  await C.writePause(deps(db), 'tb_norte', { op: 'pause', forMs: null, reason: 'x', actor: 'a', principal: 'p' });
  const before = JSON.stringify({ c: db.get('order_control/tb_norte/current'), e: db.get('order_control/tb_norte/events') });
  await C.writeBusy(deps(db), 'tb_norte', { add_min: 15, dur_min: 60, actor: 'handheld:hh' });
  assert.strictEqual(JSON.stringify({ c: db.get('order_control/tb_norte/current'), e: db.get('order_control/tb_norte/events') }), before);
  await C.writeBusy(deps(db), 'tb_norte', { clear: true, actor: 'handheld:hh' });
  assert.strictEqual(db.get('order_control/tb_norte/busy'), null);
  assert.strictEqual(JSON.stringify({ c: db.get('order_control/tb_norte/current'), e: db.get('order_control/tb_norte/events') }), before);
  for (const bad of [{ add_min: 5, dur_min: 60 }, { add_min: 15, dur_min: 45 }, { add_min: '15', dur_min: 60 }]) {
    await assert.rejects(() => C.writeBusy(deps(db), 'tb_norte', { ...bad, actor: 'a' }), /bad busy/);
  }
});

test('resumeIfOwn (no-answer undo): resumes only its OWN pause; a newer pause by someone else stays', async () => {
  const db = createFakeDb({});
  const mine = await C.writePause(deps(db), 'tb_norte', { op: 'pause', forMs: null, reason: 'sin respuesta', actor: 'sistema', principal: 'sistema' });
  assert.deepStrictEqual(await C.resumeIfOwn(deps(db), 'tb_norte', mine.op_id), { ok: true, resumed: true });
  assert.strictEqual(db.get('order_control/tb_norte/current/paused'), false);
  const sys = await C.writePause(deps(db), 'tb_norte', { op: 'pause', forMs: null, reason: 'sin respuesta', actor: 'sistema', principal: 'sistema' });
  await C.writePause(deps(db), 'tb_norte', { op: 'pause', forMs: 1800000, reason: 'Cocina llena', actor: 'handheld:hh', principal: 'hh' });
  assert.deepStrictEqual(await C.resumeIfOwn(deps(db), 'tb_norte', sys.op_id), { ok: true, resumed: false });
  assert.strictEqual(db.get('order_control/tb_norte/current/paused'), true);
});

test('codex r1 P1-3: a staff pause landing BETWEEN the ownership read and the write is never resumed (system v1 → staff v2)', async () => {
  const db = createFakeDb({});
  const sys = await C.writePause(deps(db), 'tb_norte', { op: 'pause', forMs: null, reason: 'sin respuesta', actor: 'sistema', principal: 'sistema' });
  assert.strictEqual(db.get('order_control/tb_norte/current/version'), 1);
  // wrap the db: right after resumeIfOwn's FIRST read of the node (ownership looks fine at v1), staff pauses (v2)
  let reads = 0;
  const wrapped = { ...db, ref: (p) => {
    const r = db.ref(p);
    if (p !== 'order_control/tb_norte') return r;
    return { ...r, transaction: r.transaction.bind(r), once: async (...a) => {
      const snap = await r.once(...a);
      if (++reads === 1) await C.writePause(deps(db), 'tb_norte', { op: 'pause', forMs: 1800000, reason: 'Cocina llena', actor: 'handheld:hh', principal: 'hh' });
      return snap;
    } };
  } };
  assert.deepStrictEqual(await C.resumeIfOwn(deps(wrapped), 'tb_norte', sys.op_id), { ok: true, resumed: false });
  const cur = db.get('order_control/tb_norte/current');
  assert.deepStrictEqual([cur.paused, cur.version, cur.by], [true, 2, 'handheld:hh'], 'the staff pause stands');
});

test('effectiveBusy: live → add_min; expired / absent / malformed → 0', () => {
  assert.strictEqual(C.effectiveBusy({ add_min: 15, until: T0 + 1 }, T0), 15);
  assert.strictEqual(C.effectiveBusy({ add_min: 15, until: T0 }, T0), 0);
  assert.strictEqual(C.effectiveBusy(null, T0), 0);
  assert.strictEqual(C.effectiveBusy({ add_min: 12, until: T0 + 9 }, T0), 0);
  assert.strictEqual(C.effectiveBusy({ add_min: 15 }, T0), 0);
});
