'use strict';
// PLATFORM F2 Q1 — kitchen-roster core (PLAN-F2-query-rules §1.3). Run: node access/kitchen-roster-core.test.js
const assert = require('assert');
const { runKitchenRoster, planRoster } = require('./kitchen-roster-core');

function fake(data) {
  const db = { data: JSON.parse(JSON.stringify(data)), updates: [] };
  const at = (p) => p.split('/').reduce((o, k) => (o == null ? undefined : o[k]), db.data);
  db.ref = (p) => ({
    once: async () => { const v = p ? at(p) : db.data; return { val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))) }; },
    update: async (u) => { db.updates.push(u); for (const [k, v] of Object.entries(u)) { const ks = k.split('/'); let o = db.data; for (const s of ks.slice(0, -1)) o = o[s] = o[s] || {}; if (v === null) delete o[ks.at(-1)]; else o[ks.at(-1)] = v; } },
  });
  return db;
}
const LOC = new Set(['x_pizza', 'la_musa', 'tb_centro']); const DEPS = new Set(['kitchen-x']);
const MAP = { kitchen: { kA: { rids: ['x_pizza'], kind: 'terminal', deployment: 'kitchen-x' }, kH: { rids: ['x_pizza', 'tb_centro'], kind: 'human' } } };
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
(async () => {
  // the blanket seed's state: every kitchen uid on every rid
  const seeded = { restaurants: { x_pizza: { kitchen_staff: { kA: true, kH: true } }, la_musa: { kitchen_staff: { kA: true, kH: true } }, tb_centro: {} } };
  let db = fake(seeded); const log = []; const L = (l) => log.push(l);
  const plan = await planRoster({ rtdb: db, mapping: MAP, locations: LOC, kitchenDeployments: DEPS });
  assert.deepStrictEqual(plan, { add: [{ rid: 'tb_centro', uid: 'kH' }], remove: [{ rid: 'la_musa', uid: 'kA' }, { rid: 'la_musa', uid: 'kH' }] });
  assert.strictEqual(await runKitchenRoster({ rtdb: db, mapping: MAP, locations: LOC, kitchenDeployments: DEPS, apply: false, log: L }), 0);
  assert.strictEqual(db.updates.length, 0, 'dry run writes nothing');
  ok('plan = the exact diff vs the reviewed mapping (the blanket seed\'s extra memberships are REMOVED, a missing one added); dry run writes nothing');
  assert.strictEqual(await runKitchenRoster({ rtdb: db, mapping: MAP, locations: LOC, kitchenDeployments: DEPS, apply: true, log: L }), 0);
  assert.strictEqual(db.updates.length, 1, 'apply = ONE multi-path update');
  assert.deepStrictEqual(db.data.restaurants.la_musa.kitchen_staff || {}, {}); assert.strictEqual(db.data.restaurants.tb_centro.kitchen_staff.kH, true);
  assert.deepStrictEqual(await planRoster({ rtdb: db, mapping: MAP, locations: LOC, kitchenDeployments: DEPS }), { add: [], remove: [] }, 'idempotent: a second plan is empty');
  ok('apply: one multi-path update, read back; afterwards the roster equals the mapping (a re-plan is empty)');
  db = fake(seeded);
  assert.strictEqual(await runKitchenRoster({ rtdb: db, mapping: { kitchen: { kA: { rids: ['nowhere'], kind: 'terminal' } } }, locations: LOC, kitchenDeployments: DEPS, apply: true, log: L }), 2);
  assert.strictEqual(db.updates.length, 0);
  ok('an invalid mapping is refused (exit 2) before any write');
  console.log(`kitchen-roster-core: OK (${n})`);
})().catch((e) => { console.error('kitchen-roster-core FAILED:', e); process.exit(1); });
