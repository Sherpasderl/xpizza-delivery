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
const { planPorts, SLOTS, SERVICE_LISTENERS, ALL_HOST_ENV, childEnv, DISCOVERY_PREFIX } = require('./emulator-run.js');
const os = require('os');

/* ═══ 🔴 DID THE SUITE REFUSE? KEYED TO THE PROPERTY, NOT TO ONE SUITE'S SPELLING ═══════════════
 * This was `r.status !== 1 || !/REFUSED/.test(r.stderr)`, and BOTH halves were forms rather than the
 * property. Main's preparing-ready suite refuses correctly, says WHY more clearly than ours do, and
 * still failed the old check twice over: it exits 2, and it says REFUSING where the check wanted
 * REFUSED. The guard was asserting a spelling and an exit number, so main's better refusal read as
 * no refusal at all.
 *
 * OWNER DECISION (d): ACCEPT ANY NONZERO EXIT, AND GET THE PRECISION BACK FROM AN ANCHORED MARKER
 * INSTEAD OF FROM THE NUMBER. An earlier draft of this very note claimed the opposite — that `exit 1 or
 * 2` had been REJECTED to keep exit 2 reserved — while the predicate below accepted any nonzero, 2
 * included. A comment contradicting the code underneath it is the defect this slice has spent its
 * findings deleting, so here is the actual reasoning, with the lines to check it against:
 *   · `tools/bootstrap-identity.js:73` (`process.exit(1);   // 🔴 NOT 2: exit 2 is the project guard's
 *     alone`) is ONE TOOL'S CLI CONTRACT. It reserves 2 among bootstrap-identity's OWN codes; it is not a
 *     repo-wide reservation and it says nothing about what an emulator suite may exit with.
 *   · THE EMULATOR HARNESS ALREADY USES EXIT 2 FOR "REFUSED", and this file already asserts that it
 *     does: tools/emulator-run.js refuses with 2 at :55, :197, :199, :200, :203, :221 and :314, and the
 *     cells below REQUIRE exactly that: the `a malformed port offset refuses (exit 2)` cell, the
 *     `an --only service with no port band REFUSES (exit 2)` cell, and the `argument shapes that could
 *     bypass the preflight are each refused (exit 2)` cell. Named by their ok() LABELS and not by line
 *     number, deliberately: a citation to a line in THIS file is invalidated by the next edit to this
 *     file. The numbers that stood here were measured before the comment they sit in was inserted, and
 *     by the time it landed they pointed at a blank line and at an unrelated assert expecting exit 3 —
 *     correct when taken, false when committed. A label moves with the cell it names. So 2 is the harness's
 *     established refusal code, and main's suite exiting 2 is CONSISTENT with ours rather than a
 *     deviation from them. Reserving 2 here would have contradicted three of our own cells.
 *   · AND EXIT 1 IS ALSO A CRASH CODE, in main's suite and in ours alike: main's refuses with 2 at
 *     test/preparing-ready.emulator.test.js:29 and CRASHES with 1 at :285
 *     (`.catch((e) => { … process.exit(1); })`). So the number cannot separate "declined to run" from
 *     "blew up while running" in either direction, which is precisely why the old `status !== 1` check
 *     was keyed to a form rather than to the property.
 * What CAN separate them is the pair this predicate uses: a clean nonzero exit (numeric, unsignalled, no
 * spawn error) AND an anchored refusal banner. The exit code says something went wrong; only the banner
 * says the harness DECIDED not to run.
 *
 * 🔴 AND A BANNER IS STILL ONLY A STATEMENT ABOUT INTENT. `{status:1, signal:null, stderr:"\n🔴 REFUSED
 * — late guard.\n", stdout:"suite already executed\n"}` satisfies every clause above, and a suite that did
 * its work, touched a database and THEN printed the banner would pass. No suite does that today — both
 * helpers exit on the spot — but this guard exists to stop an emulator suite writing to a NON-LOCAL
 * database, so the property it must hold is "contacted nothing", not "said the right thing".
 * So the guaranteed property is now: REFUSED AS A SINGLE PROCESS, WITH A CLEAN NONZERO EXIT AND AN
 * ANCHORED BANNER, HAVING MADE ZERO OUTBOUND CONNECTION ATTEMPTS AND ZERO PROCESS OR WORKER LAUNCHES.
 *
 * 🔴 SINGLE-PROCESS IS THE POINT, AND IT IS WHY THE PREVIOUS THREE FIXES KEPT REOPENING. An
 * in-process observer cannot vouch for a process that does not carry it: a piped child's trailer was
 * swallowed, then a child spawned with `env: {}` carried neither the preload nor the record dir and left
 * NO record while the parent's clean record passed. A non-node child — `curl`, a shell — can never carry
 * it at all. Observing the tree is not a closable problem, so launching anything is simply forbidden, and
 * every launch is recorded at CALL time (child_process spawn/spawnSync/exec/execSync/execFile/
 * execFileSync/fork, and worker_threads.Worker) so a child that escapes observation still leaves proof it
 * was started. ESM named imports are covered via `syncBuiltinESMExports()`, MEASURED by a cell rather
 * than assumed. Verified before forbidding it: no suite launches anything today.
 * ═══ 🔴 THE THREAT MODEL, STATED ═══
 * Catches NON-ADVERSARIAL suites that do work, launch a process or worker, or contact a host before
 * refusing, through any public Node networking or process API (classified exhaustively against
 * builtinModules — see the `all N builtin modules are classified` cell). It does NOT defend against a
 * suite that deliberately tampers with its own observer (hook removal, record-file writes, native addons,
 * process.binding, process.dlopen); that is out of scope for this test-harness guard. Deliberate tampering
 * with the platform is owned by a separate platform-security initiative (access control, credential
 * separation, server-side trust), not by this guard.
 * Every hook lives in the same process as the code it watches, so a suite that wants to remove them can.
 * The accident this stops — a suite pointed at a non-local database doing its work before refusing — is
 * not adversarial, and a guarantee against carelessness is worth having where one against malice is not
 * available. What would be dishonest is leaving the difference unstated.
 *
 * The connection half is measured inside each suite's own process by
 * the tools/no-connect.js preload, whose header records which layers it hooks and why. Proven by the
 * `the no-connect preload really counts attempts` cell before anything relies on it, and enforced by the
 * `all 49 emulator suites REFUSE a foreign emulator` cell. Cited by LABEL, not line number.
 *
 * 🔴 AND THE VERDICT IS READ FROM PER-PROCESS RECORD FILES, NOT FROM stderr, so no stdio arrangement
 * can hide a process: each process writes `${NO_CONNECT_DIR}/<pid>.rec` with START / CONNECT-per-attempt /
 * EXIT. A suite is refused only if a record exists for the TOP-LEVEL pid, every record has START and EXIT,
 * and no record holds a single CONNECT. It FAILS CLOSED on a missing record (nothing observed it) and on a
 * record without EXIT (observed but unfinished) — "we stopped watching" is not "it did nothing". The
 * `a child's contact is attributed to the suite whatever its stdio` cell proves all three.
 *
 * 🔴 AND THE WHOLE PROCESS TREE IS COVERED, NOT JUST THE SPAWNED PROCESS. The preload is injected
 * through NODE_OPTIONS rather than `-r`, because `-r` stops at the process boundary: a suite that spawns
 * a CHILD node process which connects, waits for it, then prints its own banner emits a single
 * `##CONNECT 0` under `-r` and passes. NODE_OPTIONS is inherited, so every node process in the tree emits
 * its own trailer, and a suite counts as refused only if at least one trailer exists AND EVERY trailer
 * reports zero. Reading only the first would make the verdict depend on which process exited first.
 * The `a CHILD process's connection is attributed to the suite` cell proves all of that, and asserts the
 * `-r` miss as a PREMISE so the justification cannot quietly go stale.
 * NODE_OPTIONS is APPENDED, never assigned: gate-all puts `--require count-marks.js` there when it runs
 * this file, and clobbering it would disable the cell counter for every suite spawned here.
 * Zero ASSERTIONS would NOT be the same guarantee: a suite can wipe a root before its first assertion.
 *
 * ALL of these, because each rules out a different way of being wrong:
 *   · `typeof status === 'number' && status !== 0` — a refusal exits nonzero, and `status` is null
 *     when the child was signalled, where a bare `!== 0` would read null as success-ish nonzero.
 *   · `signal === null` — a suite KILLED by the 30s timeout never decided anything. Without this a
 *     hang scores as a refusal, which is the worst failure available here: it would mean a suite that
 *     silently connects to a foreign emulator and stalls counts as safe.
 *   · `!error` — a spawn that never ran the file (ENOENT, EACCES) is not a refusal either.
 *   · a LINE-ANCHORED marker — a bare /REFUSED/ substring matches an ASSERTION about refusal from a
 *     suite that already connected: test/d4p1-mint-atomic.emulator.test.js:503 fails with
 *     "…WAS REFUSED — the stale-source lockout…" and exits 1. Under the old check that suite passed
 *     this cell by failing for an unrelated reason. Anchoring to the start of a line is what separates
 *     "the harness printed its refusal banner" from "the word appeared somewhere in a stack".
 *
 * The two markers are the two real refusal helpers, and the ONLY two:
 *   test/_emulator-required.js:81          `🔴 REFUSED — ${what}.`
 *   test/preparing-ready.emulator.test.js:26  `🛑 REFUSING TO RUN — …`  (main's, exit 2, NOT edited)
 *
 * 🔴 A LATENT FRAGILITY, MEASURED AND RECORDED RATHER THAN GUESSED AT. Two suites print a refusal with
 * NO emoji — backfill-identities.emulator.test.js:37 and catalog-rules.emulator.test.js:34 both write
 * a bare "REFUSED — …" — which this predicate does NOT accept. I drove all 49 suites under the hostile
 * env before relying on that: zero are rejected, because those bare lines fire only when the host var
 * is UNSET, and a foreign-but-set host goes through _emulator-required instead. So the marker list is
 * complete FOR THIS CELL'S INPUT. If a suite ever refuses with a bare "REFUSED —" on this path, this
 * cell fails loudly and the marker belongs in the list on purpose — which is the behaviour we want
 * over a substring that quietly accepts anything. */
const REFUSAL_MARKER = /^[ \t]*(?:🔴 REFUSED —|🛑 REFUSING TO RUN —)/m;
const refusedForeignHost = (r) => typeof r.status === 'number'
  && r.status !== 0
  && r.signal === null
  && !r.error
  && REFUSAL_MARKER.test(r.stderr || '');

/* THE no-connect TRAILER. `##CONNECT <n> <first-target>` on stderr, written synchronously by the preload
   so it survives the `process.exit()` both refusal helpers end on.
   🔴 `null` MEANS UNTRUSTWORTHY, NOT ZERO. A missing trailer is the shape a MISSED INJECTION takes —
   the preload never loaded, so nothing was watching — and reading that as "made no connections" would
   certify precisely the suites nobody measured. Same rule count-marks.js states for `##CELLS`. */
const CONNECT_TRAILER = /^##CONNECT (\d+) (\S*)$/gm;
const NO_CONNECT = path.join(ROOT, 'tools', 'no-connect.js');

/* 🔴 THE VERDICT COMES FROM PER-PROCESS RECORD FILES, NOT FROM stderr. Injection propagates to child
   processes; OBSERVATION DOES NOT. NODE_OPTIONS reaches a child, so the child loads the preload and
   writes its trailer — into whatever its stdio points at, and under DEFAULT `spawnSync` stdio that is a
   pipe the PARENT captures and never re-emits. Reproduced: a parent spawning a default-piped child that
   connects, then printing the banner and exiting 1, is scored a CLEAN REFUSAL by a stderr-only reader
   (one trailer, `##CONNECT 0 -`). The record files cannot be intercepted by any stdio arrangement.
   The stderr trailer is kept for diagnostics and is never consulted for the verdict. */
const EXIT_LINE = /^EXIT (-?\d+) (\d+) (\d+)$/;
const readRecords = (dir) => {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.rec')); } catch (_) { return []; }
  return names.map((f) => {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
    const exitLine = lines.find((l) => l.startsWith('EXIT '));
    const m = exitLine ? EXIT_LINE.exec(exitLine) : null;
    return {
      pid: Number(path.basename(f, '.rec')),
      start: lines.some((l) => l.startsWith('START ')),
      /* MORE THAN ONE START in a single pid means a THREAD loaded this preload — a loader thread from
         module.register, or a Worker. Counted, because it is a different condition from a lost write and
         deserves a different message. */
      starts: lines.filter((l) => l.startsWith('START ')).length,
      exitLine: exitLine || null,
      /* The counts the process held IN MEMORY at exit. null means the EXIT line is missing or in a shape
         this reader does not understand — both of which are rejections, never a zero. */
      counted: m ? Number(m[2]) : null,
      spawned: m ? Number(m[3]) : null,
      connects: lines.filter((l) => l.startsWith('CONNECT ')).map((l) => l.slice('CONNECT '.length)),
      spawnsSeen: lines.filter((l) => l.startsWith('SPAWN ')).map((l) => l.slice('SPAWN '.length)),
    };
  });
};

/* FAILS CLOSED, in three distinct ways, because each is a different way of not knowing:
     · no record for the TOP-LEVEL pid — the preload never loaded, so nothing observed the suite at all;
     · any record with START but no EXIT — that process was watched and did not finish, so its evidence
       is incomplete. Reading an unfinished observation as a clean one is the failure this exists to stop;
     · any CONNECT line in any process of the tree — the suite contacted a host, whichever process did it.
   Only "every record complete, none with a CONNECT" is a pass. */
/* 🔴 THE PROPERTY IS NOW SINGLE-PROCESS, BECAUSE AN IN-PROCESS OBSERVER CANNOT BE MADE TREE-COMPLETE.
   Four rounds of findings were one class: a child whose stderr was swallowed; then a child spawned with
   `env: {}`, carrying neither NODE_OPTIONS nor NO_CONNECT_DIR, leaving NO record at all. Each fix
   observed one more path and the next hole was a path that carried nothing — and a non-node child
   (`curl`, a shell) can never carry it. Observing the tree is not a closable problem.
   So the guarantee stops being "every process was clean" and becomes "THERE WAS ONLY ONE PROCESS":
   exactly one record, for the top-level pid, with zero connections and zero launches. Every launch is
   recorded at CALL time, so a child that escapes observation entirely still leaves proof it was started.
   EXTRA RECORDS ARE A REJECTION TOO, not just missing ones: an unexpected process is a process whose
   behaviour this file did not govern, whichever direction the surprise came from. */
const contactVerdict = (r, dir) => {
  const records = readRecords(dir);
  if (!records.some((x) => x.pid === r.pid)) {
    return { ok: false, records, why: `NO RECORD for the top-level pid ${r.pid} — the preload never loaded, so nothing observed this suite` };
  }
  if (records.length !== 1) {
    return { ok: false, records, why: `${records.length} records (pid ${records.map((x) => x.pid).join(', ')}) — a refusal must be a SINGLE process; any other process is one this file did not govern` };
  }
  const [rec] = records;
  if (!rec.start || !rec.exitLine) {
    return { ok: false, records, why: `record for pid ${rec.pid} has no EXIT — observed but unfinished, which is incomplete coverage rather than a clean run` };
  }
  if (rec.counted === null || rec.spawned === null) {
    return { ok: false, records, why: `the EXIT line does not carry both counts (${JSON.stringify(rec.exitLine)}) — malformed or an older format, which cannot be read as zero` };
  }
  /* 🔴 A LAUNCH IS CHECKED FIRST, BECAUSE IT EXPLAINS EVERYTHING ELSE. A suite that started a
     process or a loader thread has already failed, and any counter disagreement below is a CONSEQUENCE of
     that thread rather than a lost write. Checking the cross-check first made `module.register` report
     "a record write was lost", which is a true rejection with a false diagnosis — it would send an
     operator hunting a disk problem when a second thread had simply written a line the main thread's
     counter never saw. */
  if (rec.spawned > 0) {
    return { ok: false, records, why: `${rec.spawned} process/worker/loader launch(es) before refusing — first ${rec.spawnsSeen[0]}. A refusal must not start anything: a child that carries neither the preload nor the record dir, is not node at all, or runs on a loader thread cannot be vouched for` };
  }
  /* A second START under one pid is a THREAD that loaded this preload. Its own counter is separate from
     the main thread's, so the totals cannot be reconciled — and saying so is more useful than calling it
     a lost write. */
  if (rec.starts > 1) {
    return { ok: false, records, why: `${rec.starts} START lines for pid ${rec.pid} — a THREAD loaded this preload in the same process (a loader thread or a worker). Its counter is independent of the main thread's, so this suite's evidence cannot be reconciled` };
  }
  /* 🔴 THE CROSS-CHECK, for a genuinely LOST WRITE. `rec()` swallows its own write errors so it can
     never break the process it observes, so a CONNECT or SPAWN append can be lost while START and EXIT
     both land. The in-memory counts cannot be lost that way. Reached only after a launch and a thread have
     been ruled out, so by here a disagreement really does mean evidence went missing. */
  if (rec.counted !== rec.connects.length || rec.spawned !== rec.spawnsSeen.length) {
    return { ok: false, records, why: `record/counter MISMATCH — pid ${rec.pid} reported ${rec.counted} connection(s) and ${rec.spawned} launch(es) at exit but left ${rec.connects.length} CONNECT and ${rec.spawnsSeen.length} SPAWN line(s). A record write was lost, so this suite's evidence is incomplete and cannot be read as clean` };
  }
  if (rec.counted > 0) {
    return { ok: false, records, why: `${rec.counted} connection attempt(s) before refusing; first ${rec.connects[0]}` };
  }
  return { ok: true, records, why: `exactly 1 process, START + EXIT with both counts, zero CONNECT, zero SPAWN, counts agree` };
};

const refusedAsOneCleanProcess = (r, verdict) => refusedForeignHost(r) && verdict.ok;

/* Run a script under the preload with records enabled, exactly as the suites are run. The record dir is
   per-run and removed afterwards, so one suite's tree can never be read as another's. */
const runObserved = (argv, extraEnv = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-connect-rec-'));
  try {
    const r = spawnSync(process.execPath, argv, {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, ...extraEnv, NO_CONNECT_DIR: dir, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${NO_CONNECT}`.trim() },
    });
    return { r, verdict: contactVerdict(r, dir), trailers: [...String(r.stderr || '').matchAll(CONNECT_TRAILER)].map((m) => ({ attempts: Number(m[1]), first: m[2] })) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

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

  // ── 10b. 🔴 THE REFUSAL PREDICATE ITSELF, BEFORE ANYTHING RELIES ON IT ──────────────────────
  /* The cell below drives 49 suites through `refusedForeignHost`. If that predicate is wrong, THAT
     cell fails with "a suite did NOT refuse a foreign host" — a message that blames the suites for a
     defect in the check. So the predicate is exercised FIRST, on synthetic spawnSync results, and a
     broken predicate dies here on the line that names the mechanism. Assertion order decides which
     cell a defect reports against.
     🔴 AND IT DRIVES THE REAL FUNCTION, NOT A COPY OF IT. A cell that re-implements the regex proves
     the cell's regex works and nothing about the one in use — the same "spelling, not property"
     mistake one level up, which is what this whole resolution is repairing. */
  {
    const R = (o) => ({ status: 1, signal: null, error: undefined, stderr: '', stdout: '', ...o });

    // POSITIVE — one per real marker, which is the point: both helpers must be honoured.
    assert.ok(refusedForeignHost(R({ status: 1, stderr: '\n🔴 REFUSED — FIRESTORE_EMULATOR_HOST is not a local emulator.\n' })),
      '🔴 the predicate rejected our own _emulator-required refusal (exit 1)');
    assert.ok(refusedForeignHost(R({ status: 2, stderr: '\n🛑 REFUSING TO RUN — FIREBASE_DATABASE_EMULATOR_HOST is not a local emulator.\n' })),
      "🔴 the predicate rejected main's refusal at EXIT 2 — the harness's OWN refusal code (tools/emulator-run.js, and this file's own cells for a malformed port offset, an unknown --only service, and argument shapes that could bypass the preflight), which is the whole reason this predicate stopped keying on the number");

    // NEGATIVE — each is a DIFFERENT way to look like a refusal without being one.
    assert.ok(!refusedForeignHost(R({ status: 1, stderr: 'Error: connect ECONNREFUSED 127.0.0.1:8080\n    at TCPConnectWrap.afterConnect\n' })),
      '🔴 a failed CONNECTION counted as a refusal — the suite tried to reach the foreign host and merely could not; it never declined to run');
    assert.ok(!refusedForeignHost(R({ status: 1, stderr: "AssertionError [ERR_ASSERTION]: 🔴 PUBLISHING AFTER THE PREVIOUS CELL'S ROLLBACK WAS REFUSED — the stale-source lockout\n    at Object.<anonymous> (/x/test/d4p1-mint-atomic.emulator.test.js:503:12)\n" })),
      '🔴 an ASSERTION containing the word REFUSED counted as a refusal — that suite had already connected and failed for an unrelated reason (the real shape at d4p1-mint-atomic:503)');
    assert.ok(!refusedForeignHost(R({ status: null, signal: 'SIGTERM', stderr: '\n🔴 REFUSED — something.\n' })),
      '🔴 a suite KILLED by the timeout counted as a refusal — a hang decided nothing, and calling it safe is the worst possible direction to be wrong in here');
    assert.ok(!refusedForeignHost(R({ status: 0, stderr: '\n🔴 REFUSED — something.\n' })),
      '🔴 exit 0 counted as a refusal — a suite that printed the banner and then exited green has not refused');
    assert.ok(!refusedForeignHost(R({ status: 1, error: new Error('spawn ENOENT'), stderr: '\n🔴 REFUSED — something.\n' })),
      '🔴 a spawn that never ran the file counted as a refusal');
    assert.ok(!refusedForeignHost(R({ status: 1, stderr: 'the helper says it would have REFUSED — but mid-line\n' })),
      '🔴 the marker matched mid-line — anchoring is what separates the refusal BANNER from the word appearing in prose or a stack');
    assert.ok(!refusedForeignHost(R({ status: 1, stderr: '\nREFUSED — FIRESTORE_EMULATOR_HOST is not set.\n' })),
      'a bare REFUSED without a marker emoji is not accepted — recorded deliberately: two suites print this form when the var is UNSET, which is not this path (all 49 measured), so if it ever reaches here the cell must say so rather than accept it silently');

    ok('the refusal predicate keys on the PROPERTY: any nonzero exit with an anchored marker passes, while a connect error, an assertion mentioning REFUSED, a timeout kill, exit 0, a failed spawn and a mid-line match are each rejected');
  }

  // ── 10c. 🔴 THE PRELOAD REALLY RECORDS — NON-VACUITY BEFORE ANY ZERO IS BELIEVED ────────────
  /* The cell below requires every process of every suite to record zero connection attempts. A hook that
     never fires, or a record file that is never written, produces exactly that for everything — and it
     would read as the strongest claim in this file while asserting nothing at all. So the real preload is
     driven first and must be shown to RECORD a real attempt and NAME it.
     Throwaway scripts in os.tmpdir(), never the repo; they connect only to 127.0.0.1 on a port nothing
     listens on. */
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-guard-noconnect-'));
    const w = (n, body) => { const f = path.join(tmp, n); fs.writeFileSync(f, body); return f; };
    const BANNER = "console.error('\\n🔴 REFUSED — a foreign host.');\nprocess.exit(1);\n";
    const clean = w('clean.js', BANNER);
    const connects = w('connects.js',
      "const net = require('net');\n"
      + "const s = net.connect({ host: '127.0.0.1', port: 9 });\n"
      + "s.on('error', () => { console.error('\\n🔴 REFUSED — late guard.'); process.exit(1); });\n");
    const fetches = w('fetches.js',
      "fetch('http://127.0.0.1:9').catch(() => { console.error('\\n🔴 REFUSED — after fetch.'); process.exit(1); });\n");

    // NON-VACUITY: a real socket attempt is RECORDED and the target NAMED.
    const c = runObserved([connects]);
    const cRec = c.verdict.records.find((x) => x.connects.length);
    assert.ok(cRec, `🔴 the preload recorded NO connection attempt for a script that really connects — every zero in this file would then be vacuous (${c.verdict.why})`);
    assert.match(cRec.connects[0], /127\.0\.0\.1:9/, 'and the record names the target, so a failure is diagnosable without a re-run');
    assert.ok(!refusedAsOneCleanProcess(c.r, c.verdict), '🔴 connecting and then printing the banner counted as a clean refusal');

    /* And global fetch is recorded too, which needs its OWN hook: node's built-in fetch is bundled undici
       behind internal bindings and never reaches the public `net` module. Measured, not assumed — without
       it the richest exfiltration path in the runtime would be invisible while this cell claimed zero. */
    const f = runObserved([fetches]);
    assert.ok(f.verdict.records.some((x) => x.connects.length),
      `🔴 a global fetch() was NOT recorded — the socket hook cannot see node's built-in fetch, so it needs its own (${f.verdict.why})`);
    assert.ok(!refusedAsOneCleanProcess(f.r, f.verdict), '🔴 fetching and then printing the banner counted as a clean refusal');

    // POSITIVE: banner, clean exit 1, nothing contacted, record complete.
    const ok1 = runObserved([clean]);
    assert.ok(refusedAsOneCleanProcess(ok1.r, ok1.verdict),
      `🔴 a suite that refused and contacted nothing was rejected (${ok1.verdict.why}, exit ${ok1.r.status})`);
    assert.strictEqual(ok1.verdict.records.length, 1, 'premise — one process, so exactly one record');

    /* NEGATIVE: the preload never loaded. The realistic failure is a spawn shape that stops receiving the
       injection, and it must read as untrustworthy rather than as zero, or the suites nobody watched
       become the ones that pass most easily. The record dir EXISTS and is EMPTY, which is the honest
       shape of that failure. */
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'no-connect-rec-'));
    const rBare = spawnSync(process.execPath, [clean], { cwd: ROOT, encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_OPTIONS: '', NO_CONNECT_DIR: bare } });
    const vBare = contactVerdict(rBare, bare);
    assert.ok(refusedForeignHost(rBare), 'premise — it still looks like a refusal to the banner predicate, which is why records are required on top');
    assert.ok(!refusedAsOneCleanProcess(rBare, vBare), `🔴 a suite nothing observed was accepted (${vBare.why})`);
    assert.match(vBare.why, /NO RECORD/, 'and the reason names the missed injection rather than reporting a clean zero');
    fs.rmSync(bare, { recursive: true, force: true });

    fs.rmSync(tmp, { recursive: true, force: true });
    /* THE FORMAT PREMISE: a clean run's record must actually END with a parsed count, or every check
       below is testing a shape that does not occur. */
    assert.match(ok1.verdict.records[0].exitLine, /^EXIT \d+ 0 0$/,
      `premise — a clean refusal's record ends with EXIT <code> 0 0: no connections AND no launches (got ${JSON.stringify(ok1.verdict.records[0].exitLine)})`);

    /* 🔴 THE LOST WRITE. `rec()` swallows its own errors so it can never break the process it observes,
       so a CONNECT append can be lost while START and EXIT both land — leaving a record holding exactly
       the lines a clean run holds. Before EXIT carried the count, that read as CLEAN, and the header
       claimed it failed closed. It did not.
       appendFileSync cannot be made to fail on demand, so the record is written BY HAND: the shape is
       what matters, and a synthetic record is the honest way to reach a state the real writer only
       reaches when the disk misbehaves. */
    const lost = fs.mkdtempSync(path.join(os.tmpdir(), 'no-connect-rec-'));
    fs.writeFileSync(path.join(lost, '424242.rec'), 'START 424242 1\nEXIT 1 1 0\n');
    const synthetic = { status: 1, signal: null, error: undefined, pid: 424242, stderr: '\n🔴 REFUSED — a foreign host.\n', stdout: '' };
    const vLost = contactVerdict(synthetic, lost);
    assert.ok(refusedForeignHost(synthetic), 'premise — it satisfies the banner predicate, and its record has START, EXIT and no CONNECT: indistinguishable from clean by line TYPES alone');
    assert.ok(!refusedAsOneCleanProcess(synthetic, vLost),
      `🔴 a record whose counter says 1 attempt while no CONNECT line survived was read as CLEAN — that is the lost-write hole, and the whole reason EXIT carries the counts (${vLost.why})`);
    assert.match(vLost.why, /MISMATCH/, 'and the reason names the lost write rather than reporting a connection or a clean run');
    fs.rmSync(lost, { recursive: true, force: true });

    /* And the OLD format — `EXIT <code>` with no count — is refused by name rather than read generously.
       It would satisfy any "is there an EXIT line" check while carrying none of the cross-check evidence. */
    const oldfmt = fs.mkdtempSync(path.join(os.tmpdir(), 'no-connect-rec-'));
    fs.writeFileSync(path.join(oldfmt, '424243.rec'), 'START 424243 1\nEXIT 0\n');
    /* And the TWO-field form, which is this file's own previous format — the likeliest stale record and
       the one a generous reader would accept by matching only the first two groups. */
    const twoField = fs.mkdtempSync(path.join(os.tmpdir(), 'no-connect-rec-'));
    fs.writeFileSync(path.join(twoField, '424244.rec'), 'START 424244 1\nEXIT 0 0\n');
    const vTwo = contactVerdict({ ...synthetic, pid: 424244 }, twoField);
    assert.ok(!vTwo.ok, '🔴 the previous TWO-field EXIT format was accepted — a stale record from an older preload cannot be read as zero launches');
    fs.rmSync(twoField, { recursive: true, force: true });
    const vOld = contactVerdict({ ...synthetic, pid: 424243 }, oldfmt);
    assert.ok(!vOld.ok, '🔴 an EXIT line with no attempt count was accepted — an older or truncated format cannot be read as zero');
    assert.match(vOld.why, /does not carry both counts/, 'and the reason says the counts are what is missing');
    fs.rmSync(oldfmt, { recursive: true, force: true });

    ok('the preload RECORDS what it sees (raw socket AND global fetch, which needs its own hook) and names the target; a clean refusal passes, while connecting first, fetching first, a missed injection, a LOST CONNECT WRITE caught by the exit counter, and an EXIT line with no count are each rejected');
  }

  // ── 10d. 🔴 A REFUSAL MUST BE A SINGLE PROCESS — LAUNCHING ANYTHING IS THE REJECTION ────────
  /* Four rounds of findings on one class, each closed and each reopened one path over:
       1. a child whose stderr was PIPED, so its trailer was swallowed by the parent;
       2. so injection moved to NODE_OPTIONS and the verdict to record FILES;
       3. then a child spawned with `env: {}` — carrying neither NODE_OPTIONS nor NO_CONNECT_DIR, leaving
          NO record at all, while the parent's clean record passed a presence-only check.
     The pattern is not a sequence of bugs. AN IN-PROCESS OBSERVER CANNOT VOUCH FOR A PROCESS THAT DOES
     NOT CARRY IT, and a non-node child — `curl`, a shell — can never carry it. Observing the tree is not
     a closable problem, so the property is inverted: a refusal launches NOTHING, and every launch is
     recorded at CALL time so a child that escapes observation entirely still leaves proof it existed.
     🔴 MEASURED BEFORE THIS WAS BUILT, as the condition for building it: none of the 49 suites launches a
     child or a Worker under the hostile env — 48 end `EXIT 1 0 0` and one `EXIT 2 0 0`. So this forbids
     something no suite does, which is the only safe time to forbid it.
     OUT OF SCOPE, stated rather than implied: native addons, `process.binding` and `process.dlopen` can
     execute code this file cannot see. No test suite in this repo uses any of them; if one ever does,
     that is a new finding and a new mechanism, not a gap to be quietly absorbed here. */
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-guard-single-'));
    const w = (n, body) => { const f = path.join(tmp, n); fs.writeFileSync(f, body); return f; };
    const BANNER = "console.error('\\n🔴 REFUSED — a foreign host.');\nprocess.exit(1);\n";
    const CHILD_CONNECTS = "const net=require('net');const s=net.connect({host:'127.0.0.1',port:9});s.on('error',()=>process.exit(0));s.on('connect',()=>process.exit(0));";

    // POSITIVE: one process, nothing contacted, nothing launched.
    const clean = runObserved([w('clean.js', BANNER)]);
    assert.ok(refusedAsOneCleanProcess(clean.r, clean.verdict), `🔴 a single-process refusal was rejected (${clean.verdict.why})`);
    assert.strictEqual(clean.verdict.records.length, 1, 'premise — exactly one record');

    /* CODEX'S CASE: the child is given `env: {}`, so it inherits NEITHER the preload NOR the record dir.
       The premise is the important half — the child leaves NO record, so a reader that checks only
       "is there a record for the top-level pid" sees one clean record and accepts. */
    const envStripped = runObserved([w('env-stripped.js',
      "const { spawnSync } = require('child_process');\n"
      + `spawnSync(process.execPath, ['-e', ${JSON.stringify(CHILD_CONNECTS)}], { env: {} });\n`
      + BANNER)]);
    assert.strictEqual(envStripped.verdict.records.length, 1,
      `premise — the env-stripped child left NO record of its own, so only the parent's exists (${JSON.stringify(envStripped.verdict.records.map((x) => x.pid))})`);
    assert.strictEqual(envStripped.verdict.records[0].connects.length, 0,
      'premise — and that record shows no connection, because the process that connected was never observed: this is precisely the false clean bill');
    assert.ok(!refusedAsOneCleanProcess(envStripped.r, envStripped.verdict),
      '🔴 a suite that spawned an UNOBSERVED child which connected counted as a clean refusal — the SPAWN record is the only thing that can catch this, since the child carried nothing');
    assert.match(envStripped.verdict.why, /launch/, 'and the reason names the launch rather than a connection nobody saw');

    /* 🔴 CODEX'S SECOND SHAPE: a hand-built ChildProcess, which reaches NONE of the named launcher
       functions. Hooking per function could never have caught this; hooking ChildProcess.prototype.spawn
       does, and the async family plus cluster.fork ride on that same floor (measured). */
    const raw = runObserved([w('raw-cp.js',
      "const { ChildProcess } = require('child_process');\n"
      + "const c = new ChildProcess();\n"
      + "c.spawn({ file: '/bin/echo', args: ['/bin/echo', 'x'], envPairs: [], stdio: 'pipe' });\n"
      + "setTimeout(() => { console.error('\\n🔴 REFUSED — a foreign host.'); process.exit(1); }, 200);\n")]);
    assert.ok(raw.verdict.records.some((x) => x.spawnsSeen.some((l) => l.startsWith('ChildProcess.spawn:'))),
      `🔴 a raw ChildProcess().spawn() was NOT recorded — it reaches none of the named launcher functions, which is exactly why the hook is on the PROTOTYPE (${raw.verdict.why})`);
    assert.ok(!refusedAsOneCleanProcess(raw.r, raw.verdict), '🔴 a hand-built ChildProcess launch counted as a clean refusal');

    // A NON-NODE child can never be instrumented at all, which is the general form of the same hole.
    const nonNode = runObserved([w('non-node.js',
      "require('child_process').spawnSync('/bin/echo', ['x']);\n" + BANNER)]);
    assert.ok(!refusedAsOneCleanProcess(nonNode.r, nonNode.verdict), '🔴 spawning a non-node binary counted as a clean refusal');
    assert.match(nonNode.verdict.records[0].spawnsSeen[0], /spawnSync:\/bin\/echo/, 'and the record names what was launched');

    // A WORKER shares the process but not the module registry, so it is execution this file cannot vouch for.
    const worker = runObserved([w('worker.js',
      "const { Worker } = require('worker_threads');\n"
      + "const wk = new Worker('setTimeout(()=>{},1)', { eval: true });\n"
      + "wk.on('online', () => { wk.terminate(); console.error('\\n🔴 REFUSED — a foreign host.'); process.exit(1); });\n"
      + "setTimeout(() => { console.error('\\n🔴 REFUSED — a foreign host.'); process.exit(1); }, 2000);\n")]);
    assert.ok(!refusedAsOneCleanProcess(worker.r, worker.verdict), `🔴 starting a Worker counted as a clean refusal (${worker.verdict.why})`);
    assert.ok(worker.verdict.records.some((x) => x.spawnsSeen.some((l) => l.startsWith('Worker:'))), 'and the Worker is named in the record');

    /* 🔴 THE ESM PATH, MEASURED RATHER THAN ASSUMED. `import { spawn } from 'node:child_process'` binds to
       the builtin's export, NOT to the property this preload overwrites, so without
       `require('module').syncBuiltinESMExports()` an ESM suite would bypass every hook. This cell is the
       proof that the resync works; without it the hooks would be real and reachable only from CJS. */
    const esm = runObserved([w('esm.mjs',
      "import { spawnSync } from 'node:child_process';\n"
      + "spawnSync('/bin/echo', ['esm']);\n"
      + "console.error('\\n🔴 REFUSED — a foreign host.');\n"
      + "process.exit(1);\n")]);
    assert.ok(!refusedAsOneCleanProcess(esm.r, esm.verdict),
      `🔴 an ESM named-import spawn was NOT recorded — syncBuiltinESMExports is what makes the hooks reach ESM, and without it every hook here is CJS-only (${esm.verdict.why})`);

    fs.rmSync(tmp, { recursive: true, force: true });
    ok('a refusal must be a SINGLE process: the env-stripped child that leaves no record at all, a non-node binary, a Worker, and an ESM named-import spawn are each rejected by their SPAWN record, while a clean one-process refusal passes');
  }

  // ── 10e. 🔴 THE UDP AND WEBSOCKET PATHS, WHICH BYPASS THE SOCKET HOOK ENTIRELY ───────────────
  /* `dgram.send` reaches a host with NO connection at all, and node's global `WebSocket` is bundled undici
     behind internal bindings. Both were measured to produce ZERO hits on net.Socket.prototype.connect, so
     each needs its own hook — and each cell below asserts the hook RECORDED the attempt before asserting
     the verdict, because a hook that never fires makes every zero in this file vacuous. */
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-guard-udp-'));
    const w = (n, body) => { const f = path.join(tmp, n); fs.writeFileSync(f, body); return f; };
    const BANNER = "console.error('\\n🔴 REFUSED — a foreign host.');\nprocess.exit(1);\n";

    const udpSend = runObserved([w('udp-send.js',
      "const s = require('dgram').createSocket('udp4');\n"
      + "s.send(Buffer.from('x'), 9, '127.0.0.1', () => { s.close(); console.error('\\n🔴 REFUSED — a foreign host.'); process.exit(1); });\n")]);
    assert.ok(udpSend.verdict.records.some((x) => x.connects.some((c) => c.startsWith('udp:'))),
      `🔴 a UDP send was NOT recorded — dgram bypasses the socket hook, so without its own hook a suite could reach a host over UDP and report zero (${udpSend.verdict.why})`);
    assert.ok(!refusedAsOneCleanProcess(udpSend.r, udpSend.verdict), '🔴 a suite that sent a UDP packet before refusing counted as clean');

    const udpConnect = runObserved([w('udp-connect.js',
      "const s = require('dgram').createSocket('udp4');\n"
      + "s.connect(9, '127.0.0.1', () => {});\n"
      + "setTimeout(() => { try { s.close(); } catch (_) {} console.error('\\n🔴 REFUSED — a foreign host.'); process.exit(1); }, 200);\n")]);
    assert.ok(udpConnect.verdict.records.some((x) => x.connects.some((c) => c.startsWith('udp-connect:'))),
      `🔴 a dgram connect was NOT recorded (${udpConnect.verdict.why})`);
    assert.ok(!refusedAsOneCleanProcess(udpConnect.r, udpConnect.verdict), '🔴 a suite that dgram-connected before refusing counted as clean');

    if (typeof globalThis.WebSocket === 'function') {
      const ws = runObserved([w('ws.js',
        "const ws = new WebSocket('ws://127.0.0.1:9');\n"
        + "ws.onerror = () => {};\n"
        + "setTimeout(() => { console.error('\\n🔴 REFUSED — a foreign host.'); process.exit(1); }, 400);\n")]);
      assert.ok(ws.verdict.records.some((x) => x.connects.some((c) => c.startsWith('websocket:'))),
        `🔴 a global WebSocket was NOT recorded — it bypasses the socket hook exactly as fetch does (${ws.verdict.why})`);
      assert.ok(!refusedAsOneCleanProcess(ws.r, ws.verdict), '🔴 a suite that opened a WebSocket before refusing counted as clean');
    }

    // And the control: a suite that does none of these is still accepted.
    const clean = runObserved([w('clean.js', BANNER)]);
    assert.ok(refusedAsOneCleanProcess(clean.r, clean.verdict), `🔴 the permitting control was rejected (${clean.verdict.why})`);

    fs.rmSync(tmp, { recursive: true, force: true });
    ok(`the UDP and WebSocket paths are recorded and rejected — both measured to make ZERO hits on ${'net.Socket.prototype.connect'}, so neither is covered by the socket hook`);
  }

  // ── 10f-pre. 🔴 DNS IS A HOST, AND module.register STARTS A THREAD ───────────────────────────
  /* Both of these were classified NOT APPLICABLE in this file's own table, on reasoning that read as
     plausible and cited nothing:
       · "a resolver is not the target" — but `Resolver.setServers()` lets a suite choose the server, so the
         server IS the host it reaches. c-ares does the query natively, touching neither the socket hook nor
         dgram, so only the JS entry points can see it.
       · "module loading" — but `module.register()` runs loader hooks on a DEDICATED THREAD that does not go
         through the wrapped Worker constructor.
     Both are now hooked, and both are driven here so the classification cannot quietly revert to prose. */
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-guard-dns-'));
    const w = (n, body) => { const f = path.join(tmp, n); fs.writeFileSync(f, body); return f; };
    const BANNER = "console.error('\\n🔴 REFUSED — a foreign host.');\nprocess.exit(1);\n";

    // A Resolver pointed at a server of the suite's choosing — the exact reproduction.
    const res = runObserved([w('resolver.js',
      "const { Resolver } = require('dns');\n"
      + "const r = new Resolver({ timeout: 100, tries: 1 });\n"
      + "r.setServers(['127.0.0.1:9']);\n"
      + "r.resolve4('example.test', () => { console.error('\\n🔴 REFUSED — a foreign host.'); process.exit(1); });\n")]);
    assert.ok(res.verdict.records.some((x) => x.connects.some((c) => c.startsWith('dns:127.0.0.1:9'))),
      `🔴 a DNS query to a server the suite CHOSE was not recorded — it left "EXIT 1 0 0" before this hook, i.e. a clean bill for contacting a host (${res.verdict.why})`);
    assert.ok(!refusedAsOneCleanProcess(res.r, res.verdict), '🔴 a suite that queried a resolver before refusing counted as clean');

    // The promises surface is a DIFFERENT Resolver class — measured, not assumed.
    const resP = runObserved([w('resolver-promises.js',
      "const dp = require('dns/promises');\n"
      + "const r = new dp.Resolver({ timeout: 100, tries: 1 });\n"
      + "r.setServers(['127.0.0.1:9']);\n"
      + "r.resolve4('example.test').catch(() => {});\n"
      + "setTimeout(() => { console.error('\\n🔴 REFUSED — a foreign host.'); process.exit(1); }, 300);\n")]);
    assert.ok(resP.verdict.records.some((x) => x.connects.some((c) => c.includes('dns.promises.Resolver'))),
      `🔴 the dns/promises Resolver was not recorded — dns.promises.Resolver !== dns.Resolver, so patching one class does not cover the other (${resP.verdict.why})`);
    assert.ok(!refusedAsOneCleanProcess(resP.r, resP.verdict), '🔴 the promises resolver path counted as clean');

    // dns.lookup goes through getaddrinfo — the system resolver rather than a chosen server, still a host.
    const look = runObserved([w('lookup.js',
      "require('dns').lookup('example.test', () => { console.error('\\n🔴 REFUSED — a foreign host.'); process.exit(1); });\n")]);
    assert.ok(look.verdict.records.some((x) => x.connects.some((c) => c.startsWith('dns:system'))),
      `🔴 dns.lookup was not recorded, and it is labelled system(getaddrinfo) rather than a chosen server so a failure says which it was (${look.verdict.why})`);
    assert.ok(!refusedAsOneCleanProcess(look.r, look.verdict), '🔴 a suite that resolved a name before refusing counted as clean');

    /* module.register — and the DIAGNOSIS matters as much as the verdict here. Before this hook the case
       was already rejected, but as a "record write was lost" MISMATCH: the loader thread appended a CONNECT
       the main thread's counter never saw. That is a true rejection with a false cause, and it would send
       an operator looking for a disk problem. The launch check now runs FIRST, so the reason names it. */
    const reg = runObserved([w('modreg.js',
      "const mod = require('module');\n"
      + "const src = \"export async function initialize(){ const net = await import('node:net'); const s = net.connect({host:'127.0.0.1',port:9}); s.on('error',()=>{}); }\";\n"
      + "mod.register('data:text/javascript,' + encodeURIComponent(src));\n"
      + "setTimeout(() => { console.error('\\n🔴 REFUSED — a foreign host.'); process.exit(1); }, 500);\n")]);
    assert.ok(reg.verdict.records.some((x) => x.spawnsSeen.some((l) => l.startsWith('module.register:'))),
      `🔴 module.register was not recorded as a launch (${reg.verdict.why})`);
    assert.ok(!refusedAsOneCleanProcess(reg.r, reg.verdict), '🔴 registering loader hooks counted as a clean refusal');
    assert.match(reg.verdict.why, /launch/,
      '🔴 the reason must name the LAUNCH — before the launch check was moved ahead of the cross-check this reported "a record write was lost", which is a true verdict with a false diagnosis');

    // Permitting control: a suite that does none of this still passes.
    const clean = runObserved([w('clean.js', BANNER)]);
    assert.ok(refusedAsOneCleanProcess(clean.r, clean.verdict), `🔴 the permitting control was rejected (${clean.verdict.why})`);

    fs.rmSync(tmp, { recursive: true, force: true });
    ok('a DNS query is a host contact (chosen server, the separate promises Resolver class, and getaddrinfo via dns.lookup) and module.register is a launch whose rejection names the launch rather than a lost write');
  }

  // ── 10f. 🔴 EVERY BUILTIN IS CLASSIFIED — COMPLETE BY CONSTRUCTION, NOT BY RECOLLECTION ─────
  /* Five rounds of this guard were each closed by hooking one more path that someone thought of. This cell
     removes "someone thought of it" from the chain: it takes the RUNTIME'S OWN `builtinModules` and fails
     if any entry is absent from no-connect.js's classification table, so a new node version cannot add an
     unobserved capability silently.
     🔴 IT ALREADY EARNED ITS PLACE: the first version of that table was missing five entries
     (_stream_duplex, _stream_passthrough, _stream_readable, _stream_transform, _stream_writable) because I
     wrote it from the capabilities I had considered rather than from the list. The cell failed and named
     them.
     The table is read from a CHILD process on purpose: requiring no-connect.js here would install its
     hooks in the guard's own process, which both perturbs this file's other spawns and would make the
     guard an observer of itself. */
  {
    /* 🔴 THE CHILD WRITES TO A FILE, NOT TO stdout. A first version read `r.stdout` and passed when
       run standalone, then FAILED INSIDE THE GATE — because gate-all sets
       `NODE_OPTIONS=--require count-marks.js`, the child inherits it, and count-marks appends `##CELLS 0`
       to STDOUT. The child's output was `{...}##CELLS 0` and JSON.parse threw at position 7. stdout is a
       SHARED CHANNEL in this repo by design, so it is not a data channel; a file cannot be decorated by a
       preload. The standalone run could never have caught this, because standalone is the one context
       where NODE_OPTIONS is empty. */
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ports-guard-table-')), 'table.json');
    const r = spawnSync(process.execPath,
      ['-e', `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(require(${JSON.stringify(NO_CONNECT)}).BUILTIN_CLASSIFICATION))`],
      { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(r.status, 0, `premise — the classification table must be readable (${(r.stderr || '').slice(-200)})`);
    let table;
    assert.doesNotThrow(() => { table = JSON.parse(fs.readFileSync(out, 'utf8')); }, 'premise — and parseable');

    const builtins = require('module').builtinModules;
    assert.ok(builtins.length >= 60, `premise — the runtime's own builtin list is populated (${builtins.length})`);
    const unclassified = builtins.filter((m) => !Object.prototype.hasOwnProperty.call(table, m));
    assert.deepStrictEqual(unclassified, [],
      `🔴 ${unclassified.length} builtin module(s) are not classified in tools/no-connect.js: ${JSON.stringify(unclassified)}. Each must be HOOKED (naming the hook) or carry a one-line reason it cannot launch a process or reach a host. An unclassified builtin is a capability nobody has looked at`);

    /* Every entry must say something. A key present with an empty classification would satisfy the
       completeness check while asserting nothing — the hand-kept-list-in-a-costume shape. */
    const empty = Object.entries(table).filter(([, v]) => !v || (v.hooked ? !v.by : !v.why));
    assert.deepStrictEqual(empty.map(([k]) => k), [],
      '🔴 a classification entry carries neither a hook name nor a reason — presence in the table is not a classification');

    /* 🔴 AND EVERY ENTRY MUST CITE THE DOCUMENTATION SECTION IT RESTS ON. Two entries in this table were
       wrong on reasoning alone — `dns` ("a resolver is not the target": but a Resolver's server is chosen by
       the caller) and `module` ("module loading": but module.register runs hooks on a dedicated thread).
       Both read as plausible and neither cited anything checkable. A citation is what lets the next reader
       audit the claim instead of re-deriving it, and it is the cheapest defence against a confident
       sentence. */
    const undocumented = Object.entries(table).filter(([, v]) => !v.doc).map(([k]) => k);
    assert.deepStrictEqual(undocumented, [],
      `🔴 ${undocumented.length} classification entr(ies) cite no documentation section: ${JSON.stringify(undocumented)}. A verdict with no citation is the shape both of this table's errors took`);
    const measured = Object.values(table).filter((v) => v.measured).length;
    assert.ok(measured >= 20,
      `premise — the doubtful entries are MEASURED under the preload, not reasoned about (${measured} carry a probe result)`);

    const hooked = Object.values(table).filter((v) => v.hooked).length;
    for (const m of ['child_process', 'cluster', 'worker_threads', 'dgram', 'net', 'tls', 'http', 'https', 'http2']) {
      assert.ok(table[m] && table[m].hooked, `premise — ${m} must be classified HOOKED, not explained away`);
    }
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
    ok(`all ${builtins.length} builtin modules are classified in no-connect.js (${hooked} hooked, ${builtins.length - hooked} with a reason, every entry citing a doc section, ${measured} carrying a measured probe result), derived from the runtime's own list so a new node version cannot add an unobserved path silently`);
  }

  // ── 11. 🔴 EVERY SUITE ON DISK ACTUALLY REFUSES A FOREIGN EMULATOR — DRIVEN, NOT GREPPED ───
  /* This used to assert that each file CONTAINED the string "_emulator-required". A substring is not
     a call: commenting the line out still passed, and so did a file that only mentioned it in prose.
     It was checking the spelling of the property rather than the property. So each suite is now
     SPAWNED with a deliberately foreign host var and must refuse — which can only pass if the helper
     is really required, really invoked, and really validating. The refusal happens before any
     emulator connection, so this needs no emulator and costs milliseconds per suite. */
  {
    const files = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.emulator.test.js'));
    assert.ok(files.length >= 43, `premise — the emulator suites are on disk (${files.length})`);
    /* 🔴 THE PRELOAD GOES IN VIA NODE_OPTIONS, NOT `-r`, BECAUSE `-r` STOPS AT THE PROCESS BOUNDARY.
       A suite that spawns a CHILD node process which connects, then prints its own banner and exits 1,
       is invisible to a `-r` injection: measured, that shape emits ONE trailer reading `##CONNECT 0 -`
       and would have been accepted as a clean refusal. Through NODE_OPTIONS, which node passes down,
       the same shape emits TWO trailers and the child's reads `##CONNECT 1 127.0.0.1:9`.
       APPENDED rather than assigned: gate-all already puts `--require count-marks.js` in NODE_OPTIONS
       when it runs this file, and replacing it would silently disable the cell counter for every suite
       spawned here. (The two do not collide — ##CELLS is written to stdout, ##CONNECT to stderr.) */
    const hostile = {
      FIRESTORE_EMULATOR_HOST: 'evil.example:1234',
      FIREBASE_DATABASE_EMULATOR_HOST: 'evil.example:1234',
      FIREBASE_FIRESTORE_EMULATOR_ADDRESS: 'evil.example:1234',
      FIREBASE_EMULATOR_HUB: 'evil.example:1234',
    };
    const accepted = [];
    for (const f of files) {
      /* runObserved gives each suite its OWN record dir and removes it afterwards, so one suite's
         process tree can never be read as another's, and injects the preload through NODE_OPTIONS
         APPENDED to whatever is already there — gate-all puts `--require count-marks.js` in it when it
         runs this file, and clobbering that would silently disable the cell counter for all 49. */
      const { r, verdict } = runObserved([path.join(ROOT, 'test', f)], hostile);
      if (!refusedAsOneCleanProcess(r, verdict)) {
        accepted.push(`${f} (exit ${r.status}, signal ${r.signal}) — ${verdict.why}`);
      }
    }
    assert.deepStrictEqual(accepted, [],
      '🔴 an emulator suite did NOT refuse a foreign host WITHOUT CONTACTING IT — either it never declined, or it made an outbound connection attempt first, or its ##CONNECT trailer is missing so nothing observed it. A suite that reaches a non-local database can assert against another tree, report green, and in the worst case wipe it');

    // …and each suite is reachable by a script, or nothing will ever run it.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const named = new Set();
    for (const v of Object.values(pkg.scripts || {})) {
      if (!/emulator-run\.js/.test(v)) continue;
      for (const m of String(v).matchAll(/test\/([A-Za-z0-9._-]+\.js)/g)) named.add(m[1]);
    }
    const orphans = files.filter((f) => !named.has(f));
    assert.deepStrictEqual(orphans, [],
      '🔴 an emulator suite has no script — the aggregate enumerates scripts, so nothing runs it and its failures are invisible');
    ok(`all ${files.length} emulator suites REFUSE a foreign emulator when driven — each as a SINGLE process with a clean nonzero exit, an anchored banner, zero outbound connection attempts and zero process or worker launches, decided from its own record file rather than from stdio — and each is reachable by a script`);
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

  // ── 13. THE GATE LIST IS ENUMERATED, NEVER HAND-KEPT — AND IT IS EVERY TEST SCRIPT ─────────
  /* 🔴 THE LOOP WAS THE DEFECT, TWICE. First it was twelve of forty-two emulator scripts, which left
     four suites red for an unknown period. Then it was "all forty-four emulator scripts" while
     test:portal — eight test files — sat in no chain and no aggregate at all. So the runner covers
     every test script including `npm test`, and the emulator-only view is a FLAG over the same list
     rather than a second list. Both counts are derived from package.json here, so neither can drift
     into a hand-kept set again. */
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const SELF = new Set(['test:gate', 'test:emulators:all']);
    const entries = Object.entries(pkg.scripts || {});
    const wantAll = entries.filter(([k, v]) => !SELF.has(k) && (k === 'test' || k.startsWith('test:')) && String(v).trim()).length;
    /* 🔴 THE SUBSET IS FILTERED THE SAME WAY THE GATE FILTERS, or the guard is checking a different
       question than the tool answers. gate-all only ever runs `test` and `test:*` (minus its own two
       entry points), so a script that routes the emulator WITHOUT being a test script — a measurement
       harness, say — is legitimately outside the gate. Counting every emulator-routing script here
       made the guard expect one the listing had correctly excluded. Aligning it is not a weakening:
       the SELF/test:* filter is the gate's own rule, applied to the same input. */
    const wantEmu = entries.filter(([k, v]) => !SELF.has(k) && (k === 'test' || k.startsWith('test:')) && /emulator-run\.js/.test(v)).length;
    assert.ok(wantEmu >= 40 && wantAll > wantEmu, `premise — ${wantEmu} emulator scripts inside ${wantAll} test scripts`);

    const list = (args) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'gate-all.js'), ...args, '--list'], { cwd: ROOT, encoding: 'utf8' });
      assert.strictEqual(r.status, 0, `the runner can list (${args.join(' ') || 'full'})`);
      return r.stdout || '';
    };

    const full = list([]);
    const mFull = /(\d+) test scripts/.exec(full);
    assert.ok(mFull, 'the full listing reports a count');
    assert.strictEqual(Number(mFull[1]), wantAll,
      '🔴 the gate runs a different set than package.json declares — a hand-kept list has crept back in');
    /* An exact line, not /^test\b/: the word boundary sits before the colon, so \b happily matched
       "test:backfill-identities" and the check would have passed on any emulator script. */
    assert.match(full, /^test$/m, '🔴 npm test is not in the gate — it was a separate thing to remember');
    assert.match(full, /test:portal/, '🔴 test:portal is not in the gate — the exact suite that hid');
    assert.ok(!/test:gate|test:emulators:all/.test(full), 'the runner does not list itself (it would recurse)');

    const emu = list(['--emulators']);
    const mEmu = /(\d+) emulator scripts/.exec(emu);
    assert.ok(mEmu, 'the subset listing reports a count');
    assert.strictEqual(Number(mEmu[1]), wantEmu, '🔴 the emulator subset drifted from package.json');
    assert.ok(!/test:portal/.test(emu) && !/^test$/m.test(emu), 'the subset really is the emulator scripts only');
    ok(`the gate list is enumerated from package.json — ${wantAll} test scripts including npm test and test:portal, with a ${wantEmu}-script emulator subset over the SAME list`);
  }

  // ── 14. 🔴 AN EXCUSE CANNOT OUTLIVE ITS DEFECT, AND A SKIP IS NEVER SILENT ──────────────────
  /* The three outcomes a gate actually turns on, driven directly rather than inferred from one long
     run: a plain failure fails; an allowlisted failure is EXCUSED and still printed; and an
     allowlisted suite that has started PASSING fails the run so the entry must be deleted. That last
     one is the point — an allowlist nobody prunes quietly re-hides the next regression in that
     suite. The empty case fails too: a run that measured nothing is never a pass. */
  {
    const { classify, KNOWN_RED } = require('./gate-all.js');

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

    /* 🔴 THE SAME RULE ONE LEVEL DOWN. Success came from the exit status alone, so a suite that
       exited early — or whose output convention went unrecognised — reported green with 0 cells,
       sitting in the very column meant to make that visible. */
    const zeroCell = classify([{ name: 'test:a', ok: true, cells: 0 }], {});
    assert.strictEqual(zeroCell.exitCode, 1, '🔴 a suite that exited 0 while asserting NOTHING passed the gate');
    assert.strictEqual(zeroCell.rows[0].state, 'zero-cell');
    assert.strictEqual(classify([{ name: 'test:a', ok: true, cells: 0 }], {}, { 'test:a': 'a recorded reason' }).exitCode, 0,
      'an allowlisted zero-cell suite is excused, like KNOWN_RED');
    assert.strictEqual(classify([{ name: 'test:a', ok: true, cells: 5 }], {}).exitCode, 0, 'an ordinary passing suite is unaffected');

    /* 🔴 THE REASON RULE IS DRIVEN, NOT MERELY LOOPED OVER. KNOWN_RED is empty now that the
       resolve-manual excuse was deleted, and a `for` loop over an empty table passes while checking
       nothing — an empty walk is not evidence. So the rule is asserted against a SYNTHETIC entry
       that breaks it, which is what proves the rule would catch a reasonless excuse if one were
       added; the live table is then reported as a count, not as a check it passed. */
    const reasonOk = (reason) => typeof reason === 'string' && reason.length > 40;
    assert.strictEqual(reasonOk('too short'), false, '🔴 the reason rule accepts an excuse with no substance — an excuse without one is a silent skip');
    assert.strictEqual(reasonOk(undefined), false, 'and an excuse with no reason at all');
    assert.strictEqual(reasonOk('a recorded reason long enough to say what is broken and where to look'), true, 'while a substantive reason is accepted');
    for (const [name, reason] of Object.entries(KNOWN_RED)) {
      assert.ok(reasonOk(reason), `🔴 KNOWN_RED["${name}"] has no substantive reason — an excuse without one is a silent skip`);
    }
    ok(`fail / excused / stale-excuse / zero-assertion / nothing-measured each decided correctly; the reason rule rejects a reasonless excuse (KNOWN_RED currently holds ${Object.keys(KNOWN_RED).length})`);
  }

  // ── 14b. 🔴 THE COUNT IS REPORTED BY THE SUITE, NOT INFERRED FROM ITS OUTPUT ─────────────────
  /* Inferring it from a subprocess tree's combined stdout was wrong in BOTH directions and kept
     getting wronger: the firebase CLI's "✔  Script exited successfully", "✔  firestore: …",
     "✔  Rules updated." and "✔  Export complete" inflated every emulator suite, while one suite's own
     summary line ("✓ driver-diag: 10 tests passed") stood for ten and counted as one. Stripping them
     one at a time was a denylist that grew every round.
     tools/count-marks.js is preloaded into the SUITE'S OWN PROCESS, so the chrome — written by a
     different process — is excluded by isolation rather than by pattern. */
  {
    const { countCells, classify } = require('./gate-all.js');

    // Chrome in the stream is irrelevant now: only trailers are read.
    const withChrome = [
      '✔  firestore: Firestore Emulator was started in standard edition.',
      '✔  firestore: Rules updated.',
      '  ✓ 1 a real assertion',
      '##CELLS 1',
      '✔  Script exited successfully (code 0)',
      '✔  Export complete',
    ].join('\n');
    assert.strictEqual(countCells(withChrome), 1,
      '🔴 CLI chrome reached the count — emulator suites are inflated by however much the CLI happened to print');

    // Several processes in a chain each report; they sum. test:rewards:emulator runs six suites.
    assert.strictEqual(countCells('##CELLS 12\n##CELLS 30\n##CELLS 0\n'), 42,
      'trailers from a chained script and its wrapper processes sum');

    /* 🔴 NO TRAILER IS "NOT MEASURED", NOT "ZERO". Reading a broken measurement as a silent suite
       files it under the wrong rule and sends whoever reads the row to the wrong problem. */
    assert.strictEqual(countCells('  ✓ 1 marks but no trailer\n'), null,
      '🔴 a suite that emitted no count was treated as a number rather than as unmeasured');

    const unmeasured = classify([{ name: 'test:x', ok: true, cells: null }], {});
    assert.strictEqual(unmeasured.rows[0].state, 'not-measured', '🔴 a suite that was never counted passed the gate');
    assert.strictEqual(unmeasured.exitCode, 1, 'and the gate is red for it');
    assert.notStrictEqual(unmeasured.rows[0].state, 'zero-cell', '🔴 a broken measurement was filed as a silent suite');

    const silent = classify([{ name: 'test:x', ok: true, cells: 0 }], {});
    assert.strictEqual(silent.rows[0].state, 'zero-cell', 'while a suite that really asserted nothing is still zero-cell');
    assert.strictEqual(silent.exitCode, 1, 'and also red');

    /* The preload itself, driven end to end: it must count the marks its process writes and no
       others, and its own trailer must not be counted. */
    const probe = spawnSync(process.execPath, ['-r', path.join(ROOT, 'tools', 'count-marks.js'), '-e',
      "console.log('  ✓ 1 one');console.log('ok 2 two');console.log('✔ three');console.log('i  chrome');"],
      { encoding: 'utf8', timeout: 30000 });
    assert.match(probe.stdout, /^##CELLS 3$/m, `🔴 the preload miscounted its own process: ${JSON.stringify(probe.stdout)}`);
    ok('the count comes from the suite\'s own process: CLI chrome is excluded by isolation, chained trailers sum, and no trailer is NOT-MEASURED rather than zero');
  }

  // ── 14bb. 🔴 EVERY node IN A CHAINED COMMAND IS PRELOADED, NOT JUST THE FIRST ───────────────
  /* The review asked whether injecting into the inner command holds for every shape it takes. All 46
     routed scripts are `node <file>` — except test:rewards:emulator, which chains SIX of them with
     `&&` in one string. A `^node ` prefix preloads the first and leaves five uncounted, and because
     a missing trailer is NOT-MEASURED rather than zero, that fails loudly instead of quietly
     reverting to an inferred number — but it still fails, so the chain is driven here. */
  {
    const { injectCounter } = require('./emulator-run.js');
    const C = '/abs/tools/count-marks.js';

    assert.strictEqual(injectCounter('node test/a.emulator.test.js', C), `node -r ${C} test/a.emulator.test.js`,
      'the ordinary single-suite shape is preloaded');

    const chained = injectCounter('node test/a.js && node test/b.js && node test/c.js', C);
    assert.strictEqual((chained.match(/-r \/abs/g) || []).length, 3,
      '🔴 a chained script preloaded only some of its suites — the rest report no count at all');

    // Every routed script in package.json actually receives it.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    let routed = 0;
    for (const [name, body] of Object.entries(pkg.scripts || {})) {
      if (!/emulator-run\.js/.test(body)) continue;
      routed += 1;
      const m = body.match(/"([^"]+)"\s*$/);
      assert.ok(m, `🔴 routed script ${name} has no quoted inner command, so nothing can be injected into it`);
      const injected = injectCounter(m[1], C);
      const nodes = (m[1].match(/\bnode\s+[\w./-]+\.(?:js|mjs)\b/g) || []).length;
      assert.strictEqual((injected.match(/-r \/abs/g) || []).length, nodes,
        `🔴 ${name}: ${nodes} node invocations but only ${(injected.match(/-r \/abs/g) || []).length} preloaded — the rest would be NOT MEASURED`);
    }
    ok(`all ${routed} routed scripts receive the counter in every node invocation, chained ones included`);
  }

  // ── 14d. 🔴 THE GATE'S OWN MAIN PATH IS EXECUTED, NOT JUST ITS FUNCTIONS ────────────────────
  /* Everything below `require.main !== module` in gate-all.js is invisible to a suite that REQUIRES
     it. A `join is not defined` in the spawn loop therefore survived a green npm test, six green
     sweeps and a green run of THIS file — the only thing that executed it was the gate, which is the
     thing being changed. Requiring a module proves it parses; it does not prove it runs. */
  {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'gate-all.js'), '--only=test:portal'],
      { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.ok(!/ReferenceError|TypeError|is not defined|is not a function/.test(out),
      `🔴 the gate crashes on its own main path: ${out.split('\n').filter((l) => /Error/.test(l))[0] || out.slice(-200)}`);
    assert.match(out, /gate-all: 1\/1 passing/, `🔴 the gate did not complete one script end to end: ${out.slice(-300)}`);
    assert.match(out, /\d+ cells/, 'and it reported a cell count, so the counting path ran too');
    assert.strictEqual(r.status, 0, 'a passing script leaves the gate green');
    ok('gate-all runs one real script through its whole main path — the code below require.main is executed, not only parsed');
  }

  // ── 14c. 🔴 A SUMMARY LINE IS NOT A CELL — the same defect, opposite direction ────────────────
  /* driver-diag printed one `✓ driver-diag: N tests passed`, which every counter read as ONE cell
     standing for N. So the same counter made emulator rows one high and this row nine low. Fixed at
     source: one mark per test. */
  {
    const src = fs.readFileSync(path.join(ROOT, 'driver-diag.test.js'), 'utf8');
    assert.ok(!/✓ driver-diag: \$\{pass\} tests passed/.test(src),
      '🔴 driver-diag still reports a summary line that counts as one cell for many assertions');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'driver-diag.test.js')], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    const marks = (r.stdout.match(/^\s*✓ \d+ /gm) || []).length;
    assert.ok(marks >= 10, `🔴 driver-diag emits ${marks} marks for its tests — a summary line hides how many assertions ran`);
    ok(`driver-diag emits one mark per test (${marks}), not one summary line standing for all of them`);
  }

  // ── 14e. 🔴 THE SETTLE WAIT: ENGAGES, TIMES OUT LOUDLY, AND RECORDS ITSELF ──────────────────
  /* Ports take ~300ms to release after an emulator suite, so a following suite can start while the
     previous emulator still holds one — an observed hazard here, which once produced a false DRIFTED
     sweep result. The branches are driven with an injected prober rather than real sockets, because
     the timeout path cannot otherwise be reached in a test.
     🔴 IT WAS BUILT AS A FIX FOR THE identity-registry FLAKE AND IT IS NOT ONE — it engaged on every
     transition and the flake occurred anyway with all ports confirmed free. These cells assert the
     port-collision guard, which is what it actually is. */
  {
    const { settleAfter, SETTLE_POLL_MS } = require('./gate-all.js');
    const band = { database: 9140, hub: 4540 };

    // …engages while a port is held, and stops as soon as it clears.
    {
      let clock = 0; let polls = 0;
      const stats = { engagements: 0, maxWaitMs: 0, totalWaitMs: 0 };
      const waited = settleAfter('prev', 'next', {
        band, stats, timeoutMs: 30000,
        now: () => clock,
        sleep: () => { clock += SETTLE_POLL_MS; polls += 1; },
        isFree: (port) => !(port === 9140 && polls < 3),
        onRefuse: () => { throw new Error('refused when it should have waited'); },
      });
      assert.strictEqual(waited, 3 * SETTLE_POLL_MS, `🔴 it did not wait for the held port to clear (waited ${waited}ms)`);
      assert.strictEqual(stats.engagements, 1, '🔴 an engagement was not recorded — a silent wait is indistinguishable from no wait');
      assert.strictEqual(stats.maxWaitMs, 3 * SETTLE_POLL_MS, 'and the maximum is what the summary reports');
    }

    // …returns immediately when nothing is held, and records NOTHING, so "never engaged" stays true.
    {
      const stats = { engagements: 0, maxWaitMs: 0, totalWaitMs: 0 };
      let clock = 0;
      const waited = settleAfter('prev', 'next', {
        band, stats, timeoutMs: 30000, now: () => clock,
        sleep: () => { clock += SETTLE_POLL_MS; }, isFree: () => true,
        onRefuse: () => { throw new Error('refused on a clear band'); },
      });
      assert.strictEqual(waited, 0, 'a clear band is not waited on');
      assert.strictEqual(stats.engagements, 0,
        '🔴 a no-op was recorded as an engagement — the figures would suggest a guard that is doing work it is not');
    }

    /* 🔴 ON TIMEOUT IT REFUSES; IT MUST NEVER FALL THROUGH. Falling through starts the next suite into
       exactly the condition this removes, while printing nothing — so the hazard returns looking
       identical and the wait has hidden its own evidence. */
    {
      let clock = 0; let refusedWith = null;
      const realErr = console.error; const lines = [];
      console.error = (...a) => lines.push(String(a[0]));
      try {
        settleAfter('test:previous-suite', 'test:next-suite', {
          band, stats: { engagements: 0, maxWaitMs: 0, totalWaitMs: 0 }, timeoutMs: 500,
          now: () => clock, sleep: () => { clock += SETTLE_POLL_MS; },
          isFree: () => false,
          onRefuse: (code) => { refusedWith = code; return code; },
        });
      } finally { console.error = realErr; }
      assert.strictEqual(refusedWith, 2, '🔴 the settle wait FELL THROUGH on timeout — it would start the suite into the condition it exists to remove');
      const said = lines.join('\n');
      assert.match(said, /GATE REFUSED/, 'it refuses by name');
      assert.match(said, /test:previous-suite/, 'names the suite that held the port');
      assert.match(said, /test:next-suite/, 'names the suite that was about to run');
      assert.match(said, /127\.0\.0\.1:9140/, 'and names the port');
    }
    ok('the settle wait engages and records it, no-ops silently on a clear band, and REFUSES by name on timeout rather than falling through');
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
    const want = path.join(os.tmpdir(), `${DISCOVERY_PREFIX}${process.pid}`);
    assert.strictEqual(fns.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH, want,
      '🔴 a functions run would boot the unpinnable discovery server into our own port bands');
    /* 🔴 A PATH WE OWN, NOT THE LITERAL "true". "true" makes the CLI mkdtemp its own
       firebase-discovery-XXXX and never delete it — discovery/index.js reads the manifest and removes
       nothing, so every functions run leaked one directory. Four had already accumulated from my own
       runs. Naming it by pid is what lets the startup sweep tell a stale one from a live one. */
    assert.ok(want.startsWith(os.tmpdir()), 'the manifest lives outside the repo — never near a deploy archive');
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
