// xpizza-dispatch/dispatch-eta-snapshot.test.js
import assert from 'node:assert';
import { createEtaSnapshotStore } from './dispatch-eta-snapshot.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

{
  const s = createEtaSnapshotStore();
  assert.strictEqual(s.baseline('o1'), null);
  assert.strictEqual(s.has('o1'), false);
  ok('no baseline before observing');
}
{
  const s = createEtaSnapshotStore();
  s.observe('o1', 5000);
  s.observe('o1', 9000);                 // later ETA ignored — first observed wins
  assert.strictEqual(s.baseline('o1'), 5000);
  ok('first observed wins, later ignored');
}
{
  const s = createEtaSnapshotStore();
  s.observe('o1', NaN);                  // non-finite ignored
  assert.strictEqual(s.baseline('o1'), null);
  ok('non-finite arrival not recorded');
}
{
  const s = createEtaSnapshotStore();
  s.observe('o1', 5000); s.clear('o1');
  assert.strictEqual(s.baseline('o1'), null);
  ok('clear drops baseline');
}
// instance-private / session-scoped: two stores never share state
{
  const a = createEtaSnapshotStore();
  const b = createEtaSnapshotStore();
  a.observe('o1', 5000);
  assert.strictEqual(b.baseline('o1'), null, 'store b unaffected by store a');
  assert.strictEqual(b.has('o1'), false);
  assert.strictEqual(a.baseline('o1'), 5000, 'store a still holds its own');
  ok('two stores are isolated (instance-private, no shared globals)');
}

console.log(`\n${pass} passed`);
