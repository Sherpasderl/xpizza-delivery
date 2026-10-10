#!/usr/bin/env node
'use strict';
/* R1 EVIDENCE PROOF (PLAN-emulator-isolation v5 §e) — REAL emulators, REAL launcher, TWO worktrees. Not in a test
 * chain: it boots JVMs and needs a second worktree of the same commit. Run in a CLEAR WINDOW (no old-code emulator
 * runs on the machine):
 *
 *   PATH="/opt/homebrew/opt/openjdk/bin:$PATH" node test/emu-isolation.proof.js run <second-worktree-root>
 *
 * Proves, each against the real firebase-tools 15.16.0:
 *   1. ISOLATION — two concurrent same-project runs (A here, B in the other worktree) write DIFFERENT sentinels to the
 *      SAME Firestore doc and RTDB path; each reads back only its own, before and after the other finishes.
 *   2. HUB — both runs inherit one parent TMPDIR, yet each gets its own hub-<project>.json (per-run child TMPDIR).
 *   3. RULES LOADED, BEHAVIOURALLY — per run, unauthenticated REST: Firestore public read ALLOWED + write and a
 *      default-deny read DENIED; RTDB /menus read ALLOWED + /orders read and a write DENIED. Allowed+denied together
 *      cannot both hold under either permissive or closed defaults, so this is non-vacuous.
 *   4. PROJECT — a stale parent GOOGLE_CLOUD_PROJECT is normalised to the run's project in the suite.
 *   5. MARKERS — the run's own nonce is visible on its emulator JVMs (and, in the functions step, on a worker).
 *   6. SAME-CHECKOUT — a second run in worktree A while A is live is REFUSED (exit 4).
 *   7. QUARANTINE + REAP — a marked orphan with a dead supervisor quarantines its slot (a pin to it refuses naming the
 *      orphan); an unpinned run lands elsewhere; emu-reap reclaims it; the pin then succeeds.
 *   8. RULES MISSING / INVALID — the launcher refuses before starting (in the second worktree, restored after).
 *   9. FUNCTIONS — discovery passes lib/admin.js's validator (both data hosts real), a worker carries the marker.
 */
const assert = require('assert');
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROJECT = 'demo-xpizza';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, what) => { const t = Date.now() + ms; while (Date.now() < t) { if (fn()) return; await sleep(200); } throw new Error(`timeout waiting for ${what}`); };

// ═══ INSIDE: runs as the suite command under tools/emulator-run.js ═══════════════════════════════════════════════
async function inside(ctl, tag, peer) {
  require('./_emulator-required')('firestore', 'database');
  const A = require('../tools/emu-alloc');
  const admin = require('firebase-admin');
  const fsHost = process.env.FIRESTORE_EMULATOR_HOST, dbHost = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  const NS = `${PROJECT}-default-rtdb`;
  const out = { tag, offset: process.env.XPIZZA_EMU_OFFSET, tmpdir: os.tmpdir(), gcloud: process.env.GCLOUD_PROJECT, gcp: process.env.GOOGLE_CLOUD_PROJECT };
  out.hubFile = path.join(os.tmpdir(), `hub-${PROJECT}.json`);
  out.hubFileExists = fs.existsSync(out.hubFile);
  // rules, behaviourally (unauthenticated REST)
  const st = async (url, init) => (await fetch(url, init)).status;
  const fsDoc = (p) => `http://${fsHost}/v1/projects/${PROJECT}/databases/(default)/documents/${p}`;
  out.rules = {
    fsPublicRead: await st(fsDoc('restaurants/r1probe')),                                   // allowed → 404 (no doc)
    fsDenyRead: await st(fsDoc('r1secret/x')),                                              // global default-deny → 403
    fsDenyWrite: await st(`${fsDoc('restaurants')}?documentId=r1probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"fields":{}}' }),
    dbPublicRead: await st(`http://${dbHost}/menus.json?ns=${NS}`),                          // .read true → 200
    dbDenyRead: await st(`http://${dbHost}/orders.json?ns=${NS}`),                           // no grant → 401
    dbDenyWrite: await st(`http://${dbHost}/r1probe.json?ns=${NS}`, { method: 'PUT', body: '"x"' }),
  };
  // markers on this run's own processes
  const nonce = A.parseMarker(process.env[A.RUN_VAR]).nonce;
  const t = A.readPsTables();
  const mine = A.joinScans(t.plain, t.withEnv).filter((r) => r.readable && (A.markerIn(r.env) || {}).nonce === nonce);
  out.marked = mine.map((r) => (/\bjava\b|\/java /.test(r.argv) ? 'java' : /firebase/.test(r.argv) ? 'firebase-cli' : 'node'));
  // isolation: the SAME paths, different values
  admin.initializeApp({ projectId: PROJECT, databaseURL: `http://${dbHost}?ns=${NS}` });
  const fsd = admin.firestore(); const db = admin.database();
  await fsd.doc('r1iso/sentinel').set({ tag });
  await db.ref('r1iso/sentinel').set(tag);
  const read = async () => [(await fsd.doc('r1iso/sentinel').get()).get('tag'), (await db.ref('r1iso/sentinel').once('value')).val()];
  fs.writeFileSync(path.join(ctl, `${tag}.ready`), '1');
  if (peer) await waitFor(() => fs.existsSync(path.join(ctl, `${peer}.ready`)), 120000, `${peer}.ready`);
  out.readAfterPeerWrote = await read();
  fs.writeFileSync(path.join(ctl, `${tag}.done`), '1');
  if (peer) await waitFor(() => fs.existsSync(path.join(ctl, `${peer}.done`)) || fs.existsSync(path.join(ctl, `${peer}.json`)), 120000, `${peer}.done`);
  await sleep(1500);                                         // let the peer reach / pass its teardown
  out.readAfterPeerDone = await read();
  fs.writeFileSync(path.join(ctl, `${tag}.json`), JSON.stringify(out));
  console.log(`  ✓ 1 inside ${tag}: wrote + read back (${out.readAfterPeerDone.join(', ')})`);
  process.exit(0);
}

// ═══ functions step: a worker carries the marker; discovery passed lib/admin's validator ═════════════════════════
async function insideFunctions(ctl) {
  require('./_emulator-required')('firestore', 'database');
  const A = require('../tools/emu-alloc');
  const hub = process.env.FIREBASE_EMULATOR_HUB;
  const list = await (await fetch(`http://${hub}/emulators`)).json();
  const fx = list.functions;
  const r = await fetch(`http://${fx.host}:${fx.port}/${PROJECT}/us-central1/reportClientVersion`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const nonce = A.parseMarker(process.env[A.RUN_VAR]).nonce;
  const t = A.readPsTables();
  const rows = A.joinScans(t.plain, t.withEnv).filter((x) => x.readable && (A.markerIn(x.env) || {}).nonce === nonce);
  const worker = rows.filter((x) => /FUNCTION_TARGET=reportClientVersion/.test(x.env) && /FUNCTIONS_EMULATOR=true/.test(x.env));
  fs.writeFileSync(path.join(ctl, 'fn.json'), JSON.stringify({ status: r.status, workerMarked: worker.length, kinds: rows.length }));
  console.log(`  ✓ 1 functions: reportClientVersion → ${r.status}; ${worker.length} marked worker(s)`);
  process.exit(0);
}

// ═══ ORCHESTRATOR ════════════════════════════════════════════════════════════════════════════════════════════════
function launch(root, only, inner, extraEnv = {}) {
  const env = { ...process.env, GOOGLE_CLOUD_PROJECT: 'stale-parent-project', ...extraEnv };
  if (env.NODE_OPTIONS) env.NODE_OPTIONS = env.NODE_OPTIONS.replace(/--require[= ]\S*count-marks\.js/g, '').trim() || undefined;
  if (env.NODE_OPTIONS === undefined) delete env.NODE_OPTIONS;
  const c = spawn(process.execPath, [path.join(root, 'tools', 'emulator-run.js'), '--only', only, '--project', PROJECT, inner], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  const done = new Promise((res) => c.on('exit', (code) => res({ code, out })));
  return { child: c, done, get out() { return out; } };
}
const slotOf = (out) => { const m = /emulator-run: slot (\d+)/.exec(out); return m ? Number(m[1]) : null; };

async function run(rootB) {
  rootB = path.resolve(rootB, fs.existsSync(path.join(rootB, 'xpizza-functions')) ? 'xpizza-functions' : '.');
  assert.ok(fs.existsSync(path.join(rootB, 'tools', 'emulator-run.js')), `second worktree: ${rootB}`);
  const head = (r) => execFileSync('git', ['-C', r, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.strictEqual(head(rootB), head(ROOT), 'premise — both worktrees are the SAME commit');
  assert.notStrictEqual(fs.realpathSync(rootB), fs.realpathSync(ROOT), 'premise — two DIFFERENT checkouts');
  const ctl = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-proof-'));
  const report = {};
  const inner = (tag, peer) => `node test/emu-isolation.proof.js inside ${ctl} ${tag} ${peer || ''}`.trim();

  // ── 1-6: A + B concurrently, same project, same parent TMPDIR; C (same checkout as A) refused ──
  const a = launch(ROOT, 'firestore,database', inner('A', 'B'));
  const b = launch(rootB, 'firestore,database', inner('B', 'A'));
  await waitFor(() => fs.existsSync(path.join(ctl, 'A.ready')), 180000, 'A.ready');
  const c = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'emulator-run.js'), '--only', 'database', '--project', PROJECT, `node test/emu-isolation.proof.js inside ${ctl} C`], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 60000 });
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.strictEqual(ra.code, 0, `A failed:\n${ra.out.slice(-2000)}`);
  assert.strictEqual(rb.code, 0, `B failed:\n${rb.out.slice(-2000)}`);
  const A = JSON.parse(fs.readFileSync(path.join(ctl, 'A.json'), 'utf8'));
  const B = JSON.parse(fs.readFileSync(path.join(ctl, 'B.json'), 'utf8'));
  report.slots = [slotOf(ra.out), slotOf(rb.out)];
  assert.notStrictEqual(report.slots[0], report.slots[1], '🔴 two concurrent runs got the SAME slot');
  assert.deepStrictEqual([A.readAfterPeerWrote, A.readAfterPeerDone], [['A', 'A'], ['A', 'A']], `🔴 A read B's data (or lost its own): ${JSON.stringify(A)}`);
  assert.deepStrictEqual([B.readAfterPeerWrote, B.readAfterPeerDone], [['B', 'B'], ['B', 'B']], `🔴 B read A's data (or lost its own): ${JSON.stringify(B)}`);
  report.isolation = 'A reads only A, B reads only B — Firestore r1iso/sentinel + RTDB r1iso/sentinel, before and after the peer finished';
  assert.notStrictEqual(A.tmpdir, B.tmpdir, '🔴 the two runs shared a TMPDIR');
  assert.ok(A.hubFileExists && B.hubFileExists, `🔴 a run's own hub-${PROJECT}.json was not in its own TMPDIR: ${JSON.stringify([A.hubFile, B.hubFile])}`);
  report.hub = [A.hubFile, B.hubFile];
  for (const R of [A, B]) {
    assert.strictEqual(R.gcloud, PROJECT); assert.strictEqual(R.gcp, PROJECT, `🔴 the stale parent GOOGLE_CLOUD_PROJECT reached the suite: ${R.gcp}`);
    const x = R.rules;
    assert.ok(x.fsPublicRead === 404 || x.fsPublicRead === 200, `🔴 Firestore public read not allowed (${x.fsPublicRead}) — rules not loaded as written`);
    assert.strictEqual(x.fsDenyRead, 403, `🔴 Firestore default-deny read was ALLOWED (${x.fsDenyRead}) — permissive fallback, rules NOT loaded`);
    assert.strictEqual(x.fsDenyWrite, 403, `🔴 Firestore client write was ALLOWED (${x.fsDenyWrite})`);
    assert.strictEqual(x.dbPublicRead, 200, `🔴 RTDB /menus public read denied (${x.dbPublicRead}) — rules not loaded as written`);
    assert.ok(x.dbDenyRead === 401 || x.dbDenyRead === 403, `🔴 RTDB /orders read ALLOWED (${x.dbDenyRead}) — rules NOT loaded`);
    assert.ok(x.dbDenyWrite === 401 || x.dbDenyWrite === 403, `🔴 RTDB client write ALLOWED (${x.dbDenyWrite})`);
    assert.ok(R.marked.filter((k) => k === 'java').length >= 2, `🔴 the run's emulator JVMs do not carry its marker: ${JSON.stringify(R.marked)}`);
  }
  report.rules = { A: A.rules, B: B.rules };
  report.marked = { A: A.marked, B: B.marked };
  report.project = 'stale parent GOOGLE_CLOUD_PROJECT=stale-parent-project → both runs see GCLOUD_PROJECT = GOOGLE_CLOUD_PROJECT = demo-xpizza';
  assert.strictEqual(c.status, 4, `🔴 a second run in A's checkout was not refused (exit ${c.status})\n${c.stderr}`);
  assert.match(c.stderr, /another emulator run of THIS checkout is live/);
  report.sameCheckout = 'C (A\'s checkout, while A live) refused exit 4';

  // ── 7: quarantine + reap ──
  const ALLOC = require('../tools/emu-alloc');
  let X = null;
  for (let s = ALLOC.SLOTS - 1; s >= 0 && X === null; s--) { const sv = await ALLOC.bindSentinel(ALLOC.sentinelPort(s)); if (sv) { await ALLOC.closeServer(sv); X = s; } }
  const deadSup = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { env: { ...process.env, NODE_OPTIONS: '', [ALLOC.RUN_VAR]: ALLOC.formatMarker({ slot: X, pid: Number(deadSup.stdout), nonce: ALLOC.newNonce(), start: 1 }) }, stdio: 'ignore', detached: true });
  orphan.unref();
  await sleep(500);
  const noop = `node test/emu-isolation.proof.js noop`;
  const pinned = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'emulator-run.js'), '--only', 'database', '--project', PROJECT, noop], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', XPIZZA_EMU_PORT_OFFSET: String(X * 10) }, timeout: 120000 });
  assert.strictEqual(pinned.status, 3, `🔴 a pin onto a slot with a marked orphan was not refused (exit ${pinned.status})\n${pinned.stderr}`);
  assert.match(pinned.stderr, new RegExp(`QUARANTINED — orphan pid\\(s\\) ${orphan.pid}`), '🔴 the refusal does not name the orphan');
  const free = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'emulator-run.js'), '--only', 'database', '--project', PROJECT, noop], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 180000 });
  assert.strictEqual(free.status, 0, `unpinned run failed:\n${free.stderr.slice(-1500)}`);
  assert.notStrictEqual(slotOf(free.stderr), X, '🔴 an unpinned run was admitted onto the quarantined slot');
  const rp = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'emu-reap.js'), String(X)], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(rp.status, 0, `emu-reap failed: ${rp.stderr}`);
  assert.ok(!ALLOC.pidAlive(orphan.pid), '🔴 emu-reap left the orphan alive');
  const again = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'emulator-run.js'), '--only', 'database', '--project', PROJECT, noop], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', XPIZZA_EMU_PORT_OFFSET: String(X * 10) }, timeout: 180000 });
  assert.strictEqual(again.status, 0, `🔴 the pin onto the RECLAIMED slot failed:\n${again.stderr.slice(-1500)}`);
  report.quarantine = `orphan ${orphan.pid} on slot ${X}: pin refused naming it; unpinned run → slot ${slotOf(free.stderr)}; emu-reap reclaimed; pin then admitted`;

  // ── 8: missing / invalid rules refuse (second worktree; restored) ──
  const dbRules = path.join(rootB, 'database.rules.json'), fsRules = path.join(rootB, 'firestore.rules');
  const keepDb = fs.readFileSync(dbRules), keepFs = fs.readFileSync(fsRules);
  const tryRun = (only) => spawnSync(process.execPath, [path.join(rootB, 'tools', 'emulator-run.js'), '--only', only, '--project', PROJECT, noop], { cwd: rootB, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 60000 });
  const cases = [];
  try {
    fs.unlinkSync(dbRules); cases.push(['database rules MISSING', tryRun('database')]); fs.writeFileSync(dbRules, keepDb);
    fs.writeFileSync(dbRules, '{ "rules": '); cases.push(['database rules INVALID JSON', tryRun('database')]); fs.writeFileSync(dbRules, keepDb);
    fs.unlinkSync(fsRules); cases.push(['firestore rules MISSING', tryRun('firestore')]); fs.writeFileSync(fsRules, keepFs);
    fs.writeFileSync(fsRules, '   \n'); cases.push(['firestore rules EMPTY', tryRun('firestore')]); fs.writeFileSync(fsRules, keepFs);
  } finally { fs.writeFileSync(dbRules, keepDb); fs.writeFileSync(fsRules, keepFs); }
  for (const [label, r] of cases) {
    assert.strictEqual(r.status, 2, `🔴 ${label}: the launcher started anyway (exit ${r.status})`);
    assert.match(r.stderr, /rules file .* (is missing|is not valid JSON|is empty)/, `${label}: names why`);
  }
  report.rulesRefusal = cases.map(([l]) => l).join('; ') + ' — each refused (exit 2) before any emulator started';

  // ── 9: functions — discovery validated by lib/admin.js, a worker carries the marker ──
  const fnRun = launch(ROOT, 'functions', `node test/emu-isolation.proof.js functions ${ctl}`);
  const rf = await fnRun.done;
  assert.strictEqual(rf.code, 0, `functions step failed:\n${rf.out.slice(-2500)}`);
  assert.match(rf.out, /starting functions,firestore,database/, 'functions implied both data services');
  const fn = JSON.parse(fs.readFileSync(path.join(ctl, 'fn.json'), 'utf8'));
  assert.ok(fn.workerMarked >= 1, `🔴 no functions worker carried the run marker: ${JSON.stringify(fn)}`);
  report.functions = `discovery loaded index.js through lib/admin.js's validator (would refuse otherwise); reportClientVersion → ${fn.status}; ${fn.workerMarked} marked worker(s)`;

  fs.rmSync(ctl, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
  console.log('\nemu-isolation proof: ALL PASSED');
  process.exit(0);
}

const [mode, ...args] = process.argv.slice(2);
const main = mode === 'inside' ? () => inside(...args)
  : mode === 'functions' ? () => insideFunctions(...args)
    : mode === 'noop' ? async () => { require('./_emulator-required')('database'); console.log('  ✓ 1 noop'); process.exit(0); }
      : mode === 'run' ? () => run(...args)
        : () => { console.error('usage: emu-isolation.proof.js run <second-worktree>'); process.exit(2); };
main().catch((e) => { console.error('emu-isolation proof FAILED:', e && e.stack || e); process.exit(1); });
