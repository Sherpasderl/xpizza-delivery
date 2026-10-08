'use strict';
// D4-c4 §6 — the HEALTHY latency budget on the emulator (PLAN-D4c4 rev 13 §6): createOrder and chargeOnlineOrder (fresh +
// reuse), the switch OPEN with healthy reads, p95 Δ ≤ +10 % AND ≤ +50 ms for a warm hit, a cold miss and a single-flight
// refresh, at concurrency 10; 5 warm-ups then 50 samples per case; identical seeded state; the BASELINE (e1aeb3f, no
// switch) and the CANDIDATE alternate in the same emulator session. The OUTAGE behaviour is reported separately (bounded,
// not budgeted): a hung switch read costs at most the 1 s bound, then the 503.
//
//   npm run measure:order-control-latency -- <baseline xpizza-functions dir>       (writes the report to stdout as JSON)
//
// Each (version, case) runs in its OWN child process (one index.js per process), sequentially, alternating versions.
require('./_emulator-required')('database', 'firestore');
const path = require('path');
const { execFileSync } = require('child_process');

const WARM_ROUNDS = 1; const SAMPLES = 50; const CONC = 10;   // one warm-up round of 10 concurrent requests (≥ 5 warm-ups), then 5 rounds = 50 samples
const CASES = ['createOrder_fresh', 'charge_fresh', 'charge_reuse'];
const MODES = ['hit', 'miss', 'refresh'];

if (process.argv[2] === '--child') return child(process.argv[3], process.argv[4], process.argv[5]);

const BASE_DIR = path.resolve(process.argv[2] || '');
const CAND_DIR = path.join(__dirname, '..');
const runChild = (dir, cs, mode) => {
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.FORCE_COLOR;
  const out = execFileSync('node', [path.join(CAND_DIR, 'test', 'order-control-latency.measure.js'), '--child', dir, cs, mode], { encoding: 'utf8', env, maxBuffer: 1 << 26, timeout: 600000 });
  return JSON.parse(out.trim().split('\n').pop());
};
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const report = { warmups: WARM_ROUNDS * CONC, samples: SAMPLES, concurrency: CONC, rows: [], outage: null };
for (const cs of CASES) {
  for (const mode of MODES) {
    const base = runChild(BASE_DIR, cs, 'base');
    const cand = runChild(CAND_DIR, cs, mode);
    const bp = p95(base.ms); const cp = p95(cand.ms);
    const d = cp - bp;
    const row = { case: cs, cache: mode, base_p95: +bp.toFixed(1), cand_p95: +cp.toFixed(1), delta_ms: +d.toFixed(1), delta_pct: +((d / bp) * 100).toFixed(1),
      base_median: +med(base.ms).toFixed(1), cand_median: +med(cand.ms).toFixed(1), base_status: base.status, cand_status: cand.status, cand_cache_states: cand.cache,
      within: d <= 50 && d <= 0.10 * bp };
    report.rows.push(row);
    console.error(JSON.stringify(row));
  }
}
report.outage = runChild(CAND_DIR, 'createOrder_fresh', 'outage');
report.pass = report.rows.every((r) => r.within);
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
  const origLog = console.log; console.log = (...a) => { const l = a.join(' '); if (l.startsWith('order_control_read ')) logs.push(JSON.parse(l.slice('order_control_read '.length))); };
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
  const oneBody = () => (cs === 'charge_reuse' ? body(reuseOid, 'online') : body(`lat_${process.pid}_${++seq}`, cs === 'charge_fresh' ? 'online' : 'cash'));
  const fire = async () => { const t = process.hrtime.bigint(); const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer lat-secret' }, body: JSON.stringify(oneBody()) }); await r.text(); return { ms: Number(process.hrtime.bigint() - t) / 1e6, status: r.status }; };
  let OC = null; try { OC = req('order-control'); } catch (_) {}
  const prep = () => {
    if (!OC) return;
    if (mode === 'miss') OC._resetForTests();                       // every request: a cold miss
    if (mode === 'refresh' && !prep.done) { OC._resetForTests({ ttlMs: 0 }); prep.done = true; }   // every request after the first: an expired entry → a single-flight refresh
  };
  if (cs === 'charge_reuse') { const r0 = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer lat-secret' }, body: JSON.stringify(body(reuseOid, 'online')) }); await r0.text(); }
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
  const ms = []; const statuses = new Set();
  for (let round = 0; round < WARM_ROUNDS + Math.ceil(SAMPLES / CONC); round++) {
    await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove();
    prep();
    const batch = await Promise.all(Array.from({ length: CONC }, () => fire()));
    if (round >= WARM_ROUNDS) for (const b of batch) { if (ms.length < SAMPLES) ms.push(b.ms); statuses.add(b.status); }
  }
  srv.close();
  console.log = origLog;
  const cache = {}; for (const l of logs) cache[l.cache] = (cache[l.cache] || 0) + 1;
  origLog(JSON.stringify({ ms, status: [...statuses], cache }));
  process.exit(0);
}
