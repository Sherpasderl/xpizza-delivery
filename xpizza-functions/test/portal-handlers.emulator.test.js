'use strict';
// PORTAL SPEED P1 (PLAN-portal-speed rev 3 §5/§6) — THE FIVE PORTAL FUNCTIONS, THROUGH THE REAL EXPORTED HANDLERS, IN
// BOTH LOAD MODES, against the Firestore + RTDB emulators.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:isolated-portal-handlers
//
// The existing portal suites drive the CORES (edit/publish/reads/stats) directly; what this slice moved is the WIRING
// around them — the onRequest options, the injected verifier / membership db / publisher / mirror / alarm / keyer /
// live cache. So every call here goes through an exported CloudFunction behind a real HTTP server (cors middleware
// included), with a real (emulator-format, unsigned) ID token verified by the real Admin SDK:
//   own restaurants → editable catalog → save (editCatalog) → publish (publishEdited) → catalog re-read → sales stats,
//   plus the refusals (no token, a non-owner) and the CORS preflight.
// It runs the SAME script in fresh child processes, one per load mode, each on a wiped emulator:
//   full     — index.js with FUNCTION_TARGET unset (deploy discovery, tests: everything loads)
//   isolated — index.js with FUNCTION_TARGET=editCatalog (production gen2 + emulator workers: the early branch)
//   base     — OPTIONAL, PORTAL_BASE_DIR=<a checkout of the integration parent's xpizza-functions> (evidence runs)
// and asserts the normalized transcripts are IDENTICAL across modes, apart from the one approved delta — the preflight's
// Access-Control-Max-Age (absent on base, 600 on the candidate).
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const MODES = [['full', {}], ['isolated', { FUNCTION_TARGET: 'editCatalog' }]];
if (process.env.PORTAL_BASE_DIR) MODES.unshift(['base', { PORTAL_ENTRY: path.join(process.env.PORTAL_BASE_DIR, 'index.js') }]);

if (process.argv[2] !== '--child') {
  require('./_emulator-required')('firestore', 'database');
  let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
  const transcripts = {};
  for (const [mode, extra] of MODES) {
    const env = { ...process.env, ...extra, PORTAL_MODE: mode };
    if (!extra.FUNCTION_TARGET) delete env.FUNCTION_TARGET;
    const r = spawnSync(process.execPath, [__filename, '--child'], { env, encoding: 'utf8', timeout: 180000 });
    const out = r.stdout || '';
    if (r.status !== 0) { console.error(out, r.stderr); throw new Error(`portal-handlers(emulator): the ${mode} run failed (exit ${r.status})`); }
    const line = out.split('\n').find((l) => l.startsWith('TRANSCRIPT '));
    assert.ok(line, `${mode}: transcript printed`);
    transcripts[mode] = JSON.parse(line.slice('TRANSCRIPT '.length));
    const markers = out.split('\n').filter((l) => l.startsWith('portal_isolated_entry'));
    assert.deepStrictEqual(markers, mode === 'isolated' ? ['portal_isolated_entry editCatalog'] : [],
      `${mode}: the isolated-branch marker appears exactly when (and only when) the early branch ran`);
    ok(`${mode}: all ${transcripts[mode].length} steps passed through the real exported handlers (${mode === 'isolated' ? 'early branch ran: only portal/functions.js loaded' : mode === 'base' ? 'the integration parent, unchanged' : 'full load'})`);
  }
  const strip = (t, mode) => t.map((s) => {
    if (s.step !== 'preflight') return s;
    const { maxAge, ...rest } = s;
    assert.strictEqual(maxAge, mode === 'base' ? null : '600', `${mode}: preflight Access-Control-Max-Age`);
    return rest;
  });
  assert.deepStrictEqual(strip(transcripts.isolated, 'isolated'), strip(transcripts.full, 'full'), '🔴 the isolated load answers differently from the full load');
  ok('isolated == full: every status, error code, body shape, wiring-dependent value and CORS header identical');
  if (transcripts.base) {
    assert.deepStrictEqual(strip(transcripts.full, 'full'), strip(transcripts.base, 'base'), '🔴 the candidate answers differently from the integration parent');
    ok('candidate == integration parent (base): identical in every recorded field except the approved Access-Control-Max-Age: 600');
  }
  console.log(`\nportal-handlers(emulator): OK (${n})`);
  process.exit(0);
}

// ── the child: one load mode, one wiped emulator ─────────────────────────────────────────────────────────────────
require('./_emulator-required')('firestore', 'database');   // BEFORE index.js — it pins the PRODUCTION databaseURL
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'portal-handlers-secret-'.padEnd(48, 'x');
process.env.STATS_HMAC_SECRET = process.env.STATS_HMAC_SECRET || 'portal-handlers-stats-secret-'.padEnd(48, 'y');

const http = require('http');
const PROJECT = process.env.GCLOUD_PROJECT;
const RID = 'x_pizza';
const OWNER = 'uPortalOwner01';
const STRANGER = 'uPortalStranger01';
const ORIGIN = 'https://sherpa-portal.netlify.app';

/* THE AUTH EMULATOR STAND-IN. With FIREBASE_AUTH_EMULATOR_HOST set, the REAL Admin verifyIdToken accepts an unsigned
   emulator-format token (signature skipped by the SDK, every claim — iss, aud, sub, exp, iat — still checked) and then
   asks the Auth emulator whether the user is disabled or revoked (accounts:lookup). tools/emulator-run.js does not
   start an Auth emulator, so this process answers exactly that one lookup: the two known users, enabled; anyone else
   USER_NOT_FOUND (→ the verifier fails closed). Every other path 404s, so an unexpected Auth call fails loudly. */
const USERS = new Set(['uPortalOwner01', 'uPortalStranger01']);
function startAuthStandIn() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (req.method === 'POST' && /\/accounts:lookup$/.test(req.url)) {
          const ids = (JSON.parse(raw || '{}').localId) || [];
          const users = ids.filter((u) => USERS.has(u)).map((u) => ({ localId: u, email: `${u}@example.test`, disabled: false, providerUserInfo: [] }));
          res.writeHead(users.length ? 200 : 400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(users.length ? { kind: 'identitytoolkit#GetAccountInfoResponse', users } : { error: { code: 400, message: 'USER_NOT_FOUND' } }));
        }
        res.writeHead(404); res.end();
      });
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}
let app, getFirestore, getDatabase;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (uid) => {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, auth_time: now, user_id: uid, sub: uid, iat: now, exp: now + 3600, email: `${uid}@example.test`, firebase: { identities: {}, sign_in_provider: 'password' } })}.`;
};

async function call(fn, { method = 'GET', query = '', body, uid, origin = ORIGIN, headers = {} } = {}) {
  const srv = http.createServer((req, res) => {
    // what the Functions Framework provides: an express-shaped req (get/query/body) and res (status/json/set/send)
    const express = require('express');
    const a = express(); a.use(express.json()); a.all('*', (rq, rs) => fn(rq, rs)); a(req, res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const h = { ...headers };
    if (origin) h.Origin = origin;
    if (uid) h.Authorization = `Bearer ${idToken(uid)}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/${query}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) { /* csv / empty */ }
    return { status: r.status, headers: r.headers, json, text };
  } finally { await new Promise((r) => srv.close(r)); }
}

const shape = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).sort() : typeof o);

(async () => {
  const authSrv = await startAuthStandIn();
  process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${authSrv.address().port}`;
  app = require(process.env.PORTAL_ENTRY || path.join(__dirname, '..', 'index.js'));
  ({ getFirestore } = require('firebase-admin/firestore'));
  ({ getDatabase } = require('firebase-admin/database'));
  const fs = getFirestore();
  const db = getDatabase();
  // wipe (both emulators) — guarded above; this process can only reach the emulators
  await db.ref('/').set(null);
  const r0 = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  assert.ok(r0.ok, 'firestore emulator wiped');

  // seed: the draft + an initial published version (the publisher's own path), and the owner grant in RTDB
  const { sourceRefOf, canonicalize } = require('../catalog/source-store');
  const { buildSourceFromCode } = require('../tools/seed-source-store');
  const { publishVersion } = require('../catalog/catalog-publish');
  await sourceRefOf(fs, RID).set(canonicalize(buildSourceFromCode(RID)));
  const { input } = require('../tools/publish-version').buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'seed' });
  await publishVersion(fs, RID, input, { expected: { activeVersionId: null } });
  const { ownerGrantPaths } = require('../catalog/owner-index');
  await db.ref().update(ownerGrantPaths(RID, OWNER));

  const T = [];
  const step = (name, rec) => { T.push({ step: name, ...rec }); };

  // 1. CORS preflight on every portal function — answered by cors, before any handler code
  for (const fn of ['getMyRestaurants', 'getEditableCatalog', 'editCatalog', 'publishEdited', 'getSalesStats']) {
    const r = await call(app[fn], { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    step('preflight', { fn, status: r.status, allowOrigin: r.headers.get('access-control-allow-origin'), allowHeaders: r.headers.get('access-control-allow-headers'),
      allowMethods: r.headers.get('access-control-allow-methods'), vary: r.headers.get('vary'), maxAge: r.headers.get('access-control-max-age') });
    assert.strictEqual(r.status, 204); assert.strictEqual(r.headers.get('access-control-allow-origin'), ORIGIN);
  }

  // 2. refusals: no token, and a signed-in stranger
  for (const [fn, opts] of [['getMyRestaurants', {}], ['getEditableCatalog', { query: `?restaurantId=${RID}` }], ['editCatalog', { method: 'POST', body: { restaurantId: RID } }],
    ['publishEdited', { method: 'POST', body: { restaurantId: RID } }], ['getSalesStats', { query: `?restaurantId=${RID}` }]]) {
    const anon = await call(app[fn], opts);
    step('no_token', { fn, status: anon.status, error: anon.json && anon.json.error, acao: anon.headers.get('access-control-allow-origin') });
    assert.strictEqual(anon.status, 401, `${fn}: no token → 401 (${anon.text.slice(0, 120)})`);
    if (fn !== 'getMyRestaurants') {
      const st = await call(app[fn], { ...opts, uid: STRANGER });
      step('stranger', { fn, status: st.status, error: st.json && st.json.error });
      assert.strictEqual(st.status, 403, `${fn}: a non-owner → 403 (${st.text.slice(0, 120)})`);
    }
  }

  // 3. getMyRestaurants → the owner's restaurant (RTDB owner index, real verifier)
  const mine = await call(app.getMyRestaurants, { uid: OWNER });
  step('getMyRestaurants', { status: mine.status, shape: shape(mine.json), rids: (mine.json.restaurants || []).map((x) => x.restaurantId || x.id || x.rid || x).map(String) });
  assert.strictEqual(mine.status, 200, mine.text.slice(0, 200));

  // 4. getEditableCatalog → the draft + CAS baseline + the active version + fiscal capability
  const cat = await call(app.getEditableCatalog, { uid: OWNER, query: `?restaurantId=${RID}` });
  assert.strictEqual(cat.status, 200, cat.text.slice(0, 200));
  step('getEditableCatalog', { status: cat.status, shape: shape(cat.json), usesPlatformFactura: cat.json.usesPlatformFactura, hasActive: !!cat.json.activeVersionId, items: cat.json.source.items.length });

  // 5. editCatalog: a +1 price change, conditional on the baseline just read (the real decoder runs)
  const src = JSON.parse(JSON.stringify(cat.json.source));
  src.items[0].price += 1;
  if (src.items[0].display) src.items[0].display.price = src.items[0].price;
  const saved = await call(app.editCatalog, { method: 'POST', uid: OWNER, body: { restaurantId: RID, source: src, baseSourceUpdateTime: cat.json.sourceUpdateTime } });
  assert.strictEqual(saved.status, 200, saved.text.slice(0, 300));
  step('editCatalog', { status: saved.status, shape: shape(saved.json), changes: JSON.stringify(saved.json.diff && saved.json.diff.changes || saved.json.diff && Object.keys(saved.json.diff).sort()) });
  // a stale baseline is refused (the CAS through the real Timestamp decoder)
  const stale = await call(app.editCatalog, { method: 'POST', uid: OWNER, body: { restaurantId: RID, source: src, baseSourceUpdateTime: cat.json.sourceUpdateTime } });
  step('editCatalog_stale', { status: stale.status, error: stale.json && stale.json.error });
  assert.ok(stale.status >= 400 && stale.status < 500, `a stale baseline is refused (${stale.text.slice(0, 160)})`);

  // 6. publishEdited: the real publisher + RTDB mirror + alarm wiring
  const pub = await call(app.publishEdited, { method: 'POST', uid: OWNER, body: { restaurantId: RID, token: saved.json.token, fiscalAck: true, acknowledgedChanges: (saved.json.diff && saved.json.diff.largeChangeSet) || [] } });
  assert.strictEqual(pub.status, 200, pub.text.slice(0, 300));
  const mirror = (await db.ref(`catalog_snapshot/${RID}`).get()).val();
  step('publishEdited', { status: pub.status, shape: shape(pub.json), mirrored: !!mirror });
  assert.ok(mirror, 'the publish was mirrored to RTDB through the real makeRtdbMirror wiring');

  // 7. the re-read sees the published price as live
  const after = await call(app.getEditableCatalog, { uid: OWNER, query: `?restaurantId=${RID}` });
  step('getEditableCatalog_after', { status: after.status, priceDelta: after.json.source.items[0].price - cat.json.source.items[0].price, activeMoved: after.json.activeVersionId !== cat.json.activeVersionId });
  assert.strictEqual(after.json.source.items[0].price - cat.json.source.items[0].price, 1);

  // 8. getSalesStats: the real keyer + live cache (empty history → a valid, empty answer)
  const tz = require('../stats/stats-time');
  const day = tz.addDays(tz.dateOf(Date.now()), -1);
  const st = await call(app.getSalesStats, { uid: OWNER, query: `?restaurantId=${RID}&from=${day}&to=${day}&compare=none` });
  step('getSalesStats', { status: st.status, shape: shape(st.json), expose: st.headers.get('access-control-expose-headers') });
  assert.strictEqual(st.status, 200, st.text.slice(0, 300));
  const csv = await call(app.getSalesStats, { uid: OWNER, query: `?restaurantId=${RID}&from=${day}&to=${day}&compare=none&format=csv` });
  step('getSalesStats_csv', { status: csv.status, type: csv.headers.get('content-type'), disposition: !!csv.headers.get('content-disposition'), expose: csv.headers.get('access-control-expose-headers') });
  assert.strictEqual(csv.status, 200, csv.text.slice(0, 200));

  console.log(`TRANSCRIPT ${JSON.stringify(T)}`);
  process.exit(0);
})().catch((e) => { console.error('portal-handlers child FAILED:', e && e.stack || e); process.exit(1); });
