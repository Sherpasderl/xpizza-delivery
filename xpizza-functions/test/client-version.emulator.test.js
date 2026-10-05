'use strict';
// P-SELFUPDATE §4 — reportClientVersion + sweepClientVersions on the RTDB + Firestore emulators.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:client-version
//
// The REAL exported handler (express-wrapped, as the other emulator suites do) with a manifest carrying a SYNTHETIC third
// deployment (context synthetic_3, registered in Firestore — the registry decides) and one whose context is NOT
// registered (ghost_4 — refused). Cells:
//   schema   — every refusal is a 400 BEFORE any database work (the whole RTDB tree is byte-identical afterwards)
//   record   — server-time last_seen, build only in the instance record, hourly counter keyed deployment/context/compat
//   limiter  — the DEDICATED bucket (client_version_limits) caps a burst; the order buckets (rate_limits) are untouched;
//              a limiter FAILURE drops the report ({allowed:false, failed:true}), unlike the order path's fail-open
//   sweep    — indexed, bounded, CONDITIONAL: stale instances/limits removed, fresh kept, a record refreshed between the
//              query and the delete is kept; counters older than 30 days removed by key; > one batch handled
require('./_emulator-required')('database', 'firestore');
const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'cv-secret';

const sitesPath = require.resolve('../platform/sites.json');
const synth = JSON.parse(JSON.stringify(require('../platform/sites.json')));
synth.deployments.push({ id: 'orders-synth', app: 'orders', folder: 'synth-orders', entrypoints: ['index.html'], context: 'synthetic_3', origins: ['https://orders.synthetic.test'] });
synth.deployments.push({ id: 'orders-ghost', app: 'orders', folder: 'ghost-orders', entrypoints: ['index.html'], context: 'ghost_4', origins: ['https://orders.ghost.test'] });
require.cache[sitesPath] = { id: sitesPath, filename: sitesPath, loaded: true, children: [], paths: [], exports: synth };

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const CV = require('../client-version');
const { PLATFORM } = require('../platform-manifest');
const { ServerValue } = require('firebase-admin/database');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('client-version(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

function post(body, ip = '10.0.0.1', method = 'POST') {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(app.reportClientVersion);
    const s = http.createServer(w).listen(0, async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const tree = async () => JSON.stringify((await rtdb.ref().get()).val());
const R = (o = {}) => ({ app: 'orders', deployment: 'orders-xpizza', context: 'x_pizza', build: 'a1b2c3d4e5f6', compat: 1, instance: 'inst_xpizza_0001', ...o });

(async () => {
  await fs.collection('restaurants').doc('synthetic_3').set({ name: 'Synthetic 3' });   // the registry learns it

  // ═══ schema: refused BEFORE any database work ═══
  await rtdb.ref().set(null);
  const before = await tree();
  const bad = [
    ['unknown app', R({ app: 'nope' })], ['app/deployment mismatch', R({ deployment: 'kitchen-xpizza' })],
    ['context ≠ the deployment\'s', R({ context: 'la_musa' })], ['unregistered context (ghost_4)', R({ deployment: 'orders-ghost', context: 'ghost_4' })],
    ['compat 0', R({ compat: 0 })], ['compat above the app\'s generation', R({ compat: PLATFORM.maxCompat('orders') + 1 })], ['compat 1.5', R({ compat: 1.5 })],
    ['compat as a string', R({ compat: '1' })], ['build with a slash', R({ build: 'a/b' })], ['build too long', R({ build: 'x'.repeat(81) })],
    ['instance too short', R({ instance: 'abc' })], ['instance path chars', R({ instance: 'inst/../x1234' })], ['client-supplied last_seen', R({ last_seen: 1 })],
    ['unknown diag', R({ diag: 'whatever' })], ['array body', [R()]], ['deployment path chars', R({ deployment: '../orders' })],
  ];
  for (const [label, body] of bad) {
    const r = await post(body);
    assert.strictEqual(r.status, 400, `${label}: ${r.text}`);
  }
  assert.strictEqual((await post(null, '10.0.0.1', 'GET')).status, 405, 'GET → 405');
  assert.strictEqual(await tree(), before, '🔴 a refused report touched the database');
  ok(`schema: ${bad.length} malformed reports + a GET refused (400/405) and the WHOLE RTDB tree is byte-identical — no database work before validation`);

  // ═══ record ═══
  const t0 = Date.now();
  let r = await post(R());
  assert.strictEqual(r.status, 204, r.text);
  const rec = (await rtdb.ref('client_versions/orders/inst_xpizza_0001').get()).val();
  assert.deepStrictEqual(Object.keys(rec).sort(), ['build', 'compat', 'context', 'deployment', 'last_seen']);
  assert.ok(typeof rec.last_seen === 'number' && rec.last_seen >= t0 - 5000 && rec.last_seen <= Date.now() + 5000, 'last_seen is SERVER time');
  assert.strictEqual(rec.build, 'a1b2c3d4e5f6');
  const hour = CV.hourKey(Date.now());
  assert.strictEqual((await rtdb.ref(`client_version_stats/${hour}/orders-xpizza/x_pizza/1`).get()).val(), 1);
  assert.strictEqual((await post(R())).status, 204);
  assert.strictEqual((await rtdb.ref(`client_version_stats/${hour}/orders-xpizza/x_pizza/1`).get()).val(), 2, 'the hourly counter counts reports');
  const statsKeys = JSON.stringify((await rtdb.ref(`client_version_stats/${hour}`).get()).val());
  assert.ok(!statsKeys.includes('a1b2c3d4e5f6'), 'build is NEVER a counter key (bounded cardinality)');
  assert.strictEqual((await post(R({ app: 'legal', deployment: 'legal', context: 'platform', instance: 'inst_legal_0001' }))).status, 204, 'a platform-context page');
  assert.strictEqual((await post(R({ deployment: 'orders-synth', context: 'synthetic_3', instance: 'inst_synth_0001' }))).status, 204, 'the synthetic third deployment, registry-known');
  assert.strictEqual((await rtdb.ref(`client_version_stats/${hour}/orders-synth/synthetic_3/1`).get()).val(), 1);
  assert.strictEqual((await post(R({ app: 'kitchen', deployment: 'kitchen-lamusa', context: 'la_musa', instance: 'inst_kds_00001', diag: 'kitchen_floor_refusal' }))).status, 204);
  assert.strictEqual((await rtdb.ref(`client_version_stats/${hour}/diag/kitchen_floor_refusal/kitchen-lamusa/1`).get()).val(), 1, 'a module KDS\'s below-floor refusal is counted as a diagnostic');
  // last_seen is the DATABASE's server time (ServerValue.TIMESTAMP), not the function's clock: drive recordReport with a
  // fake function clock (0) — the bucket follows that clock, last_seen must not
  await CV.recordReport(rtdb, ServerValue, R({ instance: 'inst_clock_0001' }), 0);
  const ls = (await rtdb.ref('client_versions/orders/inst_clock_0001/last_seen').get()).val();
  assert.ok(ls > 1e12 && Math.abs(ls - Date.now()) < 60000, `🔴 last_seen must be RTDB server time, not the caller's clock (got ${ls})`);
  assert.strictEqual((await rtdb.ref('client_version_stats/1970010100/orders-xpizza/x_pizza/1').get()).val(), 1, 'the hour bucket follows the function clock');
  ok('record: server-time last_seen, build only in the live record, hourly counter per deployment/context/compat; platform context, the synthetic third deployment and a kitchen refusal diagnostic all recorded');

  // ═══ limiter ═══
  await rtdb.ref('rate_limits').set(null);
  let last;
  for (let i = 0; i < CV.HEARTBEAT_LIMIT.max; i += 1) { last = await post(R({ instance: `inst_burst_${String(i).padStart(4, '0')}` }), '10.9.9.9'); assert.strictEqual(last.status, 204, `burst ${i}`); }
  last = await post(R({ instance: 'inst_burst_over' }), '10.9.9.9');
  assert.strictEqual(last.status, 429, 'the dedicated bucket caps the burst'); assert.ok(Number(last.json && 1) && true);
  assert.strictEqual((await rtdb.ref('client_versions/orders/inst_burst_over').get()).val(), null, 'a limited report writes nothing');
  assert.strictEqual((await rtdb.ref('rate_limits').get()).val(), null, '🔴 the ORDER buckets (rate_limits) are never touched by telemetry');
  assert.strictEqual((await post(R({ instance: 'inst_other_ip01' }), '10.9.9.8')).status, 204, 'another IP is unaffected');
  // limiter FAILURE → dropped (not the order path's fail-open)
  const failing = { ref: (p) => ({ transaction: async () => { throw new Error('UNAVAILABLE'); }, update: async () => { throw new Error('must not write'); } }) };
  const lim = await CV.checkHeartbeatLimit(failing, '10.1.1.1');
  assert.deepStrictEqual({ allowed: lim.allowed, failed: lim.failed }, { allowed: false, failed: true });
  let wrote = false;
  const fakeRes = { _s: 0, status(c) { this._s = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; }, end() { return this; } };
  const failingDb = { ref: (p) => ({ transaction: async () => { throw new Error('UNAVAILABLE'); }, update: async () => { wrote = true; } }) };
  await CV.handleReport({ method: 'POST', body: R(), headers: { 'x-forwarded-for': '10.1.1.1' } }, fakeRes, { db: failingDb, ServerValue, platform: PLATFORM, registry: { ready: async () => {}, known: () => new Set(['x_pizza']) } });
  assert.strictEqual(fakeRes._s, 503); assert.strictEqual(fakeRes.body.dropped, true); assert.strictEqual(wrote, false, 'a dropped report writes nothing');
  ok(`limiter: the dedicated per-IP bucket allows ${CV.HEARTBEAT_LIMIT.max} then 429s (writing nothing); rate_limits untouched; a limiter FAILURE returns {allowed:false, failed:true} and the report is DROPPED (503, no write)`);

  // ═══ sweep ═══
  await rtdb.ref().set(null);
  const now = Date.now();
  const OLD = now - CV.INSTANCE_TTL_MS - 60000;
  const seed = {};
  for (let i = 0; i < 2 * CV.SWEEP_BATCH + 50; i += 1) seed[`client_versions/kitchen/old_${String(i).padStart(5, '0')}`] = { deployment: 'kitchen-xpizza', context: 'x_pizza', build: 'b', compat: 1, last_seen: OLD };
  seed['client_versions/kitchen/fresh_00001'] = { deployment: 'kitchen-xpizza', context: 'x_pizza', build: 'b', compat: 1, last_seen: now };
  seed['client_versions/orders/racer_00001'] = { deployment: 'orders-xpizza', context: 'x_pizza', build: 'b', compat: 1, last_seen: OLD };
  seed['client_version_limits/oldkey'] = { count: 3, window_start: now - CV.HEARTBEAT_LIMIT.windowMs - 1000 };
  seed['client_version_limits/livekey'] = { count: 3, window_start: now };
  const oldHour = CV.hourKey(now - CV.STATS_RETENTION_MS - 3600000), keepHour = CV.hourKey(now - 3600000);
  seed[`client_version_stats/${oldHour}/orders-xpizza/x_pizza/1`] = 7;
  seed[`client_version_stats/${keepHour}/orders-xpizza/x_pizza/1`] = 9;
  await rtdb.ref().update(seed);
  // the RACE: the record is refreshed AFTER the indexed query selected it and BEFORE its conditional delete
  let raced = false;
  const racyDb = { ref: (p) => {
    const r = rtdb.ref(p);
    if (p === 'client_versions/orders/racer_00001') return { transaction: async (fn) => { if (!raced) { raced = true; await r.update({ last_seen: ServerValue.TIMESTAMP }); } return r.transaction(fn); } };
    return r;
  } };
  const out = await CV.sweepClientVersions({ db: racyDb, platform: PLATFORM, now: () => now });
  assert.ok(raced, 'premise: the race was injected');
  assert.strictEqual(out.instances, 2 * CV.SWEEP_BATCH + 50, `every stale instance removed across ${Math.ceil((2 * CV.SWEEP_BATCH + 50) / CV.SWEEP_BATCH)} bounded batches (${JSON.stringify(out)})`);
  const kitchen = (await rtdb.ref('client_versions/kitchen').get()).val();
  assert.deepStrictEqual(Object.keys(kitchen), ['fresh_00001'], 'the fresh instance is kept');
  assert.ok((await rtdb.ref('client_versions/orders/racer_00001').get()).val(), '🔴 a record refreshed between the query and the delete is KEPT (conditional delete)');
  assert.strictEqual((await rtdb.ref('client_version_limits/oldkey').get()).val(), null);
  assert.ok((await rtdb.ref('client_version_limits/livekey').get()).val(), 'a live limiter window is kept');
  assert.strictEqual((await rtdb.ref(`client_version_stats/${oldHour}`).get()).val(), null, 'counters past 30 days removed');
  assert.strictEqual((await rtdb.ref(`client_version_stats/${keepHour}/orders-xpizza/x_pizza/1`).get()).val(), 9, 'recent counters kept');
  ok('sweep: indexed + bounded batches remove every stale instance (> 2 batches), keep the fresh one and the one refreshed mid-sweep (conditional delete); expired limiter windows removed, live kept; counters past 30 days removed by key, recent kept');

  FINISHED = true;
  console.log(`client-version(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('client-version(emulator) FAILED:', e); process.exit(1); });
