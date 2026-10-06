'use strict';
// P-SELFUPDATE — the owner CLIs' pure cores: the floor plans (tools/client-floor-admin.js) and the version report
// aggregation + header-less log parsing (tools/client-version-report-core.js). Run: node pselfupdate-cli.test.js
const assert = require('assert');
const F = require('./tools/client-floor-admin');
const R = require('./tools/client-version-report-core');
const { hourKey } = require('./client-version');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
// a drained event loop (e.g. a never-settling promise) must FAIL, never pass as a silent exit 0
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('pselfupdate-cli FAILED: exited without completing'); process.exitCode = 1; } });
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

  // ── codex CP1 B1: discovery can never silently omit a restaurant ──
  p = F.planFloor({ kind: 'kitchen', op: 'set', value: 1, current: {}, rids, registryOk: false, maxCompat: 1 });
  assert.ok(!p.ok && /registry discovery FAILED/.test(p.error), '🔴 set REFUSED when the registry could not be read');
  p = F.planFloor({ kind: 'kitchen', op: 'raise', value: 1, current: {}, rids, registryOk: false, maxCompat: 1 });
  assert.ok(!p.ok && /registry discovery FAILED/.test(p.error), '🔴 raise REFUSED when the registry could not be read');
  p = F.planFloor({ kind: 'kitchen', op: 'delete', current: {}, rids: ['x_pizza'], floorKeys: ['ghost_9', 'Bad Key'], registryOk: false, maxCompat: 1 });
  assert.ok(p.ok, 'delete needs no registry');
  assert.deepStrictEqual(Object.keys(p.updates).sort(), [kp('Bad Key'), kp('ghost_9'), kp('x_pizza')].sort(), '🔴 delete covers EVERY existing floor node (even an identity-less or malformed key) ∪ the discovered restaurants');
  p = F.planFloor({ kind: 'kitchen', op: 'set', value: 1, current: {}, rids: ['x_pizza'], floorKeys: ['ghost_9'], maxCompat: 1 });
  assert.deepStrictEqual(Object.keys(p.updates).sort(), [kp('ghost_9'), kp('x_pizza')].sort(), 'set also covers a restaurant known only by its existing floor');
  assert.ok(!F.planFloor({ kind: 'kitchen', op: 'set', value: 1, current: {}, rids: ['x_pizza'], floorKeys: ['Bad Key'], maxCompat: 1 }).ok, 'set refuses a malformed key it would have to cover');
  // discoverRestaurants: registry failure and registry TIMEOUT are reported, RTDB keys + floor keys still found
  const rt = { ref: () => ({ once: async () => ({ val: () => ({ x_pizza: { identity: {} }, ghost_9: { client_floor: { kitchen: 2 } }, la_musa: { item_availability: {} } }) }) }) };
  let d = await F.discoverRestaurants(rt, async () => { throw new Error('firestore down'); });
  assert.deepStrictEqual({ ok: d.registryOk, rids: d.rids, floors: d.floorKeys }, { ok: false, rids: ['ghost_9', 'la_musa', 'x_pizza'], floors: ['ghost_9'] });
  { let dl; const DEADLINE = Symbol('deadline');
    d = await Promise.race([F.discoverRestaurants(rt, () => new Promise(() => {}), { timeoutMs: 50 }), new Promise((r) => { dl = setTimeout(() => r(DEADLINE), 2000); })]);
    clearTimeout(dl);
    assert.notStrictEqual(d, DEADLINE, '🔴 a HUNG registry read must be BOUNDED by discovery\'s own timeout');
    assert.strictEqual(d.registryOk, false, 'a HUNG registry read is a failure, not an empty registry'); }
  // WIRING: the CLI hands the registry reader to discoverRestaurants UNWRAPPED. (The real Firestore client presents its
  // failures as hangs on the emulator — bounded above — so a swallowed REJECTION cannot be produced end-to-end; this pins
  // that the CLI cannot turn one into an empty registry.)
  const cliSrc = require('fs').readFileSync(require('path').join(__dirname, 'tools', 'client-floor.js'), 'utf8');
  const call = cliSrc.match(/discoverRestaurants\(rtdb,([^;]*)\);/);
  assert.ok(call, 'the CLI calls discoverRestaurants');
  assert.ok(!/\.catch\s*\(/.test(call[1]) && !/\|\|\s*\[\]/.test(call[1]), '🔴 the CLI must not swallow a registry failure (no .catch / || [] around the reader)');
  d = await F.discoverRestaurants(rt, async () => ['synthetic_3']);
  assert.deepStrictEqual({ ok: d.registryOk, rids: d.rids }, { ok: true, rids: ['ghost_9', 'la_musa', 'synthetic_3', 'x_pizza'] }, 'registry ∪ every RTDB restaurant key (identity or not) ∪ floor keys');
  ok('codex B1: set/raise REFUSE on a failed or hung registry read; delete needs no registry and covers every floor node (identity-less, malformed); discovery = registry ∪ RTDB keys ∪ floor keys');

  // ── apply = ONE multi-path update + read-back ──
  const store = {}; let updates = 0;
  const fake = { ref: (path) => ({
    update: async (u) => { updates += 1; for (const [k, v] of Object.entries(u)) { if (v === null) delete store[k]; else store[k] = v; } },
    once: async () => ({ val: () => {
      if (path === 'restaurants') { const out = {}; for (const [k, v] of Object.entries(store)) { const m = k.match(/^restaurants\/([^/]+)\/client_floor\/kitchen$/); if (m) out[m[1]] = { client_floor: { kitchen: v } }; } return out; }
      return path in store ? store[path] : null; } }) }) };
  const plan = F.planFloor({ kind: 'kitchen', op: 'set', value: 1, current: {}, rids, maxCompat: 1 });
  assert.deepStrictEqual(await F.applyPlan(fake, plan, { kind: 'kitchen', target: 1 }), { ok: true, mismatched: [] });
  assert.strictEqual(updates, 1, '🔴 ONE multi-path update — never one write per restaurant');
  store['restaurants/stray_7/client_floor/kitchen'] = 4;   // a floor the plan did not cover (e.g. added concurrently)
  const scan = await F.applyPlan(fake, plan, { kind: 'kitchen', target: 1 });
  assert.ok(!scan.ok && scan.mismatched.some((m) => /re-scan restaurants\/stray_7/.test(m)), '🔴 the FULL re-scan catches a floor outside the plan — success is never reported on an incomplete plan');
  delete store['restaurants/stray_7/client_floor/kitchen'];
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

  // ── report: ONE explicit [start, end) for both sources (codex CP1 B2) + header-less counted from the log lines ──
  const W = R.reportWindow(now, 24);                                           // now = 2026-10-05 18:30Z
  assert.strictEqual(W.endIso, '2026-10-05T18:00:00.000Z', 'end = the start of the current (incomplete) hour, exclusive');
  assert.strictEqual(W.startIso, '2026-10-04T18:00:00.000Z', 'start = end − 24 h — NOT now − 24 h (18:30), which would skip 18:00–18:30');
  assert.deepStrictEqual([W.hours[0], W.hours[23]], [hourKey(Date.UTC(2026, 9, 4, 18)), hourKey(Date.UTC(2026, 9, 5, 17))], 'the counters\' hours are exactly the window\'s');
  const f = R.headerlessLogFilter(W);
  assert.ok(f.includes('timestamp>="2026-10-04T18:00:00.000Z"') && f.includes('timestamp<"2026-10-05T18:00:00.000Z"'), 'the log query is bounded by the SAME [start, end)');
  assert.throws(() => R.headerlessLogFilter(), /explicit report window/, 'no window → no query (never an unbounded/rolling one)');
  const line = (ep, hl) => `client_version {"endpoint":"${ep}","app":null,"deployment":null,"build":null,"compat":null,"headerless":${hl}}`;
  const entries = [
    { timestamp: '2026-10-04T18:10:00Z', textPayload: line('createOrder', true) },       // the FIRST PARTIAL hour a rolling 24h would miss
    { timestamp: '2026-10-04T17:59:59Z', textPayload: line('createOrder', true) },       // before the window — not counted
    { timestamp: '2026-10-05T18:00:00Z', textPayload: line('createOrder', true) },       // at end (exclusive) — not counted
    { timestamp: '2026-10-05T17:20:00Z', textPayload: line('createOrder', true) },
    { timestamp: '2026-10-05T17:20:00Z', textPayload: line('quoteOrder', false) },
    { timestamp: '2026-10-05T17:25:00Z', textPayload: 'something else entirely' },
    { timestamp: '2026-10-05T17:26:00Z', textPayload: 'client_version {broken' },
  ];
  let hc = R.countHeaderless(entries, { startMs: W.startMs, endMs: W.endMs, limit: 1000 });
  assert.deepStrictEqual(hc.counts, { createOrder: { [hourKey(Date.UTC(2026, 9, 4, 18))]: 1, [hourKey(Date.UTC(2026, 9, 5, 17))]: 1 } }, '🔴 the first partial hour IS counted; outside-window, non-header-less and broken lines are not');
  assert.strictEqual(hc.truncated, false);
  hc = R.countHeaderless(entries, { startMs: W.startMs, endMs: W.endMs, limit: entries.length });
  assert.strictEqual(hc.truncated, true, '🔴 a read that hit the limit is TRUNCATED (a lower bound, never complete)');
  ok('report window (codex B2): one explicit [start, end) of complete UTC hours for the counters AND the log query; a header-less request in the first partial hour is counted; outside-window entries are not; a capped read is TRUNCATED');

  // ── codex CP1 r2 B2: a fractional window is REFUSED (the counters are hourly) ──
  for (const bad of ['1.5', '0.5', 'abc', '0', '-1', '721', '1e1', '', ' 2']) {
    const r = R.parseReportArgs(['--hours', bad]);
    assert.ok(!r.ok, `🔴 --hours ${JSON.stringify(bad)} must be refused`);
  }
  assert.ok(!R.parseReportArgs(['--hours']).ok, '--hours with no value is refused');
  for (const good of ['1', '24', '720']) assert.deepStrictEqual(R.parseReportArgs(['--hours', good]), { ok: true, hours: Number(good), required: {} });
  assert.deepStrictEqual(R.parseReportArgs([]), { ok: true, hours: 24, required: {} }, 'default 24 h unchanged');
  assert.deepStrictEqual(R.parseReportArgs(['--require', 'orders=2,kitchen=3']).required, { orders: 2, kitchen: 3 });
  for (const bad of ['orders=2.5', 'orders=', 'orders', 'Orders=2', 'orders=two']) assert.ok(!R.parseReportArgs(['--require', bad]).ok, `--require ${bad} refused`);
  assert.throws(() => R.reportWindow(Date.UTC(2026, 9, 5, 18, 30), 1.5), /INTEGER/, '🔴 reportWindow itself refuses a fractional window (defence in depth)');
  const W1 = R.reportWindow(Date.UTC(2026, 9, 5, 18, 30), 2);
  assert.deepStrictEqual([W1.startIso, W1.endIso, W1.hours.length], ['2026-10-05T16:00:00.000Z', '2026-10-05T18:00:00.000Z', 2], 'an integer window: counters and logs cover the SAME whole hours');
  ok('codex r2 B2: --hours must be a whole number in [1,720] (1.5 / 0.5 / abc / 0 / 721 / 1e1 refused); --require generations must be integers; reportWindow refuses a fractional window; integer windows unchanged');

  FINISHED = true;
  console.log(`pselfupdate-cli: OK (${n})`);
})().catch((e) => { console.error('pselfupdate-cli FAILED:', e); process.exit(1); });
