'use strict';
/* THE GATE'S FAILURE BLOCK (light; npm test chain). emulator-ports.guard 14d went red twice in slots and nobody could
 * tell which suite failed: gate-all printed the first 6 lines matching /FAIL|…|REFUSED|not ok/, and passing portal TEST
 * NAMES match that. Here a REAL `node --test` run (never hand-typed TAP) with passing tests named «…FAILS…REFUSED…» and
 * real failures is fed to gate-all's failureBlock, and gate-all's whole main path is run on a red script in a
 * synthetic tree, so the failure branch below `require.main` is executed, not only parsed.
 * Run: node tools/gate-all-failure.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let n = 0;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const GATE_SRC = process.env.GATE_ALL_SRC || path.join(__dirname, 'gate-all.js');   // RED-first / mutant runs point this at another copy
const G = require(GATE_SRC);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-all-failure-'));
/* NODE_TEST_CONTEXT must be ABSENT, not empty: an empty value still reads as «inside a test run» and node --test then
   skips running files (rc 0, nothing run) — so a guard run under a node --test runner would see a green fixture. */
const childEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; delete e.NODE_OPTIONS; return e; };
const FIXTURE = `import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
for (const k of [1, 2, 3, 4]) test(\`a row the gate REFUSED \${k} FAILS the publish — Error: named, passing\`, () => {});
test('the real defect', () => { assert.strictEqual(1 + 1, 3, 'REAL-FAILURE-MARKER'); });
describe('a group that REFUSED', () => { test('the nested defect', () => { assert.fail('NESTED-MARKER'); }); });
`;
fs.writeFileSync(path.join(TMP, 'fx.test.mjs'), FIXTURE);

try {
  // the real writer: node --test over a pipe (exactly how gate-all spawns a suite) prints TAP
  const r = spawnSync(process.execPath, ['--test', 'fx.test.mjs'], { cwd: TMP, encoding: 'utf8', env: childEnv() });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.notStrictEqual(r.status, 0, 'premise: the fixture run is red');
  assert.match(out, /^\s*not ok \d+ - the real defect/m, 'premise: node --test over a pipe prints TAP `not ok`');
  const oldBlock = out.split('\n').filter((l) => /FAIL|AssertionError|Error:|REFUSED|not ok/.test(l)).slice(0, 6).join('\n');
  assert.ok(!/REAL-FAILURE-MARKER|the real defect/.test(oldBlock), 'positive control: the OLD filter\'s 6 lines are all passing test names (the 14d blindness)');
  ok('a real node --test run with passing tests named «…REFUSED…FAILS…» hides the real failure from the old 6-line filter');

  // 1. the block shows the real not ok lines with their diagnostics, leaves first, no passing name
  const block = G.failureBlock(out);
  const text = block.join('\n');
  assert.match(text, /not ok \d+ - the real defect/, '🔴 the failure block does not show the failing test');
  assert.match(text, /REAL-FAILURE-MARKER/, '🔴 the failure block drops the failing test\'s assertion message (its YAML block)');
  assert.match(text, /location: .*fx\.test\.mjs/, '🔴 the failure block drops the failing test\'s location');
  assert.match(text, /not ok \d+ - the nested defect[\s\S]*NESTED-MARKER/, '🔴 a nested failure is not shown with its message');
  assert.ok(!/not ok \d+ - a group that REFUSED/.test(text), '🔴 a parent that only reports «subtests failed» was shown ahead of the leaves');
  assert.ok(!block.some((l) => /a row the gate REFUSED/.test(l)), '🔴 a PASSING test name is in the failure block');
  assert.ok(block.length <= 4 * 12, 'the block stays bounded');
  ok(`failureBlock shows both real \`not ok\` leaves with their message and location (${block.length} lines), no passing name, not the «subtests failed» parent`);

  // 2. bounded: many failures cap at maxFailures and say how many more
  const many = Array.from({ length: 9 }, (_, i) => `not ok ${i + 1} - t${i}\n  ---\n  error: 'E${i}'\n  ...`).join('\n');
  const capped = G.failureBlock(many);
  assert.strictEqual(capped.filter((l) => /^not ok/.test(l)).length, 4, '🔴 the block is not capped at 4 failures');
  assert.match(capped[capped.length - 1], /and 5 more `not ok`/, '🔴 the cap does not say how many failures it left out');
  ok('the block is bounded (4 failures, the rest counted, not dropped silently)');

  // 3. no TAP at all (a ✓/✗ suite or a crash): keyword lines, but never a passing name
  const custom = '  ✓ 1 a REFUSED row FAILS the publish\n  ✓ 2 Error: named, passing\n  ✗ 3 the real defect\nAssertionError [ERR_ASSERTION]: CUSTOM-MARKER\n';
  const fb = G.failureBlock(custom);
  assert.deepStrictEqual(fb, ['✗ 3 the real defect', 'AssertionError [ERR_ASSERTION]: CUSTOM-MARKER'], '🔴 the fallback shows a passing ✓ name or misses the ✗ failure');
  ok('with no `not ok`, the fallback keeps the ✗ line and the AssertionError and drops passing ✓ names');

  // 4. the WHOLE main path on a red script: the block, the log path, and the log holding the full output
  const tree = path.join(TMP, 'tree');
  fs.mkdirSync(path.join(tree, 'tools'), { recursive: true });
  fs.copyFileSync(GATE_SRC, path.join(tree, 'tools', 'gate-all.js'));
  fs.copyFileSync(path.join(__dirname, 'count-marks.js'), path.join(tree, 'tools', 'count-marks.js'));
  fs.copyFileSync(path.join(TMP, 'fx.test.mjs'), path.join(tree, 'fx.test.mjs'));
  /* Codex #121 P1: failures with no TAP and no keyword — a stderr-only fatal, a segfault (a REAL SIGSEGV, re-raised by
     npm), a silent SIGKILL with no output at all */
  fs.writeFileSync(path.join(tree, 'package.json'), JSON.stringify({ name: 'gate-all-fixture', private: true, scripts: {
    'test:fx': 'node --test fx.test.mjs',
    'test:fatal': `node -e "process.stderr.write('connecting\\nfatal: connection terminated\\n'); process.exit(3)"`,
    'test:segv': `node -e "process.stderr.write('Segmentation fault: 11\\n'); process.kill(process.pid, 'SIGSEGV')"`,
    'test:killed': `node -e "process.kill(process.pid, 'SIGKILL')"`,
  } }));
  const logDir = path.join(TMP, 'logs');
  const env = { ...childEnv(), GATE_ALL_LOG_DIR: logDir };
  const g = spawnSync(process.execPath, [path.join(tree, 'tools', 'gate-all.js'), '--only=test:fx,test:fatal,test:segv,test:killed'], { cwd: tree, encoding: 'utf8', env, timeout: 120000 });
  const gout = `${g.stdout || ''}${g.stderr || ''}`;
  assert.ok(!/ReferenceError|TypeError|is not defined|is not a function/.test(gout), `🔴 the gate's failure branch crashes: ${gout.slice(-400)}`);
  assert.strictEqual(g.status, 1, `🔴 a red script did not make the gate red (rc ${g.status})`);
  const sec = (name) => { const a = gout.indexOf(`── ${name} `); assert.ok(a >= 0, `🔴 no failure section for ${name}:\n${gout.slice(-1500)}`); const rest = gout.slice(a + 3); const b = rest.search(/\n── |\ngate-all/); return rest.slice(0, b < 0 ? undefined : b); };
  const section = sec('test:fx');
  assert.match(section, /not ok \d+ - the real defect[\s\S]*REAL-FAILURE-MARKER/, `🔴 the gate's printed failure block hides the real failure:\n${section.slice(0, 1500)}`);
  const logPath = (/full output: (\S+\.log)/.exec(section) || [])[1];
  assert.ok(logPath, `🔴 the gate prints no full-output log path for the failing script:\n${section.slice(0, 1500)}`);
  const runDir = path.dirname(logPath);
  assert.strictEqual(path.dirname(runDir), logDir, 'the run\'s log dir is made INSIDE GATE_ALL_LOG_DIR (the parent)');
  assert.match(section, /exit code 1 · full output:/, '🔴 the exit code is not printed beside the log path');
  const logged = fs.readFileSync(logPath, 'utf8');
  assert.match(logged, /a row the gate REFUSED 4[\s\S]*the real defect[\s\S]*NESTED-MARKER/, '🔴 the log does not hold the full output');
  ok(`gate-all's main path on a red script prints the real \`not ok\` with its message, its exit code and a full-output log (${path.basename(logPath)}) that holds every line`);

  // 6. Codex #121 P1: no TAP, no keyword — the block is the output's last lines, and the exit code / signal is ALWAYS said
  const fatal = sec('test:fatal');
  assert.match(fatal, /fatal: connection terminated/, `🔴 a stderr-only fatal gives an empty block:\n${fatal}`);
  assert.match(fatal, /exit code 3 · full output:/, `🔴 the stderr-only failure's exit code is not printed:\n${fatal}`);
  const segv = sec('test:segv');
  assert.match(segv, /Segmentation fault: 11/, `🔴 a segfault message gives an empty block:\n${segv}`);
  assert.match(segv, /killed by SIGSEGV · full output:/, `🔴 the segfault's signal is not printed:\n${segv}`);
  const killed = sec('test:killed');
  assert.match(killed, /\(no output at all\)/, `🔴 a silent kill does not say it printed nothing:\n${killed}`);
  assert.match(killed, /killed by SIGKILL · full output:/, `🔴 a silent kill's signal is not printed:\n${killed}`);
  assert.deepStrictEqual(G.failureBlock('a\n\nb\n'), ['a', 'b'], 'the tail keeps non-empty lines only');
  assert.strictEqual(G.failureBlock(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')).length, 12, '🔴 the tail is not bounded');
  ok('a stderr-only «fatal», a real SIGSEGV and a silent SIGKILL each print their last lines (or «no output at all») and «exit code 3» / «killed by SIGSEGV» / «killed by SIGKILL»; the tail is bounded at 12');

  // 7. Codex #121 P2: the logs are PRIVATE — a 0700 run dir, 0600 files, and an existing path is never opened
  assert.strictEqual(fs.statSync(runDir).mode & 0o777, 0o700, `🔴 the run's log dir is not private (0${(fs.statSync(runDir).mode & 0o777).toString(8)})`);
  assert.strictEqual(fs.statSync(logPath).mode & 0o777, 0o600, `🔴 a log file is not private (0${(fs.statSync(logPath).mode & 0o777).toString(8)})`);
  const d2 = G.makeLogDir(TMP);
  const victim = path.join(TMP, 'victim.txt');
  fs.writeFileSync(victim, 'VICTIM');
  fs.symlinkSync(victim, path.join(d2, 'test_a.log'));
  fs.writeFileSync(path.join(d2, 'test_b.log'), 'PLANTED');
  const pa = G.writeFailureLog(d2, 'test:a', 'OUT-A');
  const pb = G.writeFailureLog(d2, 'test:b', 'OUT-B');
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'VICTIM', '🔴 a planted symlink was followed and its target overwritten');
  assert.strictEqual(fs.readFileSync(path.join(d2, 'test_b.log'), 'utf8'), 'PLANTED', '🔴 an existing log file was overwritten');
  assert.deepStrictEqual([path.basename(pa), path.basename(pb)], ['test_a.2.log', 'test_b.2.log'], '🔴 a taken name did not get a numbered sibling');
  assert.strictEqual(fs.readFileSync(pa, 'utf8'), 'OUT-A', 'the sibling holds the output');
  assert.match(G.writeFailureLog(path.join(TMP, 'no-such-dir'), 'test:c', 'x'), /^\(could not write the full output: /, 'an unwritable dir is said, never fatal');
  ok('logs are private (run dir 0700, files 0600); a planted symlink or file at the name is never followed or overwritten (numbered sibling); an unwritable dir is said, not thrown');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`gate-all-failure: OK (${n})`);
