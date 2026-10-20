'use strict';
/* R1 SEMANTIC ENDPOINT CENSUS (codex R1-build P1-1) — every executable under xpizza-functions and the repo-root
 * harnesses that CONSTRUCTS an Admin app, READS an emulator / prod-URL variable, or makes an HTTP call to a functions
 * URL is found by WHAT IT DOES (not by a file-name suffix), must carry a disposition below, and — where it can reach a
 * database — is DRIVEN with mixed / foreign / missing signals and must refuse as ONE process with zero connection
 * attempts and zero launches (tools/no-connect.js records). An unclassified match FAILS: a new file is a decision.
 *
 * Out of scope by directory, stated: every other top-level app dir (xpizza-orders, -dashboard, -dispatch, -kitchen,
 * -portal, -track, -driver, -catering, -factura, la-musa-orders, legal, platform, xpizza-reference) is a separately
 * deployed BROWSER bundle or the separate factura print-agent package — not run under the functions emulator launcher.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const EE = require('../lib/emulator-endpoint');

const FN = path.join(__dirname, '..');
const REPO = path.join(FN, '..');
const NO_CONNECT = path.join(FN, 'tools', 'no-connect.js');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── discovery: semantic signals ────────────────────────────────────────────────────────────────────────────────────
const SIG = {
  admin: /initializeApp\s*\(|initializeTestEnvironment\s*\(/,
  // constructs the Admin app TRANSITIVELY: loads index.js / lib/admin.js (the default app is created at require time)
  index: /require\(\s*['"`](?:\.\.?\/)+(?:index(?:\.js)?|lib\/admin(?:\.js)?)['"`]\s*\)/,
  env: /_EMULATOR_HOST|_EMULATOR_ADDRESS|FIREBASE_EMULATOR_HUB|FUNCTIONS_EMULATOR\b|FB_DATABASE_URL/,
  http: (s) => /CREATEORDER_URL|INGEST_URL|cloudfunctions\.net|us-central1\//.test(s) && /fetch\(|request\(|\.post\(/.test(s),
};
function discover() {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', '.impeccable'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      const rel = path.relative(REPO, p).split(path.sep).join('/');
      if (e.isDirectory()) { if (!rel.includes('/') && !['xpizza-functions', 'scripts'].includes(rel)) continue; walk(p); continue; }
      if (!/\.(c|m)?js$/.test(e.name)) continue;
      const s = fs.readFileSync(p, 'utf8');
      const sig = [SIG.admin.test(s) && 'admin', SIG.index.test(s) && 'index', SIG.env.test(s) && 'env', SIG.http(s) && 'http'].filter(Boolean);
      if (sig.length) out.set(rel, sig);
    }
  };
  walk(REPO);
  return out;
}

// ── dispositions ───────────────────────────────────────────────────────────────────────────────────────────────────
const F = (r) => `xpizza-functions/${r}`;
const SUITE = /^xpizza-functions\/(test|contract)\/[^/]+\.emulator\.test\.m?js$/;   // driven by emulator-ports.guard cell "all N emulator suites REFUSE" (contract/ = R3)
const D = {
  // emulator-only harnesses — strict validator before any client (driven below: no signal / foreign / half-configured)
  [F('test/d4p1-capture-order-control.js')]: 'harness', [F('deploy/emulator-e2e.js')]: 'harness', [F('deploy/config-read-probe.js')]: 'harness',
  [F('deploy/check-seed-readiness.js')]: 'harness', [F('deploy/emu-seed.js')]: 'harness', [F('tools/menus-identity-publish.js')]: 'harness',
  [F('test/portal-emulator-workers.probe.js')]: 'harness', [F('test/_kds-writer-worker.js')]: 'harness', [F('test/emu-isolation.proof.js')]: 'harness',
  [F('test/measure-identity-fence.js')]: 'harness',
  // TRACKER FIXES T9: the cost harness — `_emulator-required('database')` before index.js is loaded (driven below like every harness)
  [F('test/tracker-measure.mjs')]: 'harness',
  // H1a gate G-1: the handheld isolation ACCEPTANCE check A1 runs before enabling pairing (expected red until F2(c)) —
  // `_emulator-required('database')` is its first statement, so it is driven like every harness; it is not in the gate chain
  [F('test/merchant-isolation.g1.js')]: 'harness',
  // D4-c2b: the monitor's fresh-process child and the §8 latency measure — `_emulator-required('database', 'firestore')` is the
  // first statement of each, before index.js is loaded (driven below like every harness)
  [F('test/_c2b-monitor-child.js')]: 'harness', [F('test/c2b-latency.measure.js')]: 'harness',
  // signup phase 1: the verifyOtp differential worker — `_emulator-required('database', 'firestore')` first, before index.js loads
  [F('test/_signup-otp-worker.js')]: 'harness',
  // KDS parent: self-launches the runner when NO signal is present (by design) — driven with foreign + half-configured
  [F('kds-manifest-writer.test.mjs')]: 'harness-selflaunch',
  // the latency child: `node -e` children that load index.js — guarded by lib/admin.js (driven: its child shape)
  [F('tools/portal-speed-proof.js')]: 'latency-parent',
  // operator CLIs — tools/require-project.js runs the mixed-signal guard (driven: mixed ⇒ refuse)
  ...Object.fromEntries(['backfill-identities', 'backfill-snapshot', 'bootstrap-identity', 'client-floor', 'client-version-report',
    'draft-drift-report', 'identity-display-name', 'verify-first-group', 'menus-divergence-report', 'migrate-catalog-display', 'order-control', 'preflight-pointers', 'publish-version',
    'rollback-version', 'seed-catalog', 'seed-owner', 'seed-source-store', 'stats-rollup', 'verify-catalog',
    // PLATFORM F1 — the brands owner CLI: requireProject({ requireFlag: true }) before any client
    'brands-admin',
    // PLATFORM F2 Q1 — the access census + kitchen roster owner CLIs: requireProject({ requireFlag: true }) before any client
    'access-census', 'kitchen-roster',
    // D4-c2b operator CLIs — requireProject({ requireFlag: true }): --project mandatory, an inherited project variable alone refuses
    'ack-identity-finding', 'record-evidence-boundary',
    // per-product extras gate 0: the READ-ONLY live export (active version + public menu) for the advisor's parity run
    'extras-export-live',
    // H1c step 0 — the owner-run hardware-gate sender (ONE data-only FCM message; no database read or write):
    // requireProject({ requireFlag: true }) before any client
    'handheld-push-probe',
    // TRACKER FIXES — the owner-run flag-transition tool: requireProject({ requireFlag: true }) before any client
    'tracker-reconcile'].map((t) => [F(`tools/${t}.js`), 'prod-cli'])),
  // functions-root production scripts — tools/emu-mixed-guard.js before initializeApp (driven: mixed ⇒ refuse)
  [F('publish-menus.mjs')]: 'prod-script', [F('seed-kitchen-staff.mjs')]: 'prod-script', [F('seed_identity.js')]: 'prod-script',
  [F('scripts/backfill-driver-push.js')]: 'prod-script', [F('scripts/backfill-driver-accounts.js')]: 'prod-script', [F('scripts/set-driver-enforcement-mode.js')]: 'prod-script', [F('scripts/test-ingest.js')]: 'prod-script', [F('ready-time-quality-run.js')]: 'prod-script',
  // deployed / library code (not executables on their own)
  [F('lib/admin.js')]: 'lib: the deployed Admin app — validator in its emulator branch (emulator-endpoint.test cells 1-8)',
  [F('driver-accounts-backfill.lib.js')]: 'lib: PURE backfill data + record builder + authRtdbCoherent(emuMode, authEmuHostSet) predicate — no client; FIREBASE_AUTH_EMULATOR_HOST appears only in a comment (codex r1 P1-6)',
  [F('lib/svc-assigner.js')]: 'lib: the narrowly-privileged svc-assigner Admin app (S1a §3) — lazy, named, singleton; created on first handler use, never at module load, so the one-default-app invariant (portal-split) holds; getDatabase() auto-redirects under the emulator host',
  [F('lib/emulator-endpoint.js')]: 'lib: the validator itself', [F('deploy/emu-ns.js')]: 'lib: emuDatabaseURL → validateRtdbUrl (strict)',
  [F('test/_emulator-required.js')]: 'lib: the suite/harness guard',
  [F('test/_kds-sdk-loader.mjs')]: 'lib: F2 Q2 test-only kitchen-SDK loader, imported only by *.emulator.test.mjs suites (behind _emulator-required + emulator-run); it connects the npm SDK ONLY to FIREBASE_DATABASE_EMULATOR_HOST and is never executed directly', [F('tools/emu-mixed-guard.js')]: 'lib: the CLI mixed-signal guard',
  [F('tools/require-project.js')]: 'lib: project guard + mixed-signal guard', [F('tools/emulator-run.js')]: 'lib: the launcher',
  [F('tools/emu-cmd-wrapper.js')]: 'lib: the marked suite wrapper — spawned only by the launcher; reads the run\'s own Firestore host to load its rules (emu-alloc.test cell 10 + the real proof)',
  [F('index.js')]: 'lib: the deployed entry — its Admin app is lib/admin.js (guarded)', [F('portal/functions.js')]: 'lib: the deployed portal entry — lib/admin.js',
  [F('portal/reset-draft.js')]: 'lib: deployed portal module — lib/admin.js',
  [F('cors-preflight.test.js')]: 'unit: proven loopback-only, off-band (emulator-endpoint.test cell 8)',
  [F('tools/portal-split.js')]: 'lib: source-TEXT fold (the initializeApp is a string it rewrites, no runtime Admin)',
  [F('tools/deploy-env-guard.js')]: 'lib: reads deploy env KEY NAMES only, no client',
  [F('tools/secret-env.js')]: 'lib: R3 credential scrub — names env KEYS (and reads .env KEY NAMES only) to DELETE them from a test process env; no client, no value read or printed',
  [F('tools/portal-latency-probe.js')]: 'prod-measurement: HTTP to the DEPLOYED functions by design (token-authenticated); no Admin client, emulator vars do not reach it',
  // tests that never contact a database (fakes / stubs / text), each verified
  [F('rtdb-init.test.js')]: 'unit: proven loopback-only, off-band (emulator-endpoint.test cell 8)',
  [F('stats/stats-volume.test.js')]: 'unit: a named app over catalog/firestore-fake — no network',
  [F('stats/stats-job.test.js')]: 'unit: initializeApp appears in a source string under test', [F('catalog/project-guard.test.js')]: 'unit: drives require-project refusals (no data I/O)',
  [F('tools/brands-admin.test.js')]: 'unit: drives the brands CLI into require-project refusals — dead-port hosts, no credential (no data I/O)',
  [F('tools/access-census.test.js')]: 'unit: drives the access-census CLI into require-project refusals — dead-port hosts, no credential (no data I/O)',
  [F('tools/kitchen-roster.test.js')]: 'unit: drives the kitchen-roster CLI into require-project refusals — dead-port hosts, no credential (no data I/O)',
  [F('tools/identity-display-name.test.js')]: 'unit: drives the CLI\'s require-project refusals (no data I/O); its spawned CLI is pointed at a dead loopback RTDB port with void credentials',
  [F('catalog/identity-integrity-guards.test.js')]: 'unit: drives the two c2b prod CLIs into require-project refusals — dead-port hosts, no credential (no data I/O)',
  [F('tools/verify-first-group.test.js')]: 'unit: drives the CLI\'s require-project + argument refusals before any client (no data I/O); its spawned CLI points at a dead loopback RTDB port with void credentials',
  [F('test/kds-writer-capture.mjs')]: 'unit: a STUB initializeApp (returns {})', [F('portal/portal-split.test.js')]: 'unit: fold-guard text',
  [F('pselfupdate-client.test.js')]: 'unit: injected fetch, no network', [F('pselfupdate-wrapper-lint.test.js')]: 'unit: lints source text',
  'order-control-client.test.mjs': 'unit: injected fetch, no network',
  [F('tools/emulator-endpoint.test.js')]: 'test of this guard family', [F('tools/emulator-ports.guard.test.js')]: 'test of this guard family',
  [F('tools/deploy-env-guard.test.js')]: 'test of this guard family', [F('tools/endpoint-census.guard.test.js')]: 'this file',
  // R3 contract HARNESS modules — loaded only by contract/*.emulator.test.* suites, which refuse before any client (driven above)
  [F('contract/scheduler.js')]: 'lib: R3 harness (scheduler) — loaded only by contract suites, after their emulator guard',
  [F('contract/rtdb-adapter.js')]: 'lib: R3 harness (staff-page Firebase adapter on Admin) — loaded only by contract suites, after their emulator guard',
  [F('contract/form-router.js')]: 'lib: R3 harness (in-process HTTP to the real handlers on 127.0.0.1) — loaded only by contract suites, after their emulator guard',
  [F('test/_web-sdk-loader.mjs')]: 'lib: test-only client-SDK loader — imported only by *.emulator.test.* suites after their emulator guard; makeWebSdkLoader throws without FIREBASE_DATABASE_EMULATOR_HOST and only ever connects to that loopback emulator',
  'scripts/backfill-pickup-completion.mjs': 'prod-only root script, RTDB ONLY: no second service to mix; an inherited RTDB host var can only redirect AWAY from production',
};

// ── the observer ───────────────────────────────────────────────────────────────────────────────────────────────────
const SCRUB = ['FUNCTIONS_EMULATOR', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_FIRESTORE_EMULATOR_ADDRESS', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB',
  'XPIZZA_EMU_OFFSET', 'XPIZZA_EMU_SERVICES', 'XPIZZA_EMU_DEAD', 'XPIZZA_EMU_RUN', 'FUNCTION_TARGET', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'CREATEORDER_URL', 'FB_DATABASE_URL', 'PROBE_TARGET', 'READINESS_TARGET'];
function observe(args, extra, { cwd = FN } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-census-'));
  try {
    const env = { ...process.env };
    for (const k of SCRUB) delete env[k];
    Object.assign(env, extra, { NO_CONNECT_DIR: dir, HOME: os.tmpdir() });   // HOME: no ADC file can be picked up
    env.NODE_OPTIONS = `${(env.NODE_OPTIONS || '').replace(/--require[= ]\S*count-marks\.js/g, '')} --require ${NO_CONNECT}`.trim();
    const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60000, env });
    const recs = fs.readdirSync(dir).filter((f) => f.endsWith('.rec')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean));
    return { r, recs, connects: recs.flatMap((l) => l.filter((x) => x.startsWith('CONNECT '))), spawns: recs.flatMap((l) => l.filter((x) => x.startsWith('SPAWN '))) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const refusedClean = (x, label) => {
  assert.ok(typeof x.r.status === 'number' && x.r.status !== 0 && x.r.signal === null, `🔴 ${label}: did not refuse (exit ${x.r.status}, signal ${x.r.signal})\n${(x.r.stdout + x.r.stderr).slice(-700)}`);
  assert.match(x.r.stderr || '', /^[ \t]*(?:🔴 REFUSED —|🛑 REFUSING TO RUN —)/m, `🔴 ${label}: no anchored refusal banner\n${(x.r.stderr || '').slice(-700)}`);
  assert.deepStrictEqual(x.connects, [], `🔴 ${label}: contacted ${x.connects.join(', ')} before refusing`);
  assert.deepStrictEqual(x.spawns, [], `🔴 ${label}: launched ${x.spawns.join(', ')} before refusing`);
};

const P = EE.planPorts(70);
const lo = (p) => `127.0.0.1:${p}`;
const MIXED = { FIRESTORE_EMULATOR_HOST: lo(P.firestore) };                                    // RTDB absent ⇒ that half = PROD
const MIXED_DB = { FIREBASE_DATABASE_EMULATOR_HOST: lo(P.database), FB_DATABASE_URL: 'https://xpizza-delivery-default-rtdb.firebaseio.com' };
const FOREIGN = { FIRESTORE_EMULATOR_HOST: 'evil.example:8080', FIREBASE_DATABASE_EMULATOR_HOST: 'evil.example:9000' };

(async () => {
  // 1. COMPLETE: every semantic match is classified; no stale entries
  const found = discover();
  const unclassified = [...found.keys()].filter((f) => !SUITE.test(f) && !D[f]);
  assert.deepStrictEqual(unclassified, [], `🔴 ${unclassified.length} endpoint-touching executable(s) have NO disposition — classify each (and drive it if it can reach a database):\n  ${unclassified.map((f) => `${f} [${found.get(f)}]`).join('\n  ')}`);
  const stale = Object.keys(D).filter((f) => !found.has(f));
  assert.deepStrictEqual(stale, [], `🔴 dispositions for files that no longer match: ${stale.join(', ')}`);
  const suites = [...found.keys()].filter((f) => SUITE.test(f)).length;
  ok(`semantic census: ${found.size} executables touch an Admin app / emulator or prod-URL variable / functions URL — ${suites} emulator suites (driven by the ports guard) + ${Object.keys(D).length} classified here, 0 unclassified, 0 stale`);

  const rel = (f) => path.relative(FN, path.join(REPO, f));
  // 2. HARNESSES: no signal / foreign / half-configured ⇒ refuse before any client
  const HARNESS_EXTRA = {
    [F('deploy/emulator-e2e.js')]: { CREATEORDER_URL: `http://127.0.0.1:${P.functions}/demo-xpizza/us-central1/createOrder`, GCLOUD_PROJECT: 'demo-xpizza' },
    [F('deploy/config-read-probe.js')]: { CREATEORDER_URL: `http://127.0.0.1:${P.functions}/demo-xpizza/us-central1/createOrder`, INTAKE_SECRET: 's', PROBE_STAMP: 'r1-stamp-0123456789abcdef', GCLOUD_PROJECT: 'demo-xpizza' },
    [F('test/_kds-writer-worker.js')]: { __args: ['/nonexistent-args.json'] },
    [F('test/emu-isolation.proof.js')]: { __args: ['inside', os.tmpdir(), 'X'] },
    [F('tools/menus-identity-publish.js')]: { __args: ['--project', 'xpizza-delivery'] },
    [F('test/tracker-measure.mjs')]: { __args: ['--flag', 'off', '--out', path.join(os.tmpdir(), 'tracker-measure-census.json')] },
  };
  let driven = 0;
  for (const [f, kind] of Object.entries(D).filter(([, k]) => k === 'harness' || k === 'harness-selflaunch')) {
    const { __args = [], ...extra } = HARNESS_EXTRA[f] || {};
    const shapes = [['FOREIGN', FOREIGN], ['HALF (Firestore only)', MIXED], ['HALF (RTDB only)', { FIREBASE_DATABASE_EMULATOR_HOST: lo(P.database) }]];
    if (kind === 'harness') shapes.unshift(['NO signal', {}]);
    for (const [shape, env] of shapes) { refusedClean(observe([rel(f), ...__args], { ...extra, ...env }), `${f} under ${shape}`); driven += 1; }
  }
  ok(`${driven} harness runs refuse before any client: every emulator-only harness under no-signal / foreign / both half-configured shapes (the KDS parent's no-signal case self-launches the runner by design, so it is driven with the other three)`);

  // 3. PROD CLIs (require-project) + functions-root PROD SCRIPTS: mixed signals ⇒ refuse; no signal ⇒ unchanged
  const ARGS = {
    [F('scripts/test-ingest.js')]: ['https://us-central1-xpizza-delivery.cloudfunctions.net/ingestDriverLocation', 'UID'],
  };
  const EXTRA = { [F('seed_identity.js')]: { ULTRAMSG_INSTANCE_ID: 'instanceX' } };
  let cli = 0;
  for (const [f] of Object.entries(D).filter(([, k]) => k === 'prod-cli' || k === 'prod-script')) {
    for (const [shape, env] of [['MIXED (Firestore emulator, RTDB prod)', MIXED], ['MIXED (RTDB emulator, Firestore prod)', MIXED_DB], ['FOREIGN', FOREIGN]]) {
      const x = observe([rel(f), ...(ARGS[f] || []), '--project', 'xpizza-delivery'], { ...(EXTRA[f] || {}), ...env, GOOGLE_CLOUD_PROJECT: 'xpizza-delivery' });
      refusedClean(x, `${f} under ${shape}`);
      cli += 1;
    }
  }
  ok(`${cli} production CLI/script runs: every require-project CLI and every functions-root production script REFUSES mixed (either half emulated, the other prod) and foreign signals before any client`);

  // 3b. (a) S1a r7 P2 — test-ingest is EMULATOR-ONLY (retired from prod; it opens/replaces driver shifts via
  //     unrestricted Admin). A NO-SIGNAL production run is refused before any client. (Mixed/foreign signals are
  //     refused as incoherent in section 3 above; a coherent local emulator is its only allowed shape.)
  //     (b) DOTENV INJECTION: every require-project CLI that loads dotenv AFTER its early check is run from a directory
  //     whose .env introduces a FOREIGN Firestore host — the client-construction re-check must refuse before any client.
  {
    const coherent = { FIRESTORE_EMULATOR_HOST: lo(P.firestore), FIREBASE_DATABASE_EMULATOR_HOST: lo(P.database), XPIZZA_EMU_OFFSET: '70' };
    // S1a r7 P2 — test-ingest is now EMULATOR-ONLY (retired from prod): a NO-SIGNAL production run is refused before any client.
    refusedClean(observe([rel(F('scripts/test-ingest.js')), 'https://us-central1-xpizza-delivery.cloudfunctions.net/ingestDriverLocation', 'UID'], {}), 'test-ingest under NO signal (emulator-only, refuses a production run)');
    // per-product extras gate 0 (codex r1 P1-1): the live export pairs a source with the PRODUCTION public menu — a coherent
    // emulator env would pair emulator data with production, so it is production-only too
    refusedClean(observe([rel(F('tools/extras-export-live.js')), '--project', 'xpizza-delivery', '--out', '/tmp/extras-census-never', 'x_pizza'], { ...coherent, GOOGLE_CLOUD_PROJECT: 'xpizza-delivery' }), 'extras-export-live under a COHERENT emulator env (production-only)');
    const DOTENV_CLIS = fs.readdirSync(path.join(FN, 'tools')).filter((f) => f.endsWith('.js'))
      .filter((f) => { const t = fs.readFileSync(path.join(FN, 'tools', f), 'utf8'); return /requireProject\(/.test(t) && /require\('dotenv'\)\.config\(\)/.test(t) && f !== 'require-project.js'; });
    assert.ok(DOTENV_CLIS.length >= 10, `premise — the dotenv-loading require-project CLIs were found (${DOTENV_CLIS.length})`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-dotenv-'));
    fs.writeFileSync(path.join(dir, '.env'), 'FIRESTORE_EMULATOR_HOST=evil.example:8080\n');
    // the arguments / env each needs to REACH client construction (a usage exit would prove nothing about the re-check)
    const ARGS2 = { 'stats-rollup.js': ['backfill', '--from', '2026-01-01', '--to', '2026-01-02'] };
    const ENV2 = { 'stats-rollup.js': { STATS_HMAC_SECRET: 'r1-census-dummy-secret-0123456789abcdef' } };
    const passed = [];
    try {
      for (const f of DOTENV_CLIS) {
        const x = observe([path.join(FN, 'tools', f), ...(ARGS2[f] || []), '--project', 'xpizza-delivery'], { GOOGLE_CLOUD_PROJECT: 'xpizza-delivery', ...(ENV2[f] || {}) }, { cwd: dir });
        refusedClean(x, `${f} with a .env that injects a foreign Firestore host AFTER its early check`);
        passed.push(f);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    ok(`test-ingest is emulator-only (a no-signal production run is refused); extras-export-live refuses even a coherent emulator env (production-only); ${passed.length} dotenv-loading require-project CLIs each refuse a .env-injected foreign emulator host at client construction, before any contact (${passed.join(', ')})`);
  }

  // 4. the LATENCY CHILD: portal-speed-proof's `node -e` children load index.js → lib/admin.js refuses mixed/foreign
  {
    for (const [shape, env] of [['HALF', MIXED], ['FOREIGN', FOREIGN]]) {
      const x = observe(['-e', "require('./index.js')"], { ...env, GCLOUD_PROJECT: 'demo-xpizza' });
      assert.ok(x.r.status !== 0 && /EmulatorEndpointError/.test(x.r.stderr) && !x.connects.length && !x.spawns.length, `🔴 the latency child shape under ${shape} did not refuse cleanly\n${x.r.stderr.slice(-500)}`);
    }
    ok('the latency child (index.js loaded under inherited env, as portal-speed-proof spawns it) refuses half-configured and foreign signals in lib/admin.js before any client');
  }
  // 6. codex r3 P2-2 — the client-construction hook FAILS CLOSED if firebase-admin's internals change
  {
    const run = (code) => observe(['-e', code], {});
    const realArm = run("console.log('ARMED', require('./tools/emu-mixed-guard').armClientRecheck('t'))");
    assert.match(realArm.r.stdout, /ARMED true/, `the hook arms on the installed firebase-admin\n${realArm.r.stderr}`);
    assert.deepStrictEqual([realArm.connects, realArm.spawns], [[], []], '🔴 arming (its self-test app) contacted or launched something');
    const renamed = run("require('./tools/emu-mixed-guard').armClientRecheck('t', { adminApp: { initializeApp: () => Object.create({ getOrInitServiceRenamed() {} }), deleteApp: async () => {} } }); console.log('NOT REFUSED')");
    assert.ok(renamed.r.status === 2 && /internals changed; the emulator-safety hook can't arm \(FirebaseApp\.getOrInitService is not a function\)/.test(renamed.r.stderr) && !/NOT REFUSED/.test(renamed.r.stdout), `🔴 a RENAMED initializer did not refuse the CLI\n${renamed.r.stderr}`);
    const unrouted = run("require('./tools/emu-mixed-guard').armClientRecheck('t', { accessors: { firestore: () => {}, database: () => {} } }); console.log('NOT REFUSED')");
    assert.ok(unrouted.r.status === 2 && /did not route through getOrInitService/.test(unrouted.r.stderr), `🔴 accessors that bypass getOrInitService did not refuse the CLI\n${unrouted.r.stderr}`);
    ok('the client-construction hook arms on the installed firebase-admin with zero contact and zero launches; a renamed initializer or accessors that bypass getOrInitService each REFUSE the CLI (exit 2, "firebase-admin internals changed")');
  }
  console.log(`\nendpoint-census: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('ENDPOINT CENSUS FAILED:', e && e.stack || e); process.exit(1); });
