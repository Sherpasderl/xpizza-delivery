// H1b T4 — the Listo undo window (advisor 2; codex P1-2; BC1). In memory only: a 5 s LOCAL timer, then exactly one enqueue of a
// record carrying uid+rid+op_id. Deshacer cancels it. A session gen change drops it. A refused accept drops a pending Listo of the
// same order (BC1). Accepted residual: a crash inside the window loses that Listo (the order stays in En preparación).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUndo } from './undo.js';
import { createQueue, memoryStorage } from './offline-queue.js';
import { makeClock, makeTimer } from './clock.js';

const P = { uid: 'hh_tb_norte_a', rid: 'tb_norte' };
function rig() {
  let mono = 0; let wall = 1_000_000; let n = 0;
  const s = { ...P, gen: 1 };
  const session = { current: () => s };
  const queue = createQueue({ storage: memoryStorage(), partition: P, session, newOpId: () => `q-op-${String(++n).padStart(6, '0')}` });
  const undo = createUndo({ queue, session, makeTimer: () => makeTimer({ mono: () => mono, wall: () => wall }), newOpId: () => `undo-${String(++n).padStart(6, '0')}` });
  return { queue, undo, s, adv: (ms, { monoToo = true } = {}) => { wall += ms; if (monoToo) mono += ms; }, setWall: (v) => { wall = v; } };
}

test('expiry → EXACTLY one enqueue carrying uid + rid + op_id', () => {
  const r = rig();
  const op = r.undo.startReady('o1');
  r.adv(4999); r.undo.tick();
  assert.equal(r.queue.items().length, 0);
  assert.equal(r.undo.pending('o1').remaining, 1);
  r.adv(1); r.undo.tick(); r.undo.tick(); r.undo.onResume();
  const items = r.queue.items();
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].action, items[0].order_id, items[0].uid, items[0].rid, items[0].op_id], ['ready', 'o1', P.uid, P.rid, op]);
  assert.equal(r.undo.pending('o1'), null);
});

test('Deshacer before expiry → never enqueued', () => {
  const r = rig();
  r.undo.startReady('o1');
  r.adv(3000);
  assert.equal(r.undo.cancel('o1'), true);
  r.adv(5000); r.undo.tick();
  assert.deepEqual(r.queue.items(), []);
  assert.equal(r.undo.cancel('o1'), false, 'nothing left to cancel');
});

test('backgrounded past expiry (mono stopped) → onResume enqueues once; still inside → the remaining time is reported', () => {
  const r = rig();
  r.undo.startReady('o1'); r.undo.startReady('o2');
  r.adv(8000, { monoToo: false });
  r.undo.onResume();
  assert.deepEqual(r.queue.items().map((i) => i.order_id), ['o1', 'o2']);
  const r2 = rig();
  r2.undo.startReady('o1');
  r2.adv(2000, { monoToo: false });
  r2.undo.onResume();
  assert.deepEqual([r2.queue.items().length, r2.undo.pending('o1').remaining], [0, 3000]);
});

test('a server offset change during the window does not stretch or shrink it (still 5 s local)', () => {
  const r = rig();
  const clock = makeClock({ wall: () => 0 });
  r.undo.startReady('o1');
  clock.setOffset(30 * 60000);
  r.adv(5000); r.undo.tick();
  assert.equal(r.queue.items().length, 1);
});

test('sign-out / branch change (gen bump) during the window → dropped, never enqueued under any identity', () => {
  const r = rig();
  r.undo.startReady('o1');
  r.s.gen++;
  r.adv(6000); r.undo.tick();
  assert.deepEqual(r.queue.items(), []);
  assert.equal(r.undo.pending('o1'), null);
});

test('a Listo whose accept is still queued is enqueued BEHIND it (the T3 dependency then applies)', async () => {
  const r = rig();
  r.queue.enqueue({ action: 'accept', order_id: 'o1', payload: { prep_min: 20 } });
  r.undo.startReady('o1');
  r.adv(5000); r.undo.tick();
  assert.deepEqual(r.queue.items().map((i) => i.action), ['accept', 'ready']);
  const res = await r.queue.flush(async (it) => (it.action === 'accept' ? { ok: false, code: 'stale_state' } : { ok: true }));
  assert.deepEqual(res.dropped.map((d) => `${d.action}:${d.reason}`), ['accept:refused', 'ready:depends_on_refused_accept']);
});

test('BC1: an accept refused while its Listo is still INSIDE the window → the pending Listo is dropped and the refusal reported', async () => {
  const r = rig();
  const heard = [];
  r.undo.onDropped((d) => heard.push(d));
  r.queue.enqueue({ action: 'accept', order_id: 'o1', payload: { prep_min: 20 } });
  r.undo.startReady('o1'); r.undo.startReady('o2');
  await r.queue.flush(async () => ({ ok: false, code: 'not_served' }));
  assert.equal(r.undo.pending('o1'), null, 'dropped');
  assert.ok(r.undo.pending('o2'), 'another order\'s Listo is untouched');
  assert.deepEqual(heard, [{ order_id: 'o1', code: 'not_served', reason: 'accept_refused' }]);
  r.adv(6000); r.undo.tick();
  assert.deepEqual(r.queue.items().map((i) => i.order_id), ['o2'], 'the dropped Listo never reaches the queue');
});

test('a second Listo tap on the same order restarts nothing (one pending record, its original op_id)', () => {
  const r = rig();
  const a = r.undo.startReady('o1');
  r.adv(2000);
  const b = r.undo.startReady('o1');
  assert.equal(a, b);
  r.adv(3000); r.undo.tick();
  assert.equal(r.queue.items().length, 1);
});

test('a persist failure at expiry is reported, not swallowed (the order stays visibly in preparation)', () => {
  let n = 0;
  const s = { ...P, gen: 1 };
  const queue = createQueue({ storage: memoryStorage({ failWrites: true }), partition: P, session: { current: () => s }, newOpId: () => `q-${String(++n).padStart(8, '0')}` });
  let t = 0;
  const undo = createUndo({ queue, session: { current: () => s }, makeTimer: () => makeTimer({ mono: () => t, wall: () => t }), newOpId: () => `u-${String(++n).padStart(8, '0')}` });
  const heard = [];
  undo.onDropped((d) => heard.push(d.reason));
  undo.startReady('o1'); t += 5000; undo.tick();
  assert.deepEqual(heard, ['storage']);
});
