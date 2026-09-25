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

console.log(`\n${n} cells passed`);
