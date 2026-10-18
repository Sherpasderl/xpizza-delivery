'use strict';
// PLATFORM F2 Q1 — access census core (PLAN-F2-query-rules §1.2 a–f). Run: node access/access-census-core.test.js
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { runAccessCensus } = require('./access-census-core');

// a minimal paged fake: ref(p).orderByKey().startAfter(k).limitToFirst(n).once('value') and ref(p).once('value')
function fake(data) {
  const at = (p) => p.split('/').reduce((o, k) => (o == null ? undefined : o[k]), data);
  const queries = [];
  const snap = (rows) => ({ forEach: (fn) => rows.forEach(([key, v]) => fn({ key, val: () => v })), val: () => null });
  return {
    queries,
    ref: (p) => {
      const q = { after: null, n: Infinity };
      const api = {
        orderByKey: () => api, startAfter: (k) => { q.after = k; return api; }, limitToFirst: (n) => { q.n = n; return api; },
        once: async () => {
          const v = at(p);
          if (q.n === Infinity) return { val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))), forEach: () => {} };
          const keys = Object.keys(v || {}).sort().filter((k) => q.after === null || k > q.after).slice(0, q.n);
          queries.push({ path: p, rows: keys.length });
          return snap(keys.map((k) => [k, v[k]]));
        },
      };
      return api;
    },
  };
}
// TODAY's KDS filter (order-filter.js) knows only the two legacy kitchens — x_pizza is the catch-all — so the kitchen
// deployments are the legacy ones; the synthetic brand tb_brand (tb_centro, tb_norte, tb_viejo retired) is the third location.
const SITES = { deployments: [
  { id: 'kitchen-x', app: 'kitchen', context: 'x_pizza' }, { id: 'kitchen-m', app: 'kitchen', context: 'la_musa' }, { id: 'orders-x', app: 'orders', context: 'x_pizza' },
] };
const BRANDS = {
  x_pizza: { name: 'X', active: true, locations: { x_pizza: 'member' } }, la_musa: { name: 'M', active: true, locations: { la_musa: 'member' } },
  tb_brand: { name: 'T', active: true, locations: { tb_centro: 'member', tb_norte: 'member', tb_viejo: 'retired' } },
};
const REST = (extra = {}) => ({
  x_pizza: { identity: {}, kitchen_staff: { kA: true } }, la_musa: { identity: {}, kitchen_staff: { kB: true } },
  tb_centro: { identity: { brand_id: 'tb_brand' } }, tb_norte: { identity: { brand_id: 'tb_brand' } }, tb_viejo: { identity: { brand_id: 'tb_brand' } }, ...extra,
});
const MAP = (extra = {}) => ({ kitchen: { kA: { rids: ['x_pizza'], kind: 'terminal', deployment: 'kitchen-x' }, kB: { rids: ['la_musa'], kind: 'terminal', deployment: 'kitchen-m' }, ...extra } });
const o = (rid, extra = {}) => ({ restaurant_id: rid, status: 'preparing', created_at: 1_800_000_000_000, ...extra });
const NOW = 1_800_000_000_000 + 3600_000;

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
(async () => {
  const filters = await import(pathToFileURL(path.join(__dirname, '..', '..', 'xpizza-kitchen', 'order-filter.js')).href);
  const run = (data, mapping = MAP(), extra = {}) => runAccessCensus({ rtdb: fake(data), mapping, sites: SITES, filters, nowMs: NOW, pageSize: 2, ...extra });
  const world = (orders, more = {}) => ({ brands: BRANDS, restaurants: REST(), kitchen: { kA: true, kB: true }, orders, tasks: { O1_pickup: { order_id: 'O1', type: 'pickup' } }, ...more });

  // clean world → exit 0
  let r = await run(world({ O1: o('x_pizza'), O2: o('la_musa'), O3: o('x_pizza', { status: 'scheduled' }), O4: o('la_musa', { status: 'delivered' }) }));
  assert.strictEqual(r.code, 0, JSON.stringify(r.report.blocking)); assert.deepStrictEqual(r.report.blocking, []);
  ok('a clean world (every rid a location, parity holds, roster = mapping, canonical task keys) exits 0');

  // (a) ownership
  r = await run(world({ O1: o(undefined), O2: o(''), O3: o('nowhere'), O4: o('tb_viejo') }));
  const a = r.report.blocking.filter((b) => b.startsWith('order_location'));
  assert.deepStrictEqual(a.sort(), ['order_location_absent:O1', 'order_location_absent:O2', 'order_location_unknown:O3:nowhere'].sort(), 'a RETIRED location is still a location');
  r = await run(world({ O1: o('x_pizza') }, { restaurants: REST({ tb_centro: { identity: { brand_id: 'other' } }, la_musa: { identity: { brand_id: 'tb_brand' }, kitchen_staff: { kB: true } } }) }));
  assert.ok(r.report.blocking.includes('identity_brand_mismatch:tb_centro (other ≠ tb_brand)') && r.report.blocking.includes('identity_brand_mismatch:la_musa (tb_brand ≠ la_musa)'));
  r = await run(world({ O1: o('x_pizza') }, { restaurants: REST({ tb_norte: { identity: {} } }) }));
  assert.ok(r.report.blocking.includes('identity_brand_missing:tb_norte (listed by tb_brand)'), 'a branded location needs brand_id; a legacy one may omit it');
  ok('(a) absent / empty / unknown rid blocking; retired counts as a location; identity.brand_id mismatch or missing (non-legacy) blocking');

  // (b) KDS parity — a valid third location is shown by today's x_pizza catch-all, not by the exact query; an exception is accepted
  r = await run(world({ O1: o('tb_centro'), O2: o('tb_norte', { status: 'scheduled' }), O3: o('la_musa') }));
  assert.deepStrictEqual(r.report.blocking.filter((b) => b.startsWith('kds_parity')).map((b) => b.split(' ')[0]).sort(), ['kds_parity:kitchen-x:O1', 'kds_parity:kitchen-x:O2'],
    `codex P1-6: both views (live O1, scheduled O2) of the catch-all KDS break parity for a third location; la_musa's strict KDS does not (${JSON.stringify(r.report.blocking)})`);
  r = await run(world({ O1: o('tb_centro'), O2: o('tb_norte', { status: 'scheduled' }) }), { ...MAP(), visibility_exceptions: { O1: 'accepted', O2: 'accepted' } });
  assert.ok(!r.report.blocking.some((b) => b.startsWith('kds_parity')), 'reviewed visibility exceptions are accepted');
  ok("(b) KDS parity: today's x_pizza catch-all vs the exact rid set, live AND scheduled views — a valid third location breaks parity; listed exceptions accepted; la_musa's strict view holds")

  // (c) roster
  r = await run(world({ O1: o('x_pizza') }, { kitchen: { kA: true, kB: true, kZ: true }, restaurants: REST({ x_pizza: { identity: {}, kitchen_staff: { kA: true, kB: true } }, la_musa: { identity: {} } }) }),
    MAP({ kH: { rids: ['x_pizza', 'la_musa'], kind: 'human' } }));
  assert.deepStrictEqual(r.report.blocking.filter((b) => /^(roster|kitchen)/.test(b)).sort(), [
    'kitchen_unmapped:kZ', 'roster_extra:kB@x_pizza', 'roster_missing:kB@la_musa', 'roster_missing:kH@la_musa', 'roster_missing:kH@x_pizza',
  ].sort());
  r = await run(world({}), MAP({ kT: { rids: ['x_pizza', 'la_musa'], kind: 'terminal' }, kD: { rids: ['la_musa'], kind: 'terminal', deployment: 'kitchen-x' } }));
  assert.ok(r.report.blocking.includes('roster_terminal_rids:kT (2)') && r.report.blocking.some((b) => b.startsWith('roster_terminal_deployment:kD')));
  ok('(c) roster vs mapping: missing / extra / unmapped global kitchen uid blocking; a multi-rid HUMAN is allowed (Q-C), a terminal must have one rid at its deployment');

  // (d) attribution informational, (e) task keys, (f) history
  r = await run(world({ O1: o('x_pizza', { delivered_by_driver_uid: 'd1', delivered_by_uid: 'd2' }), O2: o('x_pizza', { delivered_by_uid: 'd3' }) },
    { tasks: { O1_pickup: { order_id: 'O1', type: 'pickup' }, X_delivery: { order_id: 'O1', type: 'delivery' }, O2_other: { order_id: 'O2', type: 'other' } } }));
  assert.deepStrictEqual(r.report.info.attribution, { primary_ne_legacy: 1, legacy_only: 1 });
  assert.ok(!r.report.blocking.some((b) => b.includes('attribution')), 'attribution never blocks (advisor: union accepted)');
  assert.deepStrictEqual(r.report.blocking.filter((b) => b.startsWith('task_key')).sort(), ['task_key_noncanonical:O2_other', 'task_key_noncanonical:X_delivery']);
  assert.strictEqual(r.report.info.history.per_rid.x_pizza.count, 2); assert.ok(r.report.info.history.per_rid.x_pizza.bytes > 0);
  assert.strictEqual(r.report.info.history.per_driver.d2.legacy.count, 1);
  assert.deepStrictEqual(Object.values(r.report.info.history.daily_last_14d.x_pizza), [2]);
  ok('(d) attribution counted, never blocking; (e) non-canonical task keys blocking; (f) history size per rid / per driver / daily');

  // paging bound + mapping refusal
  const big = {}; for (let i = 0; i < 9; i++) big[`B${i}`] = o('x_pizza');
  const db = fake(world(big));
  await runAccessCensus({ rtdb: db, mapping: MAP(), sites: SITES, filters, nowMs: NOW, pageSize: 2 });
  assert.ok(db.queries.every((q) => q.rows <= 2) && db.queries.filter((q) => q.path === 'orders').length >= 5, 'every query is one page');
  r = await run(world({}), { kitchen: { kA: { rids: ['nowhere'], kind: 'boss' } } });
  assert.strictEqual(r.code, 2); assert.ok(r.report.mapping_errors.length >= 2);
  ok('every orders/tasks read is a bounded page; an invalid mapping (unknown rid, bad kind) → exit 2 before any finding');

  console.log(`access-census-core: OK (${n})`);
})().catch((e) => { console.error('access-census-core FAILED:', e); process.exit(1); });
