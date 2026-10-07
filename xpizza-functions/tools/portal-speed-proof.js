#!/usr/bin/env node
'use strict';
// PORTAL SPEED P1 — THE BASE-vs-CANDIDATE PROOFS (PLAN-portal-speed rev 3 §6). TEST-ONLY tool, run on demand (it
// needs a checkout of the integration parent, so it is not in a chain):
//   node tools/portal-speed-proof.js --base <parent>/xpizza-functions [--cand <candidate>/xpizza-functions] [--out file.json]
// Every load is a FRESH child process with FUNCTION_TARGET and the emulator/debug flags unset unless stated, and both
// trees resolve the SAME installed node_modules (the candidate's lockfile resolution is unchanged).
//   (1) MANIFEST — the SDK's own discovery path: runtime/loader.js loadStack(dir) → runtime/manifest.js stackToWire
//       (exactly what bin/firebase-functions.js serves as functions.yaml), key-canonicalized, compared IN FULL.
//   (2) ISOLATED METADATA — per portal target, the isolated load's endpoint == the full discovery's endpoint.
//   (3) EVERY OTHER FUNCTION — FUNCTION_TARGET = each non-portal endpoint name: the FULL wire manifest and the full
//       export inventory, exactly as with FUNCTION_TARGET unset.
//   (4) CORS — the REAL exported functions, base vs candidate (full and isolated), OUTSIDE the emulator: allowed
//       production + localhost origins, a denied origin, no Origin; requested Authorization/Content-Type; plus a normal
//       (unauthenticated) request. Identical except the approved delta: Access-Control-Max-Age: 600 on preflights.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const BASE = path.resolve(arg('--base', ''));
const CAND = path.resolve(arg('--cand', path.join(__dirname, '..')));
const OUT = arg('--out', null);
if (!arg('--base')) { console.error('usage: --base <integration-parent xpizza-functions dir>'); process.exit(2); }
const PORTAL = ['getMyRestaurants', 'getEditableCatalog', 'editCatalog', 'publishEdited', 'getSalesStats'];

function run(dir, target, script) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GCLOUD_PROJECT: 'demo-xpizza' };
    for (const k of Object.keys(env)) if (/^(FUNCTION_TARGET|FUNCTIONS_EMULATOR|FIREBASE_DEBUG_|K_SERVICE|FORCE_COLOR|FIREBASE_CONFIG|FUNCTIONS_CONTROL_API)/.test(k)) delete env[k];
    if (target !== undefined) env.FUNCTION_TARGET = target;
    const p = spawn(process.execPath, ['-e', script], { cwd: dir, env });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout ${dir} ${target}`)); }, 120000);
    p.on('close', (code) => {
      clearTimeout(t);
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      if (code !== 0 || !line) return reject(new Error(`${dir} FUNCTION_TARGET=${target} exit ${code}\n${err.slice(-2000)}`));
      resolve(JSON.parse(line.slice(7)));
    });
  });
}
async function pool(items, size, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

const MANIFEST_JS = `
(async () => {
  // by FILE (the package's exports map does not expose lib/runtime): the installed SDK's own discovery serialization
  const sdk = require('path').join(require('fs').realpathSync('node_modules'), 'firebase-functions', 'lib', 'runtime');
  const { loadStack } = require(require('path').join(sdk, 'loader.js'));
  const { stackToWire } = require(require('path').join(sdk, 'manifest.js'));
  const stack = await loadStack(process.cwd());
  const wire = stackToWire(stack);
  const keys = Object.keys(require(require('path').resolve('index.js')));
  console.log('RESULT ' + JSON.stringify({ wire, keys }));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });`;

const CORS_JS = (targets) => `
(async () => {
  const app = require(require('path').resolve('index.js'));
  const http = require('http');
  const once = (fn, method, headers, body) => new Promise((resolve) => { const srv = http.createServer((q, s) => {
    let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
      q.body = b ? JSON.parse(b) : undefined; q.query = Object.fromEntries(new URL(q.url, 'http://x').searchParams);
      q.get = (h) => q.headers[String(h).toLowerCase()];
      s.status = (c) => { s.statusCode = c; return s; }; s.set = (k, v) => { s.setHeader(k, v); return s; };
      s.json = (o) => { s.setHeader('Content-Type', 'application/json; charset=utf-8'); s.end(JSON.stringify(o)); return s; }; s.send = (o) => { s.end(String(o)); return s; };
      fn(q, s); }); }).listen(0, '127.0.0.1', async () => {
    const r = await fetch('http://127.0.0.1:' + srv.address().port + '/?restaurantId=x_pizza', { method, headers, body });
    const text = await r.text();
    const h = {}; for (const [k, v] of r.headers) if (!['date', 'connection', 'keep-alive'].includes(k)) h[k] = v;
    srv.close(() => resolve({ status: r.status, h, body: text })); }); });
  const ORIGINS = { prod: 'https://sherpa-portal.netlify.app', localhost5173: 'http://localhost:5173', localhost: 'http://localhost', denied: 'https://evil.example', none: null };
  const out = {};
  for (const t of ${JSON.stringify(targets)}) {
    out[t] = {};
    for (const [label, o] of Object.entries(ORIGINS)) {
      for (const reqHeaders of ['authorization,content-type', 'authorization', 'content-type', null]) {
        const hd = { 'Access-Control-Request-Method': ['editCatalog', 'publishEdited'].includes(t) ? 'POST' : 'GET' };
        if (reqHeaders) hd['Access-Control-Request-Headers'] = reqHeaders;
        if (o) hd.Origin = o;
        out[t]['OPTIONS ' + label + ' ' + reqHeaders] = await once(app[t], 'OPTIONS', hd);
      }
      const post = ['editCatalog', 'publishEdited'].includes(t);
      const nh = post ? { 'Content-Type': 'application/json' } : {};
      if (o) nh.Origin = o;
      out[t]['NORMAL ' + label] = await once(app[t], post ? 'POST' : 'GET', nh, post ? '{}' : undefined);
      out[t]['WRONG_METHOD ' + label] = await once(app[t], post ? 'GET' : 'DELETE', o ? { Origin: o } : {});
    }
  }
  console.log('RESULT ' + JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });`;

(async () => {
  const report = { base: BASE, cand: CAND, node: process.version, sdk: require(path.join(CAND, 'node_modules/firebase-functions/package.json')).version };
  assert.strictEqual(fs.realpathSync(path.join(BASE, 'node_modules')), fs.realpathSync(path.join(CAND, 'node_modules')), 'both trees resolve the SAME installed node_modules');

  // (1) manifest, full discovery
  const [b, c] = await Promise.all([run(BASE, undefined, MANIFEST_JS), run(CAND, undefined, MANIFEST_JS)]);
  const bw = canon(b.wire); const cw = canon(c.wire);
  assert.deepStrictEqual(cw, bw, '🔴 (1) the discovery wire manifest differs');
  assert.deepStrictEqual(c.keys, b.keys, '🔴 (1) the export inventory (order included) differs');
  report.manifest = { identical: true, endpoints: Object.keys(bw.endpoints).length, exports: b.keys.length, specVersion: bw.specVersion,
    requiredAPIs: (bw.requiredAPIs || []).length, extensions: Object.keys(bw.extensions || {}).length, params: (bw.params || []).length };
  console.log(`(1) MANIFEST identical: ${report.manifest.endpoints} endpoints, ${report.manifest.exports} exports, requiredAPIs ${report.manifest.requiredAPIs}, params ${report.manifest.params}, extensions ${report.manifest.extensions}`);

  // (2) isolated metadata == full discovery metadata, per portal target
  report.isolated = {};
  for (const t of PORTAL) {
    const r = await run(CAND, t, MANIFEST_JS);
    const iw = canon(r.wire);
    assert.deepStrictEqual(Object.keys(iw.endpoints).sort(), [...PORTAL].sort(), `(2) ${t}: the isolated load exposes the portal group`);
    for (const e of PORTAL) assert.deepStrictEqual(iw.endpoints[e], cw.endpoints[e], `🔴 (2) ${t}: isolated endpoint ${e} != full discovery`);
    assert.deepStrictEqual(iw.requiredAPIs || [], [], `(2) ${t}: no requiredAPIs`);
    report.isolated[t] = { endpoints: Object.keys(iw.endpoints).length, eachEqualsFull: true };
  }
  console.log('(2) ISOLATED METADATA: for each of the 5 targets, every portal endpoint == its full-discovery endpoint');

  // (3) every non-portal target → the full load, identical wire + inventory
  const others = Object.keys(cw.endpoints).filter((e) => !PORTAL.includes(e));
  const res = await pool(others, 6, (t) => run(CAND, t, MANIFEST_JS).then((r) => [t, r]));
  for (const [t, r] of res) {
    assert.deepStrictEqual(canon(r.wire), cw, `🔴 (3) FUNCTION_TARGET=${t}: not the full manifest`);
    assert.deepStrictEqual(r.keys, c.keys, `🔴 (3) FUNCTION_TARGET=${t}: not the full inventory`);
  }
  report.nonPortalTargets = { count: others.length, allFull: true, names: others };
  console.log(`(3) EVERY OTHER FUNCTION: ${others.length} non-portal targets each construct the FULL manifest + inventory`);

  // (4) CORS, base vs candidate (full) vs candidate (isolated)
  const cb = await run(BASE, undefined, CORS_JS(PORTAL));
  const cc = await run(CAND, undefined, CORS_JS(PORTAL));
  const ci = {};
  for (const t of PORTAL) ci[t] = (await run(CAND, t, CORS_JS([t])))[t];
  let cases = 0; let preflights = 0;
  for (const t of PORTAL) {
    for (const k of Object.keys(cb[t])) {
      cases++;
      for (const [label, got] of [['full', cc[t][k]], ['isolated', ci[t][k]]]) {
        const want = JSON.parse(JSON.stringify(cb[t][k]));
        if (k.startsWith('OPTIONS ')) {
          assert.ok(!('access-control-max-age' in want.h), 'base has no Max-Age');
          assert.strictEqual(got.h['access-control-max-age'], '600', `(4) ${label} ${t} ${k}: Max-Age 600`);
          want.h['access-control-max-age'] = '600';
        }
        assert.deepStrictEqual(canon(got), canon(want), `🔴 (4) ${label} ${t} ${k}: differs from base beyond the approved Max-Age`);
      }
      if (k.startsWith('OPTIONS ')) preflights++;
    }
  }
  report.cors = { cases, preflights, identicalExceptMaxAge: true, sample: { base: cb.getSalesStats['OPTIONS prod authorization,content-type'], cand: cc.getSalesStats['OPTIONS prod authorization,content-type'] } };
  console.log(`(4) CORS: ${cases} cases (${preflights} preflights) × {full, isolated} == base, except Access-Control-Max-Age: 600 on every preflight`);

  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('portal-speed-proof: OK');
  process.exit(0);
})().catch((e) => { console.error('portal-speed-proof FAILED:', e && e.stack || e); process.exit(1); });
