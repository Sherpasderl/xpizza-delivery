'use strict';
// P-SELFUPDATE — the owner CLIs' pure cores: the floor plans (tools/client-floor-admin.js) and the version report
// aggregation + header-less log parsing (tools/client-version-report-core.js). Run: node pselfupdate-cli.test.js
const assert = require('assert');
const F = require('./tools/client-floor-admin');
const R = require('./tools/client-version-report-core');
const { hourKey } = require('./client-version');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const rids = ['la_musa', 'synthetic_3', 'x_pizza'];
const kp = F.kitchenPath;

(async () => {
  // ── floor plans ──
  let p = F.planFloor({ kind: 'kitchen', op: 'set', value: 1, current: {}, rids, maxCompat: 1 });
  assert.ok(p.ok); assert.deepStrictEqual(p.updates, { [kp('la_musa')]: 1, [kp('synthetic_3')]: 1, [kp('x_pizza')]: 1 });
  p = F.planFloor({ kind: 'kitchen', op: 'delete', current: { [kp('x_pizza')]: 1 }, rids, maxCompat: 1 });
  assert.deepStrictEqual(p.updates, { [kp('la_musa')]: null, [kp('synthetic_3')]: null, [kp('x_pizza')]: null }, 'delete-all covers EVERY restaurant (the kill switch)');
  assert.deepStrictEqual(p.rows.find((r) => r.path === kp('x_pizza')), { path: kp('x_pizza'), from: 1, to: null });
  p = F.planFloor({ kind: 'kitchen', op: 'raise', value: 1, current: { [kp('la_musa')]: 2 }, rids, maxCompat: 3 });
  assert.ok(!p.ok && /refuses to LOWER/.test(p.error), 'raise never lowers');
  p = F.planFloor({ kind: 'kitchen', op: 'raise', value: 2, current: { [kp('la_musa')]: 2, [kp('x_pizza')]: 1 }, rids, maxCompat: 3 });
  assert.ok(p.ok && Object.values(p.updates).every((v) => v === 2), 'raise to an equal-or-higher value sets every restaurant');
  p = F.planFloor({ kind: 'kitchen', op: 'set', value: 2, current: {}, rids, maxCompat: 1 });
  assert.ok(!p.ok && /refuse EVERY page/.test(p.error), 'a floor above the current generation is refused');
  assert.ok(F.planFloor({ kind: 'kitchen', op: 'set', value: 2, current: {}, rids, maxCompat: 1, force: true }).ok, '… unless forced');
  for (const v of [-1, 1.5, '2', NaN, 2000000]) assert.ok(!F.planFloor({ kind: 'orders', op: 'set', value: v, current: {}, rids, maxCompat: 9 }).ok, `bad value ${v} refused`);
  assert.ok(!F.planFloor({ kind: 'kitchen', op: 'set', value: 1, current: {}, rids: [], maxCompat: 1 }).ok, 'no restaurants → refused');
  assert.ok(!F.planFloor({ kind: 'kitchen', op: 'set', value: 1, current: {}, rids: ['Bad Id'], maxCompat: 1 }).ok, 'a malformed restaurant id → refused');
  assert.ok(!F.planFloor({ kind: 'menus', op: 'set', value: 1, current: {}, rids, maxCompat: 1 }).ok, 'unknown kind refused');
  p = F.planFloor({ kind: 'orders', op: 'set', value: 1, current: {}, rids, maxCompat: 1 });
  assert.deepStrictEqual(p.updates, { 'platform_config/client_floor/orders': 1 });
  ok('floor plans: kitchen set/raise/delete cover EVERY restaurant; raise never lowers; above-generation refused unless forced; bad values, unknown kinds, empty/malformed restaurant sets refused; orders targets platform_config/client_floor/orders');

  // ── apply = ONE multi-path update + read-back ──
  const store = {}; let updates = 0;
  const fake = { ref: (path) => ({
    update: async (u) => { updates += 1; for (const [k, v] of Object.entries(u)) { if (v === null) delete store[k]; else store[k] = v; } },
    once: async () => ({ val: () => (path in store ? store[path] : null) }) }) };
  const plan = F.planFloor({ kind: 'kitchen', op: 'set', value: 1, current: {}, rids, maxCompat: 1 });
  assert.deepStrictEqual(await F.applyPlan(fake, plan), { ok: true, mismatched: [] });
  assert.strictEqual(updates, 1, '🔴 ONE multi-path update — never one write per restaurant');
  const lying = { ref: (path) => ({ update: async () => {}, once: async () => ({ val: () => null }) }) };
  assert.strictEqual((await F.applyPlan(lying, plan)).ok, false, 'a read-back mismatch is reported');
  ok('apply: exactly ONE multi-path update for all restaurants, then a read-back that reports any mismatch');

  // ── report: live ──
  const now = Date.UTC(2026, 9, 5, 18, 30);
  const live = R.aggregateLive({ orders: { a: { deployment: 'orders-xpizza', build: 'b1', compat: 1, last_seen: now - 60000 }, b: { deployment: 'orders-xpizza', build: 'b1', compat: 1, last_seen: now - 1000 },
    c: { deployment: 'orders-xpizza', build: 'b0', compat: 1, last_seen: now - 31 * 60000 } } }, now);
  assert.deepStrictEqual(live, [{ app: 'orders', deployment: 'orders-xpizza', build: 'b1', compat: 1, live: 2 }], 'only the last 30 min count as live');
  // ── report: history (coverage, unknown hours, below-required) ──
  const hours = R.windowHours(now, 3);
  assert.deepStrictEqual(hours, [hourKey(Date.UTC(2026, 9, 5, 15)), hourKey(Date.UTC(2026, 9, 5, 16)), hourKey(Date.UTC(2026, 9, 5, 17))], 'complete UTC hours only (the current hour is excluded)');
  const deps = [{ id: 'orders-xpizza', app: 'orders', context: 'x_pizza' }, { id: 'kitchen-lamusa', app: 'kitchen', context: 'la_musa' }];
  const stats = { [hours[0]]: { 'orders-xpizza': { x_pizza: { 1: 4, 2: 6 } } }, [hours[2]]: { 'orders-xpizza': { x_pizza: { 2: 5 } }, 'kitchen-lamusa': { la_musa: { 2: 1 } } } };
  const h = R.aggregateHistory(stats, deps, hours, { orders: 2, kitchen: 2 });
  assert.deepStrictEqual(h.coverage.find((c) => c.deployment === 'orders-xpizza').unknown_hours, [hours[1]], 'an hour without a report is UNKNOWN');
  assert.deepStrictEqual(h.coverage.find((c) => c.deployment === 'kitchen-lamusa').unknown_hours, [hours[0], hours[1]]);
  assert.deepStrictEqual(h.below.find((b) => b.deployment === 'orders-xpizza'), { deployment: 'orders-xpizza', context: 'x_pizza', app: 'orders', required: 2, below: 4 });
  assert.strictEqual(h.totals.find((t) => t.deployment === 'orders-xpizza').reports, 15);
  ok('report: live = last 30 min grouped by app × deployment × build × compat; history = complete UTC hours, a report-less hour is UNKNOWN (never zero), below-required counted per deployment');

  // ── report: header-less from Cloud Logging lines (ruling R3.1) ──
  const entries = [
    { timestamp: '2026-10-05T17:10:00Z', textPayload: 'client_version {"endpoint":"createOrder","app":null,"deployment":null,"build":null,"compat":null,"headerless":true}' },
    { timestamp: '2026-10-05T17:20:00Z', textPayload: 'client_version {"endpoint":"createOrder","app":null,"deployment":null,"build":null,"compat":null,"headerless":true}' },
    { timestamp: '2026-10-05T17:20:00Z', textPayload: 'client_version {"endpoint":"quoteOrder","app":"orders","deployment":"orders-xpizza","build":"b","compat":1,"headerless":false}' },
    { timestamp: '2026-10-05T17:25:00Z', textPayload: 'something else entirely' },
    { timestamp: '2026-10-05T17:26:00Z', textPayload: 'client_version {broken' },
  ];
  assert.deepStrictEqual(R.countHeaderless(entries), { createOrder: { [hourKey(Date.UTC(2026, 9, 5, 17))]: 2 } });
  assert.ok(R.headerlessLogFilter().includes('client_version') && R.headerlessLogFilter().includes('headerless'));
  ok('report: header-less identity requests are counted per endpoint × hour from the client_version log lines; other and broken lines ignored');

  console.log(`pselfupdate-cli: OK (${n})`);
})().catch((e) => { console.error('pselfupdate-cli FAILED:', e); process.exit(1); });
