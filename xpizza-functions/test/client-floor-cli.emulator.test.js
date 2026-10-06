'use strict';
// P-SELFUPDATE — the REAL owner CLIs end-to-end on the emulators (spawned as the owner would run them; the emulator host
// variables, required here, route them to the emulators). Run: npm run test:client-floor-cli
//   • status (read-only); kitchen set — DRY RUN writes nothing; --apply sets EVERY restaurant (RTDB identity ∪ registry,
//     incl. a registry-only synthetic third merchant) and reads back; raise refuses to lower; above-generation refused;
//     delete-all (the kill switch) clears every restaurant; orders set/delete on platform_config/client_floor/orders;
//   • the version report runs read-only (the whole RTDB tree is byte-identical) and reports live instances + UNKNOWN hours.
require('./_emulator-required')('database', 'firestore');
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const admin = require('firebase-admin');
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const PROJECT = 'xpizza-delivery';
admin.initializeApp({ projectId: PROJECT, databaseURL: RTDB_URL });
const rtdb = admin.database();
const fs = admin.firestore();

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const runCli = (env, tool, ...args) => {
  // every CLI run is BOUNDED (60 s): a CLI that hangs (e.g. on a dead database) fails this suite by assertion, never hangs it
  try { return { code: 0, out: execFileSync('node', [path.join(__dirname, '..', 'tools', tool), '--project', PROJECT, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, killSignal: 'SIGKILL' }) }; }
  catch (e) { return { code: e.status === null ? `TIMEOUT(${e.signal})` : e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
const cli = (tool, ...args) => runCli(process.env, tool, ...args);
// the registry (Firestore) UNREACHABLE: a dead emulator port — RTDB stays on the real emulator
const cliNoRegistry = (tool, ...args) => runCli({ ...process.env, FIRESTORE_EMULATOR_HOST: '127.0.0.1:1' }, tool, ...args);
const tree = async () => JSON.stringify((await rtdb.ref().get()).val());
const kf = async (rid) => (await rtdb.ref(`restaurants/${rid}/client_floor/kitchen`).get()).val();

(async () => {
  await rtdb.ref().set(null);
  await rtdb.ref('restaurants/x_pizza/identity').set({ name: 'x' });
  await rtdb.ref('restaurants/la_musa/identity').set({ name: 'l' });
  await fs.collection('restaurants').doc('synthetic_3').set({ name: 's3' });    // registry-only third merchant

  let before = await tree();
  let r = cli('client-floor.js', 'status');
  assert.strictEqual(r.code, 0, r.out); assert.strictEqual(await tree(), before, 'status is read-only');
  r = cli('client-floor.js', 'kitchen', 'set', '1');
  assert.strictEqual(r.code, 0, r.out); assert.ok(/DRY RUN/.test(r.out)); assert.strictEqual(await tree(), before, '🔴 a dry run writes nothing');
  ok('status and a DRY-RUN set are read-only (the whole tree is byte-identical)');

  r = cli('client-floor.js', 'kitchen', 'set', '1', '--apply');
  assert.strictEqual(r.code, 0, r.out); assert.ok(/applied in ONE update and read back \(3 path/.test(r.out), r.out);
  for (const rid of ['x_pizza', 'la_musa', 'synthetic_3']) assert.strictEqual(await kf(rid), 1, `${rid} kitchen floor set`);
  ok('kitchen set --apply: EVERY restaurant (RTDB identity ∪ registry, incl. a registry-only third merchant) in ONE update, read back');

  await rtdb.ref('restaurants/la_musa/client_floor/kitchen').set(5);   // simulate a higher floor on one restaurant
  before = await tree();
  r = cli('client-floor.js', 'kitchen', 'raise', '1', '--apply');
  assert.notStrictEqual(r.code, 0); assert.ok(/refuses to LOWER/.test(r.out)); assert.strictEqual(await tree(), before, 'a refused raise writes nothing');
  r = cli('client-floor.js', 'kitchen', 'set', '7', '--apply');
  assert.notStrictEqual(r.code, 0); assert.ok(/refuse EVERY page/.test(r.out)); assert.strictEqual(await tree(), before, 'an above-generation floor is refused, nothing written');
  ok('raise refuses to lower any restaurant; a floor above the current generation is refused — nothing written in either case');

  r = cli('client-floor.js', 'kitchen', 'delete', '--apply');
  assert.strictEqual(r.code, 0, r.out);
  for (const rid of ['x_pizza', 'la_musa', 'synthetic_3']) assert.strictEqual(await kf(rid), null, `${rid} kitchen floor cleared`);
  ok('kitchen delete --apply (THE KILL SWITCH): every restaurant\'s floor cleared in one update');

  // ── codex CP1 B1 — discovery can never silently omit a restaurant ──
  await rtdb.ref('restaurants/ghost_9/client_floor/kitchen').set(3);          // a floor on a restaurant with NO identity
  before = await tree();
  r = cliNoRegistry('client-floor.js', 'kitchen', 'set', '1', '--apply');
  assert.notStrictEqual(r.code, 0, r.out); assert.ok(/registry discovery FAILED/.test(r.out), r.out);
  assert.strictEqual(await tree(), before, '🔴 set with the registry unreachable is REFUSED and writes nothing');
  r = cliNoRegistry('client-floor.js', 'kitchen', 'raise', '1', '--apply');
  assert.notStrictEqual(r.code, 0); assert.strictEqual(await tree(), before, '🔴 raise with the registry unreachable is REFUSED');
  r = cli('client-floor.js', 'kitchen', 'set', '1', '--apply');
  assert.strictEqual(r.code, 0, r.out);
  for (const rid of ['x_pizza', 'la_musa', 'synthetic_3', 'ghost_9']) assert.strictEqual(await kf(rid), 1, `${rid}: set covers it (ghost_9 known only by its floor)`);
  r = cliNoRegistry('client-floor.js', 'kitchen', 'delete', '--apply');
  assert.strictEqual(r.code, 0, `delete must work WITHOUT the registry: ${r.out}`);
  const left = Object.entries((await rtdb.ref('restaurants').get()).val() || {}).filter(([, v]) => v && v.client_floor && v.client_floor.kitchen != null).map(([k]) => k);
  assert.deepStrictEqual(left, [], '🔴 the emergency delete leaves NO kitchen floor anywhere — incl. the identity-less ghost_9 and the registry-only synthetic_3');
  ok('codex B1: with the registry unreachable set/raise are REFUSED (nothing written) and delete still removes EVERY floor (registry-only and identity-less restaurants included); set covers a restaurant known only by its floor');

  r = cli('client-floor.js', 'orders', 'set', '1', '--apply');
  assert.strictEqual(r.code, 0, r.out); assert.strictEqual((await rtdb.ref('platform_config/client_floor/orders').get()).val(), 1);
  r = cli('client-floor.js', 'orders', 'delete', '--apply');
  assert.strictEqual(r.code, 0, r.out); assert.strictEqual((await rtdb.ref('platform_config/client_floor/orders').get()).val(), null);
  ok('orders set / delete on platform_config/client_floor/orders');

  const now = Date.now();
  await rtdb.ref('client_versions/orders/inst_live_0001').set({ deployment: 'orders-xpizza', context: 'x_pizza', build: 'bX', compat: 1, last_seen: now });
  before = await tree();
  r = cli('client-version-report.js', '--hours', '3', '--require', 'orders=1');
  assert.strictEqual(r.code, 0, r.out); assert.strictEqual(await tree(), before, '🔴 the report is read-only');
  const rep = JSON.parse(r.out.slice(r.out.indexOf('{')));   // the project guard prints its line first
  assert.deepStrictEqual(rep.live, [{ app: 'orders', deployment: 'orders-xpizza', build: 'bX', compat: 1, live: 1 }]);
  assert.ok(rep.coverage.every((c) => c.unknown_hours.length === 3), 'no historical reports → every hour UNKNOWN, never zero');
  assert.ok(/^UNKNOWN \(run with --logs/.test(rep.headerless), 'without --logs the header-less count is UNKNOWN and the gcloud command is printed');
  ok('version report: read-only; live instances grouped; report-less hours UNKNOWN; header-less UNKNOWN without --logs (command printed)');

  // ── codex CP1 B2 — the REAL report CLI with --logs against a FAKE `gcloud` on PATH (records its argv, returns fixtures) ──
  {
    const os = require('os'); const fsys = require('fs');
    const dir = fsys.mkdtempSync(path.join(os.tmpdir(), 'fake-gcloud-'));
    const argvFile = path.join(dir, 'argv.json'), outFile = path.join(dir, 'out.json');
    fsys.writeFileSync(path.join(dir, 'gcloud'), `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(require('fs').readFileSync(${JSON.stringify(outFile)}, 'utf8'));\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    const endMs = Math.floor(Date.now() / 3600000) * 3600000, startMs = endMs - 3 * 3600000;
    const line = (ep) => `client_version {"endpoint":"${ep}","app":null,"deployment":null,"build":null,"compat":null,"headerless":true}`;
    const iso = (ms) => new Date(ms).toISOString();
    fsys.writeFileSync(outFile, JSON.stringify([
      { timestamp: iso(startMs + 10 * 60000), textPayload: line('createOrder') },   // first partial hour (a rolling window misses it)
      { timestamp: iso(startMs - 60000), textPayload: line('createOrder') },        // before the window
      { timestamp: iso(endMs - 60000), textPayload: line('quoteOrder') },
    ]));
    r = runCli(env, 'client-version-report.js', '--hours', '3', '--logs');
    assert.strictEqual(r.code, 0, r.out);
    const args = JSON.parse(fsys.readFileSync(argvFile, 'utf8'));
    const filter = args[2];
    assert.ok(filter.includes(`timestamp>="${iso(startMs)}"`) && filter.includes(`timestamp<"${iso(endMs)}"`), `🔴 the log query carries the report's own [start, end): ${filter}`);
    assert.ok(!args.some((a) => /freshness/.test(a)), '🔴 no rolling --freshness');
    assert.ok(args.includes('--limit=100000'), 'the limit is explicit');
    let rep2 = JSON.parse(r.out.slice(r.out.indexOf('{')));
    assert.strictEqual(rep2.window.start, iso(startMs)); assert.strictEqual(rep2.window.end_exclusive, iso(endMs));
    assert.strictEqual(rep2.headerless.status, 'complete');
    const total = (c) => Object.values(c).reduce((a, byH) => a + Object.values(byH).reduce((x, y) => x + y, 0), 0);
    assert.strictEqual(total(rep2.headerless.counts), 2, '🔴 the first-partial-hour request IS counted, the out-of-window one is not');
    // TRUNCATED: the read returns exactly --limit entries → a lower bound, never presented as complete
    const many = []; for (let i = 0; i < 100000; i += 1) many.push({ timestamp: iso(startMs + 1000 + i), textPayload: line('createOrder') });
    fsys.writeFileSync(outFile, JSON.stringify(many));
    r = runCli(env, 'client-version-report.js', '--hours', '3', '--logs');
    assert.strictEqual(r.code, 0, r.out);
    rep2 = JSON.parse(r.out.slice(r.out.indexOf('{')));
    assert.ok(/^TRUNCATED/.test(rep2.headerless.status), `🔴 a capped read is reported TRUNCATED (${rep2.headerless.status})`);
    assert.ok(!('counts' in rep2.headerless) && rep2.headerless.lower_bound, 'the capped numbers are labelled a LOWER BOUND, never `counts`');
    ok('codex B2: the real report CLI queries logs for EXACTLY its [start, end) (no --freshness, explicit limit); a header-less request in the first partial hour is counted, one before the window is not; a capped read is reported TRUNCATED with a lower bound');
  }

  // ── codex CP1 r2 B2: a fractional --hours is refused BEFORE any database access ──
  {
    const deadDb = { ...process.env, FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1', FIRESTORE_EMULATOR_HOST: '127.0.0.1:1' };
    before = await tree();
    const t0 = Date.now();
    r = runCli(deadDb, 'client-version-report.js', '--hours', '1.5', '--logs');
    assert.strictEqual(r.code, 2, `exit 2 (got ${r.code}): ${r.out}`);
    assert.ok(/REFUSED — --hours must be a whole number/.test(r.out), r.out);
    assert.ok(Date.now() - t0 < 15000, 'refused promptly — with every database endpoint DEAD it never waited on one');
    assert.strictEqual(await tree(), before, 'nothing written');
    r = runCli(process.env, 'client-version-report.js', '--hours', '2');
    assert.strictEqual(r.code, 0, r.out);
    const rep3 = JSON.parse(r.out.slice(r.out.indexOf('{')));
    assert.strictEqual(rep3.window.hours, 2, 'an integer window still runs');
    ok('codex r2 B2: --hours 1.5 exits 2 with a refusal BEFORE any database access (all database hosts dead, prompt exit); an integer window still runs');
  }

  console.log(`client-floor-cli(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('client-floor-cli(emulator) FAILED:', e); process.exit(1); });
