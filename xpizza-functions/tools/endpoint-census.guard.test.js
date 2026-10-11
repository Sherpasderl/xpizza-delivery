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
const SUITE = /^xpizza-functions\/test\/[^/]+\.emulator\.test\.m?js$/;   // driven by emulator-ports.guard cell "all N emulator suites REFUSE"
const D = {
  // emulator-only harnesses — strict validator before any client (driven below: no signal / foreign / half-configured)
  [F('test/d4p1-capture-order-control.js')]: 'harness', [F('deploy/emulator-e2e.js')]: 'harness', [F('deploy/config-read-probe.js')]: 'harness',
  [F('deploy/check-seed-readiness.js')]: 'harness', [F('deploy/emu-seed.js')]: 'harness', [F('tools/menus-identity-publish.js')]: 'harness',
  [F('test/portal-emulator-workers.probe.js')]: 'harness', [F('test/_kds-writer-worker.js')]: 'harness', [F('test/emu-isolation.proof.js')]: 'harness',
  [F('test/measure-identity-fence.js')]: 'harness',
  // KDS parent: self-launches the runner when NO signal is present (by design) — driven with foreign + half-configured
  [F('kds-manifest-writer.test.mjs')]: 'harness-selflaunch',
  // the latency child: `node -e` children that load index.js — guarded by lib/admin.js (driven: its child shape)
  [F('tools/portal-speed-proof.js')]: 'latency-parent',
  // operator CLIs — tools/require-project.js runs the mixed-signal guard (driven: mixed ⇒ refuse)
  ...Object.fromEntries(['backfill-identities', 'backfill-snapshot', 'bootstrap-identity', 'client-floor', 'client-version-report',
    'draft-drift-report', 'menus-divergence-report', 'migrate-catalog-display', 'order-control', 'preflight-pointers', 'publish-version',
    'rollback-version', 'seed-catalog', 'seed-owner', 'seed-source-store', 'stats-rollup', 'verify-catalog'].map((t) => [F(`tools/${t}.js`), 'prod-cli'])),
  // functions-root production scripts — tools/emu-mixed-guard.js before initializeApp (driven: mixed ⇒ refuse)
  [F('publish-menus.mjs')]: 'prod-script', [F('seed-kitchen-staff.mjs')]: 'prod-script', [F('seed_identity.js')]: 'prod-script',
  [F('scripts/backfill-driver-push.js')]: 'prod-script', [F('scripts/test-ingest.js')]: 'prod-script', [F('ready-time-quality-run.js')]: 'prod-script',
  // deployed / library code (not executables on their own)
  [F('lib/admin.js')]: 'lib: the deployed Admin app — validator in its emulator branch (emulator-endpoint.test cells 1-8)',
  [F('lib/emulator-endpoint.js')]: 'lib: the validator itself', [F('deploy/emu-ns.js')]: 'lib: emuDatabaseURL → validateRtdbUrl (strict)',
  [F('test/_emulator-required.js')]: 'lib: the suite/harness guard', [F('tools/emu-mixed-guard.js')]: 'lib: the CLI mixed-signal guard',
  [F('tools/require-project.js')]: 'lib: project guard + mixed-signal guard', [F('tools/emulator-run.js')]: 'lib: the launcher',
  [F('tools/emu-cmd-wrapper.js')]: 'lib: the marked suite wrapper — spawned only by the launcher; reads the run\'s own Firestore host to load its rules (emu-alloc.test cell 10 + the real proof)',
  [F('index.js')]: 'lib: the deployed entry — its Admin app is lib/admin.js (guarded)', [F('portal/functions.js')]: 'lib: the deployed portal entry — lib/admin.js',
  [F('portal/reset-draft.js')]: 'lib: deployed portal module — lib/admin.js',
  [F('cors-preflight.test.js')]: 'unit: proven loopback-only, off-band (emulator-endpoint.test cell 8)',
  [F('tools/portal-split.js')]: 'lib: source-TEXT fold (the initializeApp is a string it rewrites, no runtime Admin)',
  [F('tools/deploy-env-guard.js')]: 'lib: reads deploy env KEY NAMES only, no client',
  [F('tools/portal-latency-probe.js')]: 'prod-measurement: HTTP to the DEPLOYED functions by design (token-authenticated); no Admin client, emulator vars do not reach it',
  // tests that never contact a database (fakes / stubs / text), each verified
  [F('rtdb-init.test.js')]: 'unit: proven loopback-only, off-band (emulator-endpoint.test cell 8)',
  [F('stats/stats-volume.test.js')]: 'unit: a named app over catalog/firestore-fake — no network',
  [F('stats/stats-job.test.js')]: 'unit: initializeApp appears in a source string under test', [F('catalog/project-guard.test.js')]: 'unit: drives require-project refusals (no data I/O)',
  [F('test/kds-writer-capture.mjs')]: 'unit: a STUB initializeApp (returns {})', [F('portal/portal-split.test.js')]: 'unit: fold-guard text',
  [F('pselfupdate-client.test.js')]: 'unit: injected fetch, no network', [F('pselfupdate-wrapper-lint.test.js')]: 'unit: lints source text',
  'order-control-client.test.mjs': 'unit: injected fetch, no network',
  [F('tools/emulator-endpoint.test.js')]: 'test of this guard family', [F('tools/emulator-ports.guard.test.js')]: 'test of this guard family',
  [F('tools/deploy-env-guard.test.js')]: 'test of this guard family', [F('tools/endpoint-census.guard.test.js')]: 'this file',
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

  // 4. the LATENCY CHILD: portal-speed-proof's `node -e` children load index.js → lib/admin.js refuses mixed/foreign
  {
    for (const [shape, env] of [['HALF', MIXED], ['FOREIGN', FOREIGN]]) {
      const x = observe(['-e', "require('./index.js')"], { ...env, GCLOUD_PROJECT: 'demo-xpizza' });
      assert.ok(x.r.status !== 0 && /EmulatorEndpointError/.test(x.r.stderr) && !x.connects.length && !x.spawns.length, `🔴 the latency child shape under ${shape} did not refuse cleanly\n${x.r.stderr.slice(-500)}`);
    }
    ok('the latency child (index.js loaded under inherited env, as portal-speed-proof spawns it) refuses half-configured and foreign signals in lib/admin.js before any client');
  }
  console.log(`\nendpoint-census: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('ENDPOINT CENSUS FAILED:', e && e.stack || e); process.exit(1); });
