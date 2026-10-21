'use strict';
// BRAND-AGNOSTIC SERVER (PLAN-brand-agnostic-server r3 §A) — the return-base invariant: every update that leaves
// current_restaurant_id null while the prior value was non-null ALSO writes that prior value to return_restaurant_id, in the
// same update; a null prior writes nothing (history survives empty / duplicate / repeated clears). Applied CENTRALLY:
// withReturnCopy wraps EVERY syncDriverHubUpdate result (clear, and set / backfill from a pickup with no restaurant_id) and the
// shift callables' multi-path batches (prefix drivers/{uid}/). Run: node driver-return-copy.test.js
const assert = require('assert');
const { withReturnCopy, syncDriverHubUpdate } = require('./driver-ingest');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const A = { lat: 15.51, lng: -88.03 };   // tb_centro's hub (synthetic)
const B = { lat: 15.52, lng: -88.04 };   // tb_norte's hub (synthetic)

// ── the pure helper ──
assert.deepStrictEqual(withReturnCopy({ current_restaurant_id: null, current_hub_lat: null }, 'tb_centro'),
  { current_restaurant_id: null, current_hub_lat: null, return_restaurant_id: 'tb_centro' }, 'a null-out of a known rid records it');
assert.deepStrictEqual(withReturnCopy({ current_restaurant_id: null }, null), { current_restaurant_id: null }, 'a null prior writes nothing');
assert.deepStrictEqual(withReturnCopy({ current_restaurant_id: null }, undefined), { current_restaurant_id: null }, 'an absent prior writes nothing');
assert.deepStrictEqual(withReturnCopy({ current_restaurant_id: 'tb_norte' }, 'tb_centro'), { current_restaurant_id: 'tb_norte' }, 'a non-null new rid writes nothing');
assert.deepStrictEqual(withReturnCopy({ current_hub_task_id: 'x' }, 'tb_centro'), { current_hub_task_id: 'x' }, 'an update that does not touch the rid writes nothing');
assert.strictEqual(withReturnCopy(null, 'tb_centro'), null, 'no update stays no update');
assert.deepStrictEqual(withReturnCopy({ 'drivers/u1/current_restaurant_id': null, 'drivers/u1/active': false }, 'tb_centro', 'drivers/u1/'),
  { 'drivers/u1/current_restaurant_id': null, 'drivers/u1/active': false, 'drivers/u1/return_restaurant_id': 'tb_centro' }, 'the multi-path prefix');
assert.deepStrictEqual(withReturnCopy({ 'drivers/u1/current_restaurant_id': null }, 'tb_centro'), { 'drivers/u1/current_restaurant_id': null }, 'the prefix must match the key');
const input = { current_restaurant_id: null }; withReturnCopy(input, 'tb_centro');
assert.deepStrictEqual(input, { current_restaurant_id: null }, 'the caller’s object is not mutated');
ok('withReturnCopy: records a non-null prior on a null-out (plain + drivers/{uid}/ prefix); a null prior, a non-null new rid, an untouched rid, no update → unchanged; never mutates');

// ── EVERY syncDriverHubUpdate action × prior rid {null, tb_centro} ──
const pk = (id, rid, hub, linked) => ({ type: 'pickup', restaurant_id: rid, destination_lat: hub && hub.lat, destination_lng: hub && hub.lng, linked_task_id: linked });
const TASKS = {
  pB: pk('pB', 'tb_norte', B, 'dB'), dB: { type: 'delivery', linked_task_id: 'pB' },
  pN: pk('pN', undefined, B, 'dN'), dN: { type: 'delivery', linked_task_id: 'pN' },   // a pickup with NO restaurant_id
  dX: { type: 'delivery', linked_task_id: 'missing' },
};
const snap = (rid, hub) => ({ current_restaurant_id: rid, current_hub_lat: hub ? hub.lat : null, current_hub_lng: hub ? hub.lng : null });
const CASES = [
  // [label, eventAfter, fresh, existing, expected action shape]
  ['clear (no task)', null, null],
  ['clear (unknown task)', 'zz', 'zz'],
  ['set (pickup with a restaurant)', 'pB', 'pB'],
  ['set (pickup with NO restaurant_id)', 'pN', 'pN'],
  ['backfill (delivery, linked pickup with a restaurant)', 'dB', 'dB'],
  ['backfill (delivery, linked pickup with NO restaurant_id)', 'dN', 'dN'],
  ['noop (delivery, no linked pickup)', 'dX', 'dX'],
  ['diverged (stale event)', null, 'pB'],
];
let checked = 0;
for (const prior of [null, 'tb_centro']) {
  for (const [label, ev, fresh] of CASES) {
    const existing = snap(prior, prior ? A : null);
    const u = syncDriverHubUpdate(ev, fresh, TASKS, existing);
    const nullsRid = !!u && Object.prototype.hasOwnProperty.call(u, 'current_restaurant_id') && u.current_restaurant_id == null;
    if (nullsRid && prior != null) assert.strictEqual(u.return_restaurant_id, prior, `${label} / prior ${prior}: the null-out records the prior rid`);
    else assert.ok(!u || !('return_restaurant_id' in u), `${label} / prior ${prior}: nothing recorded (${JSON.stringify(u)})`);
    checked++;
  }
}
// the named outcomes the invariant must produce (so the loop above is not vacuous)
const withPrior = snap('tb_centro', A);
assert.strictEqual(syncDriverHubUpdate(null, null, TASKS, withPrior).return_restaurant_id, 'tb_centro', 'clear after a tb_centro task → return tb_centro');
assert.strictEqual(syncDriverHubUpdate('pN', 'pN', TASKS, withPrior).return_restaurant_id, 'tb_centro', 'a pickup lacking restaurant_id that replaces tb_centro with null records tb_centro');
assert.strictEqual(syncDriverHubUpdate('dN', 'dN', TASKS, withPrior).return_restaurant_id, 'tb_centro', 'a backfill lacking restaurant_id records tb_centro');
assert.ok(!('return_restaurant_id' in syncDriverHubUpdate('pB', 'pB', TASKS, withPrior)), 'stacked advancement to a restaurant pickup never touches it');
assert.ok(!('return_restaurant_id' in syncDriverHubUpdate(null, null, TASKS, snap(null, null))), 'a second (empty) clear preserves the stored value — writes nothing');
assert.strictEqual(syncDriverHubUpdate(null, 'pB', TASKS, withPrior), null, 'a stale (diverged) event writes nothing');
assert.deepStrictEqual(syncDriverHubUpdate(null, null, TASKS, withPrior),
  { current_hub_lat: null, current_hub_lng: null, current_restaurant_id: null, current_hub_task_id: null, return_restaurant_id: 'tb_centro' }, 'the clear joins the SAME update');
ok(`syncDriverHubUpdate: ${checked} cells (every action × prior {null, tb_centro}) hold the invariant — clear and set/backfill from a restaurant-less pickup record the prior; a second clear, a restaurant pickup, a diverged event write nothing`);

console.log(`\ndriver-return-copy: OK (${n})`);
