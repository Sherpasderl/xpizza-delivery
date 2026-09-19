'use strict';
/* Guards the per-checkout emulator ports.
 *
 * 🔴 WHAT THIS PROTECTS. Two checkouts on one machine used to share the Firebase default ports, so a
 * suite run while another checkout's emulator was up could ATTACH to it, assert against a foreign
 * tree, and still report green. tools/emulator-run.js fixes that two ways — per-checkout ports, and a
 * preflight that refuses a bound port instead of attaching. Both are only worth anything while every
 * suite goes through the runner and no suite names a port itself, which is what these cells hold.
 *
 * Needs no emulator: the refusal path returns before firebase is ever launched.
 */
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { planPorts, SLOTS } = require('./emulator-run.js');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  // ── 1. EVERY SUITE GOES THROUGH THE RUNNER ──────────────────────────────────────────────────
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const direct = Object.entries(pkg.scripts || {}).filter(([, v]) => /firebase\s+emulators:exec/.test(v));
    assert.deepStrictEqual(direct.map(([k]) => k), [],
      '🔴 a script calls `firebase emulators:exec` directly, bypassing the preflight — it can attach to another checkout\'s emulator and report green');
    const viaRunner = Object.values(pkg.scripts || {}).filter((v) => /emulator-run\.js/.test(v));
    assert.ok(viaRunner.length >= 40, `premise — the runner is actually in use (${viaRunner.length} scripts)`);

    /* `emulators:start` is the other way to launch one, and it was not covered until it was looked
       for. `serve` is the single deliberate exemption: it is an interactive dev convenience, not a
       suite, and it asserts nothing — so a shared port there costs a confusing startup, never a green
       run on a foreign tree. Any NEW direct invocation has to be added here on purpose. */
    const ALLOWED_DIRECT = new Set(['serve']);
    const directStart = Object.entries(pkg.scripts || {})
      .filter(([k, v]) => /firebase\s+emulators:(start|exec)/.test(v) && !ALLOWED_DIRECT.has(k));
    assert.deepStrictEqual(directStart.map(([k]) => k), [],
      '🔴 a script launches an emulator directly instead of through the runner — no preflight, and a default port shared with every other checkout');
    ok(`all ${viaRunner.length} emulator scripts go through the runner; the only direct launch is the documented \`serve\``);
  }

  // ── 2. NO SUITE NAMES A PORT ITSELF ─────────────────────────────────────────────────────────
  /* catalog-rules did exactly this (`port: 8080`) and would have kept pointing at the default after
     the move — the one suite that opted out of env detection by writing a number down. */
  {
    const offenders = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))) {
      const src = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8');
      for (const m of src.matchAll(/port:\s*(\d{4})/g)) {
        if (['8080', '9000', '4400', '4000', '9150', '5001'].includes(m[1])) offenders.push(`${f} → port: ${m[1]}`);
      }
    }
    assert.deepStrictEqual(offenders, [],
      '🔴 a test names a default emulator port instead of reading FIRESTORE_EMULATOR_HOST / FIREBASE_DATABASE_EMULATOR_HOST — it will not follow the checkout\'s ports');
    ok('no suite hardcodes a default emulator port');
  }

  // ── 3. THE PORT BLOCKS CANNOT OVERLAP, FOR ANY TWO CHECKOUTS ────────────────────────────────
  /* The reason the offsets step by 10 and stop at 390: with a wider range one checkout's UI port
     lands on another checkout's hub (4000+800 == 4400+400). That collision would be caught by the
     preflight rather than silently attaching, but it would be a confusing refusal for no reason.
     This asserts the arithmetic instead of trusting the comment. */
  {
    const seen = new Map();
    for (let i = 0; i < SLOTS; i++) {
      const p = planPorts(i * 10);
      for (const [svc, port] of Object.entries(p)) {
        if (seen.has(port)) {
          assert.fail(`🔴 port ${port} is claimed by ${svc}@offset${i * 10} AND ${seen.get(port)} — two checkouts would fight over it`);
        }
        seen.set(port, `${svc}@offset${i * 10}`);
      }
    }
    const zero = planPorts(0);
    assert.strictEqual(zero.firestore, 8080, 'premise — offset 0 is the familiar default block');
    ok(`all ${seen.size} ports across all ${SLOTS} checkout slots are distinct — no service can collide with another`);
  }

  // ── 4. 🔴 A BOUND PORT REFUSES; IT DOES NOT ATTACH ──────────────────────────────────────────
  /* The load-bearing cell. Everything else is arrangement; this is the behaviour that turns a silent
     cross-checkout read into a loud stop. Uses the top slot so it cannot disturb a default-port
     emulator belonging to anyone else. */
  {
    const OFF = (SLOTS - 1) * 10;
    const port = planPorts(OFF).firestore;
    const squatter = net.createServer();
    await new Promise((res, rej) => { squatter.once('error', rej); squatter.listen(port, '127.0.0.1', res); });
    try {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'emulator-run.js'), '--only', 'firestore', '--project', 'demo-xpizza', 'node -e "process.exit(0)"'],
        { cwd: ROOT, encoding: 'utf8', env: { ...process.env, XPIZZA_EMU_PORT_OFFSET: String(OFF) } });
      assert.strictEqual(r.status, 3,
        `🔴 a bound port did not refuse (exit ${r.status}) — the run either attached to whatever is listening or started anyway`);
      assert.match(r.stderr, /REFUSED TO START/, 'the refusal is loud');
      assert.match(r.stderr, new RegExp(`127\\.0\\.0\\.1:${port}`), 'the refusal names the port that is taken');
      assert.doesNotMatch(r.stdout || '', /Running script/, '🔴 the suite command ran despite the refusal');
    } finally {
      await new Promise((res) => squatter.close(res));
    }
    ok('a bound port REFUSES with exit 3 and names the port — it never attaches, and the suite command does not run');
  }

  // ── 5. A MALFORMED OVERRIDE FAILS CLOSED ────────────────────────────────────────────────────
  /* An unusable XPIZZA_EMU_PORT_OFFSET must stop, not fall back to the derived block: a typo that
     silently reverted to the default ports is the exact thing this tool exists to prevent. */
  {
    for (const bad of ['7', '-10', '400', 'eight', '10.5']) {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'emulator-run.js'), '--only', 'firestore', 'node -e "process.exit(0)"'],
        { cwd: ROOT, encoding: 'utf8', env: { ...process.env, XPIZZA_EMU_PORT_OFFSET: bad } });
      assert.strictEqual(r.status, 2, `🔴 XPIZZA_EMU_PORT_OFFSET=${bad} was accepted or fell back instead of refusing`);
    }
    ok('a malformed port offset refuses (exit 2) rather than falling back to a default block');
  }

  // ── 6. AN UNKNOWN SERVICE REFUSES RATHER THAN TAKING A SHARED DEFAULT ───────────────────────
  /* 🔴 THE HOLE THAT WAS ACTUALLY THERE. An --only the runner had no band for fell straight through:
     nothing preflighted, nothing pinned in the generated config, so firebase started that emulator on
     its own shared default (auth 9099, storage 9199, pubsub 8085). Adding one emulator service would
     have quietly reintroduced the cross-checkout collision this whole tool removes. */
  {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'emulator-run.js'), '--only', 'auth', 'node -e "process.exit(0)"'],
      { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(r.status, 2, '🔴 an unknown --only service did not refuse — its emulator would take an unpreflighted default port');
    assert.match(r.stderr, /no port band for/, 'the refusal says why');
    assert.doesNotMatch(r.stdout || '', /Running script/, '🔴 the suite command ran anyway');
    ok('an --only service with no port band REFUSES (exit 2) instead of falling back to a shared default');
  }

  // ── 7. A STRAY GENERATED CONFIG IS SWEPT, AND CANNOT DIRTY THE TREE ─────────────────────────
  /* A SIGKILL or a crash leaves the pid-suffixed config behind. Three things have to hold: the
     pattern is ignored by git (a stray must not dirty a tree the gate reads with git status), a
     later run sweeps strays whose pid is gone, and a live run's own file is never swept by another. */
  {
    const ignored = spawnSync('git', ['check-ignore', 'firebase.emulator.12345.json'], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(ignored.status, 0, '🔴 the generated config pattern is NOT gitignored — a stray would dirty the tree at commit time');

    const stray = path.join(ROOT, 'firebase.emulator.999999.json');
    fs.writeFileSync(stray, '{}');
    const mine = path.join(ROOT, `firebase.emulator.${process.pid}.json`);
    fs.writeFileSync(mine, '{}');                       // a LIVE pid — this one must survive
    try {
      spawnSync(process.execPath, [path.join(ROOT, 'tools', 'emulator-run.js'), '--only', 'auth', 'node -e "process.exit(0)"'],
        { cwd: ROOT, encoding: 'utf8' });               // refuses at once; the sweep still runs
      assert.ok(!fs.existsSync(stray), '🔴 a stray config from a dead pid was left behind — it accumulates and can dirty the tree');
      assert.ok(fs.existsSync(mine), '🔴 the sweep deleted a LIVE run\'s config — it would pull the rug from a concurrent run');
    } finally {
      for (const f of [stray, mine]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
    }
    ok('a stray config from a dead pid is swept at startup, a live pid\'s is left alone, and the pattern is gitignored');
  }

  console.log(`emulator-ports guard: OK (${n})`);
})().catch((e) => { console.error('EMULATOR PORTS GUARD FAILED:', (e && e.stack) || e); process.exit(1); });
