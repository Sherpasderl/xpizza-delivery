// H1b T3 — the persisted action queue (PLAN-H1b T3, advisor 1 + 3, codex P1-1 / P1-3 / P2-8). accept | more | ready ALWAYS go
// persist → send → resolve; the original op_id is kept forever; single-flight; per-partition (uid+rid); a session `gen` bump
// stops a flush and voids any late result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, memoryStorage } from './offline-queue.js';

const P = { uid: 'hh_tb_norte_a', rid: 'tb_norte' };
const session = (gen = 1, part = P) => { const s = { ...part, gen }; return { current: () => s, bump() { s.gen++; } }; };
let seq = 0;
const opIds = () => `op-${String(++seq).padStart(8, '0')}`;
const mk = (storage, sess = session(), part = P) => createQueue({ storage, partition: part, session: sess, newOpId: opIds, now: () => 1000 });
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

test('enqueue persists FIRST; the item is immutable and carries uid+rid+op_id', () => {
  const st = memoryStorage();
  const q = mk(st);
  const r = q.enqueue({ action: 'accept', order_id: 'o1', payload: { prep_min: 20 } });
  assert.equal(r.ok, true);
  const [it] = q.items();
  assert.deepEqual({ ...it, op_id: typeof it.op_id }, { op_id: 'string', action: 'accept', order_id: 'o1', payload: { prep_min: 20 }, uid: P.uid, rid: P.rid, enqueued_at: 1000 });
  assert.throws(() => { 'use strict'; it.action = 'x'; }, TypeError);
  assert.equal(JSON.parse(st.raw(`hh_queue:${P.uid}:${P.rid}`)).length, 1, 'on storage before any send');
});

test('a storage write failure → nothing queued, nothing sent, the caller is told', async () => {
  const st = memoryStorage({ failWrites: true });
  const q = mk(st);
  const r = q.enqueue({ action: 'ready', order_id: 'o1' });
  assert.deepEqual(r, { ok: false, reason: 'storage' });
  let sent = 0;
  await q.flush(async () => { sent++; return { ok: true }; });
  assert.equal(sent, 0);
  assert.deepEqual(q.items(), []);
});

test('an online tap then a kill before the response → resent on restart with the SAME op_id; the receipt replay is ok', async () => {
  const st = memoryStorage();
  const q1 = mk(st);
  q1.enqueue({ action: 'accept', order_id: 'o1', payload: { prep_min: 20 } });
  const op = q1.items()[0].op_id;
  void q1.flush(() => new Promise(() => {}));        // in flight forever: the app dies here
  const q2 = mk(st);                                  // restart
  const seen = [];
  const r = await q2.flush(async (it) => { seen.push(it.op_id); return { ok: true, replay: true }; });
  assert.deepEqual(seen, [op]);
  assert.deepEqual([r.sent, q2.items().length], [1, 0]);
});

test('single flight: two flush calls send each item once; a tap during a flush is sent after, in order', async () => {
  const st = memoryStorage();
  const q = mk(st);
  q.enqueue({ action: 'accept', order_id: 'o1' });
  const d = deferred(); const seen = [];
  const send = async (it) => { seen.push(`${it.action}:${it.order_id}`); if (seen.length === 1) await d.p; return { ok: true }; };
  const a = q.flush(send); const b = q.flush(send);
  q.enqueue({ action: 'ready', order_id: 'o1' });    // tapped during the reconnect flush
  d.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(seen, ['accept:o1', 'ready:o1']);
  assert.deepEqual(q.items(), []);
});

test('a retry class stops the flush and KEEPS the item (and its op_id) for the next one', async () => {
  const q = mk(memoryStorage());
  q.enqueue({ action: 'accept', order_id: 'o1' }); q.enqueue({ action: 'accept', order_id: 'o2' });
  const op = q.items()[0].op_id;
  const r = await q.flush(async () => { throw Object.assign(new Error('x'), { code: 'functions/unavailable' }); });
  assert.equal(r.stopped, 'retry');
  assert.deepEqual(q.items().map((i) => i.op_id)[0], op);
  assert.equal(q.items().length, 2);
});

test('dependencies (codex P2-8): a refused ACCEPT drops the later items of the same order; a refused MORE or READY drops nothing else', async () => {
  const q = mk(memoryStorage());
  q.enqueue({ action: 'accept', order_id: 'o1' }); q.enqueue({ action: 'accept', order_id: 'o2' });
  q.enqueue({ action: 'ready', order_id: 'o1' }); q.enqueue({ action: 'more', order_id: 'o2' }); q.enqueue({ action: 'ready', order_id: 'o2' });
  const seen = [];
  const r = await q.flush(async (it) => {
    seen.push(`${it.action}:${it.order_id}`);
    if (it.action === 'accept' && it.order_id === 'o1') return { ok: false, code: 'stale_state' };
    if (it.action === 'more') return { ok: false, code: 'driver_assigned' };
    return { ok: true };
  });
  assert.deepEqual(seen, ['accept:o1', 'accept:o2', 'more:o2', 'ready:o2'], 'o1 ready never sent; o2 ready still sent after its refused more');
  assert.deepEqual(r.dropped.map((d) => [d.action, d.order_id, d.code, d.reason]),
    [['accept', 'o1', 'stale_state', 'refused'], ['ready', 'o1', 'stale_state', 'depends_on_refused_accept'], ['more', 'o2', 'driver_assigned', 'refused']]);
  assert.deepEqual(q.items(), []);
});

test('session guard: a gen bump while a send awaits → the late result is VOIDED and the remaining items are not sent', async () => {
  const st = memoryStorage(); const sess = session();
  const q = mk(st, sess);
  q.enqueue({ action: 'accept', order_id: 'o1' }); q.enqueue({ action: 'accept', order_id: 'o2' });
  const d = deferred(); const seen = [];
  const p = q.flush(async (it) => { seen.push(it.order_id); await d.p; return { ok: true }; });
  sess.bump();                                        // sign-out / branch change starts (gen bumped BEFORE the Auth switch)
  d.resolve();
  const r = await p;
  assert.equal(r.stopped, 'session');
  assert.deepEqual(seen, ['o1'], 'o2 never sent under a new identity');
  assert.equal(q.items().length, 2, 'the late result did not touch state');
});

test('session guard: a flush started under another partition never sends this partition\'s items', async () => {
  const st = memoryStorage();
  const q = mk(st, session(1, P));
  q.enqueue({ action: 'accept', order_id: 'o1' });
  const other = mk(st, session(1, { uid: P.uid, rid: 'tb_centro' }), { uid: P.uid, rid: 'tb_centro' });
  assert.deepEqual(other.items(), [], 'partitions are separate keys');
  const qWrong = createQueue({ storage: st, partition: P, session: session(1, { uid: P.uid, rid: 'tb_centro' }), newOpId: opIds });
  let sent = 0;
  const r = await qWrong.flush(async () => { sent++; return { ok: true }; });
  assert.deepEqual([sent, r.stopped], [0, 'session']);
});

test('auth → the queue pauses (no further sends) until resumed; discard() empties the partition with a note', async () => {
  const st = memoryStorage();
  const q = mk(st);
  q.enqueue({ action: 'accept', order_id: 'o1' }); q.enqueue({ action: 'ready', order_id: 'o1' });
  let sent = 0;
  const r = await q.flush(async () => { sent++; throw Object.assign(new Error('x'), { code: 'functions/unauthenticated' }); });
  assert.deepEqual([r.stopped, sent, q.paused()], ['auth', 1, true]);
  const r2 = await q.flush(async () => { sent++; return { ok: true }; });
  assert.deepEqual([r2.stopped, sent], ['paused', 1]);
  const note = q.discard('sign_out');
  assert.deepEqual(note, { discarded: 2, reason: 'sign_out' });
  assert.deepEqual(q.items(), []);
  assert.equal(st.raw(`hh_queue:${P.uid}:${P.rid}`), null);
});

test('onDrop listeners hear every dropped item (undo.js drops a pending Listo on a refused accept — BC1)', async () => {
  const q = mk(memoryStorage());
  const heard = [];
  q.onDrop((d) => heard.push(`${d.action}:${d.order_id}:${d.reason}`));
  q.enqueue({ action: 'accept', order_id: 'o1' });
  await q.flush(async () => ({ ok: false, code: 'not_served' }));
  assert.deepEqual(heard, ['accept:o1:refused']);
});

test('a corrupt stored partition is ignored (never sent), not thrown', () => {
  const st = memoryStorage();
  st.setRaw(`hh_queue:${P.uid}:${P.rid}`, '{nope');
  const q = mk(st);
  assert.deepEqual(q.items(), []);
});

test('enqueue keeps a caller-supplied op_id (the undo record\'s) when it is valid; otherwise mints one', () => {
  const q = mk(memoryStorage());
  q.enqueue({ action: 'ready', order_id: 'o1', op_id: 'undo-op-00000001' });
  q.enqueue({ action: 'ready', order_id: 'o2', op_id: 'bad id!' });
  const [a, b] = q.items();
  assert.equal(a.op_id, 'undo-op-00000001');
  assert.notEqual(b.op_id, 'bad id!');
});
