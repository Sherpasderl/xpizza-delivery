'use strict';
// UNASSIGN (PLAN-unassign-prepickup r1.2) — pure helpers: key validation, the U1-b driver updater, the create-only audit.
const assert = require('assert');
const { validKey, driverReleaseUpdater, auditCreateOnly, AVAILABLE_FROM, RELEASABLE_PICKUP } = require('./unassign-core');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

for (const good of ['O1', 'op-1', 'u_drvA', 'x'.repeat(128), 'ñ-ü']) assert.strictEqual(validKey(good), true, good);
for (const bad of ['', 'a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'a/b', 'x'.repeat(129), 'a\u0000b', 'a\u001fb', 'a\u007fb', null, undefined, 5, {}, ['O1']]) {
  assert.strictEqual(validKey(bad), false, JSON.stringify(bad));
}
ok('validKey: non-empty string ≤128 without . # $ [ ] / or control chars; non-strings refused');

const up = driverReleaseUpdater('O1');
assert.strictEqual(up(null), null, 'cold cache / missing → null (server re-runs; never creates)');
assert.strictEqual(up(undefined), null);
assert.strictEqual(up({ current_task_id: 'O2_pickup', status: 'assigned' }), undefined, 'competing pointer → abort');
assert.strictEqual(up({ current_task_id: 'O1', status: 'assigned' }), undefined, 'bare order id is not a task pointer');
assert.strictEqual(up({ status: 'assigned' }), undefined, 'no pointer → abort');
for (const leg of ['O1_pickup', 'O1_delivery']) {
  for (const st of ['assigned', 'at_restaurant', 'en_route_delivery', 'off_shift', 'on_break', 'available', undefined]) {
    const cur = { current_task_id: leg, status: st, name: 'a', active: true };
    const nx = up(cur);
    assert.strictEqual(nx.current_task_id, null);
    assert.strictEqual(nx.status, AVAILABLE_FROM.has(st) ? 'available' : st, `${leg}/${st}`);
    assert.strictEqual(nx.name, 'a'); assert.strictEqual(nx.active, true);
    assert.strictEqual(cur.current_task_id, leg, 'input not mutated');
  }
}
assert.deepStrictEqual([...AVAILABLE_FROM].sort(), ['assigned', 'at_restaurant', 'en_route_delivery']);
assert.deepStrictEqual([...RELEASABLE_PICKUP].sort(), ['accepted', 'assigned', 'in_progress']);
ok('driverReleaseUpdater: null→null, foreign/absent pointer aborts, own pickup/delivery cleared, available only from the cancel-core allowlist, other fields kept');

const rec = { action: 'unassign', at: 1 };
assert.strictEqual(auditCreateOnly(rec)(null), rec);
assert.strictEqual(auditCreateOnly(rec)(undefined), rec);
assert.strictEqual(auditCreateOnly(rec)({ action: 'unassign', at: 0 }), undefined, 'existing → abort');
ok('auditCreateOnly: writes only when absent');
console.log(`unassign-core: OK (${n})`);
