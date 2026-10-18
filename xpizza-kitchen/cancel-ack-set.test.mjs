// PLATFORM F2 Q2 (PLAN-F2-query-rules §2, codex F2q plan r1 P1-9) — the per-order cancel-ack set. Run: node cancel-ack-set.test.mjs
// Readiness is PER ID: a missing ack may count as a recall only once THAT id's listener has confirmed absence; a not-yet-read id
// is never treated as absent; callbacks arriving after an id was detached (or after teardown) are ignored.
import assert from 'node:assert';
import { createCancelAckSet } from './cancel-ack-set.js';

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// a controllable fake listener registry: deliver(id, value) / fail(id) fire the CURRENT listener of that id (or a retained old one)
function fakeListen() {
  const live = new Map(); const all = [];
  const listen = (id, onVal, onErr) => { const h = { id, onVal, onErr, off: false }; live.set(id, h); all.push(h); return () => { h.off = true; if (live.get(id) === h) live.delete(id); }; };
  return { listen, live, all, deliver: (id, v) => live.get(id).onVal(v), fail: (id) => live.get(id).onErr(new Error('denied')) };
}

{
  const f = fakeListen(); let changes = 0;
  const s = createCancelAckSet({ listen: f.listen, onChange: () => { changes += 1; } });
  s.setIds(['A', 'B']);
  assert.deepStrictEqual([...f.live.keys()].sort(), ['A', 'B'], 'one listener per eligible id');
  assert.strictEqual(s.isReady('A'), false); assert.strictEqual(s.isAbsent('A'), false, 'an UNREAD id is never absent');
  f.deliver('B', null);                                   // out of order: B first, confirmed absent
  assert.strictEqual(s.isAbsent('B'), true); assert.strictEqual(s.isReady('A'), false, 'B ready does not make A ready');
  f.deliver('A', { at: 1, by: 'u' });
  assert.deepStrictEqual(s.acks(), { A: { at: 1, by: 'u' } }); assert.strictEqual(s.isReady('A'), true); assert.strictEqual(changes, 2);
  ok('per-id readiness: unread ≠ absent; out-of-order initial callbacks each settle only their own id; acks() = the present ones');
}
{
  const f = fakeListen();
  const s = createCancelAckSet({ listen: f.listen, onChange: () => {} });
  s.setIds(['A']); f.deliver('A', { at: 1 });
  f.deliver('A', null);                                   // recall on another device
  assert.strictEqual(s.isAbsent('A'), true); assert.deepStrictEqual(s.acks(), {});
  f.deliver('A', { at: 2 });                              // archived again
  assert.deepStrictEqual(s.acks(), { A: { at: 2 } });
  ok('archive → recall → archive again: present / confirmed-absent / present, live');
}
{
  const f = fakeListen(); let changes = 0;
  const s = createCancelAckSet({ listen: f.listen, onChange: () => { changes += 1; } });
  s.setIds(['A', 'B']); const oldA = f.live.get('A');
  s.setIds(['B', 'C']);                                   // A becomes ineligible (view change), C eligible
  assert.ok(oldA.off, 'A detached'); assert.deepStrictEqual([...f.live.keys()].sort(), ['B', 'C']);
  const before = changes; oldA.onVal({ at: 9 });           // a STALE callback for the detached id
  assert.strictEqual(changes, before); assert.strictEqual(s.isReady('A'), false); assert.deepStrictEqual(s.acks(), {});
  s.setIds(['A', 'B', 'C']);                              // A eligible again → a FRESH listener, unread until it delivers
  assert.strictEqual(s.isReady('A'), false, 'a re-attached id starts unread (no stale state carried over)');
  ok('eligibility changes attach/detach listeners; a stale callback after detach is ignored; a re-attached id starts unread');
}
{
  const f = fakeListen();
  const s = createCancelAckSet({ listen: f.listen, onChange: () => {} });
  s.setIds(['A']); f.deliver('A', { at: 1 });
  f.fail('A');                                            // a read error (e.g. reconnect / permission) → not ready, never "absent"
  assert.strictEqual(s.isReady('A'), false); assert.strictEqual(s.isAbsent('A'), false);
  ok('a listener error leaves the id NOT ready (unknown), never confirmed-absent — no false recall');
}
{
  const f = fakeListen(); let changes = 0;
  const s = createCancelAckSet({ listen: f.listen, onChange: () => { changes += 1; } });
  s.setIds(['A', 'B']); const hs = [...f.live.values()];
  s.teardown();
  assert.ok(hs.every((h) => h.off)); const before = changes; hs[0].onVal({ at: 1 });
  assert.strictEqual(changes, before, 'no callback after teardown'); assert.deepStrictEqual(s.acks(), {});
  s.setIds(['A']); assert.strictEqual(f.live.size, 1, 'reusable after teardown (restart path)');
  ok('teardown detaches everything; callbacks after teardown are ignored; the set is reusable (restart)');
}
{
  const f = fakeListen();
  const s = createCancelAckSet({ listen: f.listen, onChange: () => {} });
  s.setIds(['A', 'A', 'B']); assert.strictEqual(f.all.length, 2, 'duplicates collapse');
  s.setIds(['A', 'B']); assert.strictEqual(f.all.length, 2, 'an unchanged id set re-attaches nothing');
  ok('idempotent: duplicates collapse; an unchanged set attaches no new listener');
}
console.log(`cancel-ack-set: OK (${n})`);
