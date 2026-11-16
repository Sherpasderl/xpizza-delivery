'use strict';
/* THE APP-SUITES GUARD (static; npm test chain). Every test file outside xpizza-functions is run by
 * someone: an xpizza-functions test script names it, or tools/app-suites.js (`test:apps`, enumerated
 * by gate-all) plans it — and a folder's own manifest never silently skips one of its files. The
 * runner's plan and verdict are pure functions, so the failure modes are driven here with synthetic
 * trees instead of being trusted from one real run.
 * Run: node tools/app-suites.guard.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('./app-suites');

let n = 0;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 APP-SUITES ${m}`;
const FUNCTIONS = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(FUNCTIONS, 'package.json'), 'utf8'));

// 1. the real tree: no problems, and reached ∪ planned is EXACTLY the test-file set (a partition)
const real = A.currentPlan();
assert.deepStrictEqual(real.problems, [], FAIL(`plan problems:\n  ${real.problems.join('\n  ')}`));
const reached = A.functionsReach(pkg.scripts);
const planned = new Set(real.entries.map((e) => e.file));
const both = real.tests.filter((f) => reached.has(f) && planned.has(f));
const neither = real.tests.filter((f) => !reached.has(f) && !planned.has(f));
assert.deepStrictEqual([both, neither], [[], []], FAIL(`not a partition — double-run ${JSON.stringify(both)}, unrun ${JSON.stringify(neither)}`));
ok(`${real.tests.length} app test files outside xpizza-functions: ${real.tests.length - planned.size} run by xpizza-functions scripts, ${planned.size} by test:apps, none by both, none by neither`);

// 2. no blind spot in the file predicate: anything that LOOKS like a test file is in the set the runner owns
const files = A.trackedFiles();
const looks = files.filter((f) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f) && !f.startsWith('xpizza-functions/') && !f.split('/').includes('node_modules'));
const missed = looks.filter((f) => !real.tests.includes(f));
assert.deepStrictEqual(missed, [], FAIL(`test-looking files the runner's predicate does not see: ${missed.join(', ')}`));
ok(`no test-looking file (*.test|spec.{js,mjs,cjs,ts,jsx,tsx}) outside xpizza-functions escapes the predicate (${looks.length} scanned)`);

// 3. wiring: the runner is a test:* script (so gate-all enumerates it) and this guard is in the npm test chain
assert.strictEqual(pkg.scripts['test:apps'], 'node tools/app-suites.js', FAIL('test:apps must be "node tools/app-suites.js"'));
assert.ok(/(^|&& )node tools\/app-suites\.guard\.test\.js( &&|$)/.test(pkg.scripts.test), FAIL('the npm test chain must run tools/app-suites.guard.test.js'));
ok('test:apps is a gate-enumerated test:* script; this guard runs in the npm test chain');

// 4. every KNOWN_RED entry names a planned file and carries a reason, an owner and an ISO date
for (const [f, e] of Object.entries(A.KNOWN_RED)) {
  assert.ok(planned.has(f), FAIL(`KNOWN_RED ${f} is not a planned file`));
  assert.ok(e && String(e.reason || '').trim() && String(e.owner || '').trim() && /^\d{4}-\d{2}-\d{2}$/.test(e.since || ''), FAIL(`KNOWN_RED ${f} needs reason + owner + since (YYYY-MM-DD)`));
}
ok(`${Object.keys(A.KNOWN_RED).length} KNOWN_RED entries, each a planned file with reason + owner + date`);

// 5. manifest parsing: the real shapes parse; a chain / pipeline / non-node-test command does not
assert.deepStrictEqual(A.parseManifest('TZ=America/Tegucigalpa node --test *.test.js'), { env: { TZ: 'America/Tegucigalpa' }, flags: [], globs: ['*.test.js'] });
assert.deepStrictEqual(A.parseManifest('node --test --test-timeout=20000'), { env: {}, flags: ['--test-timeout=20000'], globs: [] });
assert.deepStrictEqual(A.parseManifest('node --test test/*.test.js src/*.test.js'), { env: {}, flags: [], globs: ['test/*.test.js', 'src/*.test.js'] });
for (const bad of ['npm run build && node --test', 'node --test x.test.js; echo hi', 'jest', 'node x.test.js', 'node --test a.test.js --watch']) assert.strictEqual(A.parseManifest(bad), null, FAIL(`parsed an unsupported manifest: ${bad}`));
ok('manifests: env / flags / globs parse; chains, other runners and flags after globs are refused');

// 6. NEGATIVE CONTROLS on synthetic trees — each must turn the plan red (or, for a new folder, wire it)
const synth = (files, manifests, reachedSet = new Set(), globMap = {}) =>
  A.plan({ files, manifests, reached: reachedSet, glob: (cwd, g) => (globMap[`${cwd}|${g}`] || []) });
{ // a file its own manifest's globs do not match → red (today's factura src/ case, before the glob fix)
  const p = synth(['app/package.json', 'app/test/a.test.js', 'app/src/b.test.js'], { app: 'node --test test/*.test.js' }, new Set(), { 'app|test/*.test.js': ['app/test/a.test.js'] });
  assert.ok(p.problems.some((x) => x.startsWith('app/src/b.test.js: not run by its own manifest')), FAIL('an unmatched manifest file was not flagged'));
  assert.deepStrictEqual(p.entries.map((e) => e.file), ['app/test/a.test.js']);
}
{ // an unparseable manifest → red, and none of its files are silently skipped as "planned"
  const p = synth(['app/package.json', 'app/a.test.js'], { app: 'npm run build && node --test' });
  assert.ok(p.problems.length === 1 && /cannot honour it/.test(p.problems[0]) && p.entries.length === 0, FAIL('an unparseable manifest was not flagged'));
}
{ // a brand-new folder with no manifest → swept automatically (no one has to remember it)
  const p = synth(['brand-new-app/x.test.mjs', 'brand-new-app/lib/y.test.js'], {});
  assert.deepStrictEqual([p.problems, p.entries.map((e) => [e.file, e.cwd, e.rel])], [[], [['brand-new-app/lib/y.test.js', 'brand-new-app', 'lib/y.test.js'], ['brand-new-app/x.test.mjs', 'brand-new-app', 'x.test.mjs']]], FAIL('a new folder was not swept'));
}
{ // a bare `node --test` manifest covers its whole folder, carries env, and a functions-reached file is not double-run
  const p = synth(['m/a.test.js', 'm/b.test.js', 'root.test.mjs'], { m: 'TZ=UTC node --test' }, new Set(['m/b.test.js']));
  assert.deepStrictEqual(p.entries.map((e) => [e.file, e.cwd, e.env.TZ || null]), [['m/a.test.js', 'm', 'UTC'], ['root.test.mjs', '.', null]], FAIL('bare manifest / reached exclusion / root folder'));
}
{ // the predicate: a test helper or a node_modules test is not a suite; xpizza-functions is out of scope
  assert.deepStrictEqual(A.testFiles(['a/helper.js', 'a/node_modules/x/t.test.js', 'xpizza-functions/z.test.js', 'a/t.test.cjs']), ['a/t.test.cjs']);
}
ok('negative controls: an unmatched manifest file and an unparseable manifest are RED; a new folder is swept; env + bare manifests + no double-run hold');

// 7. the verdict: plain fail, excused fail, stale excuse, orphan excuse
const KR = { 'x/a.test.js': { reason: 'r', owner: 'o', since: '2026-10-19' } };
const v = (results, planned2) => A.classify(results, KR, planned2, {});
assert.strictEqual(v([{ file: 'x/b.test.js', ok: true, cells: 2 }, { file: 'x/a.test.js', ok: false }], ['x/a.test.js', 'x/b.test.js']).exitCode, 0, FAIL('an excused failure must not fail the run'));
assert.strictEqual(v([{ file: 'x/b.test.js', ok: false }, { file: 'x/a.test.js', ok: false }], ['x/a.test.js', 'x/b.test.js']).exitCode, 1, FAIL('a plain failure must fail the run'));
const stale = v([{ file: 'x/a.test.js', ok: true, cells: 2 }], ['x/a.test.js']);
assert.ok(stale.exitCode === 1 && stale.stale === 1, FAIL('a KNOWN_RED file that PASSES must fail the run'));
const orphan = v([{ file: 'x/b.test.js', ok: true, cells: 2 }], ['x/b.test.js']);
assert.ok(orphan.exitCode === 1 && orphan.orphans.length === 1, FAIL('a KNOWN_RED entry with no planned file must fail the run'));
ok('verdict: plain failure RED, excused failure green, KNOWN_RED-but-passing RED, excuse-without-a-file RED');

// 8. PER-FILE MEASUREMENT (codex app-suites r1 P1) — EXECUTABLE: real files in a temp dir, run through the
//    runner's own runFile (node --test --test-reporter=tap, count-marks stripped from the child), so the
//    controls prove the real measurement, not a copy of it. The empty file is the one Codex reproduced.
{
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-suites-cells-'));
  try {
    const put = (f, src) => fs.writeFileSync(path.join(dir, f), src);
    put('empty.test.mjs', '');
    put('exit-only.test.js', 'process.exit(0);\n');
    put('skip-only.test.js', "const t = require('node:test'); t.test('s', { skip: true }, () => {}); t.test('t', { todo: true }, () => {});\n");
    put('marks.test.js', "console.log('  ✓ 1 a'); console.log('  ✓ 2 b'); console.log('ok 3 c'); console.log('marks: OK (3)');\n");
    put('suite.test.js', "const t = require('node:test'); t.test('one', () => {}); t.describe('grp', () => { t.it('two', () => {}); t.it('three', () => {}); });\n");
    put('red.test.js', "require('assert').strictEqual(1, 2);\n");
    // codex app-suites r2: a describe() is a SUITE, not an assertion — empty, or wrapping only an empty suite, is 0
    put('empty-describe.test.js', "const t = require('node:test'); t.describe('nothing here', () => {});\n");
    put('nested-empty-describe.test.js', "const t = require('node:test'); t.describe('outer', () => { t.describe('inner', () => {}); });\n");
    put('subtest.test.js', "const t = require('node:test'); t.test('parent', async (c) => { await c.test('child', () => {}); }); t.describe('grp', () => { t.describe('empty', () => {}); });\n");
    const counter = path.join(__dirname, 'count-marks.js');
    const run = (f) => A.runFile({ file: `fx/${f}`, cwd: '.', rel: f, env: {}, flags: [] }, dir, { ...process.env, NODE_OPTIONS: `--require ${counter}` });
    const got = Object.fromEntries(['empty.test.mjs', 'exit-only.test.js', 'skip-only.test.js', 'marks.test.js', 'suite.test.js', 'red.test.js', 'empty-describe.test.js', 'nested-empty-describe.test.js', 'subtest.test.js'].map((f) => { const r = run(f); return [f, [r.ok, r.cells]]; }));
    assert.deepStrictEqual(got, {
      'empty.test.mjs': [true, 0], 'exit-only.test.js': [true, 0], 'skip-only.test.js': [true, 0],
      'marks.test.js': [true, 3], 'suite.test.js': [true, 3], 'red.test.js': [false, 0],
      'empty-describe.test.js': [true, 0], 'nested-empty-describe.test.js': [true, 0], 'subtest.test.js': [true, 1],
    }, FAIL(`per-file measurement (exit ok, cells): ${JSON.stringify(got)}`));
    // and the verdict turns each zero into RED — the empty file included — with no excuse
    const files = Object.keys(got).map((f) => `fx/${f}`);
    const v = A.classify(Object.entries(got).map(([f, [ok2, cells]]) => ({ file: `fx/${f}`, ok: ok2, cells })), {}, files, {});
    const st = Object.fromEntries(v.rows.map((r) => [r.file.slice(3), r.state]));
    assert.deepStrictEqual(st, { 'empty.test.mjs': 'zero-cell', 'exit-only.test.js': 'zero-cell', 'skip-only.test.js': 'zero-cell', 'marks.test.js': 'pass', 'suite.test.js': 'pass', 'red.test.js': 'fail', 'empty-describe.test.js': 'zero-cell', 'nested-empty-describe.test.js': 'zero-cell', 'subtest.test.js': 'pass' }, FAIL(`verdict: ${JSON.stringify(st)}`));
    assert.strictEqual(v.exitCode, 1, FAIL('zero-assertion files must fail the run'));
    assert.strictEqual(v.cells, 7, FAIL(`the run's measured total is the per-file sum (${v.cells})`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
ok('EXECUTABLE per-file measurement: an empty file, an exit-only file, a skip/todo-only file and an EMPTY describe() (also nested) measure 0 and are RED; ✓/ok marks and node:test LEAF tests count (a TAP type:suite, a parent test with subtests and the file wrapper never)');

// 9. zero-cell excuses: excused zero passes; an excuse whose file asserts, or that names no planned file, is RED;
//    the child env drops ONLY the count-marks preload; and the real ZERO_CELL_OK entries are well-formed
{
  const zr = { 'x/z.test.js': 'reason' };
  assert.strictEqual(A.classify([{ file: 'x/z.test.js', ok: true, cells: 0 }], {}, ['x/z.test.js'], zr).exitCode, 0, FAIL('an excused zero-cell file must not fail the run'));
  const stale = A.classify([{ file: 'x/z.test.js', ok: true, cells: 4 }], {}, ['x/z.test.js'], zr);
  assert.ok(stale.exitCode === 1 && stale.rows[0].state === 'zero-stale', FAIL('a ZERO_CELL_OK file that now asserts must fail the run'));
  assert.strictEqual(A.classify([{ file: 'x/y.test.js', ok: true, cells: 2 }], {}, ['x/y.test.js'], zr).exitCode, 1, FAIL('a ZERO_CELL_OK entry with no planned file must fail the run'));
  assert.strictEqual(A.childEnv({ NODE_OPTIONS: '--max-old-space-size=4096 --require /a/b/tools/count-marks.js --enable-source-maps' }, { TZ: 'UTC' }).NODE_OPTIONS, '--max-old-space-size=4096 --enable-source-maps');
  assert.ok(!('NODE_OPTIONS' in A.childEnv({ NODE_OPTIONS: '--require /x/count-marks.js' }, {})), FAIL('an emptied NODE_OPTIONS must be dropped'));
  for (const [f, why] of Object.entries(A.ZERO_CELL_OK)) assert.ok(planned.has(f) && String(why || '').trim(), FAIL(`ZERO_CELL_OK ${f} needs a planned file and a reason`));
}
ok(`zero-cell excuses: excused-zero green, excuse-that-asserts RED, orphan RED; child env drops only the count-marks preload; ${Object.keys(A.ZERO_CELL_OK).length} ZERO_CELL_OK entries`);

// 10. 🔴 A CANCELLED TEST IS RED (portal light chain r0): a test over node's per-test --test-timeout is CANCELLED, not
//     failed, and must still score RED. EXECUTABLE: a real file through the runner's own runFile + classify.
{
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-suites-cancel-'));
  try {
    fs.writeFileSync(path.join(dir, 'slow.test.js'), "const t = require('node:test'); t.test('fast', () => {}); t.test('slow', () => new Promise((r) => setTimeout(r, 3000)));\n");
    const r = A.runFile({ file: 'fx/slow.test.js', cwd: '.', rel: 'slow.test.js', env: {}, flags: ['--test-timeout=1000'], deadlineMs: 10000 }, dir, process.env);
    assert.ok(r.cancelled >= 1, FAIL(`the over-the-cap file was not reported CANCELLED (cancelled=${r.cancelled}): ${r.out.slice(-300)}`));
    assert.strictEqual(r.ok, false, FAIL('a CANCELLED (timed-out) file scored as a pass'));
    const cv = A.classify([r], {}, ['fx/slow.test.js'], {});
    assert.ok(cv.rows[0].state === 'fail' && cv.exitCode === 1, FAIL(`a cancelled file must fail the run: ${JSON.stringify(cv.rows[0])}`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
ok('EXECUTABLE: a test over node\'s per-test --test-timeout is CANCELLED, reported as such, and scored RED (never a pass)');

// 10b. 🔴 THE FILE DEADLINE (codex #100 P2): --test-timeout caps each TEST, so two tests EACH under the cap can run a file
//      past it and pass. runFile's process-level deadline (the contract's --test-timeout) must kill the whole group and
//      score the file RED «timeout». EXECUTABLE: two 900 ms tests under a 1500 ms contract, through runFile + classify.
{
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-suites-deadline-'));
  try {
    fs.writeFileSync(path.join(dir, 'sum.test.js'), "const t = require('node:test'); const w = () => new Promise((r) => setTimeout(r, 900)); t.test('one', w); t.test('two', w);\n");
    assert.strictEqual(A.fileDeadlineMs(['--test-timeout=1500']), 1500, FAIL('the deadline is read from the contract'));
    assert.strictEqual(A.fileDeadlineMs([]), A.FILE_DEADLINE_MS, FAIL('no contract timeout → the default deadline'));
    const t0 = Date.now();
    const r = A.runFile({ file: 'fx/sum.test.js', cwd: '.', rel: 'sum.test.js', env: {}, flags: ['--test-timeout=1500'] }, dir, process.env);
    const ms = Date.now() - t0;
    assert.ok(r.timedOut === true && r.ok === false, FAIL(`two tests each under the per-test cap ran the file past its 1500 ms deadline and were not stopped (${ms} ms, timedOut=${r.timedOut}, ok=${r.ok}): ${r.out.slice(-200)}`));
    assert.ok(ms < 1750, FAIL(`the deadline did not stop the file on time (${ms} ms)`));
    const dv = A.classify([r], {}, ['fx/sum.test.js'], {});
    assert.ok(dv.rows[0].state === 'fail' && dv.exitCode === 1, FAIL(`a file past its deadline must fail the run: ${JSON.stringify(dv.rows[0])}`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
ok('EXECUTABLE: a file whose tests each pass the per-test cap but together run past the contract deadline is killed (whole group) and scored RED «timeout»');

// 11. 🔴 NO BROWSER IN THE LIGHT CHAIN (rule 32: Chrome only at a slot turn). A file a light npm test step names (side
//     'test') or test:apps plans (side 'apps') whose own source launches a browser is a plan PROBLEM unless KNOWN_BROWSER
//     excuses it on that side with a reason, an owner and a date; an excuse whose file is gone, is on the other side or
//     no longer launches one is RED too. POSITIVE CONTROLS on BOTH sides, through the real chainFiles/lightSides. (The markers below are built by
//     concatenation so this guard's own source is not a browser launcher.) Browser files are named
//     *.browser.test.* and reached by a heavy script (portal: test:portal, narrowed to exactly those).
{
  const LAUNCH = `spawn(process.env.${'CHROME'}_BIN || 'chrome')`, PLAIN = "test('plain', () => {})";
  const script = 'node a.test.js && node ../d/t.test.js && node tools/emulator-ports.guard.test.js && node contract/census.negative.test.js';
  const sides = A.lightSides([{ file: 'p/x.test.js' }, { file: 'p/y.test.js' }, { file: 'k/z.test.js' }], script);
  assert.deepStrictEqual(sides, { 'xpizza-functions/a.test.js': 'test', 'd/t.test.js': 'test', 'p/x.test.js': 'apps', 'p/y.test.js': 'apps', 'k/z.test.js': 'apps' }, FAIL(`light sides (the two heavy steps dropped): ${JSON.stringify(sides)}`));
  const SRC = { 'd/t.test.js': LAUNCH, 'p/x.test.js': LAUNCH, 'p/y.test.js': PLAIN, 'k/z.test.js': `'chrome-${'headless'}-shell'`, 'xpizza-functions/a.test.js': PLAIN, 'xpizza-functions/tools/emulator-ports.guard.test.js': LAUNCH };
  const e = (side) => ({ side, reason: 'r', owner: 'o', since: '2026-11-16' });
  const got = A.browserProblems(sides, (f) => SRC[f], { 'k/z.test.js': e('apps'), 'k/gone.test.js': e('apps'), 'p/y.test.js': e('apps') });
  assert.ok(got.some((x) => x.startsWith("d/t.test.js: launches a browser") && x.includes("'test' side")), FAIL(`an unexcused browser file on the npm test side was not flagged: ${JSON.stringify(got)}`));
  assert.ok(got.some((x) => x.startsWith("p/x.test.js: launches a browser") && x.includes("'apps' side")), FAIL(`an unexcused browser file on the test:apps side was not flagged: ${JSON.stringify(got)}`));
  assert.ok(got.some((x) => x.startsWith('KNOWN_BROWSER k/gone.test.js')) && got.some((x) => x.startsWith('KNOWN_BROWSER p/y.test.js')), FAIL(`a stale KNOWN_BROWSER excuse was not flagged: ${JSON.stringify(got)}`));
  assert.strictEqual(got.length, 4, FAIL(`browser problems (a heavy step's launcher is out of the light chain; an excused one is quiet): ${JSON.stringify(got)}`));
  const wrong = A.browserProblems({ 'd/t.test.js': 'test' }, (f) => SRC[f], { 'd/t.test.js': e('apps') });
  assert.ok(wrong.length === 1 && wrong[0].includes("entry is for 'apps'"), FAIL(`an excuse for the other side must not cover a file: ${JSON.stringify(wrong)}`));
  const realSides = A.lightSides(real.entries, pkg.scripts.test);
  const light = new Set(Object.keys(realSides));
  assert.ok(realSides['xpizza-functions/tools/app-suites.guard.test.js'] === 'test' && realSides['xpizza-portal/marketing.test.mjs'] === 'apps' && !light.has('xpizza-functions/tools/emulator-ports.guard.test.js'), FAIL('premise: the real light chain has both sides and drops the heavy steps'));
  for (const [f, e] of Object.entries(A.KNOWN_BROWSER)) assert.ok(realSides[f] === e.side && String(e.reason || '').trim() && String(e.owner || '').trim() && /^\d{4}-\d{2}-\d{2}$/.test(e.since || ''), FAIL(`KNOWN_BROWSER ${f} needs a light-chain file on its side + reason + owner + since`));
  // the portal split, computed from git: test:portal reaches exactly the *.browser.test.mjs files, test:apps every other one
  const portal = real.tests.filter((f) => f.startsWith('xpizza-portal/'));
  const browser = portal.filter((f) => /\.browser\.test\.mjs$/.test(f));
  assert.ok(browser.length >= 1 && portal.length > browser.length, FAIL(`premise: ${portal.length} portal files, ${browser.length} browser`));
  assert.deepStrictEqual([portal.filter((f) => reached.has(f)), portal.filter((f) => planned.has(f)).length], [browser, portal.length - browser.length], FAIL('test:portal must reach ONLY the portal *.browser.test.mjs files, and test:apps must plan every other portal file'));
  const pm = A.parseManifest(JSON.parse(fs.readFileSync(path.join(FUNCTIONS, '..', 'xpizza-portal', 'package.json'), 'utf8')).scripts.test);
  assert.ok(pm && pm.flags.includes('--test-timeout=180000'), FAIL('the portal test contract must carry --test-timeout=180000 (the per-test cap AND the runFile per-file deadline; marketing ≈ 54 s)'));
  ok(`no browser in the light chain (${light.size} files): an unexcused browser file on the npm test side AND on the test:apps side, a wrong-side excuse and a stale excuse are RED; ${Object.keys(A.KNOWN_BROWSER).length} KNOWN_BROWSER (${Object.values(A.KNOWN_BROWSER).map((e) => e.side).join('/')}); portal: ${browser.length} browser file(s) by test:portal, ${portal.length - browser.length} by test:apps at 180 s`);
}

console.log(`app-suites.guard: OK (${n} groups)`);
