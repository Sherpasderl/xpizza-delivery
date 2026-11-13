'use strict';
// PLAN-photos-public-bucket-config r5 §2/§7 — the photos config through the REAL loader / resolver / consumer wiring, each scenario in a
// fresh child (the loader memoizes per process) under tools/egress-guard.js (loopback only), the fixture preloaded by the TEST-OWNED
// test/_photos-config-fixture.js where a scenario needs one:
//   1 configured demo-xpizza: a matching FIREBASE_CONFIG.storageBucket resolves; a conflicting one is refused; legacy env is ignored
//   2 photo-FREE publishing (codex r4 P1): the real photoPublishIoForEdit, over public "" AND over a private-refusing config, prepares an
//     empty map with ZERO resolver calls; a pid-bearing publish fails CLOSED (photo_publish_failed) and never copies
//   3 import safety: a missing / garbage config breaks no import; every resolution then refuses
//   4 the production boundary (codex r5 P2): index.js loads no test module and reads exactly the committed file; no production file
//     references the fixture installer
//   5 BOTH CLI entrypoints: poisoned legacy env, no dotenv ever opened; the committed config decides
//   6 the scheduled sweeper (the only deleting path) with a refusing config stays OFF
// Run: node photos/photos-config-wiring.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FN = path.join(__dirname, '..');
const EGRESS = path.join(FN, 'tools', 'egress-guard.js');
const FIXTURE = path.join(FN, 'test', '_photos-config-fixture.js');
const SPY = path.join(FN, 'test', '_fs-dotenv-spy.js');
const DEMO = 'demo-xpizza';
const DEMO_PRIV = 'demo-xpizza.appspot.com';
const demoCfg = (over = {}) => ({ schema: 1, public_bucket: { [DEMO]: '' }, private_bucket: { [DEMO]: DEMO_PRIV }, ...over });

function child({ script, file, args = [], fixture, mode, env = {}, spy = false, sentinel = false }) {
  const e = { ...process.env }; delete e.NODE_OPTIONS;
  for (const k of Object.keys(e)) if (/_EMULATOR_HOST$/.test(k) || /^(FUNCTION_TARGET|K_SERVICE|FUNCTION_NAME|FIREBASE_CONFIG|GCLOUD_PROJECT|GOOGLE_CLOUD_PROJECT|PHOTOS_.*)$/.test(k)) delete e[k];
  Object.assign(e, env);
  if (fixture !== undefined) e.TB_PHOTOS_FIXTURE = JSON.stringify(fixture);
  if (mode) e.TB_PHOTOS_FIXTURE_MODE = mode;
  const spyOut = spy ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-spy-')), 'seen.json') : null;
  if (spyOut) e.TB_SPY_OUT = spyOut;
  const sentOut = sentinel ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-sent-')), 'hits.json') : null;
  if (sentOut) e.TB_SENTINEL_OUT = sentOut;
  const pre = ['-r', EGRESS, ...(fixture !== undefined || mode ? ['-r', FIXTURE] : []), ...(spy ? ['-r', SPY] : []), ...(sentinel ? ['-r', path.join(FN, 'test', '_admin-read-sentinel.js')] : [])];
  const r = spawnSync(process.execPath, [...pre, ...(script ? ['-e', script] : [file, ...args])], { cwd: FN, env: e, encoding: 'utf8', timeout: 90000 });
  assert.ok(!/r3-egress: .*REFUSED/.test(r.stderr || ''), `a scenario attempted a non-loopback connection\n${(r.stderr || '').slice(-600)}`);
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  const seen = spyOut && fs.existsSync(spyOut) ? JSON.parse(fs.readFileSync(spyOut, 'utf8')) : null;
  const clientHits = sentOut && fs.existsSync(sentOut) ? JSON.parse(fs.readFileSync(sentOut, 'utf8')) : null;
  return { r, result: line ? JSON.parse(line.slice(7)) : null, seen, clientHits };
}
const RESOLVE = "const B = require('./photos/buckets'); const r = {}; try { r.b = { ...B.photoBuckets() }; } catch (e) { r.err = e.code; } r.pub = B.publicOrNull(); console.log('RESULT ' + JSON.stringify(r));";

// 1. configured demo-xpizza, through the real loader + resolver
{
  const FC = (sb) => JSON.stringify({ projectId: DEMO, storageBucket: sb });
  const match = child({ script: RESOLVE, fixture: demoCfg(), env: { GCLOUD_PROJECT: DEMO, FIREBASE_CONFIG: FC(DEMO_PRIV) } }).result;
  assert.deepStrictEqual(match, { b: { project: DEMO, private: DEMO_PRIV, public: null }, pub: null }, `DEMO-MATCHING-RESOLVES ${JSON.stringify(match)}`);
  const conflict = child({ script: RESOLVE, fixture: demoCfg(), env: { GCLOUD_PROJECT: DEMO, FIREBASE_CONFIG: FC('demo-other.appspot.com') } }).result;
  assert.deepStrictEqual(conflict, { err: 'photos_private_bucket_conflict', pub: null }, `DEMO-CONFLICTING-REFUSED ${JSON.stringify(conflict)}`);
  const poisoned = child({ script: RESOLVE, fixture: demoCfg(), env: { GCLOUD_PROJECT: DEMO, PHOTOS_PUBLIC_BUCKET: 'tb-poison', PHOTOS_PRIVATE_BUCKET: 'tb-poison-2' } }).result;
  assert.deepStrictEqual(poisoned, { b: { project: DEMO, private: DEMO_PRIV, public: null }, pub: null }, `DEMO-LEGACY-ENV-IGNORED ${JSON.stringify(poisoned)}`);
  const unconfigured = child({ script: RESOLVE, fixture: demoCfg(), env: { GCLOUD_PROJECT: 'tb-proj-z' } }).result;
  assert.deepStrictEqual(unconfigured, { err: 'photos_private_bucket_unknown', pub: null }, 'UNCONFIGURED-PROJECT (a separate cell)');
}
ok('configured demo-xpizza through the real loader + resolver: matching storageBucket resolves, a conflicting one is refused, poisoned legacy env ignored; an unconfigured project refuses private, public null');

// 2. photo-free publishing never resolves a bucket; a pid-bearing publish fails closed and never copies
{
  const FREE = "require('./lib/admin'); const B = require('./photos/buckets'); let calls = 0;"
    + " for (const k of ['photoBuckets', 'publicOrNull']) { const f = B[k]; B[k] = (...a) => { calls += 1; return f(...a); }; }"
    + " const io = require('./photos/publish-io').photoPublishIoForEdit();"
    + " (async () => { const a = await io.prepare('tb_r1', {}); const b = await io.prepare('tb_r1', null); console.log('RESULT ' + JSON.stringify({ a, b, calls })); process.exit(0); })().catch((e) => { console.log('RESULT ' + JSON.stringify({ threw: e.code || e.message })); process.exit(0); });";
  for (const [label, fx, env] of [['public ""', demoCfg(), { GCLOUD_PROJECT: DEMO }], ['private-refusing (unconfigured project)', demoCfg(), { GCLOUD_PROJECT: 'tb-proj-z' }]]) {
    const r = child({ script: FREE, fixture: fx, env }).result;
    assert.deepStrictEqual(r, { a: null, b: null, calls: 0 }, `🔴 PHOTO-FREE-PUBLISH-NEVER-RESOLVES (${label}) ${JSON.stringify(r)}`);
  }
  const PID = "const B = require('./photos/buckets'); const { makePublishIo } = require('./photos/publish-io'); let copies = 0;"
    + " const doc = (d) => ({ get: async () => ({ exists: true, data: () => d }) });"
    + " const fakeFs = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => doc({ state: 'draft' }) }) }) }), runTransaction: async () => { throw new Error('no write expected'); } };"
    + " const storage = { bucket: () => ({ file: () => ({ copy: async () => { copies += 1; }, getMetadata: async () => [{ generation: '1' }] }) }) };"
    + " const io = makePublishIo({ fs: fakeFs, storage, publicBucket: () => B.publicOrNull(), privateBucket: () => B.photoBuckets().private });"
    + " (async () => { let code = null; try { await io.prepare('tb_r1', { k1: { state: 'pid', pid: 'a'.repeat(32) } }); } catch (e) { code = e.code; } console.log('RESULT ' + JSON.stringify({ code, copies })); process.exit(0); })();";
  for (const [label, env] of [['public ""', { GCLOUD_PROJECT: DEMO }], ['private-refusing', { GCLOUD_PROJECT: 'tb-proj-z' }]]) {
    const r = child({ script: PID, fixture: demoCfg(), env }).result;
    assert.deepStrictEqual(r, { code: 'photo_publish_failed', copies: 0 }, `🔴 PID-PUBLISH-FAILS-CLOSED (${label}) ${JSON.stringify(r)}`);
  }
  const priv = child({ script: RESOLVE, fixture: demoCfg(), env: { GCLOUD_PROJECT: DEMO } }).result;
  assert.strictEqual(priv.b.private, DEMO_PRIV, 'PRIVATE-CONSUMERS-UNAFFECTED-BY-PUBLIC-EMPTY');
}
ok('photo-free publish (the real photoPublishIoForEdit) over public "" and over a private-refusing config: an empty map prepares with ZERO resolver calls; a pid-bearing publish fails closed (photo_publish_failed) with zero copies; private resolution unaffected by public ""');

// 3. import safety: a missing / garbage config breaks no import; resolutions refuse
{
  const IMPORTS = "require('./lib/admin'); for (const m of ['./photos/functions.js', './photos/publish-io.js', './photos/editable-io.js', './portal/functions.js', './photos/buckets.js']) require(m);"
    + " const B = require('./photos/buckets'); let err = null; try { B.photoBuckets(); } catch (e) { err = e.code; } console.log('RESULT ' + JSON.stringify({ err, pub: B.publicOrNull() })); process.exit(0);";
  for (const mode of ['missing', 'garbage']) {
    const x = child({ script: IMPORTS, mode, env: { GCLOUD_PROJECT: DEMO } });
    assert.deepStrictEqual(x.result, { err: 'photos_config_invalid', pub: null }, `🔴 IMPORT-SAFE (${mode}) ${JSON.stringify(x.result)} ${(x.r.stderr || '').slice(-300)}`);
  }
}
ok('import safety: with the config missing or unparseable, photos/functions, publish-io, editable-io, portal/functions and buckets all import; every resolution then refuses (photos_config_invalid), public null');

// 4. the production boundary: index.js reads exactly the committed file; no test module loads; no production file references the installer
{
  const BOUNDARY = "process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'x'; require('./index.js'); const C = require('./photos/photos-config'); const L = C.loadPhotosConfig();"
    + " const testMods = Object.keys(require.cache).filter((k) => /[\\\\/]xpizza-functions[\\\\/]test[\\\\/]/.test(k));"
    + " console.log('RESULT ' + JSON.stringify({ testMods, cached: Object.prototype.hasOwnProperty.call(require.cache, C.CONFIG_PATH), ok: L.ok, fixture: global.__TB_PHOTOS_FIXTURE_INSTALLED || null, committed: L.ok && JSON.stringify(L.config) === JSON.stringify(JSON.parse(require('fs').readFileSync(C.CONFIG_PATH, 'utf8'))) })); process.exit(0);";
  const b = child({ script: BOUNDARY, env: { GCLOUD_PROJECT: 'xpizza-delivery' } }).result;
  assert.deepStrictEqual(b, { testMods: [], cached: true, ok: true, fixture: null, committed: true }, `🔴 BOUNDARY ${JSON.stringify(b)}`);
  const offenders = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name); const rel = path.relative(FN, p);
    if (f.isDirectory()) { if (!['node_modules', 'test', '.git'].includes(f.name)) walk(p); continue; }
    if (!/\.(js|mjs|cjs)$/.test(f.name) || /\.test\.(js|mjs)$/.test(f.name)) continue;
    if (/_photos-config-fixture/.test(fs.readFileSync(p, 'utf8'))) offenders.push(rel);
  } };
  walk(FN);
  assert.deepStrictEqual(offenders, [], `🔴 BOUNDARY-NO-PRODUCTION-REFERENCE to the fixture installer: ${offenders}`);
}
ok('production boundary: loading index.js loads no test module, the loader reads exactly the committed bundled file (no fixture), and no production file references the test installer');

// 5. BOTH CLI entrypoints: poisoned legacy env, no dotenv ever opened; the committed config decides
{
  const POISON = { PHOTOS_PUBLIC_BUCKET: 'tb-poison-pub', PHOTOS_PRIVATE_BUCKET: 'tb-poison-priv' };
  // an UNNAMED public bucket (public "", the pre-launch state) still refuses: kept as a fixture since the owner named it (2026-11-11 §8a)
  const unnamed = { schema: 1, public_bucket: { 'xpizza-delivery': '' }, private_bucket: { 'xpizza-delivery': 'xpizza-delivery.firebasestorage.app' } };
  const co = child({ file: 'tools/photo-create-only-check.js', args: ['--project', 'xpizza-delivery', '--bucket', 'xpizza-delivery.firebasestorage.app'], fixture: unnamed, env: POISON, spy: true });
  assert.strictEqual(co.r.status, 2, `CLI-CREATE-ONLY public "" → refused (exit ${co.r.status})\n${co.r.stdout}${co.r.stderr}`);
  assert.ok(/not configured/.test(co.r.stderr || ''), `CLI-CREATE-ONLY says the public bucket is not configured: ${co.r.stderr}`);
  assert.deepStrictEqual(co.seen, [], `🔴 CLI-CREATE-ONLY-NO-DOTENV opened ${JSON.stringify(co.seen)}`);
  const launched = { schema: 1, public_bucket: { 'xpizza-delivery': 'tb-pub-launched' }, private_bucket: { 'xpizza-delivery': 'xpizza-delivery.firebasestorage.app' } };
  const dry = child({ file: 'tools/photo-create-only-check.js', args: ['--project', 'xpizza-delivery', '--bucket', 'xpizza-delivery.firebasestorage.app'], fixture: launched, env: POISON, spy: true });
  assert.strictEqual(dry.r.status, 0, `CLI-CREATE-ONLY-DRY with a public name (exit ${dry.r.status})\n${dry.r.stderr}`);
  assert.ok(/private xpizza-delivery\.firebasestorage\.app, public tb-pub-launched/.test(dry.r.stdout) && !/tb-poison/.test(dry.r.stdout), `CLI-CREATE-ONLY-DRY names the committed buckets, never the poison: ${dry.r.stdout}`);
  assert.deepStrictEqual(dry.seen, [], 'CLI-CREATE-ONLY-DRY-NO-DOTENV');
  // the COMMITTED file (no fixture) now names the public bucket: the dry run names both committed buckets, never the poison
  const real = child({ file: 'tools/photo-create-only-check.js', args: ['--project', 'xpizza-delivery', '--bucket', 'xpizza-delivery.firebasestorage.app'], env: POISON, spy: true });
  assert.strictEqual(real.r.status, 0, `CLI-CREATE-ONLY-COMMITTED dry run (exit ${real.r.status})\n${real.r.stderr}`);
  assert.ok(/private xpizza-delivery\.firebasestorage\.app, public sherpa-delivery-photos/.test(real.r.stdout) && !/tb-poison/.test(real.r.stdout), `CLI-CREATE-ONLY-COMMITTED names the committed buckets: ${real.r.stdout}`);
  assert.deepStrictEqual(real.seen, [], 'CLI-CREATE-ONLY-COMMITTED-NO-DOTENV');
  const bf = child({ file: 'tools/photos-legacy-backfill.js', args: ['--project', 'xpizza-delivery', '--rid', 'x_pizza', '--apply'], fixture: demoCfg(), env: POISON, spy: true });
  assert.strictEqual(bf.r.status, 2, `CLI-BACKFILL --apply with no committed entry for the project → refused (exit ${bf.r.status})\n${bf.r.stderr}`);
  assert.ok(/refused this project \(photos_private_bucket_unknown\)/.test(bf.r.stderr || ''), `CLI-BACKFILL names the refusal: ${bf.r.stderr}`);
  assert.deepStrictEqual(bf.seen, [], `🔴 CLI-BACKFILL-NO-DOTENV opened ${JSON.stringify(bf.seen)}`);
  // codex photos-config r1 #1: the DRY RUN refuses too (before any client or read)
  const bfDry = child({ file: 'tools/photos-legacy-backfill.js', args: ['--project', 'xpizza-delivery', '--rid', 'x_pizza'], fixture: demoCfg(), env: POISON, spy: true, sentinel: true });
  // ONE named assert on the whole outcome: refused (exit 2) AND no client was ever reached (the offline sentinel — not the egress guard)
  assert.deepStrictEqual({ status: bfDry.r.status, clientHits: bfDry.clientHits }, { status: 2, clientHits: [] }, `🔴 CLI-BACKFILL-DRY-REFUSES a config refusal in the dry run too, before any client\n${bfDry.r.stderr}`);
  assert.ok(/refused this project \(photos_private_bucket_unknown\)/.test(bfDry.r.stderr || ''), `CLI-BACKFILL-DRY names the refusal: ${bfDry.r.stderr}`);
  // codex photos-config r1 #2: the census refuses an UNREADABLE committed config before any read (never public "")
  for (const mode of ['garbage', 'missing']) {
    const cz = child({ file: 'tools/photos-config-census.js', args: ['--project', 'xpizza-delivery', '--storage-bucket', 'xpizza-delivery.firebasestorage.app', '--legacy-private', '<unset>', '--legacy-public', '<unset>'], mode });
    assert.strictEqual(cz.r.status, 2, `🔴 CLI-CENSUS-UNREADABLE-CONFIG-REFUSED (${mode}) exit ${cz.r.status}\n${cz.r.stdout}${cz.r.stderr}`);
    assert.ok(/not usable/.test(cz.r.stderr || '') && !/public_bucket/.test(cz.r.stdout || ''), `CLI-CENSUS (${mode}) refuses before the census: ${cz.r.stderr}`);
  }
}
ok('both CLI entrypoints (spawned, poisoned PHOTOS_* env, a dotenv-open spy): the create-only CLI refuses until a public name is committed, and with one its dry run names exactly the committed buckets; the backfill refuses a project with no committed entry in --apply AND the dry run; the census refuses an unreadable committed config before any read; no dotenv is ever opened');

// 6. the scheduled SWEEPER (the only path that DELETES; advisor 2026-11-01): driven offline through its real handler (photoSweep.run) with a
//    REFUSING config → it stays OFF: zero deleters built, zero sweep entries, zero storage use, the refusal logged. Premise: with a resolving
//    config the same handler does reach the sweep entry (stubbed off — no I/O), so the spies can see it.
{
  const SWEEP = "require('./lib/admin'); const S = require('./photos/sweep-io'); const st = require('firebase-admin/storage'); const c = { entry: 0, deleters: 0, storage: 0 };"
    + " S.sweepEntry = async () => { c.entry += 1; return { mode: 'off' }; }; const md = S.makeGcsDeleter; S.makeGcsDeleter = (...a) => { c.deleters += 1; return md(...a); };"
    + " const gs = st.getStorage; st.getStorage = (...a) => { c.storage += 1; return gs(...a); };"
    + " const logs = []; const ce = console.error; console.error = (...a) => { logs.push(a.join(' ')); };"
    + " const f = require('./photos/functions.js').photoSweep;"
    + " (async () => { let threw = null; try { await f.run({}); } catch (e) { threw = e.code || e.message; } console.error = ce;"
    + " console.log('RESULT ' + JSON.stringify({ ...c, threw, refusedLogged: logs.some((l) => /photo_sweep_config_refused/.test(l)) })); process.exit(0); })();";
  const refused = child({ script: SWEEP, fixture: demoCfg(), env: { GCLOUD_PROJECT: 'tb-proj-z' } }).result;
  assert.deepStrictEqual(refused, { entry: 0, deleters: 0, storage: 0, threw: null, refusedLogged: true }, `🔴 SWEEP-REFUSED-STAYS-OFF ${JSON.stringify(refused)}`);
  const resolving = child({ script: SWEEP, fixture: demoCfg(), env: { GCLOUD_PROJECT: DEMO } }).result;
  assert.deepStrictEqual(resolving, { entry: 1, deleters: 0, storage: 0, threw: null, refusedLogged: false }, `premise — with a resolving config the handler reaches the sweep entry ${JSON.stringify(resolving)}`);
}
ok('the scheduled sweeper (photoSweep.run, offline) with a refusing config stays OFF — no sweep entry, no deleter, no storage, the refusal logged; with a resolving config it reaches the sweep entry (premise)');

console.log(`photos-config-wiring: OK (${n})`);
