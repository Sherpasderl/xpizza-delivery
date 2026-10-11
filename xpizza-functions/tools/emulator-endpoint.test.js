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
    for (const v of inlineVars) assert.ok(hasEmulatorSignal({ [v]: v === 'FUNCTIONS_EMULATOR' ? 'true' : 'x' }), `🔴 the validator does not treat ${v} as a signal but lib/admin.js does`);
    assert.match(guardLine, /process\.env\.FUNCTIONS_EMULATOR === 'true'/, '🔴 lib/admin.js treats a FUNCTIONS_EMULATOR other than exactly "true" as a signal — a deployed "false" would throw');
    assert.ok(!hasEmulatorSignal({ FUNCTIONS_EMULATOR: 'false' }) && !hasEmulatorSignal({ FUNCTIONS_EMULATOR: '1' }), '🔴 the validator treats a non-"true" FUNCTIONS_EMULATOR as a signal');
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
    /* 🔴 PRODUCTION (codex R1-build ruling): a deployed FUNCTIONS_EMULATOR that is not exactly "true" is NOT a signal —
       it must take the production path, never throw. Driven through the REAL lib/admin.js for each such value. */
    for (const v of ['false', '0', '1', 'TRUE', 'yes', ' true']) {
      const r2 = node(`require('./lib/admin');
        const loaded = Object.keys(require.cache).some((k) => k.endsWith('/lib/emulator-endpoint.js'));
        console.log(JSON.stringify({ loaded, url: require('firebase-admin/app').getApp().options.databaseURL }));`, { FUNCTIONS_EMULATOR: v });
      assert.strictEqual(r2.status, 0, `🔴 FUNCTIONS_EMULATOR=${JSON.stringify(v)} made the production import THROW:\n${r2.stderr}`);
      assert.deepStrictEqual(JSON.parse(r2.stdout.trim().split('\n').pop()), { loaded: false, url: 'https://xpizza-delivery-default-rtdb.firebaseio.com' },
        `🔴 FUNCTIONS_EMULATOR=${JSON.stringify(v)} did not take the unchanged production path`);
    }
    ok('no signal ⇒ prod: lib/emulator-endpoint.js never loaded (zero extra cold-start work), [DEFAULT] app with the prod URL, duplicate-app still throws; FUNCTIONS_EMULATOR=false/0/1/TRUE/yes/" true" each take the PROD path and do not throw');
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
    refuses({ ...both, XPIZZA_EMU_SERVICES: 'firestore,database', FIRESTORE_EMULATOR_HOST: lo(P.firestore), XPIZZA_EMU_DEAD: 'firestore' }, /not the NULL endpoint/, 'DEAD declared on a real endpoint');
    for (const bad of ['database', 'auth', 'firestore,database', 'Firestore', ' firestore', 'firestore ', '1', 'true']) {
      refuses({ ...both, XPIZZA_EMU_DEAD: bad }, /only accepted value is "firestore"/, `XPIZZA_EMU_DEAD=${JSON.stringify(bad)} (fail closed — only the exact "firestore")`);
    }
    ok('NULL for a started service refuses; XPIZZA_EMU_DEAD accepts ONLY the exact "firestore" (8 other values fail closed) and must match a NULL endpoint; a real endpoint for an unstarted service refuses');
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

  // ── 10. P2-6: THE PROJECT / FIREBASE_CONFIG CONTRACT ──────────────────────────────────────────────────────────
  {
    const base = { FIRESTORE_EMULATOR_HOST: lo(P.firestore), FIREBASE_DATABASE_EMULATOR_HOST: lo(P.database), XPIZZA_EMU_OFFSET: String(OFF), GCLOUD_PROJECT: 'demo-xpizza' };
    const cfg = (o) => JSON.stringify(o);
    // positives: the CLI's suite shape and discovery/worker shape
    assert.strictEqual(validateEmulatorEnv({ ...base, FIREBASE_CONFIG: cfg({ projectId: 'demo-xpizza', databaseURL: 'https://demo-xpizza.firebaseio.com' }) }).project, 'demo-xpizza');
    assert.ok(validateEmulatorEnv({ ...base, FIREBASE_CONFIG: cfg({ projectId: 'demo-xpizza', databaseURL: `http://127.0.0.1:${P.database}/?ns=xpizza-delivery-default-rtdb` }) }));
    const bad = [
      [{ GOOGLE_CLOUD_PROJECT: 'xpizza-delivery' }, /disagree/, 'GCLOUD_PROJECT ≠ GOOGLE_CLOUD_PROJECT'],
      [{ FIREBASE_CONFIG: cfg({ projectId: 'xpizza-delivery' }) }, /disagree/, 'a PRODUCTION FIREBASE_CONFIG.projectId'],
      [{ FIREBASE_CONFIG: cfg({ projectId: 'demo-xpizza', databaseURL: 'https://xpizza-delivery-default-rtdb.firebaseio.com' }) }, /neither/, 'another project\'s databaseURL'],
      [{ FIREBASE_CONFIG: cfg({ projectId: 'demo-xpizza', databaseURL: `http://127.0.0.1:${P.database + 10}/?ns=x` }) }, /not this run's database port/, 'a loopback databaseURL on another slot'],
      [{ FIREBASE_CONFIG: cfg({ projectId: 'demo-xpizza', databaseURL: 'https://evil.example' }) }, /neither/, 'a foreign databaseURL'],
      [{ FIREBASE_CONFIG: '{not json' }, /does not parse/, 'an unparseable FIREBASE_CONFIG'],
    ];
    for (const [extra, re, label] of bad) refuses({ ...base, ...extra }, re, label);
    // the functions URL must be THIS run's project path
    const fnOk = `http://127.0.0.1:${P.functions}/demo-xpizza/us-central1/createOrder`;
    assert.ok(EE.validateFunctionsUrl(fnOk, base));
    assert.throws(() => EE.validateFunctionsUrl(`http://127.0.0.1:${P.functions}/xpizza-delivery/us-central1/createOrder`, base), /not under this run's project path/, '🔴 another project\'s functions path was accepted');
    assert.throws(() => EE.validateFunctionsUrl(fnOk, { ...base, GCLOUD_PROJECT: '' }), /no project is stated/);
    ok(`P2-6: project vars must agree and FIREBASE_CONFIG must name this run's database (loopback band) or the same project's own URL — ${bad.length} incoherent shapes refuse; a functions URL under another project's path refuses`);
  }

  // ── 9. P1-A + §c.1: EVERY HARNESS refuses BEFORE any client/HTTP — missing signal, foreign, half-configured ──
  {
    /* Each harness is driven for real, under the no-connect observer, and must refuse as ONE process with a clean
       nonzero exit, zero connection attempts and zero launches. Its refusal must precede require('../index.js'):
       with no signal lib/admin.js takes the PRODUCTION branch, which is the whole point of P1-A. */
    const runRec = (args, extra) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-harness-'));
      try {
        const env = cleanEnv({ ...extra, NO_CONNECT_DIR: dir });
        env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require ${NO_CONNECT}`.trim();
        const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 60000, env });
        const recs = fs.readdirSync(dir).filter((f) => f.endsWith('.rec')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean));
        return { r, recs, connects: recs.flatMap((l) => l.filter((x) => x.startsWith('CONNECT '))), spawns: recs.flatMap((l) => l.filter((x) => x.startsWith('SPAWN '))) };
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };
    const PROD_FN = 'https://us-central1-xpizza-delivery.cloudfunctions.net/createOrder';
    const good = { FIRESTORE_EMULATOR_HOST: lo(P.firestore), FIREBASE_DATABASE_EMULATOR_HOST: lo(P.database), XPIZZA_EMU_OFFSET: String(OFF), FIREBASE_EMULATOR_HUB: lo(P.hub) };
    const HARNESSES = [
      ['test/d4p1-capture-order-control.js', {}],
      ['deploy/emulator-e2e.js', { CREATEORDER_URL: `http://127.0.0.1:${P.functions}/demo-xpizza/us-central1/createOrder` }],
      ['deploy/config-read-probe.js', { CREATEORDER_URL: `http://127.0.0.1:${P.functions}/demo-xpizza/us-central1/createOrder`, INTAKE_SECRET: 's', PROBE_STAMP: 'r1-stamp-0123456789abcdef' }],
      ['test/portal-emulator-workers.probe.js', {}],
      ['test/preparing-ready.emulator.test.js', {}],
    ];
    const SHAPES = [
      ['NO emulator signal', () => ({})],
      ['a FOREIGN host', () => ({ ...good, FIRESTORE_EMULATOR_HOST: 'evil.example:8080', FIREBASE_DATABASE_EMULATOR_HOST: 'evil.example:9000' })],
      ['HALF-configured (RTDB only)', () => ({ FIREBASE_DATABASE_EMULATOR_HOST: lo(P.database), XPIZZA_EMU_OFFSET: String(OFF) })],
    ];
    let driven = 0;
    for (const [file, extra] of HARNESSES) {
      for (const [shape, env] of SHAPES) {
        const x = runRec([file], { ...extra, ...env() });
        const label = `${file} under ${shape}`;
        assert.ok(typeof x.r.status === 'number' && x.r.status !== 0 && x.r.signal === null, `🔴 ${label}: did not refuse (exit ${x.r.status}, signal ${x.r.signal})\n${(x.r.stderr || '').slice(-600)}`);
        assert.match(x.r.stderr || '', /^[ \t]*(?:🔴 REFUSED —|🛑 REFUSING TO RUN —)/m, `🔴 ${label}: no anchored refusal banner\n${(x.r.stderr || '').slice(-600)}`);
        assert.ok(x.recs.length === 1, `🔴 ${label}: ${x.recs.length} process records — a refusal must be ONE observed process`);
        assert.deepStrictEqual(x.connects, [], `🔴 ${label}: contacted ${x.connects.join(', ')} before refusing`);
        assert.deepStrictEqual(x.spawns, [], `🔴 ${label}: launched ${x.spawns.join(', ')} before refusing`);
        driven += 1;
      }
    }
    // config-read-probe: a PROD Functions URL with valid emulator vars is refused before the fetch (non-vacuous: the
    // same env with a loopback URL gets PAST the guard and does attempt the fetch, so the guard is what stopped it)
    const prod = runRec(['deploy/config-read-probe.js'], { ...good, CREATEORDER_URL: PROD_FN, INTAKE_SECRET: 's', PROBE_STAMP: 'r1-stamp-0123456789abcdef' });
    assert.ok(prod.r.status !== 0 && /REFUSED — emulator endpoint: functions URL/.test(prod.r.stderr) && !prod.connects.length, `🔴 config-read-probe called (or did not refuse) a PROD Functions URL in emulator mode\n${prod.r.stderr}`);
    const past = runRec(['deploy/config-read-probe.js'], { ...good, CREATEORDER_URL: `http://127.0.0.1:${P.functions}/demo-xpizza/us-central1/createOrder`, INTAKE_SECRET: 's', PROBE_STAMP: 'r1-stamp-0123456789abcdef' });
    assert.ok(past.connects.some((c) => c.includes(`127.0.0.1:${P.functions}`)), `premise — with a valid loopback URL the probe gets PAST the guard to its fetch (${past.connects.join(', ') || 'no contact'})`);
    const both = runRec(['deploy/config-read-probe.js'], { ...good, PROBE_TARGET: 'prod', CREATEORDER_URL: PROD_FN, INTAKE_SECRET: 's', PROBE_STAMP: 'r1-stamp-0123456789abcdef' });
    assert.ok(both.r.status !== 0 && /mixed signals/.test(both.r.stderr) && !both.connects.length, '🔴 PROBE_TARGET=prod WITH emulator vars was not refused');
    ok(`P1-A/§c.1: ${HARNESSES.length} harnesses × ${SHAPES.length} shapes (${driven} runs) each REFUSE as one process with zero contact and zero launches; config-read-probe refuses a PROD Functions URL in emulator mode before its fetch (the loopback control does reach its fetch) and refuses prod+emulator mixed signals`);
  }

  console.log(`\nemulator-endpoint: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('emulator-endpoint FAILED:', e && e.stack || e); process.exit(1); });
