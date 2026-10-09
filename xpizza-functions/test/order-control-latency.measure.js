'use strict';
// D4-c4 §6 — the HEALTHY latency budget on the emulator (PLAN-D4c4 rev 13 §6): createOrder and chargeOnlineOrder (fresh +
// reuse), the switch OPEN with healthy reads, p95 Δ ≤ +10 % AND ≤ +50 ms for a warm hit, a cold miss and a single-flight
// refresh, at concurrency 10; 5 warm-ups then 50 samples per case; identical seeded state; the BASELINE (e1aeb3f, no
// switch) and the CANDIDATE alternate in the same emulator session. The OUTAGE behaviour is reported separately (bounded,
// not budgeted): a hung switch read costs at most the 1 s bound, then the 503.
//
//   npm run measure:order-control-latency -- <baseline xpizza-functions dir>       (writes the report to stdout as JSON)
//
// Each (version, case) runs in its OWN child process (one index.js per process), sequentially. The design + statistics
// are PREREG-2's (K blocks, ABBA/BAAB, an A/A control; test/_latency-stats.js).
require('./_emulator-required')('database', 'firestore');
const path = require('path');
const { execFileSync } = require('child_process');

const WARM_ROUNDS = 1; const CONC = 10;   // one warm-up round of 10 concurrent requests (≥ 5 warm-ups), then 5 rounds = 50 samples
// LAT_SAMPLES / LAT_BLOCKS override the sample and block counts for the mechanics SELF-TEST only (its outputs are not data)
const SAMPLES = process.env.LAT_SAMPLES ? Number(process.env.LAT_SAMPLES) : 50;
const BLOCKS = process.env.LAT_BLOCKS ? Number(process.env.LAT_BLOCKS) : 6;
const CASES = ['createOrder_fresh', 'charge_fresh', 'charge_reuse'];
const MODES = ['hit', 'miss', 'refresh'];

if (process.argv[2] === '--child') return child(process.argv[3], process.argv[4], process.argv[5]);

// PREREG-2 design: per row, K blocks; a block = one A/B pair (base vs candidate) + one A/A pair (base #1 vs base #2), 50
// samples per child. The side that runs FIRST in a pair follows ABBA BAAB … over the blocks (X first in blocks 0, 3, 4, 7,
// …), so with K = 6 each side runs first in exactly 3 blocks; the A/B and A/A pairs swap order every block.
const ST = require('./_latency-stats');
const BASE_DIR = path.resolve(process.argv[2] || '');
const CAND_DIR = path.join(__dirname, '..');
const runChild = (dir, cs, mode) => {
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.FORCE_COLOR;
  const t0 = Date.now();
  const out = execFileSync('node', [path.join(CAND_DIR, 'test', 'order-control-latency.measure.js'), '--child', dir, cs, mode], { encoding: 'utf8', env, maxBuffer: 1 << 26, timeout: 600000 });
  return { ...JSON.parse(out.trim().split('\n').pop()), started_at: t0, ended_at: Date.now() };
};
const xFirst = (k) => [true, false, false, true][k % 4];
const pairRun = (k, runX, runY) => { if (xFirst(k)) { const x = runX(); return { x, y: runY(), first: 'x' }; } const y = runY(); return { x: runX(), y, first: 'y' }; };
const childOk = (c) => c.errors === 0 && c.notReused === 0 && c.ms.length === SAMPLES;
const sum = (xs, f) => xs.reduce((a, c) => a + f(c), 0);
const r1 = (v) => +v.toFixed(1); const r3 = (v) => +v.toFixed(3);

const report = { design: { blocks: BLOCKS, warmups: WARM_ROUNDS * CONC, samples: SAMPLES, concurrency: CONC, order: 'ABBA BAAB per row; A/B and A/A pairs swap order each block' }, rows: [], outage: null };
const raw = {};   // row key → { ab: [{k, first, base, cand}], aa: [{k, first, base1, base2}] }
for (let k = 0; k < BLOCKS; k++) {
  for (const cs of CASES) {
    for (const mode of MODES) {
      const key = `${cs}/${mode}`; const R = raw[key] || (raw[key] = { ab: [], aa: [] });
      const ab = () => { const p = pairRun(k, () => runChild(BASE_DIR, cs, 'base'), () => runChild(CAND_DIR, cs, mode)); R.ab.push({ k, first: p.first === 'x' ? 'base' : 'cand', base: p.x, cand: p.y }); };
      const aa = () => { const p = pairRun(k, () => runChild(BASE_DIR, cs, 'base'), () => runChild(BASE_DIR, cs, 'base')); R.aa.push({ k, first: p.first === 'x' ? 'base1' : 'base2', base1: p.x, base2: p.y }); };
      if (k % 2 === 0) { ab(); aa(); } else { aa(); ab(); }
      console.error(JSON.stringify({ block: k, row: key, ab_first: R.ab[R.ab.length - 1].first, aa_first: R.aa[R.aa.length - 1].first }));
    }
  }
}
for (const cs of CASES) {
  for (const mode of MODES) {
    const R = raw[`${cs}/${mode}`];
    const abBlocks = R.ab.map((b) => ({ x: b.base.ms, y: b.cand.ms }));
    const aaBlocks = R.aa.map((b) => ({ x: b.base1.ms, y: b.base2.ms }));
    const pooled = ST.pooledP95Delta(abBlocks); const paired = ST.pairedMedianDelta(abBlocks); const noise = ST.aaNoise(aaBlocks);
    const base = { attempts: sum(R.ab, (b) => b.base.attempts), errors: sum(R.ab, (b) => b.base.errors) };
    const cand = { attempts: sum(R.ab, (b) => b.cand.attempts), errors: sum(R.ab, (b) => b.cand.errors) };
    const valid = R.ab.every((b) => childOk(b.base) && childOk(b.cand)) && R.aa.every((b) => childOk(b.base1) && childOk(b.base2));
    const v = ST.verdict({ pooled, paired, noise, base, cand, valid });
    const cacheStates = {}; for (const b of R.ab) for (const [s, c] of Object.entries(b.cand.cache)) cacheStates[s] = (cacheStates[s] || 0) + c;
    report.rows.push({
      case: cs, cache: mode,
      base_p95: r1(pooled.x_p95), cand_p95: r1(pooled.y_p95), p95_delta_ms: r1(pooled.delta_ms), p95_delta_pct: r1(pooled.delta_rel * 100),
      paired_median_delta_ms: r1(paired), paired_median_ci95: ST.bootstrapCI(abBlocks).map(r1), block_median_deltas: ST.blockMedianDeltas(abBlocks).map(r1),
      aa_noise_p95_pct: r1(noise.noise_p95 * 100), aa_noise_median_ms: r1(noise.noise_median),
      aa_pooled_p95_delta_ms: r1(ST.pooledP95Delta(aaBlocks).delta_ms), aa_paired_median_delta_ms: r1(ST.pairedMedianDelta(aaBlocks)),
      bar_p95_rel_pct: r1(Math.max(0.10, noise.noise_p95) * 100), bar_median_ms: r3(Math.max(5, noise.noise_median)),
      ab_first: R.ab.map((b) => b.first), aa_first: R.aa.map((b) => b.first),
      base_attempts: base.attempts, cand_attempts: cand.attempts, base_errors: base.errors, cand_errors: cand.errors,
      aa_attempts: sum(R.aa, (b) => b.base1.attempts + b.base2.attempts), aa_errors: sum(R.aa, (b) => b.base1.errors + b.base2.errors),
      not_reused: sum(R.ab, (b) => b.base.notReused + b.cand.notReused) + sum(R.aa, (b) => b.base1.notReused + b.base2.notReused),
      cand_cache_states: cacheStates, valid, checks: v.checks, pass: v.pass,
    });
    console.error(JSON.stringify(report.rows[report.rows.length - 1]));
  }
}
report.outage = runChild(CAND_DIR, 'createOrder_fresh', 'outage');
report.valid = report.rows.every((r) => r.valid);
report.pass = report.rows.every((r) => r.pass);
report.raw = raw;   // every child's samples, statuses, cache states and wall-clock window — the stats recompute from this
console.log(JSON.stringify(report));
process.exit(0);

// ── one (version, case, mode) in its own process ──────────────────────────────────────────────────────────────────
async function child(dir, cs, mode) {
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
  process.env.MAKE_SECRET = 'lat-secret';
  process.env.PIXELPAY_RETURN_URL_LA_MUSA = 'https://lamusa.test';
  const req = (m) => require(path.join(dir, m));
  const http = require('http'); const express = require(path.join(dir, 'node_modules', 'express'));
  const wr = require.resolve(path.join(dir, 'whatsapp'));
  const realWa = req('whatsapp'); require.cache[wr] = { id: wr, filename: wr, loaded: true, children: [], paths: [], exports: { ...realWa, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) } };
  const ph = require.resolve(path.join(dir, 'pixelpay-hosted'));
  const realH = req('pixelpay-hosted'); require.cache[ph] = { id: ph, filename: ph, loaded: true, children: [], paths: [], exports: { ...realH, createHostedCharge: async (r) => ({ ok: true, url: `https://pay.test/${r.pixelpayOrderId}` }) } };
  const logs = [];
  const origLog = console.log; console.log = () => {};   // stdout carries only this child's JSON result
  console.warn = () => {}; console.error = () => {};
  const app = req('index.js');
  const admin = require(path.join(dir, 'node_modules', 'firebase-admin'));
  const rtdb = admin.database(); const fs = admin.firestore();
  const { catalogSnapshot } = req('catalog/generate-form-bundle');
  const seedOnce = async () => {
    if ((await rtdb.ref('restaurants/x_pizza/identity').get()).exists()) return;
    const { buildPublishCandidate } = req('tools/publish-version'); const { buildSourceFromCode } = req('tools/seed-source-store');
    const { sourceRefOf, canonicalize } = req('catalog/source-store'); const { publishVersion } = req('catalog/catalog-publish');
    const { backfillIdentities } = req('catalog/identity-backfill'); const { getActivePointer } = req('catalog/catalog-firestore'); const { makeRtdbMirror } = req('catalog/mirror-rtdb');
    await sourceRefOf(fs, 'x_pizza').set(canonicalize(buildSourceFromCode('x_pizza')));
    const { input } = buildPublishCandidate('x_pizza', { activeVersionId: null }, { source_sha: 'lat' });
    await publishVersion(fs, 'x_pizza', input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    await backfillIdentities(fs, 'x_pizza', catalogSnapshot('x_pizza'), { captured: await getActivePointer(fs, 'x_pizza') });
    const O = { open: true, start: '00:00', end: '24:00' };
    await rtdb.ref('restaurants/x_pizza/identity').set({ name: 'X', phone: '+504', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: { sun: O, mon: O, tue: O, wed: O, thu: O, fri: O, sat: O } });
  };
  await seedOnce();
  await rtdb.ref('order_control/x_pizza/current').set({ paused: false, version: 1, op_id: 'lat' });   // OPEN, healthy
  const it = catalogSnapshot('x_pizza').items.find((i) => i.key === 'Carnivora');
  let seq = 0;
  const body = (oid, method) => ({ restaurant_id: 'x_pizza', order_id: oid, customer_name: 'Lat', customer_phone: `97${String(Date.now() % 1e6).padStart(6, '0')}${seq % 10}`, customer_email: 'l@x.com', items_text: `1x ${it.display.name}`, order_type: 'pickup', payment_method: method, items: [{ name: it.display.name, qty: 1, price: it.price, extras: [] }] });
  const handler = cs === 'createOrder_fresh' ? app.createOrder : app.chargeOnlineOrder;
  const srv = await new Promise((r) => { const w = express(); w.use(express.json()); w.use(handler); const s = http.createServer(w).listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const reuseOid = `lat_reuse_${process.pid}`;
  // every request carries its own phone (seq), so the per-phone limit (4 / 10 min) never refuses a sample; the charge
  // fingerprint does not include the phone, so a reuse request still classifies as a reuse of the same live checkout
  const oneBody = () => (cs === 'charge_reuse' ? (++seq, body(reuseOid, 'online')) : body(`lat_${process.pid}_${++seq}`, cs === 'charge_fresh' ? 'online' : 'cash'));
  const fire = async () => { const t = process.hrtime.bigint(); const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer lat-secret' }, body: JSON.stringify(oneBody()) }); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (_) {} return { ms: Number(process.hrtime.bigint() - t) / 1e6, status: r.status, attempt: j && j.attempt_id }; };
  let OC = null; try { OC = req('order-control'); } catch (_) {}
  // the candidate's cache state per request comes from the reader's test observer (a healthy OPEN request logs nothing)
  if (OC) OC._observeForTests((rec) => logs.push(rec));
  const prep = () => {
    if (!OC) return;
    if (mode === 'miss') OC._resetForTests();                       // every request: a cold miss
    if (mode === 'refresh' && !prep.done) { OC._resetForTests({ ttlMs: 0 }); prep.done = true; }   // every request after the first: an expired entry → a single-flight refresh
  };
  let reuseAttempt = null;   // charge_reuse: the live checkout every sample must REUSE (same attempt_id) — checked, not assumed
  if (cs === 'charge_reuse') { const r0 = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer lat-secret' }, body: JSON.stringify(body(reuseOid, 'online')) }); const j0 = JSON.parse(await r0.text()); reuseAttempt = j0.attempt_id || null; }
  if (mode === 'outage') {
    // a HUNG switch read: every read of order_control never answers → bounded at the 1 s timeout, then the 503
    let p = Object.getPrototypeOf(rtdb.ref('x')); while (p && !Object.prototype.hasOwnProperty.call(p, 'once')) p = Object.getPrototypeOf(p);
    const real = p.once; p.once = function (...a) { if (String(this.toString()).includes('/order_control/')) return new Promise(() => {}); return real.apply(this, a); };
    OC._resetForTests();
    const out = []; for (let i = 0; i < 10; i++) { await rtdb.ref('rate_limits').remove(); OC._resetForTests(); out.push(await fire()); }
    srv.close(); console.log = origLog;
    origLog(JSON.stringify({ case: 'createOrder fresh, switch read HUNG', max_ms: Math.max(...out.map((x) => x.ms)), statuses: [...new Set(out.map((x) => x.status))], n: out.length }));
    process.exit(0);
  }
  const ms = []; const statusCounts = {}; let attempts = 0; let errors = 0; let notReused = 0;
  for (let round = 0; round < WARM_ROUNDS + Math.ceil(SAMPLES / CONC); round++) {
    await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove();
    prep();
    const batch = await Promise.all(Array.from({ length: CONC }, () => fire()));
    if (round >= WARM_ROUNDS) for (const b of batch) {
      if (ms.length >= SAMPLES) continue;
      attempts++; statusCounts[b.status] = (statusCounts[b.status] || 0) + 1; if (b.status !== 200) errors++;
      if (cs === 'charge_reuse' && b.status === 200 && (!reuseAttempt || b.attempt !== reuseAttempt)) notReused++;
      ms.push(b.ms);
    }
  }
  srv.close();
  console.log = origLog;
  const cache = {}; for (const l of logs) cache[l.cache] = (cache[l.cache] || 0) + 1;
  origLog(JSON.stringify({ ms, attempts, errors, notReused, statusCounts, cache }));
  process.exit(0);
}
