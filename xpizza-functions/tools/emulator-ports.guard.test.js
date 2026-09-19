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
const { planPorts, SLOTS, SERVICE_LISTENERS, ALL_HOST_ENV, childEnv } = require('./emulator-run.js');
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

    /* 🔴 EVERY REFUSAL PATH SWEEPS, not just the one that was tested first. The sweep originally sat
       below the --only validation, so refusing runs never swept; it was moved up, and then still sat
       below offsetFor(), which exits 2 on a malformed override — the same ordering bug one level up,
       and cell 7 did not catch it because it only drove the unknown-service path. Both refusals are
       driven here now, and any future early exit should be added to this list. */
    const REFUSALS = [
      [['--only', 'auth', 'node -e "process.exit(0)"'], {}, 'unknown --only service'],
      [['--only', 'firestore', 'node -e "process.exit(0)"'], { XPIZZA_EMU_PORT_OFFSET: '7' }, 'malformed port offset'],
      [['--only', 'firestore', '--ui', 'node -e "process.exit(0)"'], {}, 'a rejected argument'],
    ];
    for (const [args, extraEnv, why] of REFUSALS) {
      const stray = path.join(ROOT, 'firebase.emulator.999999.json');
      fs.writeFileSync(stray, '{}');
      const mine = path.join(ROOT, `firebase.emulator.${process.pid}.json`);
      fs.writeFileSync(mine, '{}');                     // a LIVE pid — this one must survive
      try {
        const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'emulator-run.js'), ...args],
          { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
        assert.strictEqual(r.status, 2, `premise — ${why} refuses`);
        assert.ok(!fs.existsSync(stray), `🔴 the ${why} path left a dead-pid config behind — it accumulates and dirties the tree`);
        assert.ok(fs.existsSync(mine), `🔴 the ${why} path deleted a LIVE run's config — it would pull the rug from a concurrent run`);
      } finally {
        for (const f of [stray, mine]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
      }
    }
    ok(`a dead-pid config is swept on all ${REFUSALS.length} refusal paths, a live pid's is left alone, and the pattern is gitignored`);
  }

  // ── 8. 🔴 ARGUMENTS CANNOT BYPASS THE PREFLIGHT ─────────────────────────────────────────────
  /* Each of these once got through. `--only firestore --only auth`: this runner read the FIRST value
     and Firebase's parser the LAST, so firestore was validated and an unbanded auth emulator started.
     `--config firebase.json`: re-points the CLI at the committed config, restoring the DEFAULT ports
     AFTER different ones were preflighted. `--ui`: overrides enabled:false and starts the UI plus
     logging. `--inspect-functions`: opens an unchecked debug listener. */
  {
    const cases = [
      [['--only', 'firestore', '--only', 'auth'], 'a repeated --only (CLI takes the last, we took the first)'],
      [['--only', 'firestore', '--config', 'firebase.json'], 'a --config that would restore default ports after preflight'],
      [['--only', 'firestore', '--ui'], 'a --ui that would start the UI despite enabled:false'],
      [['--only', 'functions', '--inspect-functions'], 'an --inspect-functions debug listener'],
      [['--only', 'firestore', '--import', './x'], 'any unanticipated flag'],
    ];
    for (const [args, why] of cases) {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'emulator-run.js'), ...args, 'node -e "process.exit(0)"'],
        { cwd: ROOT, encoding: 'utf8' });
      assert.strictEqual(r.status, 2, `🔴 ${why} was accepted — it can change ports or config after the preflight`);
      assert.doesNotMatch(r.stdout || '', /Running script/, `🔴 the command ran despite ${why}`);
    }
    ok(`${cases.length} argument shapes that could bypass the preflight are each refused (exit 2)`);
  }

  // ── 9. 🔴 EVERY LISTENER FIREBASE OPENS IS PREFLIGHTED, NOT JUST THE NAMED SERVICE ──────────
  /* Starting `functions` also starts Eventarc and Cloud Tasks, and the hub and LOGGING come up on
     every run. None of those were banded or checked, and the installed CLI SEARCHES FOR ANOTHER PORT
     when one is busy — retry-instead-of-refuse, through a service nobody listed. */
  {
    assert.deepStrictEqual(SERVICE_LISTENERS.functions, ['functions', 'eventarc', 'tasks'],
      '🔴 functions no longer declares its extra listeners — Eventarc and Cloud Tasks would start unbanded');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'emulator-run.js'), '--only', 'functions', '--project', 'demo-xpizza', 'node -e "process.exit(0)"'],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, XPIZZA_EMU_PORT_OFFSET: '0', PATH: '/nonexistent' } });
    for (const svc of ['hub', 'logging', 'functions', 'eventarc', 'tasks']) {
      assert.match(r.stderr, new RegExp(`${svc} \\d+`), `🔴 ${svc} is not in the preflight set — it would take a shared default port`);
    }
    ok('a functions run preflights hub, logging, functions, eventarc and tasks — every listener it opens');
  }

  // ── 10. THE GENERATED CONFIG CANNOT RIDE INTO A DEPLOY ARCHIVE ──────────────────────────────
  /* 🔴 gitignore IS NOT ENOUGH. The file is written inside the configured functions source dir, and
     Firebase builds the upload from functions.ignore, which does not consult .gitignore. A stray from
     a crashed run would otherwise be packaged and shipped with the functions. */
  {
    const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
    const ignore = (fb.functions && fb.functions[0] && fb.functions[0].ignore) || [];
    assert.ok(ignore.includes('firebase.emulator.*.json'),
      '🔴 functions.ignore does not exclude the generated emulator config — a stray would be uploaded with a deploy');
    ok('the generated config is excluded from the deploy archive by functions.ignore, not only by .gitignore');
  }

  // ── 11. EVERY EMULATOR SUITE REFUSES WHEN ITS HOST VAR IS UNSET ─────────────────────────────
  /* 🔴 "every suite refuses if the host var is unset" was simply false: catalog-rules had a bespoke
     check, catalog-parity and public-menu had none and seeded Admin Firestore regardless. An unset
     var means the Admin SDK targets real infrastructure; an INHERITED one means a foreign emulator,
     green. Same class as the hardcoded port — one suite remembered and nothing said so. */
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const files = new Set();
    for (const v of Object.values(pkg.scripts || {})) {
      if (!/emulator-run\.js/.test(v)) continue;
      for (const m of v.matchAll(/test\/([A-Za-z0-9._-]+\.js)/g)) files.add(m[1]);
    }
    assert.ok(files.size >= 40, `premise — found the emulator suites (${files.size})`);
    const unguarded = [...files].filter((f) => !fs.readFileSync(path.join(ROOT, 'test', f), 'utf8').includes("_emulator-required"));
    assert.deepStrictEqual(unguarded, [],
      '🔴 an emulator suite does not refuse when its host var is unset — it would run against real infrastructure, or an inherited foreign emulator');
    ok(`all ${files.size} emulator suites refuse when their host var is unset`);
  }

  // ── 12. 🔴 AN INHERITED HOST VAR FOR AN UNSERVED SERVICE IS CLEARED, NOT PASSED ON ──────────
  /* Firebase only sets the host var for a service it actually STARTS, and the runner inherits the
     whole environment. So `--only database` in a shell carrying a FIRESTORE_EMULATOR_HOST from
     somewhere else let the suite read THAT emulator silently. This is the shape of the two red
     suites that reach Firestore while starting only the database emulator. */
  {
    const parent = { PATH: '/usr/bin', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:9000', FIREBASE_EMULATOR_HUB: '127.0.0.1:4400', PUBSUB_EMULATOR_HOST: '127.0.0.1:8085' };
    const dbOnly = childEnv(['database'], parent);
    assert.strictEqual(dbOnly.FIRESTORE_EMULATOR_HOST, undefined,
      '🔴 an inherited FIRESTORE_EMULATOR_HOST survived a database-only run — the suite can read a foreign Firestore and pass');
    assert.strictEqual(dbOnly.FIREBASE_DATABASE_EMULATOR_HOST, '127.0.0.1:9000', 'the served service keeps its var (firebase overwrites it with the real port)');
    assert.strictEqual(dbOnly.PUBSUB_EMULATOR_HOST, undefined, 'an unserved service\'s var is cleared too');
    assert.strictEqual(dbOnly.PATH, '/usr/bin', 'the rest of the environment is untouched');
    const both = childEnv(['firestore', 'database'], parent);
    assert.strictEqual(both.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080', 'a served service keeps its var');
    ok('host vars for services the run does not start are CLEARED, so an inherited value can never be used');
  }

  console.log(`emulator-ports guard: OK (${n})`);
})().catch((e) => { console.error('EMULATOR PORTS GUARD FAILED:', (e && e.stack) || e); process.exit(1); });
