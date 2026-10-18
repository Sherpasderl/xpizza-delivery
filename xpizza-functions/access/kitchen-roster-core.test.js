'use strict';
// PLATFORM F2 Q1 — kitchen-roster core (PLAN-F2-query-rules §1.3; codex Q1 r1 P1-2, P2-3, P2-5). Run: node access/kitchen-roster-core.test.js
const assert = require('assert');
const { runKitchenRoster, planRoster } = require('./kitchen-roster-core');
const { pagedFake } = require('./_paged-fake');

const LEGACY = (rid) => ({ name: rid.toUpperCase(), active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
const BRANDS = { x_pizza: LEGACY('x_pizza'), la_musa: LEGACY('la_musa'), tb_brand: { name: 'T', active: true, locations: { tb_centro: 'member' }, activation: { state: 'off', since: 1 } } };
const DEPS = new Map([['kitchen-x', 'x_pizza']]);
const MAP = { kitchen: { kA: { rids: ['x_pizza'], kind: 'terminal', deployment: 'kitchen-x' }, kH: { rids: ['x_pizza', 'tb_centro'], kind: 'human' } } };
// the blanket seed's state (every kitchen uid on every rid) + an ORPHAN restaurant grant outside /brands
const SEEDED = { brands: BRANDS, restaurants: { x_pizza: { kitchen_staff: { kA: true, kH: true } }, la_musa: { kitchen_staff: { kA: true, kH: true } }, tb_centro: { identity: { brand_id: 'tb_brand' } }, orphan: { kitchen_staff: { extra: true } } } };
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const L = () => {};
(async () => {
  let db = pagedFake(SEEDED);
  const plan = await planRoster({ rtdb: db, mapping: MAP, kitchenDeployments: DEPS, pageSize: 2 });
  assert.deepStrictEqual(plan, { add: [{ rid: 'tb_centro', uid: 'kH' }], remove: [{ rid: 'la_musa', uid: 'kA' }, { rid: 'la_musa', uid: 'kH' }, { rid: 'orphan', uid: 'extra' }] });
  assert.strictEqual(await runKitchenRoster({ rtdb: db, mapping: MAP, kitchenDeployments: DEPS, apply: false, log: L, pageSize: 2 }), 0);
  assert.strictEqual(db.updates.length, 0, 'dry run writes nothing');
  ok('plan = the exact diff over EVERY actual roster: the blanket seed\'s extras AND an orphan restaurant grant are planned for REMOVAL, a missing grant added; dry run writes nothing');

  assert.strictEqual(await runKitchenRoster({ rtdb: db, mapping: MAP, kitchenDeployments: DEPS, apply: true, log: L, pageSize: 2 }), 0);
  assert.strictEqual(db.updates.length, 1, 'apply = ONE multi-path update');
  assert.ok(!db.data.restaurants.la_musa.kitchen_staff || !Object.keys(db.data.restaurants.la_musa.kitchen_staff).length);
  assert.ok(!db.data.restaurants.orphan.kitchen_staff || !db.data.restaurants.orphan.kitchen_staff.extra, 'the orphan grant is removed');
  assert.deepStrictEqual(await planRoster({ rtdb: db, mapping: MAP, kitchenDeployments: DEPS, pageSize: 2 }), { add: [], remove: [] }, 'idempotent');
  ok('apply: one multi-path update, read back; afterwards the roster equals the mapping (a re-plan is empty)');

  // codex P1-2: a terminal mapped to TWO locations (or pinned at another deployment) is refused BEFORE any write, nonzero exit
  for (const bad of [{ kT: { rids: ['x_pizza', 'tb_centro'], kind: 'terminal' } }, { kT: { rids: ['tb_centro'], kind: 'terminal', deployment: 'kitchen-x' } }]) {
    db = pagedFake(SEEDED); const log = [];
    assert.strictEqual(await runKitchenRoster({ rtdb: db, mapping: { kitchen: bad }, kitchenDeployments: DEPS, apply: true, log: (l) => log.push(l), pageSize: 2 }), 2);
    assert.strictEqual(db.updates.length, 0, 'no write');
    assert.ok(log.some((l) => /REFUSED/.test(l)));
  }
  ok('codex P1-2: a two-location terminal, and a terminal whose deployment pins another location, are REFUSED (exit 2) with ZERO writes');

  // codex P2-3: identifiers are carried losslessly — a | in a uid is granted exactly as written; an invalid key is refused
  db = pagedFake({ brands: BRANDS, restaurants: { x_pizza: {} } });
  assert.strictEqual(await runKitchenRoster({ rtdb: db, mapping: { kitchen: { 'alice|suffix': { rids: ['x_pizza'], kind: 'human' } } }, kitchenDeployments: DEPS, apply: true, log: L, pageSize: 2 }), 0);
  assert.deepStrictEqual(Object.keys(db.data.restaurants.x_pizza.kitchen_staff), ['alice|suffix'], 'the uid with a | is granted exactly — never truncated to "alice"');
  for (const badUid of ['a/b', 'a.b', 'a#b', 'a$b', 'a[b', '']) {
    db = pagedFake({ brands: BRANDS, restaurants: { x_pizza: {} } });
    assert.strictEqual(await runKitchenRoster({ rtdb: db, mapping: { kitchen: { [badUid]: { rids: ['x_pizza'], kind: 'human' } } }, kitchenDeployments: DEPS, apply: true, log: L, pageSize: 2 }), 2, `uid ${JSON.stringify(badUid)} refused`);
    assert.strictEqual(db.updates.length, 0);
  }
  ok('codex P2-3: a uid containing | is granted losslessly; a uid that is not a valid RTDB key (/ . # $ [ empty) is refused before any write');

  db = pagedFake(SEEDED);
  assert.strictEqual(await runKitchenRoster({ rtdb: db, mapping: { kitchen: { kA: { rids: ['nowhere'], kind: 'terminal' } } }, kitchenDeployments: DEPS, apply: true, log: L, pageSize: 2 }), 2);
  assert.strictEqual(db.updates.length, 0);
  ok('an unknown location is refused (exit 2) before any write');
  console.log(`kitchen-roster-core: OK (${n})`);
})().catch((e) => { console.error('kitchen-roster-core FAILED:', e); process.exit(1); });
