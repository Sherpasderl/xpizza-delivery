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
const v = (results, planned2) => A.classify(results, KR, planned2);
assert.strictEqual(v([{ file: 'x/b.test.js', ok: true }, { file: 'x/a.test.js', ok: false }], ['x/a.test.js', 'x/b.test.js']).exitCode, 0, FAIL('an excused failure must not fail the run'));
assert.strictEqual(v([{ file: 'x/b.test.js', ok: false }, { file: 'x/a.test.js', ok: false }], ['x/a.test.js', 'x/b.test.js']).exitCode, 1, FAIL('a plain failure must fail the run'));
const stale = v([{ file: 'x/a.test.js', ok: true }], ['x/a.test.js']);
assert.ok(stale.exitCode === 1 && stale.stale === 1, FAIL('a KNOWN_RED file that PASSES must fail the run'));
const orphan = v([{ file: 'x/b.test.js', ok: true }], ['x/b.test.js']);
assert.ok(orphan.exitCode === 1 && orphan.orphans.length === 1, FAIL('a KNOWN_RED entry with no planned file must fail the run'));
ok('verdict: plain failure RED, excused failure green, KNOWN_RED-but-passing RED, excuse-without-a-file RED');

console.log(`app-suites.guard: OK (${n} groups)`);
