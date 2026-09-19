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

  // ── 11. EVERY EMULATOR SUITE ON DISK REFUSES WHEN ITS HOST VAR IS UNSET ────────────────────
  /* 🔴 ENUMERATED FROM DISK, NOT FROM package.json. This cell used to read the scripts — so it could
     only see suites something already ran, and a suite with NO script was invisible to the very check
     meant to catch unguarded suites. There were two: claim-order and claim-prefill. claim-order is a
     MONEY-PATH suite (retro-credit of a guest order's loyalty earn) that threw at require time for
     anyone following its own header, and had never executed. A suite nobody runs is exactly the one
     that needs finding, so the list comes from the filesystem. */
  {
    const files = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.emulator.test.js'));
    assert.ok(files.length >= 43, `premise — the emulator suites are on disk (${files.length})`);
    const unguarded = files.filter((f) => !fs.readFileSync(path.join(ROOT, 'test', f), 'utf8').includes("_emulator-required"));
    assert.deepStrictEqual(unguarded, [],
      '🔴 an emulator suite does not refuse when its host var is unset — it would run against real infrastructure, or an inherited foreign emulator');

    // …and every one of them is reachable by a script, or nothing will ever run it.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const named = new Set();
    for (const v of Object.values(pkg.scripts || {})) {
      if (!/emulator-run\.js/.test(v)) continue;
      for (const m of String(v).matchAll(/test\/([A-Za-z0-9._-]+\.js)/g)) named.add(m[1]);
    }
    const orphans = files.filter((f) => !named.has(f));
    assert.deepStrictEqual(orphans, [],
      '🔴 an emulator suite has no script — the aggregate enumerates scripts, so nothing runs it and its failures are invisible');
    ok(`all ${files.length} emulator suites on disk refuse when their host var is unset, and each is reachable by a script`);
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

  // ── 13. THE GATE LIST IS ENUMERATED, NEVER HAND-KEPT ────────────────────────────────────────
  /* 🔴 THE LOOP WAS THE DEFECT. Twelve of forty-two emulator scripts were being run, so four stayed
     red for an unknown period — one on a real money-path defect, one hiding twenty-one
     redemption-reserve assertions that had not executed since the 1b-1b cutover. A hand-kept list
     cannot be trusted to grow; this asserts the aggregate derives its list from package.json, so a
     suite added tomorrow is gated tomorrow. */
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const expected = Object.entries(pkg.scripts || {}).filter(([, v]) => /emulator-run\.js/.test(v)).length;
    assert.ok(expected >= 40, `premise — the emulator scripts are there (${expected})`);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'emulator-all.js'), '--list'], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, 'the aggregate can list its suites');
    const m = /(\d+) emulator scripts/.exec(r.stdout || '');
    assert.ok(m, 'the listing reports a count');
    assert.strictEqual(Number(m[1]), expected,
      '🔴 the aggregate runs a different set than package.json declares — a hand-kept list has crept back in');
    assert.ok(!/test:emulators:all/.test(r.stdout), 'the aggregate does not list itself (it would recurse)');
    ok(`the aggregate gate list is enumerated from package.json — all ${expected} emulator scripts, itself excluded`);
  }

  // ── 14. 🔴 AN EXCUSE CANNOT OUTLIVE ITS DEFECT, AND A SKIP IS NEVER SILENT ──────────────────
  /* The three outcomes a gate actually turns on, driven directly rather than inferred from one long
     run: a plain failure fails; an allowlisted failure is EXCUSED and still printed; and an
     allowlisted suite that has started PASSING fails the run so the entry must be deleted. That last
     one is the point — an allowlist nobody prunes quietly re-hides the next regression in that
     suite. The empty case fails too: a run that measured nothing is never a pass. */
  {
    const { classify, KNOWN_RED } = require('./emulator-all.js');

    const plainFail = classify([{ name: 'test:a', ok: false }], {});
    assert.strictEqual(plainFail.exitCode, 1, '🔴 an un-excused failing suite did not fail the gate');
    assert.strictEqual(plainFail.rows[0].state, 'fail');

    const excusedFail = classify([{ name: 'test:a', ok: false }], { 'test:a': 'a recorded reason' });
    assert.strictEqual(excusedFail.exitCode, 0, 'an excused failure does not fail the gate');
    assert.strictEqual(excusedFail.rows[0].state, 'excused', 'and it is reported as excused, not hidden');

    const staleExcuse = classify([{ name: 'test:a', ok: true }], { 'test:a': 'a recorded reason' });
    assert.strictEqual(staleExcuse.exitCode, 1,
      '🔴 a KNOWN-RED suite that now PASSES did not fail the run — the excuse would outlive the defect and re-hide the next regression');
    assert.strictEqual(staleExcuse.rows[0].state, 'stale-excuse');

    assert.strictEqual(classify([], {}).exitCode, 1, '🔴 a run that measured nothing reported success');

    for (const [name, reason] of Object.entries(KNOWN_RED)) {
      assert.ok(typeof reason === 'string' && reason.length > 40,
        `🔴 KNOWN_RED["${name}"] has no substantive reason — an excuse without one is a silent skip`);
    }
    ok(`fail / excused / stale-excuse / nothing-measured each decided correctly; all ${Object.keys(KNOWN_RED).length} KNOWN_RED entries carry a reason`);
  }

  // ── 15. THE CLEARED-VAR LIST COVERS WHAT THE INSTALLED CLI CAN ACTUALLY EXPORT ─────────────
  /* 🔴 MY FIRST LIST HAD FIVE HOLES — the Firestore ADDRESS alias, both Storage spellings and all
     three Data Connect spellings — and the Admin SDK honours the Storage and Data Connect aliases,
     so an inherited value for an unserved service still reached a foreign emulator. A list typed from
     memory drifts the moment the CLI adds a service, so this re-derives it from the INSTALLED CLI and
     fails on anything uncovered. Pinned in the runner rather than read at runtime: coupling the
     runner to CLI internals would break every suite the day that layout changes. */
  {
    let cliDir = null;
    for (const d of ['/usr/local/lib/node_modules/firebase-tools', path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'firebase-tools')]) {
      if (fs.existsSync(path.join(d, 'lib', 'emulator'))) { cliDir = d; break; }
    }
    if (!cliDir) {
      // Loud, not silent: the check did not run, and the output says so rather than implying a pass.
      console.log('  ⚠ 15 SKIPPED — firebase-tools not found on this machine, so the CLI env list could not be re-derived');
    } else {
      const seen = new Set();
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, e.name);
          if (e.isDirectory()) { walk(fp); continue; }
          if (!e.name.endsWith('.js')) continue;
          for (const m of fs.readFileSync(fp, 'utf8').matchAll(/["'`]([A-Z][A-Z0-9_]*(?:_HOST|_ADDRESS))["'`]/g)) seen.add(m[1]);
        }
      };
      walk(path.join(cliDir, 'lib', 'emulator'));
      const relevant = [...seen].filter((v) => /EMULATOR/.test(v));
      const uncovered = relevant.filter((v) => !ALL_HOST_ENV.includes(v));
      assert.deepStrictEqual(uncovered, [],
        `🔴 firebase-tools ${require(path.join(cliDir, 'package.json')).version} can export host vars this runner never clears — an inherited one points a suite at a foreign emulator`);
      ok(`the cleared-var list covers all ${relevant.length} emulator host vars the installed CLI can export`);
    }
  }

  // ── 16. 🔴 THE FUNCTIONS DISCOVERY SERVER OPENS NO PORT ─────────────────────────────────────
  /* The CLI discovers functions by booting a temporary admin server on 8000 + randomInt(0,1000) and
     scanning upward — a range covering our firestore 8080-8470 and websocket 8500-8890 bands, on ALL
     interfaces (observed: *:8015). It is the one listener that cannot be pinned, so instead it is not
     started: FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH=true takes the CLI's manifest branch. Without
     this the band table would be quietly false for every functions run. */
  {
    const fns = childEnv(['functions'], { PATH: '/usr/bin' });
    assert.strictEqual(fns.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH, 'true',
      '🔴 a functions run would boot the unpinnable discovery server into our own port bands');
    const dbOnly = childEnv(['database'], { PATH: '/usr/bin' });
    assert.strictEqual(dbOnly.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH, undefined,
      'runs that start no functions are left alone');
    const operator = childEnv(['functions'], { PATH: '/usr/bin', FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH: '/some/real/path' });
    assert.strictEqual(operator.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH, '/some/real/path',
      'an operator who set it deliberately is not overridden');
    ok('a functions run discovers via manifest and opens no port; a deliberate operator value is preserved');
  }

  console.log(`emulator-ports guard: OK (${n})`);
})().catch((e) => { console.error('EMULATOR PORTS GUARD FAILED:', (e && e.stack) || e); process.exit(1); });
