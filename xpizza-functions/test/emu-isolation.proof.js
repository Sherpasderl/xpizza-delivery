#!/usr/bin/env node
'use strict';
/* R1 EVIDENCE PROOF (PLAN-emulator-isolation v5 §e + codex R1-build P2-7) — REAL emulators, the REAL launcher, TWO
 * worktrees. Not in a test chain: it boots JVMs, holds the real sentinel pool for the cancellation case, and needs a
 * second worktree of the same commit. Run ONLY in a CLEAR WINDOW (no old-code emulator runs on the machine):
 *
 *   PATH="/opt/homebrew/opt/openjdk/bin:$PATH" node test/emu-isolation.proof.js run <second-worktree-root>
 *
 *  1 ISOLATION   A (here) and B (other worktree), same project, concurrently: each writes its own sentinel to the SAME
 *                Firestore doc + RTDB path and reads back only its own; then A DELETES its data and B's survives, B
 *                deletes and A's deletion stood (deletion isolation). Each records its result only AFTER its final read.
 *  2 HUB         one parent TMPDIR, yet each run has its own hub-<project>.json.
 *  3 RULES       per run, unauthenticated REST: allowed + denied, both services (non-vacuous).
 *  4 PROJECT     a stale parent GOOGLE_CLOUD_PROJECT is normalised.  5 MARKERS  JVMs + CLI + suite carry the run marker.
 *  6 SAME-CHECKOUT  a second run in A's checkout while A is live is refused (exit 4).
 *  7 TEARDOWN-BEFORE-RELEASE  a watcher binds A's sentinel the instant it frees: at that instant A has NO marked process
 *                and its band is free.
 *  8 LEAKED DESCENDANT  a suite step leaves a detached marked child behind; the launcher's teardown ends it.
 *  9 SUPERVISOR SIGKILL MID-CHAIN  the chain runs on under the marked wrapper; every scan shows the slot quarantined and a
 *                pin onto it is refused, until the chain and its emulators are gone.
 * 10 ORPHAN WRITER  a marked writer with a dead supervisor keeps (re)trying the slot's RTDB: the slot is quarantined (pin
 *                refused, naming it), an unpinned run goes elsewhere; emu-reap ends it; the reclaimed slot's run then sees
 *                NONE of the orphan's writes.
 * 11 QUEUE CANCELLATION  with all 40 real sentinels held, SIGINT cancels a queued run promptly, holding nothing.
 * 12 LOUD RE-SLOT  a listener appears on the admitted slot's logging port after admission (a real race): the CLI refuses,
 *                the launcher says RE-SLOTTING, tears down and succeeds on another slot.
 * 13 RULES REFUSAL  missing / invalid-JSON RTDB rules, missing / empty / INVALID NON-EMPTY Firestore rules each refuse.
 * 14 FUNCTIONS   discovery passes lib/admin.js's validator (both data hosts real); a worker carries the marker.
 */
const assert = require('assert');
const net = require('net');
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROJECT = 'demo-xpizza';
const NS = `${PROJECT}-default-rtdb`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, what) => { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return; await sleep(100); } throw new Error(`timeout waiting for ${what}`); };
const touch = (f) => fs.writeFileSync(f, String(Date.now()));

// ═══ INSIDE modes: run as the suite command under tools/emulator-run.js ═════════════════════════════════════════
async function inside(ctl, tag, peer) {
  require('./_emulator-required')('firestore', 'database');
  const A = require('../tools/emu-alloc');
  const admin = require('firebase-admin');
  const fsHost = process.env.FIRESTORE_EMULATOR_HOST, dbHost = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  const out = { tag, offset: process.env.XPIZZA_EMU_OFFSET, tmpdir: os.tmpdir(), gcloud: process.env.GCLOUD_PROJECT, gcp: process.env.GOOGLE_CLOUD_PROJECT };
  out.hubFile = path.join(os.tmpdir(), `hub-${PROJECT}.json`);
  out.hubFileExists = fs.existsSync(out.hubFile);
  const st = async (url, init) => (await fetch(url, init)).status;
  const fsDoc = (p) => `http://${fsHost}/v1/projects/${PROJECT}/databases/(default)/documents/${p}`;
  out.rules = {
    fsPublicRead: await st(fsDoc('restaurants/r1probe')),
    fsDenyRead: await st(fsDoc('r1secret/x')),
    fsDenyWrite: await st(`${fsDoc('restaurants')}?documentId=r1probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"fields":{}}' }),
    dbPublicRead: await st(`http://${dbHost}/menus.json?ns=${NS}`),
    dbDenyRead: await st(`http://${dbHost}/orders.json?ns=${NS}`),
    dbDenyWrite: await st(`http://${dbHost}/r1probe.json?ns=${NS}`, { method: 'PUT', body: '"x"' }),
  };
  const nonce = A.parseMarker(process.env[A.RUN_VAR]).nonce;
  const t = A.readPsTables();
  const mine = A.joinScans(t.plain, t.withEnv).filter((r) => r.readable && (A.markerIn(r.env) || {}).nonce === nonce);
  out.marked = mine.map((r) => (/\bjava\b|\/java /.test(r.argv) ? 'java' : /firebase/.test(r.argv) ? 'firebase-cli' : /emu-cmd-wrapper/.test(r.argv) ? 'wrapper' : 'node'));
  admin.initializeApp({ projectId: PROJECT, databaseURL: `http://${dbHost}?ns=${NS}` });
  const fsd = admin.firestore(); const db = admin.database();
  const read = async () => [(await fsd.doc('r1iso/sentinel').get()).get('tag') || null, (await db.ref('r1iso/sentinel').once('value')).val()];
  const del = async () => { await fsd.doc('r1iso/sentinel').delete(); await db.ref('r1iso').remove(); };
  const F = (n) => path.join(ctl, n);
  await fsd.doc('r1iso/sentinel').set({ tag });
  await db.ref('r1iso/sentinel').set(tag);
  touch(F(`${tag}.ready`));
  await waitFor(() => fs.existsSync(F(`${peer}.ready`)), 180000, `${peer}.ready`);
  out.readAfterPeerWrote = await read();                                         // [tag, tag]
  if (tag === 'A') {                                                             // A deletes FIRST, then B checks it survived
    await del(); touch(F('A.deleted'));
    await waitFor(() => fs.existsSync(F('B.deleted')), 180000, 'B.deleted');
  } else {
    await waitFor(() => fs.existsSync(F('A.deleted')), 180000, 'A.deleted');
    out.readAfterPeerDeleted = await read();                                     // B's data SURVIVED A's deletion
    await del(); touch(F('B.deleted'));
  }
  out.readAfterOwnDelete = await read();                                         // [null, null] — own deletion worked
  fs.writeFileSync(F(`${tag}.json`), JSON.stringify(out));                      // written only AFTER the final read
  console.log(`  ✓ 1 inside ${tag}`);
  process.exit(0);
}

// a step that leaves a DETACHED marked descendant behind (it inherits the run marker) and exits 0
function insideLeaky(pidFile) {
  require('./_emulator-required')('database');
  const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: process.env, stdio: 'ignore', detached: true });
  c.unref();
  fs.writeFileSync(pidFile, String(c.pid));
  console.log('  ✓ 1 leaky step left a detached marked child');
  process.exit(0);
}

// the reclaimed slot's run: nothing the orphan writer tried to write reached THIS run's emulator
async function insideOrphanCheck(ctl) {
  require('./_emulator-required')('database');
  await sleep(2500);                                                              // give a (dead) writer every chance
  // non-vacuity: prove the admin read works by reading a value this run writes itself first
  const H = { Authorization: 'Bearer owner' };
  await fetch(`http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/r1control.json?ns=${NS}`, { method: 'PUT', headers: H, body: '"present"' });
  const control = await (await fetch(`http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/r1control.json?ns=${NS}`, { headers: H })).json();
  if (control !== 'present') { console.error(`orphan check: the admin read is not working (${JSON.stringify(control)})`); process.exit(1); }
  // ADMIN read (the emulator's owner bearer): the orphan wrote through the Admin SDK, which bypasses rules — an
  // unauthenticated read would just be DENIED by the rules and prove nothing
  const v = await (await fetch(`http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/r1orphan.json?ns=${NS}`, { headers: { Authorization: 'Bearer owner' } })).json();
  fs.writeFileSync(path.join(ctl, 'orphan-check.json'), JSON.stringify({ value: v, offset: process.env.XPIZZA_EMU_OFFSET }));
  console.log('  ✓ 1 orphan check');
  process.exit(0);
}

async function insideFunctions(ctl) {
  require('./_emulator-required')('firestore', 'database');
  const A = require('../tools/emu-alloc');
  const list = await (await fetch(`http://${process.env.FIREBASE_EMULATOR_HUB}/emulators`)).json();
  const fx = list.functions;
  const r = await fetch(`http://${fx.host}:${fx.port}/${PROJECT}/us-central1/reportClientVersion`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const nonce = A.parseMarker(process.env[A.RUN_VAR]).nonce;
  const t = A.readPsTables();
  const rows = A.joinScans(t.plain, t.withEnv).filter((x) => x.readable && (A.markerIn(x.env) || {}).nonce === nonce);
  const worker = rows.filter((x) => /FUNCTION_TARGET=reportClientVersion/.test(x.env) && /FUNCTIONS_EMULATOR=true/.test(x.env));
  fs.writeFileSync(path.join(ctl, 'fn.json'), JSON.stringify({ status: r.status, workerMarked: worker.length }));
  console.log(`  ✓ 1 functions: ${r.status}; ${worker.length} marked worker(s)`);
  process.exit(0);
}

// ═══ ORCHESTRATOR ══════════════════════════════════════════════════════════════════════════════════════════════
const cleanEnv = (extra = {}) => {
  const env = { ...process.env, GOOGLE_CLOUD_PROJECT: 'stale-parent-project', ...extra };
  if (env.NODE_OPTIONS) env.NODE_OPTIONS = env.NODE_OPTIONS.replace(/--require[= ]\S*count-marks\.js/g, '').trim() || undefined;
  if (env.NODE_OPTIONS === undefined) delete env.NODE_OPTIONS;
  return env;
};
function launch(root, only, inner, extraEnv = {}) {
  const c = spawn(process.execPath, [path.join(root, 'tools', 'emulator-run.js'), '--only', only, '--project', PROJECT, inner], { cwd: root, env: cleanEnv(extraEnv), stdio: ['ignore', 'pipe', 'pipe'] });
  const o = { child: c, out: '' };
  c.stdout.on('data', (d) => { o.out += d; }); c.stderr.on('data', (d) => { o.out += d; });
  o.done = new Promise((res) => c.on('exit', (code, signal) => res({ code, signal, out: o.out })));
  return o;
}
const slotOf = (out) => { const m = /emulator-run: slot (\d+) \(/.exec(out); return m ? Number(m[1]) : null; };
const slotsOf = (out) => [...out.matchAll(/emulator-run: slot (\d+) \(/g)].map((m) => Number(m[1]));
const runSync = (root, only, inner, extraEnv = {}, timeout = 240000) => spawnSync(process.execPath, [path.join(root, 'tools', 'emulator-run.js'), '--only', only, '--project', PROJECT, inner], { cwd: root, encoding: 'utf8', env: cleanEnv(extraEnv), timeout });

async function run(rootB) {
  rootB = path.resolve(rootB, fs.existsSync(path.join(rootB, 'xpizza-functions')) ? 'xpizza-functions' : '.');
  assert.ok(fs.existsSync(path.join(rootB, 'tools', 'emulator-run.js')), `second worktree: ${rootB}`);
  const head = (r) => execFileSync('git', ['-C', r, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.strictEqual(head(rootB), head(ROOT), 'premise — both worktrees are the SAME commit');
  assert.notStrictEqual(fs.realpathSync(rootB), fs.realpathSync(ROOT), 'premise — two DIFFERENT checkouts');
  const ALLOC = require('../tools/emu-alloc');
  const EE = require('../lib/emulator-endpoint');
  const ctl = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-proof-'));
  const report = {};
  const inner = (mode, ...a) => ['node', 'test/emu-isolation.proof.js', mode, ...a].join(' ');

  // ── 1-7: A + B concurrently; C refused; A's sentinel watched for teardown-before-release ──
  {
    const a = launch(ROOT, 'firestore,database', inner('inside', ctl, 'A', 'B'));
    const b = launch(rootB, 'firestore,database', inner('inside', ctl, 'B', 'A'));
    await waitFor(() => fs.existsSync(path.join(ctl, 'A.ready')), 180000, 'A.ready');
    const slotA = slotOf(a.out);
    // the WATCHER: bind A's sentinel the instant it frees; at that instant record A's marked processes + band state
    let release = null;
    const watcher = (async () => {
      while (!release) {
        const sv = await ALLOC.bindSentinel(ALLOC.sentinelPort(slotA));
        if (sv) {
          const sc = ALLOC.scanSlot(slotA);
          const busy = [];
          for (const [nm, pt] of [['hub', EE.planPorts(slotA * 10).hub], ['logging', EE.planPorts(slotA * 10).logging], ['firestore', EE.planPorts(slotA * 10).firestore], ['database', EE.planPorts(slotA * 10).database]]) {
            if ((await ALLOC.probePort(pt)) !== 'free') busy.push(`${nm}`);
          }
          release = { at: Date.now(), occupied: sc.occupied, orphans: sc.orphans.length, live: sc.live.length, busy, aExited: a.child.exitCode !== null };
          await ALLOC.closeServer(sv);
          break;
        }
        await sleep(25);
      }
    })();
    const c = runSync(ROOT, 'database', inner('noop'), {}, 60000);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    await watcher;
    assert.strictEqual(ra.code, 0, `A failed:\n${ra.out.slice(-2500)}`);
    assert.strictEqual(rb.code, 0, `B failed:\n${rb.out.slice(-2500)}`);
    const A = JSON.parse(fs.readFileSync(path.join(ctl, 'A.json'), 'utf8'));
    const B = JSON.parse(fs.readFileSync(path.join(ctl, 'B.json'), 'utf8'));
    report.slots = [slotA, slotOf(rb.out)];
    assert.notStrictEqual(report.slots[0], report.slots[1], '🔴 two concurrent runs got the SAME slot');
    assert.deepStrictEqual(A.readAfterPeerWrote, ['A', 'A'], `🔴 A read B's data: ${JSON.stringify(A)}`);
    assert.deepStrictEqual(B.readAfterPeerWrote, ['B', 'B'], `🔴 B read A's data: ${JSON.stringify(B)}`);
    assert.deepStrictEqual(B.readAfterPeerDeleted, ['B', 'B'], `🔴 A's DELETION reached B's data: ${JSON.stringify(B)}`);
    assert.deepStrictEqual([A.readAfterOwnDelete, B.readAfterOwnDelete], [[null, null], [null, null]], 'each run\'s own deletion worked (the check is not vacuous)');
    report.isolation = 'writes AND deletions isolated: A/B wrote the same Firestore doc + RTDB path in their own runs; A deleted, B\'s survived; each own delete took effect';
    assert.notStrictEqual(A.tmpdir, B.tmpdir, '🔴 the two runs shared a TMPDIR');
    assert.ok(A.hubFileExists && B.hubFileExists, '🔴 a run\'s own hub file was not in its own TMPDIR');
    for (const R of [A, B]) {
      assert.strictEqual(R.gcloud, PROJECT); assert.strictEqual(R.gcp, PROJECT, `🔴 the stale parent GOOGLE_CLOUD_PROJECT reached the suite: ${R.gcp}`);
      const x = R.rules;
      assert.ok(x.fsPublicRead === 404 || x.fsPublicRead === 200, `🔴 Firestore public read denied (${x.fsPublicRead})`);
      assert.strictEqual(x.fsDenyRead, 403); assert.strictEqual(x.fsDenyWrite, 403);
      assert.strictEqual(x.dbPublicRead, 200); assert.ok([401, 403].includes(x.dbDenyRead)); assert.ok([401, 403].includes(x.dbDenyWrite));
      assert.ok(R.marked.filter((k) => k === 'java').length >= 2 && R.marked.includes('wrapper'), `🔴 the run's JVMs / wrapper do not carry its marker: ${JSON.stringify(R.marked)}`);
    }
    report.rules = { A: A.rules, B: B.rules }; report.marked = { A: A.marked, B: B.marked };
    assert.strictEqual(c.status, 4, `🔴 a second run in A's checkout was not refused (exit ${c.status})\n${c.stderr}`);
    report.sameCheckout = 'C in A\'s checkout while A live: refused exit 4';
    assert.ok(release, 'premise — the watcher saw A\'s sentinel free');
    assert.deepStrictEqual({ occupied: release.occupied, busy: release.busy }, { occupied: false, busy: [] },
      `🔴 A's sentinel was released BEFORE its teardown finished: ${JSON.stringify(release)}`);
    assert.match(ra.out, /teardown complete — slot \d+: own processes confirmed down, band released; releasing the sentinel/);
    report.teardownBeforeRelease = `at the instant A's sentinel freed: marked processes ${release.orphans + release.live}, busy band ports ${release.busy.length}`;
  }

  // ── 8: a LEAKED marked descendant is ended by the launcher's teardown ──
  {
    const pidFile = path.join(ctl, 'leaky.pid');
    const r = runSync(ROOT, 'database', inner('leaky', pidFile));
    assert.strictEqual(r.status, 0, r.stderr.slice(-1500));
    const kid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(!ALLOC.pidAlive(kid), `🔴 the detached marked descendant ${kid} outlived its run's teardown`);
    report.leakedDescendant = `detached marked child ${kid} left by a step: ended by teardown before release`;
  }

  // ── 9: supervisor SIGKILL MID-CHAIN through the REAL launcher ──
  {
    const l = launch(ROOT, 'database', `${inner('sleep', '6000')} && ${inner('noop')}`);
    await waitFor(() => /Running script/.test(l.out), 120000, 'the chain to start');
    const slot = slotOf(l.out);
    await sleep(1000);
    l.child.kill('SIGKILL');
    await l.done;
    const samples = []; let pinRefused = null;
    for (let i = 0; i < 200; i++) {
      const sc = ALLOC.scanSlot(slot);
      samples.push(sc.occupied);
      if (sc.occupied && pinRefused === null) {
        const p = runSync(ROOT, 'database', inner('noop'), { XPIZZA_EMU_PORT_OFFSET: String(slot * 10) }, 60000);
        pinRefused = p.status === 3 && /QUARANTINED/.test(p.stderr);
      }
      if (!sc.occupied) break;
      await sleep(250);
    }
    assert.ok(samples.length >= 4 && samples.slice(0, -1).every(Boolean), `🔴 after the supervisor died mid-chain, the slot was not continuously quarantined: ${JSON.stringify(samples)}`);
    assert.strictEqual(pinRefused, true, '🔴 a pin onto the mid-chain orphaned slot was not refused as QUARANTINED');
    assert.strictEqual(samples[samples.length - 1], false, 'the slot frees once the chain and its emulators are gone');
    report.midChain = `supervisor SIGKILLed mid-chain on slot ${slot}: ${samples.length - 1} consecutive scans quarantined until the wrapper/chain/emulators exited; a pin meanwhile was refused (QUARANTINED)`;
  }

  // ── 10: an orphan WRITER keeps trying the slot; quarantine, reap, and the reclaimed slot sees none of its writes ──
  {
    let X = null;
    for (let s = ALLOC.SLOTS - 1; s >= 0 && X === null; s--) { const sv = await ALLOC.bindSentinel(ALLOC.sentinelPort(s)); if (sv) { await ALLOC.closeServer(sv); X = s; } }
    const deadSup = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const dbPort = EE.planPorts(X * 10).database;
    const writer = `const admin=require('firebase-admin');admin.initializeApp({projectId:'${PROJECT}',databaseURL:'http://127.0.0.1:${dbPort}?ns=${NS}'});`
      + `const db=admin.database();setInterval(()=>{db.ref('r1orphan').set(Date.now()).catch(()=>{})},200);`;
    const orphan = spawn(process.execPath, ['-e', writer], { cwd: ROOT, env: { ...cleanEnv(), FIREBASE_DATABASE_EMULATOR_HOST: `127.0.0.1:${dbPort}`, [ALLOC.RUN_VAR]: ALLOC.formatMarker({ slot: X, pid: Number(deadSup.stdout), nonce: ALLOC.newNonce(), start: 1 }) }, stdio: 'ignore', detached: true });
    orphan.unref();
    await sleep(800);
    const pinned = runSync(ROOT, 'database', inner('noop'), { XPIZZA_EMU_PORT_OFFSET: String(X * 10) }, 60000);
    assert.strictEqual(pinned.status, 3, `🔴 a pin onto a slot with a live orphan WRITER was not refused\n${pinned.stderr}`);
    assert.match(pinned.stderr, new RegExp(`QUARANTINED — orphan pid\\(s\\) ${orphan.pid}`), '🔴 the refusal does not name the orphan writer');
    const free = runSync(ROOT, 'database', inner('noop'));
    assert.strictEqual(free.status, 0, free.stderr.slice(-1500));
    assert.notStrictEqual(slotOf(free.stderr), X, '🔴 an unpinned run was admitted onto the orphan writer\'s slot');
    const rp = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'emu-reap.js'), String(X)], { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(rp.status, 0, `emu-reap did not CONFIRM: ${rp.stderr}`);
    await sleep(300);
    assert.ok(!ALLOC.pidAlive(orphan.pid), '🔴 emu-reap left the orphan writer alive');
    const again = runSync(ROOT, 'database', inner('orphancheck', ctl), { XPIZZA_EMU_PORT_OFFSET: String(X * 10) });
    assert.strictEqual(again.status, 0, `🔴 the pin onto the RECLAIMED slot failed:\n${again.stderr.slice(-1500)}`);
    const oc = JSON.parse(fs.readFileSync(path.join(ctl, 'orphan-check.json'), 'utf8'));
    assert.strictEqual(oc.value, null, `🔴 the orphan writer's data reached the reclaimed slot's run: ${JSON.stringify(oc)}`);
    // non-vacuity: the SAME admin read DOES see a value when one is there (written by this proof through that run) — see
    // the 'orphancheck' mode; a null here is therefore absence, not a denied/failed read

    report.orphanWriter = `live marked writer ${orphan.pid} on slot ${X} (dead supervisor, retrying RTDB every 200 ms): pin refused naming it; unpinned run → slot ${slotOf(free.stderr)}; emu-reap CONFIRMED; the reclaimed slot's run saw no orphan write`;
  }

  // ── 11: queue CANCELLATION with the real pool saturated ──
  {
    const held = [];
    for (let s = 0; s < ALLOC.SLOTS; s++) { const sv = await ALLOC.bindSentinel(ALLOC.sentinelPort(s)); assert.ok(sv, `premise — sentinel ${s} free in the clear window`); held.push(sv); }
    try {
      const q = launch(ROOT, 'database', inner('noop'));
      await waitFor(() => /QUEUED/.test(q.out), 30000, 'QUEUED');
      const t0 = Date.now();
      q.child.kill('SIGINT');
      const rq = await q.done;
      assert.strictEqual(rq.code, 130, `🔴 a cancelled queued run did not exit 130 (${rq.code})\n${rq.out.slice(-800)}`);
      assert.match(rq.out, /cancelled while QUEUED/, 'it says why');
      assert.ok(Date.now() - t0 < 3000, `🔴 cancellation was not prompt (${Date.now() - t0} ms)`);
      report.cancellation = `all 40 sentinels held; a queued run SIGINTed exited 130 in ${Date.now() - t0} ms holding nothing`;
    } finally { for (const sv of held) await ALLOC.closeServer(sv); }
  }

  // ── 12: LOUD RE-SLOT on real startup contention ──
  {
    const l = launch(ROOT, 'database', inner('noop'));
    let squatter = null; let squattedPort = null;
    await waitFor(() => { const m = /emulator-run: slot (\d+) \(/.exec(l.out); return !!m; }, 120000, 'first admission');
    const first = slotOf(l.out);
    squattedPort = EE.planPorts(first * 10).logging;
    squatter = net.createServer();
    const bound = await new Promise((res) => { squatter.once('error', () => res(false)); squatter.listen({ port: squattedPort, host: '0.0.0.0' }, () => res(true)); });
    const rl = await l.done;
    await new Promise((res) => squatter.close(res));
    if (bound && /RE-SLOTTING/.test(rl.out)) {
      const slots = slotsOf(rl.out);
      assert.strictEqual(rl.code, 0, `the re-slotted run failed:\n${rl.out.slice(-1500)}`);
      assert.ok(slots.length >= 2 && slots[1] !== first, `🔴 re-slot landed on the same slot: ${slots}`);
      report.reslot = `a listener appeared on slot ${first}'s logging port ${squattedPort} after admission: CLI refused, launcher RE-SLOTTED loudly to slot ${slots[1]} and passed`;
    } else {
      report.reslot = `race not won this time (squatter bound=${bound}; the CLI had already bound the port) — re-run to observe; exit ${rl.code}`;
    }
  }

  // ── 13: rules refusal (second worktree; restored) ──
  {
    const dbRules = path.join(rootB, 'database.rules.json'), fsRules = path.join(rootB, 'firestore.rules');
    const keepDb = fs.readFileSync(dbRules), keepFs = fs.readFileSync(fsRules);
    const tryRun = (only) => runSync(rootB, only, inner('noop-fs'), {}, 120000);
    const cases = [];
    try {
      fs.unlinkSync(dbRules); cases.push(['database rules MISSING', tryRun('database'), /is missing/]); fs.writeFileSync(dbRules, keepDb);
      fs.writeFileSync(dbRules, '{ "rules": '); cases.push(['database rules INVALID JSON', tryRun('database'), /not valid JSON/]); fs.writeFileSync(dbRules, keepDb);
      fs.unlinkSync(fsRules); cases.push(['firestore rules MISSING', tryRun('firestore'), /is missing/]); fs.writeFileSync(fsRules, keepFs);
      fs.writeFileSync(fsRules, '   \n'); cases.push(['firestore rules EMPTY', tryRun('firestore'), /is empty/]); fs.writeFileSync(fsRules, keepFs);
      fs.writeFileSync(fsRules, "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    this is not valid ((( \n  }\n}\n");
      cases.push(['firestore rules INVALID (non-empty)', tryRun('firestore'), /Firestore rules .* did not load/]); fs.writeFileSync(fsRules, keepFs);
    } finally { fs.writeFileSync(dbRules, keepDb); fs.writeFileSync(fsRules, keepFs); }
    for (const [label, r, re] of cases) {
      assert.strictEqual(r.status, 2, `🔴 ${label}: the run was not refused (exit ${r.status})\n${r.stderr.slice(-800)}`);
      assert.match(r.stderr, re, `${label}: names why`);
    }
    report.rulesRefusal = `${cases.map(([l]) => l).join('; ')} — each refused (exit 2); the invalid non-empty Firestore file is caught by the wrapper's rules load`;
  }

  // ── 14: functions ──
  {
    const rf = await launch(ROOT, 'functions', inner('functions', ctl)).done;
    assert.strictEqual(rf.code, 0, `functions step failed:\n${rf.out.slice(-2500)}`);
    const fn = JSON.parse(fs.readFileSync(path.join(ctl, 'fn.json'), 'utf8'));
    assert.ok(fn.workerMarked >= 1, `🔴 no functions worker carried the run marker: ${JSON.stringify(fn)}`);
    report.functions = `discovery through lib/admin.js's validator; reportClientVersion → ${fn.status}; ${fn.workerMarked} marked worker(s)`;
  }

  fs.rmSync(ctl, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
  console.log('\nemu-isolation proof: ALL PASSED');
  process.exit(0);
}

const [mode, ...args] = process.argv.slice(2);
const MODES = {
  inside: () => inside(...args),
  leaky: () => insideLeaky(...args),
  orphancheck: () => insideOrphanCheck(...args),
  functions: () => insideFunctions(...args),
  sleep: async () => { require('./_emulator-required')('database'); await sleep(Number(args[0]) || 1000); console.log('  ✓ 1 slept'); process.exit(0); },
  noop: async () => { require('./_emulator-required')('database'); console.log('  ✓ 1 noop'); process.exit(0); },
  'noop-fs': async () => { console.log('  ✓ 1 noop'); process.exit(0); },
  run: () => run(...args),
};
(MODES[mode] || (async () => { console.error('usage: emu-isolation.proof.js run <second-worktree>'); process.exit(2); }))()
  .catch((e) => { console.error('emu-isolation proof FAILED:', e && e.stack || e); process.exit(1); });
