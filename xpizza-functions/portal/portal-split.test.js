'use strict';
// PORTAL SPEED P1 — THE SHIP CONTRACT for the isolated portal entrypoints (PLAN-portal-speed rev 3 §0/§1/§6).
// Run: node portal/portal-split.test.js        (no emulator; every load-mode check runs in a FRESH child process,
//                                              because FUNCTION_TARGET is read once, at load)
//   1. ROUTING — the early branch is the exact pinned text at the very top of index.js; its Set is exactly the five
//      names and exactly portal/functions.js's exports; each name loads ONLY the portal group (+ the §8 marker, once);
//      unset / empty / wrong-case / padded / prefix / unknown / Object.prototype names → the FULL load, no marker.
//   2. ISOLATION — per portal target, the application require graph (local modules + the npm/builtin packages they
//      require directly; framework-internal loads excluded) EQUALS the reviewed allowlist, at import AND after a
//      representative request; the payment / order / driver / WhatsApp / factura-writer modules are absent.
//   3. THE WRAPPER — every property of the returned CloudFunction (descriptors, getters, prototype) is preserved;
//      OPTIONS gets Access-Control-Max-Age: 600, anything else nothing; same arguments in, same result out.
//   4. CORS on the five real exports — allowed / denied / absent Origin, requested headers; the preflight never
//      reaches application logic (the five cores are never called), a normal request does.
//   5. SHARED STATE — paymentAlert (one function, unchanged behaviour); ONE Admin app in both load modes;
//      rollupDailyStats and getSalesStats share ONE lazy keyer + ONE live cache; loading never reads the stats secret.
//   6. THE FOLD GUARD'S SENSITIVITY — tools/portal-split.js folds the split back to the parent byte-for-byte (asserted
//      in identity-record-guards.test.js); here: a byte changed inside a moved handler, a moved helper, a moved
//      shared module, outside the permitted edits, a require rewrite too many or too few, the routing Set, or the
//      metadata preservation — each one FAILS.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let __finished = false;
process.on('exit', (code) => { if (code === 0 && !__finished) { console.error('🔴 portal-split: exited before finishing'); process.exit(1); } });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const { foldPortalSplit, PORTAL_TARGETS, REQUIRE_REWRITES } = require('../tools/portal-split');
const { unapplyD4c5 } = require('../tools/d4c5-inverse');
const { unapplyD4c4 } = require('../tools/d4c4-inverse');
const { unapplyAddProductFold } = require('../tools/addproduct-inverse');
const PARENT_INDEX = '711db74576a3fe720c765e7c88af4738eff03fbde1b8d9fd987a2dfcb8858e09';   // bb37684:xpizza-functions/index.js

// The REVIEWED application graph of every portal target (identical for all five: they are one isolated group).
const PORTAL_GRAPH_LOCAL = [
  'catalog/add-product-io.js',              // 1D add-product A: the profile key mode, high-water mark, registry key reads, KDS sync
  'catalog/add-product.js',                 // 1D add-product A: the pure allocation + structural comparison (editCatalog / publishEdited)
  'catalog/candidate-validate.js', 'catalog/canonical-json.js', 'catalog/catalog-edit-auth.js', 'catalog/catalog-edit.js',
  'catalog/catalog-firestore.js', 'catalog/catalog-integrity.js', 'catalog/catalog-menu.js', 'catalog/catalog-publish.js',
  'catalog/catalog-transform.js', 'catalog/content-hash.js', 'catalog/display-safety.js',
  'catalog/draft-assess.js',                // 1D add-product A: getEditableCatalog's draft_unpublishable assessment (pure)
  'catalog/edit-catalog-handler.js',
  'catalog/evidence-encoding.js',           // 1D D4-c2a: the identity-evidence encoder (pure), reached via catalog-publish.js
  'catalog/exposure-source.js', 'catalog/extras-exposure.js', 'catalog/form-menu-source.js',
  'catalog/generate-form-bundle.js',        // 1D add-product A: generateKdsManifest (pure over a catalog), via kds-manifest.js
  'catalog/identity-backfill.js',
  'catalog/identity-derive.js', 'catalog/identity-destination.js',
  'catalog/identity-evidence.js',           // 1D D4-c2a: the activation-evidence builders, reached via catalog-publish.js (publishEdited)
  'catalog/identity-fence.js', 'catalog/identity-flags.js',
  'catalog/identity-partition.js', 'catalog/identity-plan.js', 'catalog/identity-reconcile.js', 'catalog/identity-registry.js',
  'catalog/identity-stampmap.js', 'catalog/identity-verdict.js', 'catalog/identity-writer.js',
  'catalog/kds-manifest.js',                // 1D add-product A: the conditional /menus writer, after a successful publish
  'catalog/mirror-rtdb.js',
  'catalog/owner-index.js', 'catalog/portal-reads.js', 'catalog/publish-edited-handler.js', 'catalog/redeem-source.js',
  'catalog/seed-catalog-core.js', 'catalog/source-store.js',
  'factura/eligibility.js',                 // usesPlatformFactura (getEditableCatalog's fiscal capability) — pure
  'index.js',                               // the entry: only its early branch runs
  'lib/admin.js', 'lib/payment-alert.js',   // the shared Admin app + the publish alarm
  'menu-pricing.js', 'portal/functions.js', 'portal/origins.js', 'portal/preflight-max-age.js', 'price-valid.js', 'restaurant-id.js',
  'rewards-redeem-config.js', 'scheduled-orders.js',
  'stats/keyer.js', 'stats/stats-api.js', 'stats/stats-build.js', 'stats/stats-classify.js', 'stats/stats-identity.js', 'stats/stats-index.js',
  'stats/stats-indexing.js', 'stats/stats-job.js', 'stats/stats-store.js', 'stats/stats-time.js',
];
const PORTAL_GRAPH_NPM = ['firebase-admin', 'firebase-functions', 'node:crypto', 'node:fs', 'node:path'];
// Never in a portal instance: the order / payment / driver / messaging / fiscal-writer surface and the heavy npm deps.
const FORBIDDEN_LOCAL = /(^|\/)(whatsapp|pixelpay|driver-|claim-|create-order|createorder|materialize|cancel-|charge|confirm|webhook|rewards-(earn|reserve|redeem-intake|core)|staff-push|sweep-|tracking-|order-)|^factura\/(?!eligibility\.js$)/;
const FORBIDDEN_NPM = ['googleapis', 'web-push', 'express', 'node-fetch'];

// ── fresh child processes ───────────────────────────────────────────────────────────────────────────────────────
function child(target, script) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GCLOUD_PROJECT: 'demo-xpizza' };
    for (const k of ['FUNCTION_TARGET', 'FUNCTIONS_EMULATOR', 'FIREBASE_DEBUG_MODE', 'FIREBASE_DEBUG_FEATURES', 'K_SERVICE', 'FORCE_COLOR']) delete env[k];
    if (target !== undefined) env.FUNCTION_TARGET = target;
    const p = spawn(process.execPath, ['-r', './tools/app-require-graph.js', '-e', script], { cwd: ROOT, env });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`child ${JSON.stringify(target)} timed out\n${err}`)); }, 60000);
    p.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      if (code !== 0 || !line) return reject(new Error(`child ${JSON.stringify(target)} exit ${code}\n${out}\n${err}`));
      resolve({ ...JSON.parse(line.slice(7)), markers: out.split('\n').filter((l) => l.startsWith('portal_isolated_entry')) });
    });
  });
}
async function pool(items, size, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
// One representative request per portal function, through a real HTTP server (no credentials → refused before any
// datastore read; the handler, cors and the core all run).
const REQUEST_JS = `
async function representative(fn, target) {
  const http = require('http');
  const post = target === 'editCatalog' || target === 'publishEdited';
  const srv = http.createServer((q, s) => { let b=''; q.on('data', (c) => { b += c; }); q.on('end', () => {
    q.body = b ? JSON.parse(b) : undefined; q.query = Object.fromEntries(new URL(q.url, 'http://x').searchParams);
    q.get = (h) => q.headers[String(h).toLowerCase()];
    s.status = (c) => { s.statusCode = c; return s; }; s.set = (k, v) => { s.setHeader(k, v); return s; };
    s.json = (o) => { s.setHeader('Content-Type', 'application/json'); s.end(JSON.stringify(o)); return s; }; s.send = (o) => { s.end(String(o)); return s; };
    fn(q, s); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const r = await fetch('http://127.0.0.1:' + srv.address().port + '/' + (post ? '' : '?restaurantId=x_pizza'),
    { method: post ? 'POST' : 'GET', headers: { Origin: 'https://sherpa-portal.netlify.app', 'Content-Type': 'application/json' }, body: post ? '{}' : undefined });
  const body = await r.text(); await new Promise((res) => srv.close(res));
  return { status: r.status, body };
}`;
const LOAD_JS = (withRequest) => `${REQUEST_JS}
(async () => {
  const m = require('./index.js');
  const g = appRequireGraph();
  const apps = require('firebase-admin/app').getApps().map((a) => ({ name: a.name, url: a.options.databaseURL }));
  let request = null, after = null;
  if (${withRequest}) { request = await representative(m[process.env.FUNCTION_TARGET], process.env.FUNCTION_TARGET); after = appRequireGraph(); }
  console.log('RESULT ' + JSON.stringify({ keys: Object.keys(m), g, apps, request, after }));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });`;

(async () => {
  // ── 1. ROUTING ────────────────────────────────────────────────────────────────────────────────────────────────
  const idx = read('index.js');
  const EARLY_BRANCH = "const PORTAL_ISOLATED_TARGETS = Object.freeze(new Set(['getMyRestaurants', 'getEditableCatalog', 'editCatalog', 'publishEdited', 'getSalesStats']));\n"
    + 'if (PORTAL_ISOLATED_TARGETS.has(process.env.FUNCTION_TARGET)) {\n'
    + "  console.log('portal_isolated_entry', process.env.FUNCTION_TARGET);   // §8 deploy check: the isolated branch ran\n"
    + "  module.exports = require('./portal/functions');\n"
    + '  return;\n'
    + '}\n';
  const headerEnd = idx.indexOf('\nconst PORTAL_ISOLATED_TARGETS') + 1;
  assert.ok(idx.slice(0, headerEnd).split('\n').filter(Boolean).every((l) => l.startsWith('//')), '🔴 nothing but comments precedes the early branch');
  assert.strictEqual(idx.slice(headerEnd, headerEnd + EARLY_BRANCH.length), EARLY_BRANCH, '🔴 the early branch is not the exact pinned text (Set, exact Set.has, marker, exports, return)');
  assert.strictEqual(idx.split('PORTAL_ISOLATED_TARGETS').length - 1, 2, 'the Set is declared once and read once');
  assert.ok(!/process\.env\.(K_SERVICE|FUNCTION_NAME)|toLowerCase\(\)\s*\)\s*\)\s*\{\n\s*console\.log\('portal_isolated_entry'/.test(idx.slice(0, headerEnd + EARLY_BRANCH.length)), 'no other routing input');
  assert.deepStrictEqual([...PORTAL_TARGETS].sort(), ['editCatalog', 'getEditableCatalog', 'getMyRestaurants', 'getSalesStats', 'publishEdited']);
  ok('index.js opens (after its comment header) with the EXACT pinned early branch: a frozen Set of the 5 names, exact Set.has(FUNCTION_TARGET), the §8 marker, module.exports = portal/functions, return');

  const portalTargets = PORTAL_TARGETS;
  const isolated = await pool(portalTargets, 5, (t) => child(t, LOAD_JS(true)));
  const FALLBACK = [undefined, '', 'getsalesstats', 'GETSALESSTATS', 'GetSalesStats', 'getSalesStats ', ' getSalesStats', 'getSalesStatsCore', 'getSales',
    'createOrder', 'rollupDailyStats', 'unknownFunction', 'toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf'];
  const full = await pool(FALLBACK, 4, (t) => child(t, LOAD_JS(false)));
  const fullKeys = full[0].keys;
  assert.ok(fullKeys.length >= 70, `premise: the full load exports every function (${fullKeys.length})`);
  for (const [i, t] of FALLBACK.entries()) {
    assert.deepStrictEqual(full[i].keys, fullKeys, `🔴 FUNCTION_TARGET=${JSON.stringify(t)} must take the FULL load`);
    assert.deepStrictEqual(full[i].markers, [], `🔴 FUNCTION_TARGET=${JSON.stringify(t)}: no isolated-branch marker on a full load`);
    assert.ok(full[i].g.local.includes('whatsapp.js') && full[i].g.npm.includes('googleapis'), `non-vacuity: the full load really loads everything (${JSON.stringify(t)})`);
  }
  for (const [i, t] of portalTargets.entries()) {
    assert.deepStrictEqual(isolated[i].keys.slice().sort(), [...portalTargets].sort(), `${t}: only the portal group is exported`);
    assert.deepStrictEqual(isolated[i].markers, [`portal_isolated_entry ${t}`], `${t}: the §8 marker, exactly once`);
  }
  const portalFns = require('./functions');
  assert.deepStrictEqual(Object.keys(portalFns).sort(), [...portalTargets].sort(), 'the Set == portal/functions.js exports');
  for (const t of portalTargets) assert.ok(fullKeys.includes(t), `${t} is still exported by the full load`);
  ok(`routing: the 5 names load ONLY the portal group (marker once each); ${FALLBACK.length} others — unset, empty, 3 wrong-case, 2 padded, prefix/suffix, 3 non-portal/unknown, 5 Object.prototype names — take the FULL load (${fullKeys.length} exports), no marker`);

  // ── 2. ISOLATION ──────────────────────────────────────────────────────────────────────────────────────────────
  for (const [i, t] of portalTargets.entries()) {
    const r = isolated[i];
    for (const [when, g] of [['import', r.g], ['after a request', r.after]]) {
      assert.deepStrictEqual(g.local, PORTAL_GRAPH_LOCAL, `🔴 ${t} (${when}): the local application graph differs from the reviewed allowlist`);
      assert.deepStrictEqual(g.npm, PORTAL_GRAPH_NPM, `🔴 ${t} (${when}): the npm/builtin application graph differs from the reviewed allowlist`);
      assert.deepStrictEqual(g.local.filter((f) => FORBIDDEN_LOCAL.test(f)), [], `🔴 ${t} (${when}): a forbidden module loaded`);
      for (const p of FORBIDDEN_NPM) assert.ok(!g.npm.includes(p), `🔴 ${t} (${when}): ${p} loaded`);
    }
    const want = ['editCatalog', 'publishEdited'].includes(t) ? 400 : 401;   // a body without restaurantId / no bearer → refused before any read
    assert.strictEqual(r.request.status, want, `${t}: the representative request ran the handler (${r.request.body})`);
  }
  assert.ok(PORTAL_GRAPH_LOCAL.includes('factura/eligibility.js') && PORTAL_GRAPH_LOCAL.includes('lib/payment-alert.js'), 'the plan\'s named inclusions');
  // non-vacuity of the forbidden patterns: each one really matches what the full load brings in
  const fullLocal = full[0].g.local;
  for (const f of ['whatsapp.js', 'pixelpay-confirm.js', 'driver-push.js', 'create-order-build.js', 'factura/factura-helpers.js', 'materialize.js', 'rewards-reserve.js'])
    assert.ok(fullLocal.includes(f) && FORBIDDEN_LOCAL.test(f), `non-vacuity: ${f} is loaded by the full path and matched by the forbidden pattern`);
  ok(`isolation: each portal target's application graph == the reviewed allowlist (${PORTAL_GRAPH_LOCAL.length} local incl. factura/eligibility.js + lib/payment-alert.js; npm ${PORTAL_GRAPH_NPM.join(', ')}) at import AND after a representative request; no payment/order/driver/WhatsApp/factura-writer module, no googleapis/web-push/express (the full load: ${fullLocal.length} local)`);

  // ── 3. THE WRAPPER ────────────────────────────────────────────────────────────────────────────────────────────
  const { withPreflightMaxAge, PREFLIGHT_MAX_AGE_SECONDS } = require('./preflight-max-age');
  const { onRequest } = require('firebase-functions/v2/https');
  const descr = (f) => Object.fromEntries(Reflect.ownKeys(f).map((k) => [String(k), Object.getOwnPropertyDescriptor(f, k)]));
  const sameShape = (a, b) => {
    assert.deepStrictEqual(Reflect.ownKeys(a), Reflect.ownKeys(b), 'own keys (order included)');
    const da = descr(a); const db = descr(b);
    for (const k of Object.keys(da)) {
      for (const p of ['enumerable', 'configurable', 'writable', 'get', 'set', 'value']) assert.strictEqual(da[k][p], db[k][p], `descriptor ${k}.${p}`);
    }
    assert.strictEqual(Object.getPrototypeOf(a), Object.getPrototypeOf(b), 'prototype');
  };
  {
    const inner = onRequest({ region: 'us-central1', cors: ['https://a.example'], timeoutSeconds: 7, memory: '256MiB', maxInstances: 3 }, (req, res) => res.end('x'));
    inner.extraEnumerable = { a: 1 };
    Object.defineProperty(inner, 'hiddenThing', { value: 42, enumerable: false });
    inner[Symbol.for('sym')] = 'sym';
    const w = withPreflightMaxAge(inner);
    sameShape(w, inner);
    assert.strictEqual(Object.getOwnPropertyDescriptor(w, '__trigger').get, Object.getOwnPropertyDescriptor(inner, '__trigger').get, 'the __trigger GETTER itself is carried (not a snapshot)');
    assert.deepStrictEqual(w.__trigger, inner.__trigger);
    assert.strictEqual(w.__endpoint, inner.__endpoint, '__endpoint is the same object');
    // behaviour: same args in (count included — the trace wrapper branches on it), same result out, header only on OPTIONS
    const calls = [];
    const sentinel = Promise.resolve('S');
    const fake = Object.assign((...a) => { calls.push(a); return sentinel; }, { __endpoint: {} });
    const wf = withPreflightMaxAge(fake);
    const mk = (method) => { const h = {}; return [{ method, headers: {} }, { setHeader: (k, v) => { h[k] = v; }, h }]; };
    const [rq1, rs1] = mk('OPTIONS'); assert.strictEqual(wf(rq1, rs1), sentinel, 'returns the original invocation\'s result');
    assert.deepStrictEqual(rs1.h, { 'Access-Control-Max-Age': '600' }); assert.strictEqual(calls[0].length, 2); assert.strictEqual(calls[0][0], rq1);
    const [rq2, rs2] = mk('GET'); wf(rq2, rs2, 'third'); assert.deepStrictEqual(rs2.h, {}, 'no header off a preflight');
    assert.deepStrictEqual(calls[1].slice(2), ['third'], 'every argument passed through');
    wf({ method: 'POST', headers: {} }); assert.strictEqual(calls[2].length, 1, 'argument COUNT preserved');
    assert.strictEqual(PREFLIGHT_MAX_AGE_SECONDS, 600);
    assert.throws(() => withPreflightMaxAge({}), /not a function/);
    // a function whose prototype is NOT Function.prototype (an async handler, or a custom one) keeps it — for today's
    // CloudFunctions (arrows) the prototype is already equal, so this is the case that can tell the difference
    const custom = Object.setPrototypeOf(() => {}, Object.create(Function.prototype, { tag: { value: 'custom' } }));
    sameShape(withPreflightMaxAge(custom), custom);
    const asyncFn = async () => {}; sameShape(withPreflightMaxAge(asyncFn), asyncFn);
    // SENSITIVITY: a wrapper that does not carry the descriptors is caught by the same check
    const naive = (fn) => Object.assign((...a) => fn(...a), fn);
    assert.throws(() => sameShape(naive(inner), inner), 'a copy-the-enumerables wrapper loses __trigger (non-enumerable getter) → detected');
  }
  // the five real exports: same own-property shape as a CloudFunction straight from onRequest, endpoint options pinned
  {
    const ref = onRequest({ cors: true }, () => {});
    const OPTS = {
      editCatalog: { timeoutSeconds: 60, availableMemoryMb: 512, maxInstances: 4 },
      publishEdited: { timeoutSeconds: 120, availableMemoryMb: 512, maxInstances: 2 },
      getMyRestaurants: { timeoutSeconds: 20, availableMemoryMb: 256, maxInstances: 10 },
      getEditableCatalog: { timeoutSeconds: 30, availableMemoryMb: 256, maxInstances: 10 },
      getSalesStats: { timeoutSeconds: 60, availableMemoryMb: 512, maxInstances: 10 },
    };
    for (const t of portalTargets) {
      const f = portalFns[t];
      assert.deepStrictEqual(Reflect.ownKeys(f), Reflect.ownKeys(ref), `${t}: own keys == an unwrapped CloudFunction's`);
      assert.strictEqual(Object.getOwnPropertyDescriptor(f, '__trigger').enumerable, false); assert.strictEqual(typeof Object.getOwnPropertyDescriptor(f, '__trigger').get, 'function');
      for (const [k, v] of Object.entries(OPTS[t])) assert.strictEqual(f.__endpoint[k], v, `${t}.__endpoint.${k}`);
      assert.deepStrictEqual(f.__endpoint.region, ['us-central1']); assert.deepStrictEqual(f.__endpoint.httpsTrigger, {});
    }
  }
  ok('wrapper: every own property carried with its exact descriptor (the __trigger getter itself, __endpoint by identity, non-enumerables, symbols) + the prototype; OPTIONS → Max-Age 600 then delegate, others untouched; same arguments (count included) in, same result out; a naive wrapper is caught; the 5 exports keep their exact options');

  // ── 4. CORS on the five real exports + the preflight never reaches application logic ─────────────────────────
  const CORS_JS = `
(async () => {
  const cores = [['./catalog/portal-reads', 'getMyRestaurantsCore'], ['./catalog/portal-reads', 'getEditableCatalogCore'], ['./catalog/edit-catalog-handler', 'editCatalogCore'],
    ['./catalog/publish-edited-handler', 'publishEditedCore'], ['./stats/stats-api', 'getSalesStatsCore']];
  const hits = {};
  for (const [m, k] of cores) { const mod = require(m); const orig = mod[k]; mod[k] = (...a) => { hits[k] = (hits[k] || 0) + 1; return orig(...a); }; }
  const app = require('./index.js');
  const http = require('http');
  const once = (fn, method, headers) => new Promise((resolve) => { const srv = http.createServer((q, s) => {
    q.get = (h) => q.headers[String(h).toLowerCase()]; q.query = {}; s.status = (c) => { s.statusCode = c; return s; }; s.set = (k, v) => { s.setHeader(k, v); return s; };
    s.json = (o) => { s.end(JSON.stringify(o)); return s; }; s.send = (o) => { s.end(String(o)); return s; }; fn(q, s); }).listen(0, '127.0.0.1', async () => {
    const r = await fetch('http://127.0.0.1:' + srv.address().port + '/', { method, headers }); await r.text();
    const h = {}; for (const [k, v] of r.headers) if (!['date', 'connection', 'keep-alive', 'content-length', 'transfer-encoding'].includes(k)) h[k] = v;
    srv.close(() => resolve({ status: r.status, h })); }); });
  const ORIGINS = { prod: 'https://sherpa-portal.netlify.app', local: 'http://localhost:5173', localNoPort: 'http://localhost', denied: 'https://evil.example', none: null };
  const out = {};
  for (const t of ${JSON.stringify(PORTAL_TARGETS)}) {
    out[t] = {};
    for (const [label, o] of Object.entries(ORIGINS)) {
      const hd = { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' };
      if (o) hd.Origin = o;
      out[t]['OPTIONS ' + label] = await once(app[t], 'OPTIONS', hd);
    }
    out[t].hitsAfterPreflights = { ...hits };
    out[t].normal = await once(app[t], ['editCatalog', 'publishEdited'].includes(t) ? 'POST' : 'GET', { Origin: ORIGINS.prod });
    out[t].hitsAfterNormal = { ...hits };
  }
  console.log('RESULT ' + JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });`;
  for (const mode of [undefined, 'getEditableCatalog']) {
    const r = await child(mode, CORS_JS);
    let before = 0;
    for (const t of portalTargets) {
      const o = r[t];
      const pf = o['OPTIONS prod'];
      assert.strictEqual(pf.status, 204); assert.strictEqual(pf.h['access-control-allow-origin'], 'https://sherpa-portal.netlify.app');
      assert.strictEqual(pf.h['access-control-allow-methods'], 'GET,HEAD,PUT,PATCH,POST,DELETE');
      assert.strictEqual(pf.h['access-control-allow-headers'], 'authorization,content-type'); assert.strictEqual(pf.h.vary, 'Origin, Access-Control-Request-Headers');
      assert.strictEqual(pf.h['access-control-max-age'], '600', `${t}: preflight Max-Age`);
      assert.strictEqual(o['OPTIONS local'].h['access-control-allow-origin'], 'http://localhost:5173');
      assert.strictEqual(o['OPTIONS localNoPort'].h['access-control-allow-origin'], 'http://localhost');
      assert.ok(!('access-control-allow-origin' in o['OPTIONS denied'].h), `${t}: a denied origin gets no ACAO`);
      assert.ok(!('access-control-allow-origin' in o['OPTIONS none'].h), `${t}: no Origin → no ACAO`);
      assert.ok(!('access-control-allow-credentials' in pf.h), 'credentials unchanged (not set)');
      const hitsPf = Object.values(o.hitsAfterPreflights).reduce((a, b) => a + b, 0);
      assert.strictEqual(hitsPf, before, `🔴 ${t}: a preflight reached application logic`);
      const hitsN = Object.values(o.hitsAfterNormal).reduce((a, b) => a + b, 0);
      assert.strictEqual(hitsN, before + 1, `non-vacuity: ${t}'s normal request DID reach its core`);
      before = hitsN;
      assert.ok(!('access-control-max-age' in o.normal.h), `${t}: Max-Age only on preflights`);
      assert.strictEqual(o.normal.h['access-control-allow-origin'], 'https://sherpa-portal.netlify.app');
    }
  }
  ok('CORS (real exports, full AND isolated load, outside the emulator): prod/localhost(:port) allowed, denied and absent Origin get no ACAO, methods/headers/Vary as cors() sets them, no credentials; preflight Max-Age 600; preflights call NONE of the 5 cores while each normal request calls its own exactly once');

  // ── 5. SHARED STATE ───────────────────────────────────────────────────────────────────────────────────────────
  {
    // paymentAlert: one module, imported by both paths; behaviour unchanged
    assert.ok(/^const \{ paymentAlert \} = require\('\.\/lib\/payment-alert'\);/m.test(idx), 'index.js imports the shared paymentAlert');
    assert.ok(/^const \{ paymentAlert \} = require\('\.\.\/lib\/payment-alert'\);/m.test(read('portal/functions.js')), 'portal/functions.js imports the same module');
    assert.strictEqual(require.resolve('../lib/payment-alert'), path.join(ROOT, 'lib/payment-alert.js'));
    const { paymentAlert } = require('../lib/payment-alert');
    const { ServerValue } = require('firebase-admin/database');
    const pushed = []; const warns = []; const errs = [];
    const ow = console.warn; const oe = console.error;
    console.warn = (...a) => warns.push(a); console.error = (...a) => errs.push(a.join(' '));
    try {
      await paymentAlert({ ref: (p) => ({ push: async (v) => { pushed.push([p, v]); } }) }, 'publish_x', { a: 1 });
      await paymentAlert({ ref: (p) => ({ push: async (v) => { pushed.push([p, v]); } }) }, 'nodetail');
      await paymentAlert({ ref: () => ({ push: async () => { throw new Error('rtdb down'); } }) }, 'k', { b: 2 });   // must not throw
    } finally { console.warn = ow; console.error = oe; }
    assert.deepStrictEqual(pushed, [['dispatcher_alerts', { type: 'payment_publish_x', detail: { a: 1 }, created_at: ServerValue.TIMESTAMP }],
      ['dispatcher_alerts', { type: 'payment_nodetail', detail: null, created_at: ServerValue.TIMESTAMP }]]);
    assert.deepStrictEqual(warns, [['paymentAlert[publish_x]', '{"a":1}'], ['paymentAlert[nodetail]', undefined], ['paymentAlert[k]', '{"b":2}']]);
    assert.deepStrictEqual(errs, ['paymentAlert: failed to write alert rtdb down'], 'a failed alert write is logged and SWALLOWED');
  }
  ok('paymentAlert: ONE module (both paths import it), behaviour unchanged — logs, pushes {type, detail ?? null, ServerValue.TIMESTAMP} to dispatcher_alerts, swallows a failed write');

  {
    // ONE Admin app in both load modes (from section 1's fresh children), same databaseURL as before
    const URL = 'https://xpizza-delivery-default-rtdb.firebaseio.com';
    for (const r of [...isolated, full[0]]) assert.deepStrictEqual(r.apps, [{ name: '[DEFAULT]', url: URL }], 'exactly one (default) Admin app');
    // full load, then the portal module again (cached), then lib/admin again: still one app, no duplicate-app throw
    const r = await child(undefined, `(async () => { require('./index.js'); require('./portal/functions'); require('./lib/admin');
      console.log('RESULT ' + JSON.stringify({ apps: require('firebase-admin/app').getApps().length, same: require('./index.js').getSalesStats === require('./portal/functions').getSalesStats }));
      process.exit(0); })();`);
    assert.strictEqual(r.apps, 1); assert.strictEqual(r.same, true, 'the full load re-exports the SAME portal function objects');
  }
  ok('ONE Admin app ([DEFAULT], the same databaseURL) in the full load and in each isolated load; re-requiring the portal module or lib/admin creates no second app; the full load re-exports the same function objects');

  {
    // the stats keyer: never read at load (either mode); rollupDailyStats and getSalesStats share ONE keyer + ONE cache
    const KEYER_JS = `
(async () => {
  let secretReads = 0, keyersMade = 0;
  const id = require('./stats/stats-identity');
  const ls = id.loadStatsSecret, mk = id.makeCustomerKeyer;
  id.loadStatsSecret = (...a) => { secretReads++; return ls(...a); };
  id.makeCustomerKeyer = (...a) => { keyersMade++; return mk(...a); };
  let rollupDeps = null, statsDeps = null;
  const job = require('./stats/stats-job'); job.runStatsRollup = async (deps) => { rollupDeps = deps; return { read: 0, restaurants: {} }; };
  const api = require('./stats/stats-api'); api.getSalesStatsCore = async (deps) => { statsDeps = deps; return { status: 204, body: {} }; };
  const app = require('./index.js');
  const atLoad = secretReads;
  const out = { atLoad };
  if (process.env.FUNCTION_TARGET === undefined) {
    process.env.STATS_HMAC_SECRET = 'k'.repeat(48);
    await app.rollupDailyStats.run({});
    const http = require('http');
    await new Promise((resolve) => { const srv = http.createServer((q, s) => { q.get = () => ''; q.query = {}; s.status = (c) => { s.statusCode = c; return s; }; s.json = (o) => { s.end(JSON.stringify(o)); return s; }; app.getSalesStats(q, s); })
      .listen(0, '127.0.0.1', async () => { await (await fetch('http://127.0.0.1:' + srv.address().port + '/')).text(); srv.close(resolve); }); });
    const keyer = require('./stats/keyer');
    out.sameKeyer = rollupDeps.keyer === statsDeps.getKeyer() && statsDeps.getKeyer === keyer.statsKeyer && rollupDeps.keyer === keyer.statsKeyer();
    out.sameCache = statsDeps.liveCache === keyer._statsLiveCache;
    out.keyersMade = keyersMade; out.secretReads = secretReads;
  }
  console.log('RESULT ' + JSON.stringify(out)); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });`;
    const prevSecret = process.env.STATS_HMAC_SECRET; delete process.env.STATS_HMAC_SECRET;
    try {
      const f = await child(undefined, KEYER_JS);
      const i = await child('getSalesStats', KEYER_JS);
      assert.strictEqual(f.atLoad, 0, '🔴 the full load (deploy discovery) read the stats secret');
      assert.strictEqual(i.atLoad, 0, '🔴 the isolated load read the stats secret');
      assert.strictEqual(f.sameKeyer, true, '🔴 rollupDailyStats and getSalesStats must use the SAME lazy keyer');
      assert.strictEqual(f.sameCache, true, 'getSalesStats uses the one live cache');
      assert.strictEqual(f.keyersMade, 1, 'the keyer is built ONCE per process (lazy singleton)');
      assert.strictEqual(f.secretReads, 1, 'and the secret read once, on first use');
    } finally { if (prevSecret !== undefined) process.env.STATS_HMAC_SECRET = prevSecret; }
    assert.ok(/^const \{ statsKeyer \} = require\('\.\/stats\/keyer'\);/m.test(idx) && /keyer: statsKeyer\(\),/.test(idx), 'index.js rollupDailyStats wiring reads the shared keyer');
  }
  ok('stats keyer: loading (full = deploy discovery, isolated) never reads the secret; rollupDailyStats and getSalesStats get the SAME keyer object and the one live cache; built once, secret read once, on first use');

  // ── 6. THE FOLD GUARD'S SENSITIVITY ──────────────────────────────────────────────────────────────────────────
  {
    // D4-c5 P1: the order_exists slice's eight index.js hunks are reversed ON TOP of the fold (tools/d4c5-inverse.js), so this
    // parent pin composes with the later slice and still proves nothing else changed. D4-c4: the order-control slice's
    // hunks (tools/d4c4-inverse.js) are reversed FIRST — it landed on top of D4-c5.
    // 1D add-product A: its hunks (index.js + the moved blocks) are reversed FIRST — it landed on top of D4-c4.
    const foldToParent = (root) => unapplyD4c5(unapplyD4c4(unapplyAddProductFold(foldPortalSplit(root))));
    assert.strictEqual(sha(foldToParent()), PARENT_INDEX, 'premise: the real tree folds back to the parent');
    const FILES = ['index.js', 'lib/admin.js', 'lib/payment-alert.js', 'portal/origins.js', 'portal/functions.js', 'stats/keyer.js'];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-split-'));
    const mutate = (file, from, to) => {
      for (const f of FILES) { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), read(f)); }
      const src = read(file); assert.ok(src.includes(from), `fixture anchor present: ${file} ${from.slice(0, 40)}`);
      fs.writeFileSync(path.join(tmp, file), src.replace(from, to));
      try { return sha(foldToParent(tmp)) === PARENT_INDEX ? 'UNDETECTED' : 'detected'; } catch (e) { return 'detected'; }
    };
    const CASES = [
      ['a byte inside a moved handler (publishEdited maxInstances)', 'portal/functions.js', 'timeoutSeconds: 120, memory: \'512MiB\', maxInstances: 2', 'timeoutSeconds: 120, memory: \'512MiB\', maxInstances: 3'],
      ['a byte inside a moved helper (decodeUpdateTimeForEdit)', 'portal/functions.js', 'return new FirestoreTimestamp(Number(sec), Number(nanos));', 'return new FirestoreTimestamp(Number(sec), Number(nanos) + 0);'],
      ['a non-require byte inside a moved block (an error code)', 'portal/functions.js', "console.error('getSalesStats', e && e.message);", "console.error('getSalesStatz', e && e.message);"],
      ['one rewrite too few (a specifier left as ./)', 'portal/functions.js', "require('../catalog/portal-reads')", "require('./catalog/portal-reads')"],
      ['a rewrite outside the rule (../ → ../../)', 'portal/functions.js', "require('../catalog/mirror-rtdb')", "require('../../catalog/mirror-rtdb')"],
      ['a byte outside the permitted edits (createOrder)', 'index.js', 'exports.createOrder', 'exports.createOrdeR'],
      ['the routing Set (a sixth name)', 'index.js', "'getSalesStats']));", "'getSalesStats', 'createOrder']));"],
      ['the marker', 'index.js', "console.log('portal_isolated_entry', process.env.FUNCTION_TARGET);", "console.log('portal_isolated_entry');"],
      ['paymentAlert', 'lib/payment-alert.js', "type: `payment_${kind}`,", "type: `payments_${kind}`,"],
      ['the Admin databaseURL', 'lib/admin.js', 'xpizza-delivery-default-rtdb', 'xpizza-delivery-default-rtdb2'],
      ['PORTAL_ORIGINS', 'portal/origins.js', "'https://sherpa-portal.netlify.app',", "'https://sherpa-portal.netlify.app', 'https://x.example',"],
      ['the stats keyer', 'stats/keyer.js', 'let _statsKeyer = null;', 'let _statsKeyer = undefined;'],
      ['a byte inside a D4-c5 emitter hunk (the online closed reason)', 'index.js', "OE.orderExistsBody('closed', orderId)", "OE.orderExistsBody('conflict', orderId)"],
      ['a byte inside a D4-c4 hunk (the race-guard reason)', 'index.js', "if (acq.reason === 'order_control') {", "if (acq.reason === 'order_controI') {"],
      ['a re-export site (wrong function)', 'index.js', 'exports.getEditableCatalog = portalFunctions.getEditableCatalog;', 'exports.getEditableCatalog = portalFunctions.getMyRestaurants;'],
    ];
    const results = CASES.map(([label, f, a, b]) => [label, mutate(f, a, b)]);
    fs.rmSync(tmp, { recursive: true, force: true });
    // the routing Set and marker are removed by the fold, so they are pinned by section 1's exact-text check instead:
    const pinned = (from, to) => { assert.ok(idx.includes(from)); const s = idx.replace(from, to); return s.slice(headerEnd, headerEnd + EARLY_BRANCH.length) === EARLY_BRANCH; };
    for (const [i, [label, r]] of results.entries()) {
      if (label === 'the routing Set (a sixth name)' || label === 'the marker') {
        assert.strictEqual(pinned(CASES[i][2], CASES[i][3]), false, `🔴 ${label}: the exact-text pin must catch it`);
        continue;
      }
      assert.strictEqual(r, 'detected', `🔴 the fold guard MISSED: ${label}`);
    }
    // THE SKELETON PIN: everything the fold does NOT put back — the moved files' headers, imports, exports and
    // portal/functions.js's wrapper loop, plus the whole wrapper module — is pinned byte-for-byte, so no change hides
    // in text the reconstruction never looks at (e.g. a shadow import above a moved block, a dropped wrap).
    const m = require('../tools/portal-split').movedRegions();
    const cut = (src, parts) => parts.reduce((acc, p) => { const i = acc.indexOf(p); assert.ok(i > -1 && acc.indexOf(p, i + 1) === -1, 'region once'); return acc.slice(0, i) + '⟪region⟫' + acc.slice(i + p.length); }, src);
    const rewrite = (b) => b.replace(/require\('\.\//g, "require('../");
    const skeleton = [
      ['lib/admin.js', [m.ADMIN]], ['lib/payment-alert.js', [m.PAY]], ['portal/origins.js', [m.ORIG]], ['stats/keyer.js', [m.STATS_STATE]],
      ['portal/functions.js', [rewrite(m.blocks.A), rewrite(m.blocks.B), rewrite(m.blocks.C)]], ['portal/preflight-max-age.js', []],
    ].map(([f, parts]) => `=== ${f}\n${cut(read(f), parts)}`).join('\n');
    const SKELETON = 'f5596b86b0c298cece9a8d0030d26fb7ffa9613cfc14a2c3de6f093fbf8e6119';
    // 1D add-product A adds EXACTLY two header lines to portal/functions.js (outside the moved blocks, so the fold's
    // require count is untouched). The PIN stays the pre-slice one: those two lines — each present exactly once — are
    // removed, and the remainder must still hash to it. Any other skeleton change still fails.
    const AP_LINES = [
      "const { addProductIo } = require('../catalog/add-product-io');   // 1D add-product A — outside the moved blocks (the fold counts their requires)\n",
      "const addProductIoForEdit = () => addProductIo({ fs: getFirestore(), rtdb: getDatabase() });\n",
    ];
    const skeletonPre = AP_LINES.reduce((acc, l) => { const i = acc.indexOf(l); assert.ok(i > -1 && acc.indexOf(l, i + 1) === -1, `add-product header line exactly once: ${l.slice(0, 60)}`); return acc.slice(0, i) + acc.slice(i + l.length); }, skeleton);
    assert.strictEqual(sha(skeletonPre), SKELETON, `🔴 the split's non-moved text changed (headers / imports / exports / the wrap loop / the wrapper): ${sha(skeletonPre)}`);
    assert.notStrictEqual(sha(skeleton), SKELETON, '(the add-product lines are really there)');
    assert.notStrictEqual(sha(skeletonPre.replace("exports[name] = withPreflightMaxAge(exports[name]);", 'void 0;')), SKELETON, 'sensitivity: dropping the wrap is caught');
    // metadata preservation is guarded by section 3 (its naive-wrapper sensitivity); REQUIRE_REWRITES is the exact count
    assert.strictEqual(REQUIRE_REWRITES, 12);
    // + 1D add-product A's add-product-io header import (the fifth header import; outside the moved blocks)
    assert.strictEqual((read('portal/functions.js').match(/require\('\.\.\//g) || []).length, REQUIRE_REWRITES + 5, '12 rewritten in-block specifiers + the 5 header imports (catalog/add-product-io, lib/admin, lib/payment-alert, stats/stats-api, stats/keyer)');
  }
  ok('fold-guard sensitivity: a byte changed inside a moved handler, a moved helper, a moved block\'s non-require text, outside the permitted edits, in paymentAlert / the Admin URL / PORTAL_ORIGINS / the keyer, a re-export pointed at the wrong function, one rewrite too few or a rewrite outside the rule — each FAILS the reconstruction; the routing Set and the marker fail the exact early-branch pin; every non-moved byte of the split files (headers, imports, the wrap loop, the wrapper module) is SKELETON-pinned; the wrapper\'s metadata preservation fails §3');

  __finished = true;
  console.log(`\nportal-split: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('portal-split FAILED:', e && e.stack || e); process.exit(1); });
