'use strict';
/**
 * The sweep's unmutated baseline. Run: node tools/sweep-baseline.test.js
 *
 * 🔴 WHY THIS REPLACED A STATIC PRE-FLIGHT. The previous version read each suite's SOURCE to decide
 * which emulator it needed. Three review rounds found spellings it missed and spellings it wrongly
 * matched; a detector over the ways a call can be written is an unwinnable enumeration, and the
 * failure was silent in the direction that matters.
 *
 * Running the suite answers the same question by OBSERVATION. And it answers a bigger one: the whole
 * harness rests on the premise that the suite PASSES unmutated, and nothing checked that. A suite red
 * for ANY reason makes every mutant die for a reason unrelated to its mutation — the slice's number
 * is then meaningless in a way no kills_with matching can detect.
 *
 * The properties here are about ORDER — baseline BEFORE any mutation, nothing scored after a red one
 * — so they are driven through the REAL entry point with a synthetic catalogue. Requiring the module
 * would prove nothing about order, because everything in it runs at load.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..');
const SWEEP = path.join(__dirname, 'mutation-sweep.js');

/* A catalogue whose mutants anchor real, live code — the anchor guard runs before the baseline and
   would otherwise refuse first, which would prove nothing about the baseline. `tools/fixture-anchor.js`
   is written per-probe so the anchor is guaranteed present. */
function withCatalogue(mutants, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-baseline-'));
  const file = path.join(dir, 'cat.json');
  fs.writeFileSync(file, JSON.stringify(mutants, null, 1));
  try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const run = (file) => spawnSync(process.execPath, [SWEEP, `--mutants=${file}`], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
const anchorFile = 'tools/sweep-baseline.fixture.js';
const mutant = (id, command) => ({ id, slice: 'probe', file: anchorFile, command,
  from: 'const ANCHOR_ONE = 1;', to: 'const ANCHOR_ONE = 2;', label: `probe ${id}`, kills_with: 'never' });

// ── 1. 🔴 A SUITE THAT FAILS UNMUTATED STOPS THE SWEEP, AND NOTHING IS SCORED ─────────────────
{
  const r = withCatalogue([mutant('probe-01', ['node', '-e', 'process.exit(1)'])], run);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.notStrictEqual(r.status, 0, '🔴 a sweep whose suite fails unmutated exited 0 — its numbers would read as evidence');
  assert.match(out, /SWEEP REFUSED — a suite FAILS ON THE PRISTINE TREE/,
    `🔴 the refusal does not say the premise failed: ${out.slice(-300)}`);
  assert.ok(!/KILLED|SURVIVED|DRIFTED/.test(out),
    '🔴 a mutant was SCORED after a red baseline — a partial sweep is not evidence');
  assert.match(out, /NOTHING WAS SCORED/, 'and it says so');
  ok('a red baseline refuses, names the premise, and scores nothing');
}

// ── 2. 🔴 THE BASELINE RUNS BEFORE ANY MUTATION ───────────────────────────────────────────────
/* If it ran after, the "suite passes unmutated" premise would be checked against a mutated tree —
   which is the premise being checked. The fixture is left UNMUTATED on disk by a refusal. */
{
  const fixture = path.join(ROOT, anchorFile);
  const before = fs.readFileSync(fixture, 'utf8');
  withCatalogue([mutant('probe-02', ['node', '-e', 'process.exit(1)'])], run);
  assert.strictEqual(fs.readFileSync(fixture, 'utf8'), before,
    '🔴 the tree was MUTATED before the baseline ran — the baseline measured a mutated tree');
  assert.ok(!fs.existsSync(`${fixture}.bak`), 'and no backup was left behind');
  ok('a refusing baseline leaves the tree untouched — it ran before any mutation');
}

// ── 3. A GREEN BASELINE PROCEEDS TO SCORING ───────────────────────────────────────────────────
/* Without this, cells 1 and 2 are satisfied by a baseline that refuses everything. */
{
  const r = withCatalogue([mutant('probe-03', ['node', '-e', 'process.exit(0)'])], run);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.match(out, /baseline: all 1 command\(s\) green unmutated/, `🔴 a green suite did not pass the baseline: ${out.slice(-300)}`);
  assert.match(out, /SURVIVED|KILLED|DRIFTED/, '🔴 nothing was scored after a GREEN baseline — the baseline is refusing everything');
  ok('a green baseline proceeds to scoring — the refusal is a refusal, not a blanket stop');
}

// ── 4. 🔴 DISTINCT COMMANDS ARE BASELINED ONCE EACH, NOT ONCE PER MUTANT ──────────────────────
/* 25 mutants sharing one command must not pay 25 baseline runs; two commands must both be checked.
   Counted from the sweep's own report rather than by timing. */
{
  const three = [
    mutant('probe-04', ['node', '-e', 'process.exit(0)']),
    mutant('probe-05', ['node', '-e', 'process.exit(0)']),
    mutant('probe-06', ['node', '-e', '0']),
  ];
  const r = withCatalogue(three, run);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.match(out, /baseline: 2 distinct command\(s\)/,
    `🔴 the baseline did not dedupe: three mutants over two commands should baseline twice — ${out.slice(0, 300)}`);
  ok('three mutants over two distinct commands baseline exactly twice');
}

// ── 5. 🔴 THE FAILING SUITE'S OWN OUTPUT IS THE DIAGNOSIS ─────────────────────────────────────
/* The whole point of replacing the detector: the suite says why, in its own words, instead of a
   static analyser guessing. An operator reads this at 3am. */
{
  /* 🔴 THE SENTINEL MUST BE PRODUCIBLE ONLY BY RUNNING THE SUITE. My first version put it in a
     `node -e` script — and the refusal ECHOES THE COMMAND, so the sentinel appeared whether or not
     the suite's output was shown. The cell passed while blind to its own property, and a mutant
     found it rather than review. It now lives inside a fixture file the command only names. */
  const r = withCatalogue([mutant('probe-07', ['node', 'tools/sweep-baseline.failing-fixture.js'])], run);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.ok(!/EMULATOR-REFUSED-SENTINEL/.test('node tools/sweep-baseline.failing-fixture.js'),
    'premise — the sentinel is NOT in the command, so matching it proves the output was shown');
  assert.match(out, /EMULATOR-REFUSED-SENTINEL: this line exists only inside the failing suite/,
    '🔴 the suite\'s own output was not shown — the operator gets a harness message instead of the reason');
  assert.match(out, /command : node tools\/sweep-baseline\.failing-fixture\.js/, 'and the command that failed is named');
  assert.match(out, /reached from : probe-07/, 'and which mutant reached it');
  ok('the refusal carries the suite\'s own output, the command, and the mutant that reached it');
}

// ── 6. 🔴 AN UNKNOWN OR MALFORMED FLAG RUNS NOTHING; --help / -h PRINT THE USAGE ─────────────────────
/* `--help` used to start a FULL sweep (three sessions). The refusal must come BEFORE the catalogue is
   read, so that is what is observed, directly: every refusal probe runs under a preloaded shim that
   EXITS 97 on any file read other than the tool itself (the catalogue is a require()d JSON, read
   through fs.readFileSync), on any write / copy / rename / existence probe, and on any child process.
   The shim is also the safeguard: a regressed tool cannot load the REAL catalogue or run a suite from
   this test, because the first such read stops it. The probes carry NO valid --mutants (one would mask
   an empty one as a repeat), except the repeat probe itself. */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-args-'));
  const sentinel = path.join(dir, 'ran.txt');
  const writes = ['node', '-e', `require('fs').appendFileSync(${JSON.stringify(sentinel)}, 'ran\\n')`];
  const fixture = path.join(ROOT, anchorFile); const before = fs.readFileSync(fixture, 'utf8');
  const shim = path.join(dir, 'no-io-shim.js');
  fs.writeFileSync(shim, `'use strict';
const fs = require('fs'); const cp = require('child_process'); const path = require('path');
const MAIN = path.resolve(process.argv[1]);
const trip = (op, p) => { process.stderr.write('SHIM-TRIPPED ' + op + ' ' + p + '\\n'); process.exit(97); };
const read = fs.readFileSync;
fs.readFileSync = function (p, ...rest) { const r = path.resolve(String(p)); if (r !== MAIN) trip('readFileSync', r); return read.call(this, p, ...rest); };
for (const op of ['writeFileSync', 'appendFileSync', 'copyFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'existsSync', 'readdirSync']) fs[op] = (p) => trip(op, String(p));
for (const op of ['execFileSync', 'execSync', 'spawnSync', 'spawn', 'execFile', 'exec', 'fork']) cp[op] = (c) => trip(op, String(c));
`);
  const probe = (args) => spawnSync(process.execPath, ['-r', shim, SWEEP, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  const runArgs = (file, args) => spawnSync(process.execPath, [SWEEP, `--mutants=${file}`, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const noIo = (r, label) => assert.ok(!/SHIM-TRIPPED/.test(r.stderr || ''), `🔴 ${label}: the catalogue or the tree was touched before the refusal — ${(r.stderr || '').split('\n').find((l) => /SHIM-TRIPPED/.test(l))}`);
  const untouched = (label) => {
    assert.ok(!fs.existsSync(sentinel), `🔴 ${label}: a suite command RAN`);
    assert.strictEqual(fs.readFileSync(fixture, 'utf8'), before, `🔴 ${label}: the tree was mutated`);
    assert.ok(!fs.existsSync(`${fixture}.bak`), `🔴 ${label}: a backup was left behind`);
  };
  try {
    withCatalogue([mutant('probe-08', writes)], (file) => {
      // premise: the shim DOES see a catalogue read: a valid --list (real default, or synthetic) is stopped at the read
      for (const args of [['--list'], [`--mutants=${file}`, '--list']]) {
        const r = probe(args);
        assert.strictEqual(r.status, 97, `premise: ${args.join(' ')} reads the catalogue and the shim stops it (got ${r.status}: ${(r.stderr || '').slice(0, 200)})`);
        assert.match(r.stderr, /SHIM-TRIPPED readFileSync \S*\.json/, 'premise: and names the catalogue read');
      }
      for (const flag of ['--help', '-h']) {
        const r = probe([flag]);
        noIo(r, flag);
        assert.strictEqual(r.status, 0, `${flag} exits 0 (got ${r.status})`);
        assert.match(r.stdout, /^usage: node tools\/mutation-sweep\.js/, `${flag} prints the usage`);
      }
      const refusals = [['--halp'], ['--slice'], ['--slice='], ['--slice=   '], ['--mutants='], ['--mutants=   '], ['--mutants=\t'], ['task7'],
        ['--slice=probe', '--slice=other'], [`--mutants=${file}`, `--mutants=${file}`], ['--list', '--bogus'], ['--help', '--bogus']];
      for (const args of refusals) {
        const label = JSON.stringify(args.map((x) => x.replace(file, '<cat>')));
        const r = probe(args);
        noIo(r, label);
        assert.strictEqual(r.status, 2, `${label}: exits 2 (got ${r.status})`);
        assert.match(r.stderr, /nothing was run\.\nusage: node tools\/mutation-sweep\.js/, `${label}: says nothing ran and prints the usage`);
      }
      untouched('the refusals');
      // an empty selection is a refusal too (pre-existing; asserted here so it stays one)
      const e = runArgs(file, ['--slice=no-such-slice']);
      assert.strictEqual(e.status, 2, `an empty selection exits 2 (got ${e.status})`);
      assert.match(e.stderr, /no mutants matched --slice=no-such-slice — nothing was measured/);
      untouched('an empty selection');
      // valid flags are still accepted: --list reads the catalogue and runs nothing; a path with an inner space is kept whole
      const spaced = path.join(dir, 'a catalogue dir'); fs.mkdirSync(spaced); fs.copyFileSync(file, path.join(spaced, 'cat.json'));
      for (const f of [file, path.join(spaced, 'cat.json')]) {
        const l = runArgs(f, ['--list', '--slice=probe']);
        assert.strictEqual(l.status, 0, `--list --slice=probe exits 0 for ${f} (got ${l.status}: ${(l.stderr || '').slice(0, 200)})`);
        assert.match(l.stdout, /probe-08/, '--list lists the selection');
      }
      untouched('--list');
      // non-vacuity: the sentinel DOES record a run
      const g = runArgs(file, ['--slice=probe']);
      assert.ok(fs.existsSync(sentinel), `premise: a valid --slice run executes the command and the sentinel sees it (${(g.stdout || '').slice(-200)})`);
      assert.strictEqual(fs.readFileSync(fixture, 'utf8'), before, 'and the run restored the fixture');
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  ok('--help / -h print the usage and exit 0; unknown, empty / blank-valued, positional and repeated flags exit 2 with the usage; under a no-I/O shim none of them reads the catalogue, touches the tree or spawns; an empty selection exits 2; valid runs (incl. a path with a space) are still accepted');
}

console.log(`\n${n} cells passed`);
