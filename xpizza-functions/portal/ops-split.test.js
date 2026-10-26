'use strict';
// PORTAL-UI 1a (PLAN-portal-ui-slice1-sucursales r5 §6 + §11 A4) — THE SHIP CONTRACT for the isolated branch-ops entrypoints.
// Run: node portal/ops-split.test.js   (no emulator; every load-mode check runs in a FRESH child process — FUNCTION_TARGET is
//                                        read once, at load)
//   1. ROUTING — the ops early branch is the exact pinned text (appended to the PORTAL_ISOLATED_TARGETS line); its Set is
//      exactly the PORTAL_OPS_TARGETS names and exactly portal/ops-functions.js's exports; each name loads ONLY the ops group (+ the
//      marker, once); unset / empty / wrong-case / padded / prefix / unknown / Object.prototype names → the FULL load.
//   2. CLOSURE — the STATIC require closure (every string-literal require(), conditional ones included) from
//      portal/ops-functions.js EQUALS the reviewed set; the forbidden modules are absent. RUNTIME: with no emulator env the
//      conditional lib/emulator-endpoint is NOT loaded; with one it is.
//   3. FULL LOAD — index.js (FUNCTION_TARGET unset) exports every ops name as the SAME function objects portal/ops-functions.js
//      exports, and still exports every name the base exported.
//   4. THE WRAPPER — OPTIONS on each ops function gets Access-Control-Max-Age: 600 (the shared preflight wrapper).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FN = path.join(__dirname, '..');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(FN, f), 'utf8');
const OPS = ['getMyBranches', 'updateBranch', 'setBranchPause', 'getBranchAvailability', 'setBranchAvailability', 'getBranchDevices', 'revokeBranchDevice'];

// ── 1. ROUTING ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const idx = read('index.js');
const OPS_BRANCH = " const PORTAL_OPS_TARGETS = Object.freeze(new Set(['getMyBranches', 'updateBranch', 'setBranchPause', 'getBranchAvailability', 'setBranchAvailability', 'getBranchDevices', 'revokeBranchDevice']));"
  + " if (PORTAL_OPS_TARGETS.has(process.env.FUNCTION_TARGET)) { console.log('portal_ops_entry', process.env.FUNCTION_TARGET); module.exports = require('./portal/ops-functions'); return; }";
const setLine = idx.split('\n').find((l) => l.startsWith('const PORTAL_ISOLATED_TARGETS = '));
assert.ok(setLine, 'premise: the portal Set line');
assert.ok(setLine.startsWith("const PORTAL_ISOLATED_TARGETS = Object.freeze(new Set(['getMyRestaurants', 'getEditableCatalog', 'editCatalog', 'publishEdited', 'getSalesStats']));" + OPS_BRANCH),
  '🔴 the ops early branch is not the exact pinned text (Set, exact Set.has, marker, exports, return), appended to the portal Set line');
assert.strictEqual(idx.split('PORTAL_OPS_TARGETS').length - 1, 2, 'the ops Set is declared once and read once');
assert.ok(idx.indexOf(setLine) < idx.indexOf("if (PORTAL_ISOLATED_TARGETS.has(process.env.FUNCTION_TARGET)) {"), 'the ops branch runs before anything but the comment header');
const opsMod = require('./ops-functions');
assert.deepStrictEqual(Object.keys(opsMod).sort(), [...OPS].sort(), 'the Set is exactly portal/ops-functions.js exports');
assert.deepStrictEqual([...opsMod.PORTAL_OPS_TARGETS].sort(), [...OPS].sort());
ok(`index.js line 6 carries the EXACT pinned ops early branch: a frozen Set of the ${OPS.length} names, exact Set.has(FUNCTION_TARGET), the marker, module.exports = portal/ops-functions, return`);

const LOCAL = (p) => path.relative(FN, p).split(path.sep).join('/');
const childScript = `
  const path = require('path');
  const m = require(path.join(${JSON.stringify(FN)}, 'index.js'));
  const local = Object.keys(require.cache).filter((p) => !p.includes('node_modules')).map((p) => path.relative(${JSON.stringify(FN)}, p).split(path.sep).join('/')).sort();
  console.log('RESULT ' + JSON.stringify({ exports: Object.keys(m).sort(), local }));
`;
function load(target, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.FIREBASE_DATABASE_EMULATOR_HOST; delete env.FIRESTORE_EMULATOR_HOST; delete env.FIREBASE_EMULATOR_HUB; delete env.FIREBASE_AUTH_EMULATOR_HOST;
  if (target === undefined) delete env.FUNCTION_TARGET; else env.FUNCTION_TARGET = target;
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, ['-e', childScript], { env, encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`child (${String(target)}) failed: ${r.stderr.slice(-800)}`);
  const lines = r.stdout.split('\n');
  return { ...JSON.parse(lines.find((l) => l.startsWith('RESULT ')).slice(7)), markers: lines.filter((l) => l.startsWith('portal_ops_entry') || l.startsWith('portal_isolated_entry')) };
}

const isolated = {};
for (const t of OPS) {
  const r = load(t);
  isolated[t] = r;
  assert.deepStrictEqual(r.exports, [...OPS].sort(), `${t}: only the ops group is exported`);
  assert.deepStrictEqual(r.markers, [`portal_ops_entry ${t}`], `${t}: the marker, exactly once`);
  assert.ok(r.local.includes('portal/ops-functions.js') && !r.local.includes('portal/functions.js'), `${t}: the ops module loaded, the portal group did not`);
}
ok(`each of the ${OPS.length} names loads ONLY portal/ops-functions.js (${isolated[OPS[0]].local.length} local modules), with the marker once`);

const full = load(undefined);
assert.ok(full.exports.length > 100, 'unset → the full load');
for (const t of ['', 'getmybranches', 'GetMyBranches', ' getMyBranches', 'getMyBranches ', 'getMyBranch', 'getMyBranchesX', 'nope', 'toString', '__proto__', 'constructor', 'hasOwnProperty']) {
  const r = load(t);
  assert.deepStrictEqual(r.markers.filter((m) => m.startsWith('portal_ops_entry')), [], `${JSON.stringify(t)}: no ops marker`);
  assert.ok(r.exports.length > 100 || r.exports.join() === ['editCatalog', 'getEditableCatalog', 'getMyRestaurants', 'getSalesStats', 'publishEdited'].join(), `${JSON.stringify(t)}: not the ops group`);
}
ok('unset / empty / wrong-case / padded / prefix / unknown / Object.prototype names → never the ops group, no marker');

// ── 2. CLOSURE ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const EXPECTED = [
  'portal/ops-functions.js', 'portal/ops-core.js', 'portal/origins.js', 'portal/preflight-max-age.js', 'portal/pause-reasons.js', 'portal/location-name.js', 'portal/reset-list.js',
  'lib/admin.js', 'lib/hn-date.js', 'lib/emulator-endpoint.js',
  'access/membership.js', 'access/writes-flag.js', 'brands/brand-model.js',
  'merchant/merchant-devices.js', 'merchant/merchant-validate.js', 'merchant/merchant-gate.js', 'merchant/merchant-scope.js',   /* slice 2 (E7 revoke core) */
  'restaurant-config.js', 'pickup-label.js',
  'merchant/merchant-control.js', 'tools/order-control-core.js', 'order-control-state.js', 'scheduled-orders.js', 'avail-key.js', 'availability-reset.js',
  'catalog/catalog-firestore.js', 'catalog/catalog-menu.js', 'catalog/catalog-transform.js', 'catalog/catalog-integrity.js', 'catalog/content-hash.js', 'catalog/canonical-json.js',
  'catalog/form-menu-source.js', 'catalog/redeem-source.js', 'catalog/exposure-source.js', 'catalog/extras-exposure.js', 'menu-pricing.js', 'price-valid.js', 'rewards-redeem-config.js',
  /* ORCHESTRATION O1b T8: E1+'s additive read model (readiness via the O1a writers' own facts + planner) */
  'portal/branch-read-model.js', 'branches/branch-ops.js', 'branches/branch-store.js', 'branches/drafts.js', 'branches/readiness-readers.js', 'branches/rid-alloc.js', 'sweep-pending.js',
].sort();
const CONDITIONAL = ['lib/emulator-endpoint.js'];   // reached via lib/admin.js only when an emulator env var is set
const FORBIDDEN = /^(catalog\/catalog-publish\.js|catalog\/portal-reads\.js|stats\/.*|factura\/.*|index\.js|merchant\/merchant-location\.js|merchant\/merchant-orders\.js|portal\/functions\.js)$/;

function staticClosure(entry) {
  const seen = new Set();
  const stack = [path.join(FN, entry)];
  while (stack.length) {
    const f = stack.pop();
    const rel = LOCAL(f);
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)) {
      const spec = m[2];
      if (!spec.startsWith('.')) continue;   // packages + builtins
      stack.push(require.resolve(path.resolve(path.dirname(f), spec)));
    }
  }
  return [...seen].sort();
}
const closure = staticClosure('portal/ops-functions.js');
assert.deepStrictEqual(closure, EXPECTED, `🔴 the static closure changed:\n  + ${closure.filter((x) => !EXPECTED.includes(x)).join(', ')}\n  − ${EXPECTED.filter((x) => !closure.includes(x)).join(', ')}`);
assert.deepStrictEqual(closure.filter((x) => FORBIDDEN.test(x)), [], 'no forbidden module');
const iso = isolated.updateBranch.local.filter((x) => x !== 'index.js');
assert.deepStrictEqual(iso, EXPECTED.filter((x) => !CONDITIONAL.includes(x)), 'RUNTIME (no emulator env): exactly the closure minus the conditional emulator module');
const withEmu = load('updateBranch', { FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1', FIRESTORE_EMULATOR_HOST: '127.0.0.1:1', GCLOUD_PROJECT: 'demo-xpizza' });
assert.ok(withEmu.local.includes('lib/emulator-endpoint.js'), 'RUNTIME (emulator env): the conditional emulator module is loaded');
ok(`CLOSURE: the static require closure is EXACTLY the ${EXPECTED.length} reviewed modules (none forbidden); at runtime lib/emulator-endpoint loads only under an emulator env`);

// ── 3. FULL LOAD ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const r = spawnSync(process.execPath, ['-e', `
    const path = require('path'); delete process.env.FUNCTION_TARGET;
    const m = require(path.join(${JSON.stringify(FN)}, 'index.js'));
    const o = require(path.join(${JSON.stringify(FN)}, 'portal', 'ops-functions.js'));
    console.log('SAME ' + JSON.stringify(${JSON.stringify(OPS)}.map((k) => m[k] === o[k])));`], { encoding: 'utf8', timeout: 120000, env: (() => { const e = { ...process.env }; delete e.FUNCTION_TARGET; delete e.FIREBASE_DATABASE_EMULATOR_HOST; return e; })() });
  assert.strictEqual(r.status, 0, r.stderr.slice(-500));
  assert.deepStrictEqual(JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('SAME ')).slice(5)), OPS.map(() => true), 'the full load re-exports the SAME function objects');
  const { execFileSync } = require('child_process');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbase-'));
  fs.writeFileSync(path.join(tmp, 'index.js'), execFileSync('git', ['show', '613f7e08:xpizza-functions/index.js'], { cwd: FN, maxBuffer: 1 << 28 }));
  const baseNames = [...new Set([...fs.readFileSync(path.join(tmp, 'index.js'), 'utf8').matchAll(/^exports\.([A-Za-z0-9_]+)\s*=/gm)].map((m) => m[1]))];
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of baseNames) assert.ok(full.exports.includes(k), `the full load still exports ${k}`);
  ok(`FULL LOAD: the ${OPS.length} are re-exported as the same objects; every one of the base's ${baseNames.length} directly-assigned exports is still there`);
}

// ── 4. THE WRAPPER ──────────────────────────────────────────────────────────────────────────────────────────────────────
for (const k of OPS) {
  const headers = {};
  const res = { setHeader: (h, v) => { headers[h] = v; }, getHeader: () => undefined, status() { return this; }, end() {}, json() {}, send() {}, set() { return this; }, on() {} };
  try { opsMod[k]({ method: 'OPTIONS', headers: { origin: 'https://sherpa-portal.netlify.app', 'access-control-request-method': 'POST' }, get: () => undefined, header: () => undefined }, res); } catch (_) { /* cors internals on a bare stub */ }
  assert.strictEqual(headers['Access-Control-Max-Age'], '600', `${k}: OPTIONS gets Access-Control-Max-Age: 600`);
  assert.ok(opsMod[k].__endpoint && opsMod[k].__endpoint.region && opsMod[k].__endpoint.region.includes('us-central1'), `${k}: endpoint metadata preserved (us-central1)`);
}
ok('WRAPPER: every ops export answers OPTIONS with Access-Control-Max-Age: 600 and keeps its Firebase endpoint metadata');

console.log(`\nops-split: OK (${n})`);
