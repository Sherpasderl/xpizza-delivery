// H1b T5 — api.js: accept | more | ready ONLY through the T3 queue; every other callable online-only with a fresh op_id; the
// reject returns the server's outcome (BC2: a 'pending' result gets ONE ~15 s replay of the SAME op — the receipt never re-runs
// the core and returns the stored reject_outcome).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, rejectToast } from './api.js';
import { createQueue, memoryStorage } from './offline-queue.js';

const P = { uid: 'hh_tb_norte_a', rid: 'tb_norte' };
function rig({ online = true, responses = {} } = {}) {
  let n = 0; const calls = []; const timers = [];
  const s = { ...P, gen: 1 };
  const queue = createQueue({ storage: memoryStorage(), partition: P, session: { current: () => s }, newOpId: () => `q-op-${String(++n).padStart(6, '0')}` });
  const state = { online };
  const call = async (name, data) => {
    calls.push([name, data]);
    const r = responses[name];
    const v = typeof r === 'function' ? r(data, calls) : r;
    if (v instanceof Error) throw v;
    return v === undefined ? { ok: true } : v;
  };
  const lost = [];
  const api = createApi({ call, queue, isOnline: () => state.online, rid: P.rid, newOpId: () => `d-op-${String(++n).padStart(6, '0')}`,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {}, onAuthLost: () => lost.push(1) });
  return { api, queue, calls, timers, state, lost };
}
const tick = () => new Promise((r) => setImmediate(r));

test('act(accept|more|ready) goes ONLY through the queue: persisted first, then flushed with the original op_id', async () => {
  const r = rig();
  const res = r.api.act('accept', 'o1', { prep_min: 23 });
  assert.equal(res.ok, true);
  await r.api.flush();
  assert.deepEqual(r.calls, [['merchantAccept', { rid: 'tb_norte', oid: 'o1', op_id: res.item.op_id, prep_min: 23 }]]);
  r.api.act('more', 'o1', { add_min: 10 }); r.api.act('ready', 'o1');
  await r.api.flush();
  assert.deepEqual(r.calls.slice(1).map((c) => c[0]), ['merchantMoreTime', 'merchantReady']);
  assert.throws(() => r.api.act('reject', 'o1'), /not a queued action/);
});

test('offline: act() still persists (nothing sent until a flush online); direct calls refuse with the offline class', async () => {
  const r = rig({ online: false });
  assert.equal(r.api.act('ready', 'o1').ok, true);
  await tick();
  assert.equal(r.calls.length, 0);
  assert.deepEqual(await r.api.direct('merchantSetBusy', { add_min: 15, dur_min: 60 }), { class: 'offline', code: 'offline', result: null });
  assert.deepEqual(await r.api.reject('o1', { reason: 'saturada' }), { class: 'offline', code: 'offline', state: null, op_id: null });
  r.state.online = true;
  await r.api.flush();
  assert.deepEqual(r.calls.map((c) => c[0]), ['merchantReady']);
});

test('direct(): a fresh op_id per call, rid added, the T3 classification returned', async () => {
  const r = rig({ responses: { merchantSetPause: { ok: false, code: 'not_served' } } });
  const a = await r.api.direct('merchantSetBusy', { add_min: 15, dur_min: 60 });
  const b = await r.api.direct('merchantSetPause', { op: 'pause', for_min: 30 });
  assert.equal(a.class, 'ok'); assert.deepEqual([b.class, b.code], ['terminal', 'not_served']);
  assert.notEqual(r.calls[0][1].op_id, r.calls[1][1].op_id);
  assert.equal(r.calls[0][1].rid, 'tb_norte');
});

test('reject: returned cancelled → state cancelled (the app toasts); manual_review → the tag; the request carries reason/note/items', async () => {
  const r = rig({ responses: { merchantReject: { ok: true, state: 'cancelled' } } });
  const x = await r.api.reject('o1', { reason: 'agotado', gone_items: ['Horchata grande'] });
  assert.deepEqual([x.class, x.state], ['ok', 'cancelled']);
  assert.deepEqual(r.calls[0], ['merchantReject', { rid: 'tb_norte', oid: 'o1', op_id: x.op_id, reason: 'agotado', note: null, gone_items: ['Horchata grande'] }]);
  const m = rig({ responses: { merchantReject: { ok: true, state: 'manual_review' } } });
  assert.equal((await m.api.reject('o1', { reason: 'saturada' })).state, 'manual_review');
  assert.equal(m.timers.length, 0, 'a terminal state schedules nothing');
});

test('BC2: a pending reject schedules ONE ~15 s replay of the SAME op_id; its stored outcome resolves the reject', async () => {
  let n = 0;
  const r = rig({ responses: { merchantReject: () => (++n === 1 ? { ok: true, state: 'pending' } : { ok: true, state: 'refund_pending', replay: true }) } });
  const resolved = [];
  const x = await r.api.reject('o1', { reason: 'saturada' }, { onResolved: (st) => resolved.push(st) });
  assert.equal(x.state, 'pending');
  assert.equal(r.timers.length, 1); assert.equal(r.timers[0].ms, 15000);
  await r.timers[0].fn(); await tick();
  assert.deepEqual(r.calls.map((c) => c[1].op_id), [x.op_id, x.op_id], 'the same op — a receipt replay, never a second cancel');
  assert.deepEqual(resolved, ['refund_pending']);
  assert.equal(r.timers.length, 1, 'only ONE retry, ever');
});

test('BC2: a still-pending or failed replay resolves nothing (the feed stays the resolver); a refused reject never schedules', async () => {
  const r = rig({ responses: { merchantReject: { ok: true, state: 'pending' } } });
  const resolved = [];
  await r.api.reject('o1', { reason: 'saturada' }, { onResolved: (st) => resolved.push(st) });
  await r.timers[0].fn(); await tick();
  assert.deepEqual(resolved, []);
  const f = rig({ responses: { merchantReject: { ok: false, code: 'already_requested' } } });
  const y = await f.api.reject('o1', { reason: 'saturada' });
  assert.deepEqual([y.class, y.code, y.state, f.timers.length], ['terminal', 'already_requested', null, 0]);
});

test('orderState: the server result, or null on any failure (fail closed → unassigned, no ETA)', async () => {
  const ok = rig({ responses: { merchantOrderState: { driver_assigned: true, driver_first_name: 'Ana' } } });
  assert.deepEqual(await ok.api.orderState('o1'), { driver_assigned: true, driver_first_name: 'Ana' });
  assert.deepEqual(ok.calls[0], ['merchantOrderState', { rid: 'tb_norte', oid: 'o1' }]);
  const bad = rig({ responses: { merchantOrderState: new Error('x') } });
  assert.equal(await bad.api.orderState('o1'), null);
  const off = rig({ online: false });
  assert.equal(await off.api.orderState('o1'), null);
});

test('rejectToast: only from the device\'s OWN returned outcome; the refund line only for online payments', () => {
  const o = { id: 'o1', display_number: 47, payment_method: 'online' };
  assert.equal(rejectToast(o, 'cancelled'), 'Pedido #47 cancelado. Sherpa le avisa al cliente. Le devolvemos el dinero al cliente.');
  assert.equal(rejectToast({ ...o, payment_method: 'cash' }, 'refund_pending'), 'Pedido #47 cancelado. Sherpa le avisa al cliente.');
  for (const st of ['manual_review', 'pending', 'not_cancelable', 'referred_recon', null]) assert.equal(rejectToast(o, st), null, String(st));
});

test('codex H1b r1 P1-1: after stop() a late reject / direct / orderState / BC2 retry touches NOTHING and onResolved never fires', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const r = rig({ responses: { merchantReject: async () => { await gate; return { ok: true, state: 'pending' }; }, merchantSetBusy: async () => { await gate; return { ok: true }; },
    merchantOrderState: async () => { await gate; return { driver_assigned: true }; } } });
  const resolved = [];
  const pr = r.api.reject('o1', { reason: 'agotado' }, { onResolved: (st) => resolved.push(st) });
  const pd = r.api.direct('merchantSetBusy', { add_min: 15, dur_min: 60 });
  const po = r.api.orderState('o1');
  r.api.stop();                                        // sign-out while the three are in flight
  release();
  assert.deepEqual([(await pr).class, (await pd).class, await po], ['stopped', 'stopped', null]);
  assert.equal(r.timers.length, 0, 'no BC2 retry scheduled after stop');
  assert.deepEqual(resolved, []);
  assert.deepEqual(r.api.act('accept', 'o2', { prep_min: 20 }), { ok: false, reason: 'stopped' });
  assert.equal(r.queue.items().length, 0);
});

test('codex H1b r1 P1-1: a BC2 retry already scheduled is voided by stop()', async () => {
  const r = rig({ responses: { merchantReject: { ok: true, state: 'pending' } } });
  const resolved = [];
  await r.api.reject('o1', { reason: 'saturada' }, { onResolved: (st) => resolved.push(st) });
  const callsBefore = r.calls.length;
  r.api.stop();
  await r.timers[0].fn();
  assert.equal(r.calls.length, callsBefore, 'the retry never sends');
  assert.deepEqual(resolved, []);
});

test('codex H1b r1 P1-3: every auth-class result reports onAuthLost — automatic flush, explicit flush, direct, reject, orderState', async () => {
  const unauth = Object.assign(new Error('x'), { code: 'functions/unauthenticated' });
  const r = rig({ responses: { merchantAccept: unauth, merchantHeartbeat: unauth, merchantReject: unauth, merchantOrderState: unauth } });
  r.api.act('accept', 'o1', { prep_min: 20 });         // the automatic flush inside act()
  await tick(); await tick();
  assert.equal(r.lost.length, 1, 'the automatic flush\'s auth result is not discarded');
  await r.api.direct('merchantHeartbeat', {});
  await r.api.reject('o1', { reason: 'saturada' });
  await r.api.orderState('o1');
  assert.equal(r.lost.length, 4);
  r.api.stop();
  await r.api.direct('merchantHeartbeat', {});
  assert.equal(r.lost.length, 4, 'nothing reported after stop');
});
