'use strict';
// Unit suite for the kitchen_staff seed PLANNER (KDS Phase 2b · Slice 3 · KDS_2B_PLAN.md §10 [R4 #3]).
// Proves — without any Firebase — the two guarantees the coordinator locked:
//   (1) DEFAULT seeds ALL current /kitchen uids into BOTH restaurants (no per-restaurant split, no lockout).
//   (2) IDEMPOTENT: a uid already in a restaurant's kitchen_staff is skipped (re-run = same state).
// Also pins isTruthyMember() to the isKitchen() truthiness contract. Run: node seed-kitchen-staff.test.mjs
import assert from 'node:assert';
import { planKitchenStaffSeed, isTruthyMember } from './seed-kitchen-staff.mjs';
import { RESTAURANT_IDS } from './menu-extract.mjs';

let n = 0;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// Sanity: the target set is exactly {x_pizza, la_musa}.
assert.deepStrictEqual([...RESTAURANT_IDS].sort(), ['la_musa', 'x_pizza'], 'RESTAURANT_IDS == both restaurants');
ok(`targets BOTH restaurants: ${RESTAURANT_IDS.join(', ')}`);

// ── 1. First run, empty everywhere: EVERY kitchen uid → EVERY restaurant ──
const uids = ['uidA', 'uidB', 'uidC'];
const fresh = planKitchenStaffSeed(uids, {}); // no existing membership
for (const rid of RESTAURANT_IDS) {
  assert.deepStrictEqual(fresh[rid].toWrite, uids, `${rid}: all ${uids.length} kitchen uids planned to write`);
  assert.deepStrictEqual(fresh[rid].skip, [], `${rid}: nothing skipped on a fresh seed`);
}
ok(`fresh seed writes all ${uids.length} uids into BOTH restaurants (all-kitchen → both)`);

// ── 2. Idempotency: a re-run against the state produced by run 1 is a NO-OP ──
const existingAfterRun1 = Object.fromEntries(RESTAURANT_IDS.map((rid) => [rid, new Set(uids)]));
const rerun = planKitchenStaffSeed(uids, existingAfterRun1);
for (const rid of RESTAURANT_IDS) {
  assert.deepStrictEqual(rerun[rid].toWrite, [], `${rid}: re-run writes nothing (idempotent)`);
  assert.deepStrictEqual(rerun[rid].skip, uids, `${rid}: re-run skips all (already present)`);
}
ok('re-run is a no-op — every uid already present is skipped (idempotent, same state)');

// ── 3. Partial state: only the missing uids per restaurant are written ──
const partial = planKitchenStaffSeed(uids, {
  x_pizza: new Set(['uidA']),          // uidA already on x_pizza
  la_musa: new Set(['uidA', 'uidB']),  // uidA, uidB already on la_musa
});
assert.deepStrictEqual(partial.x_pizza.toWrite, ['uidB', 'uidC'], 'x_pizza: writes only the two missing');
assert.deepStrictEqual(partial.x_pizza.skip, ['uidA'], 'x_pizza: skips uidA');
assert.deepStrictEqual(partial.la_musa.toWrite, ['uidC'], 'la_musa: writes only the one missing');
assert.deepStrictEqual(partial.la_musa.skip, ['uidA', 'uidB'], 'la_musa: skips the two present');
ok('partial state: only the per-restaurant missing uids are written (idempotent merge)');

// Also accepts a plain-object membership map (not just a Set).
const objForm = planKitchenStaffSeed(uids, { x_pizza: { uidA: true }, la_musa: {} });
assert.deepStrictEqual(objForm.x_pizza.toWrite, ['uidB', 'uidC'], 'object-map membership honored');
ok('membership accepted as Set OR plain object map');

// ── 4. isTruthyMember mirrors isKitchen() truthiness ──
for (const v of [true, 1, 'x', {}]) assert.strictEqual(isTruthyMember(v), true, `truthy member: ${JSON.stringify(v)}`);
for (const v of [false, null, 0, '', undefined]) assert.strictEqual(isTruthyMember(v), false, `non-member: ${JSON.stringify(v)}`);
ok('isTruthyMember matches isKitchen() (true/1/"x"/{} ⇒ member; false/null/0/""/undefined ⇒ not)');

console.log(`seed-kitchen-staff: OK (${n} cases)`);
