'use strict';
/* R1 — the run-endpoint validator (lib/emulator-endpoint.js) and lib/admin.js's emulator branch.
 *
 * Covers the advisor/codex conditions directly:
 *   · P2-3   a DB-only SUITE (host vars, FUNCTIONS_EMULATOR absent) takes the validated emulator branch;
 *            discovery's shape (FUNCTIONS_EMULATOR + host vars, no offset) validates in-range.
 *   · P2-4   lib/admin.js's prod init is byte-unchanged and the validator is NOT loaded without a signal;
 *            no network at import across the discovery entry graph (index.js full load + the portal entry),
 *            plus cors-preflight.test.js and rtdb-init.test.js BY NAME.
 *   · MIXED  every half-configured combination REFUSES; never a prod fall-back for the unset half.
 *   · NULL   only the exact "127.0.0.1:1"; invalid for a started service; accidental use fails FAST (bounded,
 *            asserted) — measured without the guard: Firestore ~46 s, RTDB never.
 * Everything here runs the REAL lib/admin.js / index.js in child processes — no hand-built stand-ins.
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EE = require('../lib/emulator-endpoint');
const { validateEmulatorEnv, NULL_ENDPOINT, planPorts, EmulatorEndpointError, hasEmulatorSignal } = EE;
const NO_CONNECT = path.join(ROOT, 'tools', 'no-connect.js');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

/* A child's env with NO inherited emulator/run state: whatever the parent shell (or a gate's emulator) carries must
   not decide these cells. NODE_OPTIONS stripped of gate-all's count-marks preload (a spawned child inheriting it
   prints ##CELLS into stdout we parse). */
const SCRUB = ['FUNCTIONS_EMULATOR', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_FIRESTORE_EMULATOR_ADDRESS', 'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_EMULATOR_HUB', 'XPIZZA_EMU_OFFSET', 'XPIZZA_EMU_SERVICES', 'XPIZZA_EMU_DEAD', 'XPIZZA_EMU_RUN', 'FUNCTION_TARGET',
  'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_EVENTARC_EMULATOR_HOST', 'CLOUD_TASKS_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST'];
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  if (env.NODE_OPTIONS) env.NODE_OPTIONS = env.NODE_OPTIONS.replace(/--require[= ]\S*count-marks\.js/g, '').trim();
  if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;
  return { ...env, GCLOUD_PROJECT: 'demo-xpizza', ...extra };
}
const node = (code, extra, opts = {}) => spawnSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8', timeout: opts.timeout || 30000, env: cleanEnv(extra) });

const OFF = 70;                                   // an arbitrary in-range slot for synthetic envs
const P = planPorts(OFF);
const lo = (port) => `127.0.0.1:${port}`;
const refuses = (env, re, label) => {
  assert.throws(() => validateEmulatorEnv(env), (e) => e instanceof EmulatorEndpointError && (!re || re.test(e.message)), `🔴 NOT refused: ${label}`);
};

(async () => {
  // ── 1. lib/admin.js: the prod init is the original text; the guard is a prefix; the signal list is the validator's ──
  {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'admin.js'), 'utf8');
    const ORIGINAL_INIT = "initializeApp({\n  databaseURL: 'https://xpizza-delivery-default-rtdb.firebaseio.com'\n});\n";
    assert.ok(src.endsWith(ORIGINAL_INIT), '🔴 lib/admin.js no longer ENDS with the original, unconditional prod init');
    assert.strictEqual(src.split('initializeApp({').length - 1, 1, '🔴 lib/admin.js has more than one init — a second code path to production');
    const guardLine = src.slice(src.indexOf('if (process.env.FUNCTIONS_EMULATOR'), src.indexOf(ORIGINAL_INIT));
    const inlineVars = [...guardLine.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(inlineVars, ['FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB', 'FIREBASE_FIRESTORE_EMULATOR_ADDRESS', 'FIRESTORE_EMULATOR_HOST', 'FUNCTIONS_EMULATOR'],
      '🔴 lib/admin.js\'s inline signal list drifted from the validator\'s');
    for (const v of inlineVars) assert.ok(hasEmulatorSignal({ [v]: 'x' }), `🔴 the validator does not treat ${v} as a signal but lib/admin.js does`);
    assert.ok(!hasEmulatorSignal({}), 'premise — no vars, no signal');
    assert.match(guardLine, /require\('\.\/emulator-endpoint'\)\.guardEmulatorProcess\(\);\n\n$/, '🔴 the guard must run BEFORE the init and only inside the signal branch');
    ok('lib/admin.js ends with the ORIGINAL prod init (once); the R1 guard is a signal-gated prefix whose var list equals the validator\'s');
  }

  // ── 2. P2-4: production (no signal) — the validator is NOT loaded, the app is the original one ──────────
  {
    const r = node(`require('./lib/admin');
      const { getApp } = require('firebase-admin/app');
      const loaded = Object.keys(require.cache).some((k) => k.endsWith('/lib/emulator-endpoint.js'));
      console.log(JSON.stringify({ loaded, url: getApp().options.databaseURL, name: getApp().name }));`, {});
    assert.strictEqual(r.status, 0, `prod-mode import failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepStrictEqual(out, { loaded: false, url: 'https://xpizza-delivery-default-rtdb.firebaseio.com', name: '[DEFAULT]' },
      '🔴 production mode loaded the validator or changed the app');
    // duplicate-app behaviour preserved: a second default init still throws exactly as firebase-admin does
    const d = node(`require('./lib/admin'); try { require('firebase-admin/app').initializeApp({}); console.log('NO-THROW'); } catch (e) { console.log(e.code || e.message); }`, {});
    assert.match(d.stdout, /app\/duplicate-app/, '🔴 duplicate-app behaviour changed');
    ok('no signal ⇒ prod: lib/emulator-endpoint.js never loaded (zero extra cold-start work), [DEFAULT] app with the prod URL, duplicate-app still throws');
  }

  // ── 3. P2-3 + discovery: the shapes Firebase really produces validate ───────────────────────────────
  {
    // a DB-only SUITE: host vars only (no FUNCTIONS_EMULATOR), Firestore NULL (launcher-filled), slot known
    const dbOnly = { FIREBASE_DATABASE_EMULATOR_HOST: lo(P.database), FIRESTORE_EMULATOR_HOST: NULL_ENDPOINT, XPIZZA_EMU_OFFSET: String(OFF), XPIZZA_EMU_SERVICES: 'database', FIREBASE_EMULATOR_HUB: lo(P.hub) };
    const v = validateEmulatorEnv(dbOnly);
    assert.deepStrictEqual(v.nulls, ['firestore']);
    // discovery: FUNCTIONS_EMULATOR + both real hosts, NO offset / services (discovery's env is not process.env)
    const disc = { FUNCTIONS_EMULATOR: 'true', FIRESTORE_EMULATOR_HOST: lo(P.firestore), FIREBASE_FIRESTORE_EMULATOR_ADDRESS: lo(P.firestore), FIREBASE_DATABASE_EMULATOR_HOST: lo(P.database), FIREBASE_EMULATOR_HUB: lo(P.hub) };
    assert.deepStrictEqual(validateEmulatorEnv(disc).nulls, []);
    // and through the REAL lib/admin.js in a child: the DB-only suite shape takes the validated branch
    const r = node(`require('./lib/admin'); console.log(Object.keys(require.cache).some((k) => k.endsWith('/lib/emulator-endpoint.js')) ? 'VALIDATED' : 'SKIPPED');`, dbOnly);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /VALIDATED/, '🔴 a DB-only suite (no FUNCTIONS_EMULATOR) did not take the validated emulator branch');
    ok('P2-3: a DB-only suite (host vars, FUNCTIONS_EMULATOR absent) validates through the real lib/admin.js; discovery\'s shape (flag + hosts, no offset) validates in-range');
  }

  // ── 4. MIXED SIGNALS REFUSE — every half-configured combination, never a prod fall-back ───────────────
  {
    const FS = lo(P.firestore), DB = lo(P.database);
    const cases = [
      [{ FIRESTORE_EMULATOR_HOST: FS }, /FIREBASE_DATABASE_EMULATOR_HOST is not set/, 'Firestore host only'],
      [{ FIREBASE_DATABASE_EMULATOR_HOST: DB }, /FIRESTORE_EMULATOR_HOST is not set/, 'RTDB host only'],
      [{ FIREBASE_FIRESTORE_EMULATOR_ADDRESS: FS }, /FIRESTORE_EMULATOR_HOST is not set/, 'Firestore ALIAS only'],
      [{ FIREBASE_EMULATOR_HUB: lo(P.hub) }, /is not set/, 'hub only'],
      [{ FUNCTIONS_EMULATOR: 'true' }, /is not set/, 'FUNCTIONS_EMULATOR alone'],
      [{ FUNCTIONS_EMULATOR: 'true', FIRESTORE_EMULATOR_HOST: FS }, /FIREBASE_DATABASE_EMULATOR_HOST is not set/, 'flag + Firestore, no RTDB'],
      [{ FUNCTIONS_EMULATOR: 'true', FIREBASE_DATABASE_EMULATOR_HOST: DB }, /FIRESTORE_EMULATOR_HOST is not set/, 'flag + RTDB, no Firestore'],
      [{ FIRESTORE_EMULATOR_HOST: FS, FIREBASE_DATABASE_EMULATOR_HOST: DB, FIREBASE_FIRESTORE_EMULATOR_ADDRESS: lo(P.firestore + 10) }, /disagrees/, 'alias disagrees with primary'],
      [{ FUNCTIONS_EMULATOR: '1', FIRESTORE_EMULATOR_HOST: FS, FIREBASE_DATABASE_EMULATOR_HOST: DB }, /only "true"/, 'FUNCTIONS_EMULATOR not "true"'],
      [{}, /no emulator signal/, 'no signal at all (validator called directly)'],
    ];
    for (const [env, re, label] of cases) refuses(env, re, label);
    // and the REAL lib/admin.js refuses each half-configured case BEFORE creating any app
    for (const [env, , label] of cases.slice(0, 7)) {
      const r = node(`try { require('./lib/admin'); } catch (e) { console.log('THREW', e.name); }
        console.log('APPS', require('firebase-admin/app').getApps().length);`, env);
      assert.match(r.stdout, /THREW EmulatorEndpointError/, `🔴 lib/admin.js did not refuse: ${label}\n${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /APPS 0/, `🔴 lib/admin.js created an app (prod URL) despite refusing: ${label}`);
    }
    ok(`${cases.length} half-configured / malformed signal combinations REFUSE; the real lib/admin.js throws before creating ANY app on all 7 half-configured ones`);
  }

  // ── 5. FOREIGN / MALFORMED ENDPOINTS + THE NULL STRING IS EXACT ─────────────────────────────────────
  {
    const base = { FIRESTORE_EMULATOR_HOST: lo(P.firestore), FIREBASE_DATABASE_EMULATOR_HOST: lo(P.database), XPIZZA_EMU_OFFSET: String(OFF) };
    assert.ok(validateEmulatorEnv(base), 'premise — the base env is valid');
    const bad = [
      ['FIRESTORE_EMULATOR_HOST', '0.0.0.0:' + P.firestore, 'wildcard 0.0.0.0'],
      ['FIRESTORE_EMULATOR_HOST', '127.0.0.1.example.test:' + P.firestore, 'suffix host'],
      ['FIRESTORE_EMULATOR_HOST', '10.0.0.5:' + P.firestore, 'non-loopback'],
      ['FIRESTORE_EMULATOR_HOST', 'firestore.googleapis.com:443', 'production host'],
      ['FIRESTORE_EMULATOR_HOST', lo(P.firestore + 10), 'another slot (foreign checkout)'],
      ['FIRESTORE_EMULATOR_HOST', lo(8079), 'below the band'],
      ['FIRESTORE_EMULATOR_HOST', lo(P.database), 'the RTDB port for Firestore'],
      ['FIREBASE_DATABASE_EMULATOR_HOST', lo(P.database + 1), 'off-step port'],
      ['FIREBASE_DATABASE_EMULATOR_HOST', '127.0.0.1', 'no port'],
      ['FIREBASE_DATABASE_EMULATOR_HOST', '127.0.0.1:0' + P.database, 'leading-zero port'],
      ['FIREBASE_EMULATOR_HUB', lo(P.hub + 10), 'a foreign hub'],
      ['XPIZZA_EMU_OFFSET', '75', 'off-step offset'],
      ['XPIZZA_EMU_OFFSET', '400', 'offset out of range'],
      // the NULL endpoint is EXACT — none of these are it, and none are on a band either
      ['FIRESTORE_EMULATOR_HOST', 'localhost:1', 'NULL spelled localhost:1'],
      ['FIRESTORE_EMULATOR_HOST', '[::1]:1', 'NULL spelled [::1]:1'],
      ['FIRESTORE_EMULATOR_HOST', '127.0.0.1:01', 'NULL spelled 127.0.0.1:01'],
      ['FIRESTORE_EMULATOR_HOST', '0.0.0.0:1', 'NULL spelled 0.0.0.0:1'],
      ['FIREBASE_DATABASE_EMULATOR_HOST', ' 127.0.0.1:1', 'NULL with whitespace'],
    ];
    for (const [k, v, label] of bad) refuses({ ...base, [k]: v }, null, label);
    // without an offset (discovery) a foreign SLOT is in-range by design — but still never off-band/non-loopback
    assert.ok(validateEmulatorEnv({ FUNCTIONS_EMULATOR: 'true', FIRESTORE_EMULATOR_HOST: lo(P.firestore + 10), FIREBASE_DATABASE_EMULATOR_HOST: lo(P.database) }));
    ok(`${bad.length} foreign / malformed endpoints refuse, incl. the 5 near-miss NULL spellings (localhost:1, [::1]:1, 127.0.0.1:01, 0.0.0.0:1, padded)`);
  }

  // ── 6. NULL is invalid for a STARTED service, unless the suite declared it deliberately dead ──────────
  {
    const both = { FIRESTORE_EMULATOR_HOST: NULL_ENDPOINT, FIREBASE_DATABASE_EMULATOR_HOST: lo(P.database), XPIZZA_EMU_OFFSET: String(OFF) };
    refuses({ ...both, XPIZZA_EMU_SERVICES: 'firestore,database' }, /cannot be both real and null/, 'NULL for a started service');
    assert.deepStrictEqual(validateEmulatorEnv({ ...both, XPIZZA_EMU_SERVICES: 'firestore,database', XPIZZA_EMU_DEAD: 'firestore' }).dead, ['firestore']);
    refuses({ ...both, XPIZZA_EMU_SERVICES: 'database', FIRESTORE_EMULATOR_HOST: lo(P.firestore) }, /did NOT start/, 'a real endpoint for a service the run did not start');
    refuses({ ...both, XPIZZA_EMU_DEAD: 'database' }, /not the NULL endpoint/, 'DEAD declared on a real endpoint');
    refuses({ ...both, XPIZZA_EMU_DEAD: 'auth' }, /not a data service/, 'DEAD naming a non-data service');
    ok('NULL for a started service refuses; XPIZZA_EMU_DEAD is the only opt-in and must itself be consistent; a real endpoint for an unstarted service refuses');
  }

  // ── 7. ACCIDENTAL NULL USE FAILS FAST — bounded and asserted, through the REAL lib/admin.js ─────────────
  {
    const BOUND_MS = 3000;
    const nullEnv = (svc) => ({
      FIRESTORE_EMULATOR_HOST: svc === 'firestore' ? NULL_ENDPOINT : lo(P.firestore),
      FIREBASE_DATABASE_EMULATOR_HOST: svc === 'database' ? NULL_ENDPOINT : lo(P.database),
      XPIZZA_EMU_OFFSET: String(OFF), XPIZZA_EMU_SERVICES: svc === 'firestore' ? 'database' : 'firestore',
    });
    const CALL = {
      firestore: `require('firebase-admin/firestore').getFirestore().doc('a/b').get()`,
      database: `require('firebase-admin/database').getDatabase().ref('a').once('value')`,
    };
    for (const svc of ['firestore', 'database']) {
      const t0 = Date.now();
      const r = node(`require('./lib/admin'); const t = Date.now();
        Promise.resolve().then(() => ${CALL[svc]}).then(() => console.log('RESOLVED'), (e) => console.log('ERR', e.name, Date.now() - t));`, nullEnv(svc), { timeout: 20000 });
      const wall = Date.now() - t0;
      assert.strictEqual(r.signal, null, `🔴 NULL ${svc}: the call HUNG until the ${20000} ms kill — no fast failure`);
      const m = /ERR EmulatorEndpointError (\d+)/.exec(r.stdout);
      assert.ok(m, `🔴 NULL ${svc}: one call did not fail with the NULL guard error\n${r.stdout}${r.stderr}`);
      assert.ok(Number(m[1]) < BOUND_MS, `🔴 NULL ${svc}: failed after ${m[1]} ms (bound ${BOUND_MS})`);
      assert.ok(wall < 15000, `NULL ${svc}: process wall ${wall} ms`);
    }
    // the declared-dead opt-in keeps the real SDK (a dead-backend test measures exactly that): getFirestore() constructs
    const dead = node(`require('./lib/admin'); require('firebase-admin/firestore').getFirestore(); console.log('CONSTRUCTED');`,
      { ...nullEnv('firestore'), XPIZZA_EMU_SERVICES: 'firestore,database', XPIZZA_EMU_DEAD: 'firestore' });
    assert.match(dead.stdout, /CONSTRUCTED/, `🔴 a declared-dead service was guarded: ${dead.stderr}`);
    ok(`accidental use of the NULL Firestore and the NULL RTDB each fails within ${BOUND_MS} ms with the guard error (unguarded: ~46 s / never); a DECLARED-dead service is left to the real SDK`);
  }

  // ── 8. P2-4: NO NETWORK AT IMPORT over the discovery entry graph, + two named tests ────────────────────
  {
    const runRec = (args, extra) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-noconnect-'));
      try {
        const env = cleanEnv({ ...extra, NO_CONNECT_DIR: dir });
        env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require ${NO_CONNECT}`.trim();
        const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 120000, env });
        const recs = fs.readdirSync(dir).filter((f) => f.endsWith('.rec')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean));
        return { r, recs, connects: recs.flatMap((l) => l.filter((x) => x.startsWith('CONNECT ')).map((x) => x.slice(8))), spawns: recs.flatMap((l) => l.filter((x) => x.startsWith('SPAWN '))) };
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };
    const IMPORT = (entry) => ['-e', `require(${JSON.stringify(entry)}); setTimeout(() => process.exit(0), 1500);`];
    const discoveryEnv = { FUNCTIONS_EMULATOR: 'true', FIRESTORE_EMULATOR_HOST: lo(P.firestore), FIREBASE_DATABASE_EMULATOR_HOST: lo(P.database), FIREBASE_EMULATOR_HUB: lo(P.hub) };
    const graphs = [
      ['index.js full load, NO signal (prod branch)', IMPORT('./index.js'), {}],
      ['index.js full load, discovery env (emulator branch)', IMPORT('./index.js'), discoveryEnv],
      ['portal entry (FUNCTION_TARGET=getEditableCatalog), NO signal', IMPORT('./index.js'), { FUNCTION_TARGET: 'getEditableCatalog' }],
      ['portal entry, discovery env', IMPORT('./index.js'), { ...discoveryEnv, FUNCTION_TARGET: 'publishEdited' }],
    ];
    for (const [label, args, extra] of graphs) {
      const x = runRec(args, extra);
      assert.strictEqual(x.r.status, 0, `${label}: import failed\n${x.r.stderr.slice(-800)}`);
      assert.ok(x.recs.length >= 1 && x.recs.every((l) => l.some((s) => s.startsWith('EXIT '))), `🔴 ${label}: no complete no-connect record — nothing observed the import`);
      assert.deepStrictEqual(x.connects, [], `🔴 ${label}: network attempt(s) at import: ${x.connects.join(', ')}`);
      assert.deepStrictEqual(x.spawns, [], `🔴 ${label}: process launch at import: ${x.spawns.join(', ')}`);
    }
    if (graphs[2]) {
      const portal = runRec(IMPORT('./index.js'), { FUNCTION_TARGET: 'getEditableCatalog' });
      assert.match(portal.r.stdout, /portal_isolated_entry getEditableCatalog/, 'premise — the portal entry branch really ran');
    }
    /* The two tests the sweep classified SAFE although they import index.js / lib/admin — asserted, not argued. Their only
       permitted contact is LOOPBACK (cors-preflight drives its own in-process http server); never a Google host, never an
       emulator band port, never port 443. */
    const BAND_PORTS = new Set();
    for (let s = 0; s < EE.SLOTS; s++) for (const p of Object.values(planPorts(s * EE.STEP))) BAND_PORTS.add(p);
    for (const t of ['cors-preflight.test.js', 'rtdb-init.test.js']) {
      const x = runRec([t], {});
      assert.strictEqual(x.r.status, 0, `${t} failed under the observer\n${x.r.stderr.slice(-800)}`);
      assert.ok(x.recs.length >= 1 && x.recs.every((l) => l.some((s) => s.startsWith('EXIT '))), `🔴 ${t}: no complete no-connect record`);
      // non-vacuity: cors-preflight really does contact its own loopback server, so the observer must SEE it
      if (t === 'cors-preflight.test.js') assert.ok(x.connects.length > 0, '🔴 premise — the observer saw none of cors-preflight\'s own loopback fetches');
      for (const c of x.connects) {
        const m = /^(?:fetch\(http:\/\/)?(127\.0\.0\.1|localhost|\[?::1\]?)[:/](\d+)/.exec(c);
        assert.ok(m, `🔴 ${t}: NON-loopback contact ${c}`);
        assert.ok(!BAND_PORTS.has(Number(m[2])) && Number(m[2]) !== 443, `🔴 ${t}: contacted an emulator band / TLS port ${c}`);
      }
      assert.deepStrictEqual(x.spawns, [], `🔴 ${t}: launched a process`);
    }
    ok('no network and no launch at import: index.js full load + the portal entry, each with no signal AND with the discovery env; cors-preflight.test.js + rtdb-init.test.js run with loopback-only, off-band contact');
  }

  console.log(`\nemulator-endpoint: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('emulator-endpoint FAILED:', e && e.stack || e); process.exit(1); });
