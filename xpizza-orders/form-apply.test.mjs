// Portal 1B Task 6 — the applier's own guarantees. Run: node --test xpizza-orders/form-apply.test.mjs
//
// 🔴 WHY THESE ARE NOT IN THE jsdom SUITE. Two of the module's rules are about what happens when its
// COLLABORATORS misbehave — a prepare that mutates on its way to throwing, a prepare that returns
// nothing. The forms' real prepare does neither, so loading a form can never exercise them: mutation
// testing confirmed it, with both rules surviving a full jsdom run untouched. A rule no input can reach
// is a rule that will quietly rot, so it is reached here instead, directly.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMenuApplier } = require('./form-apply.js');

const harness = (over = {}) => {
  const world = { menu: 'bundle', dom: '<bundle>' };
  const calls = [];
  const a = createMenuApplier(Object.assign({
    capture: () => { calls.push('capture'); return { menu: world.menu, dom: world.dom }; },
    restore: (p) => { calls.push('restore'); world.menu = p.menu; world.dom = p.dom; },
    prepare: (s) => { calls.push('prepare'); return s; },
    commit: (p) => { calls.push('commit'); world.menu = p.menu; world.dom = '<' + p.menu + '>'; },
  }, over));
  return { a, world, calls };
};

test('the capture is taken BEFORE prepare, so a prepare that mutates on its way out is undone', () => {
  // A prepare is supposed to be pure. This one is not — it writes, then throws, which is exactly the
  // shape a future half-finished validation step would take. Captured first, the damage is undone;
  // captured after, it is baked in as the restore point.
  const h = harness({
    prepare: (s) => { h.calls.push('prepare'); h.world.menu = 'HALF'; h.world.dom = '<HALF>'; throw new Error('prepare exploded'); },
  });
  const out = h.a.apply({ menu: 'next' });
  assert.strictEqual(out, 'refused');
  assert.strictEqual(h.world.menu, 'bundle', 'the mutation prepare made on its way out was rolled back');
  assert.strictEqual(h.world.dom, '<bundle>', '…including the DOM it had already touched');
  assert.deepStrictEqual(h.calls, ['capture', 'prepare', 'restore'],
    'the capture came FIRST — captured after prepare, the damage above would have become the restore point');
});

test('a prepare that returns nothing is a refusal, not a successful apply', () => {
  // The forms' prepare always returns an object or throws, so nothing in a loaded page can produce
  // this. It is still the difference between "there is nothing to commit" and "commit undefined".
  const h = harness({ prepare: () => undefined });
  assert.strictEqual(h.a.apply({ menu: 'next' }), 'refused');
  assert.strictEqual(h.world.menu, 'bundle', 'nothing was committed');
  assert.ok(!h.calls.includes('commit'), 'and commit was never called with nothing');
  assert.match(h.a.state().lastError.message, /apply_prepare_empty/, 'the reason is pinned, not generic');
});

test('a rollback that itself fails is reported as broken rather than silently ignored', () => {
  // The one state this cannot recover from. Saying so lets a caller reload; pretending otherwise
  // leaves an unknown page on screen claiming to be fine.
  const h = harness({
    commit: () => { throw new Error('render exploded'); },
    restore: () => { throw new Error('rollback exploded'); },
  });
  assert.strictEqual(h.a.apply({ menu: 'next' }), 'broken');
  assert.match(h.a.state().fatal.message, /rollback exploded/);
});

test('only the LATEST deferred snapshot is held', () => {
  let busy = true;
  const h = harness({ isBusy: () => busy });
  h.a.apply({ menu: 'older' });
  h.a.apply({ menu: 'newer' });
  busy = false;
  assert.strictEqual(h.a.flush(), 'applied');
  assert.strictEqual(h.world.menu, 'newer', 'the older snapshot never applies after the newer one');
  assert.strictEqual(h.a.flush(), 'idle', 'and nothing is left queued behind it');
});

test('a refused flush does not re-run forever', () => {
  // pending is cleared BEFORE the attempt. Cleared after, a snapshot that fails to apply would be
  // retried by every subsequent flush — a modal open/close loop replaying the same failure.
  let busy = true;
  const h = harness({ isBusy: () => busy, prepare: () => { throw new Error('nope'); } });
  h.a.apply({ menu: 'bad' });
  busy = false;
  assert.strictEqual(h.a.flush(), 'refused');
  assert.strictEqual(h.a.flush(), 'idle', 'the failed snapshot is not retried on the next flush');
});

test('the required collaborators are contract, not convention', () => {
  for (const missing of ['prepare', 'commit', 'capture', 'restore']) {
    const opts = { prepare: () => ({}), commit: () => {}, capture: () => ({}), restore: () => {} };
    delete opts[missing];
    assert.throws(() => createMenuApplier(opts), new RegExp(missing), `${missing} must be required`);
  }
});
