'use strict';
// PLATFORM F2 Q1 — access census core (PLAN-F2-query-rules §1.2 a–f; codex Q1 r1 P1-2, P2-4, P2-5). Run: node access/access-census-core.test.js
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { runAccessCensus, validateMapping } = require('./access-census-core');
const { pagedFake } = require('./_paged-fake');

// TODAY's KDS filter (order-filter.js) knows only the two legacy kitchens — x_pizza is the catch-all — so the kitchen
// deployments are the legacy ones; the synthetic brand tb_brand (tb_centro, tb_norte, tb_viejo retired) is the third location.
const SITES = { deployments: [
  { id: 'kitchen-x', app: 'kitchen', context: 'x_pizza' }, { id: 'kitchen-m', app: 'kitchen', context: 'la_musa' }, { id: 'orders-x', app: 'orders', context: 'x_pizza' },
] };
const LEGACY = (rid) => ({ name: rid.toUpperCase(), active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
const BRANDS = () => ({
  x_pizza: LEGACY('x_pizza'), la_musa: LEGACY('la_musa'),
  tb_brand: { name: 'T', active: true, locations: { tb_centro: 'member', tb_norte: 'member', tb_viejo: 'retired' }, activation: { state: 'off', since: 1 } },
});
const REST = (extra = {}) => ({
  x_pizza: { identity: { name: 'x' }, kitchen_staff: { kA: true } }, la_musa: { identity: { name: 'm' }, kitchen_staff: { kB: true } },
  tb_centro: { identity: { brand_id: 'tb_brand' } }, tb_norte: { identity: { brand_id: 'tb_brand' } }, tb_viejo: { identity: { brand_id: 'tb_brand' } }, ...extra,
});
const MAP = (extra = {}) => ({ kitchen: { kA: { rids: ['x_pizza'], kind: 'terminal', deployment: 'kitchen-x' }, kB: { rids: ['la_musa'], kind: 'terminal', deployment: 'kitchen-m' }, ...extra } });
const o = (rid, extra = {}) => ({ restaurant_id: rid, status: 'preparing', created_at: 1_800_000_000_000, ...extra });
const NOW = 1_800_000_000_000 + 3600_000;

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
(async () => {
  const filters = await import(pathToFileURL(path.join(__dirname, 'kds-filter-pre-f2.mjs')).href);
  const world = (orders, more = {}) => ({ brands: BRANDS(), restaurants: REST(), kitchen: { kA: true, kB: true }, orders, tasks: { O1_pickup: { order_id: 'O1', type: 'pickup' } }, ...more });
  const run = (data, mapping = MAP()) => runAccessCensus({ rtdb: pagedFake(data), mapping, sites: SITES, filters, nowMs: NOW, pageSize: 2 });

  let r = await run(world({ O1: o('x_pizza'), O2: o('la_musa'), O3: o('x_pizza', { status: 'scheduled' }), O4: o('la_musa', { status: 'delivered' }) }));
  assert.strictEqual(r.code, 0, JSON.stringify(r.report.blocking)); assert.deepStrictEqual(r.report.blocking, []);
  ok('a clean world (valid brands, every rid a location, parity holds, roster = mapping, canonical task keys) exits 0');

  // (a) ownership + the F1 membership contract (checkMembership, reused)
  r = await run(world({ O1: o(undefined), O2: o(''), O3: o('nowhere'), O4: o('tb_viejo') }));
  assert.deepStrictEqual(r.report.blocking.filter((b) => b.startsWith('order_location')).sort(), ['order_location_absent:O1', 'order_location_absent:O2', 'order_location_unknown:O3:nowhere'], 'a RETIRED location is still a location');
  const bogus = BRANDS(); bogus.tb_brand.locations.tb_norte = 'bogus';
  r = await run(world({ O1: o('x_pizza') }, { brands: bogus }));
  assert.strictEqual(r.code, 1); assert.ok(r.report.blocking.some((b) => b.startsWith('membership:brand_invalid:tb_brand')), `codex P2-4: membership value "bogus" → F1 brand_invalid (${JSON.stringify(r.report.blocking)})`);
  r = await run(world({ O1: o('x_pizza'), O2: o('tb_centro') }, { brands: bogus }));
  assert.ok(r.report.blocking.includes('order_location_unknown:O2:tb_centro'), 'an INVALID brand\'s locations are not locations (its orders are unknown-location)');
  r = await run(world({ O1: o('x_pizza') }, { brands: bogus }), MAP({ kT: { rids: ['tb_centro'], kind: 'human' } }));
  assert.strictEqual(r.code, 2, 'a mapping naming a location of an invalid brand is refused');
  r = await run(world({ O1: o('x_pizza') }, { restaurants: REST({ tb_centro: { identity: { brand_id: 'other' } }, la_musa: { identity: { brand_id: 'tb_brand' }, kitchen_staff: { kB: true } } }) }));
  for (const f of ['membership:brand_id_mismatch:tb_brand:tb_centro', 'membership:brand_missing:other:tb_centro', 'membership:not_listed:tb_brand:la_musa', 'membership:brand_id_mismatch:la_musa:la_musa']) assert.ok(r.report.blocking.includes(f), `${f} (${JSON.stringify(r.report.blocking)})`);
  r = await run(world({ O1: o('x_pizza') }, { restaurants: REST({ tb_norte: { identity: { name: 'n' } } }) }));
  assert.ok(r.report.blocking.includes('membership:brand_id_mismatch:tb_brand:tb_norte'), 'a non-legacy location needs brand_id; a LEGACY one may omit it (F1 exception)');
  ok('(a) absent / empty / unknown rid blocking; retired is a location; F1 checkMembership reused — membership "bogus" → brand_invalid, mismatch / missing / not_listed; the legacy identity exception holds');

  // (b) KDS parity
  r = await run(world({ O1: o('tb_centro'), O2: o('tb_norte', { status: 'scheduled' }), O3: o('la_musa') }));
  assert.deepStrictEqual(r.report.blocking.filter((b) => b.startsWith('kds_parity')).map((b) => b.split(' ')[0]).sort(), ['kds_parity:kitchen-x:O1', 'kds_parity:kitchen-x:O2']);
  r = await run(world({ O1: o('tb_centro'), O2: o('tb_norte', { status: 'scheduled' }) }), { ...MAP(), visibility_exceptions: { O1: 'accepted', O2: 'accepted' } });
  assert.ok(!r.report.blocking.some((b) => b.startsWith('kds_parity')));
  ok("(b) KDS parity: today's x_pizza catch-all vs the exact rid set, live AND scheduled — a third location breaks parity; reviewed exceptions accepted");

  // (c) roster over EVERY actual roster, orphans included (codex P2-5); a multi-rid HUMAN is fine (Q-C)
  r = await run(world({ O1: o('x_pizza') }, { kitchen: { kA: true, kB: true, kZ: true }, restaurants: REST({ x_pizza: { identity: { name: 'x' }, kitchen_staff: { kA: true, kB: true } }, la_musa: { identity: { name: 'm' } }, orphan: { kitchen_staff: { extra: true } } }) }),
    MAP({ kH: { rids: ['x_pizza', 'la_musa'], kind: 'human' } }));
  assert.deepStrictEqual(r.report.blocking.filter((b) => /^(roster|kitchen)/.test(b)).sort(), [
    'kitchen_unmapped:kZ', 'roster_extra:extra@orphan (orphan restaurant)', 'roster_extra:kB@x_pizza', 'roster_missing:kB@la_musa', 'roster_missing:kH@la_musa', 'roster_missing:kH@x_pizza',
  ].sort());
  ok('(c) roster vs mapping over every actual roster: an ORPHAN restaurant grant is an extra; missing / extra / unmapped global kitchen uid blocking; a multi-rid human allowed');

  // the mapping validator (shared with kitchen-roster): terminal cardinality + deployment context + RTDB keys → exit 2
  const LOC = new Set(['x_pizza', 'la_musa']); const DEPS = new Map([['kitchen-x', 'x_pizza'], ['kitchen-m', 'la_musa']]);
  const errs = (k) => validateMapping({ kitchen: k }, LOC, DEPS);
  assert.ok(errs({ t: { rids: ['x_pizza', 'la_musa'], kind: 'terminal' } }).some((e) => /exactly ONE location/.test(e)), 'codex P1-2: a two-location terminal');
  assert.ok(errs({ t: { rids: ['la_musa'], kind: 'terminal', deployment: 'kitchen-x' } }).some((e) => /pins x_pizza/.test(e)), 'codex P1-2: a deployment pinned elsewhere');
  assert.ok(errs({ 'a/b': { rids: ['x_pizza'], kind: 'human' } }).some((e) => /not a valid RTDB key/.test(e)) && errs({ u: { rids: ['x.y'], kind: 'human' } }).some((e) => /invalid RTDB key/.test(e)), 'codex P2-3: path components validated');
  assert.deepStrictEqual(errs({ 'alice|suffix': { rids: ['x_pizza'], kind: 'human' } }), [], 'a | in a uid is a valid key (kept losslessly)');
  r = await run(world({}), MAP({ kT: { rids: ['x_pizza', 'la_musa'], kind: 'terminal' } }));
  assert.strictEqual(r.code, 2); assert.ok(r.report.mapping_errors.some((e) => /exactly ONE/.test(e)));
  ok('mapping validator (the one kitchen-roster runs before writing): a two-location terminal, a deployment pinned elsewhere, an invalid RTDB key → exit 2; a | is a valid key');

  // (d) (e) (f)
  r = await run(world({ O1: o('x_pizza', { delivered_by_driver_uid: 'd1', delivered_by_uid: 'd2' }), O2: o('x_pizza', { delivered_by_uid: 'd3' }) },
    { tasks: { O1_pickup: { order_id: 'O1', type: 'pickup' }, X_delivery: { order_id: 'O1', type: 'delivery' }, O2_other: { order_id: 'O2', type: 'other' } } }));
  assert.deepStrictEqual(r.report.info.attribution, { primary_ne_legacy: 1, legacy_only: 1 });
  assert.ok(!r.report.blocking.some((b) => b.includes('attribution')), 'attribution never blocks (advisor: union accepted)');
  assert.deepStrictEqual(r.report.blocking.filter((b) => b.startsWith('task_key')).sort(), ['task_key_noncanonical:O2_other', 'task_key_noncanonical:X_delivery']);
  assert.strictEqual(r.report.info.history.per_rid.x_pizza.count, 2); assert.ok(r.report.info.history.per_rid.x_pizza.bytes > 0);
  assert.strictEqual(r.report.info.history.per_driver.d2.legacy.count, 1);
  assert.deepStrictEqual(Object.values(r.report.info.history.daily_last_14d.x_pizza), [2]);
  ok('(d) attribution counted, never blocking; (e) non-canonical task keys blocking; (f) history size per rid / per driver / daily');

  const big = {}; for (let i = 0; i < 9; i++) big[`B${i}`] = o('x_pizza');
  const db = pagedFake(world(big));
  await runAccessCensus({ rtdb: db, mapping: MAP(), sites: SITES, filters, nowMs: NOW, pageSize: 2 });
  assert.ok(db.queries.every((q) => q.rows <= 2) && db.queries.filter((q) => q.path === 'orders').length >= 5 && db.queries.some((q) => q.path === 'restaurants'), 'every collection read is one page (orders, tasks, restaurants)');
  ok('every orders / tasks / restaurants read is a bounded page');

  console.log(`access-census-core: OK (${n})`);
})().catch((e) => { console.error('access-census-core FAILED:', e); process.exit(1); });
