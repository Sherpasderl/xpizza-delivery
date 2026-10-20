#!/usr/bin/env node
'use strict';
/* THE APP-SUITES RUNNER (`npm run test:apps`): run every test file in the repo that lives OUTSIDE
 * xpizza-functions and that no xpizza-functions test script already runs.
 *
 * 🔴 WHY. gate-all enumerates xpizza-functions/package.json, and a sibling app's tests were reached
 * only when someone remembered to name a file in the functions `test` chain. Sixty were not: all of
 * xpizza-dispatch-mobile, xpizza-handheld and xpizza-factura, nineteen desktop dispatch suites, five
 * KDS suites and a few loose files. Three of them were red on main for up to three weeks without
 * anyone seeing it (one was a companion slice's mobile boot test). Same defect gate-all was written
 * to remove, one directory up — so the list is ENUMERATED from the tree here too, never typed: a test
 * file added tomorrow in any app folder is run tomorrow.
 *
 *   npm run test:apps              run them all (each file on its own, from its app folder)
 *   npm run test:apps -- --list    show the plan
 *
 * HOW A FILE RUNS. Files are grouped by their top-level folder (repo root = '.'), and each runs as
 * `node --test <file>` with that folder as cwd. If the folder has a package.json "test" script, that
 * script is the folder's CONTRACT: its env assignments and node --test flags are applied, and a file
 * its globs do not match is a PROBLEM (the manifest would never run it) — fix the manifest, not this
 * file. A folder without a test script is swept whole. Files already named by an xpizza-functions
 * test script are left where they are (no double run).
 *
 * Each file is its own verdict so KNOWN_RED can excuse ONE file, with a reason, an owner and a date.
 * An excused file that PASSES fails the run, and so does an entry whose file is gone: an excuse that
 * outlives its defect re-hides the next regression in that file.
 *
 * 🔴 A FILE THAT ASSERTS NOTHING IS NOT A PASS (codex app-suites r1 P1). Exit status alone let an EMPTY
 * test file pass, and a run-wide ##CELLS sum hid it among 700 other cells. So each file is MEASURED on
 * its own: it runs under `--test-reporter=tap`, and its cells are its LEAF test results (node:test
 * tests — never a suite, i.e. TAP `type: 'suite'`, however empty or nested — never SKIP/TODO) plus the assertion marks its own output
 * prints (the ✓ / ✔ / `ok n` lines tools/count-marks.js counts) — EXCLUDING the automatic result line
 * node --test adds for a file that is not itself a node:test suite (that wrapper is the line an empty
 * file still gets). A zero-cell file is RED unless ZERO_CELL_OK names it with a reason.
 *
 * ##CELLS: the children run WITHOUT the count-marks preload (their TAP would count the wrapper and
 * the TAP framing), and this runner emits each file's MEASURED count as its own `##CELLS n` trailer,
 * which gate-all sums with the runner's own (0: the echoed child output is prefixed so nothing in it
 * reads as a mark). The gate's number is therefore exactly the per-file measurement below.
 *
 * 🔴 xpizza-handheld/guards.test.js resolves 'acorn' through createRequire(xpizza-functions/package.json)
 * — a deliberate borrow of the functions install (handheld declares no dependencies and has no
 * lockfile). This runner therefore needs xpizza-functions to be npm ci'd first, which is the gate's
 * normal setup; on a cold tree that one file fails with MODULE_NOT_FOUND 'acorn'.
 */
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FUNCTIONS = path.join(__dirname, '..');
const ROOT = path.join(FUNCTIONS, '..');

/* Each entry RUNS; its failure is reported and excused. Passing, or naming a file that is not in the
   plan, fails the run. */
const KNOWN_RED = {
  'xpizza-dispatch-mobile/boot.test.mjs': {
    reason: 'mdra-* element ids used by the module are in neither the markup nor DYNAMIC_IDS, and the index.html module throws on evaluation (S1b companion, cc298e59)',
    owner: 'dispatch exec — test-only fix in flight on fix/dispatch-boot-mdra (ba56a2fa)',
    since: '2026-10-18',
  },
  'xpizza-dispatch/dispatch-recon-note.test.js': {
    reason: "ReferenceError: reconciliationOrders is not defined in the eval sandbox (reconNotePrompt → resolveReconciliationAction); the page line came with bcf5ff06, the harness was last touched by 08ea1e16",
    owner: 'dispatch exec (money-adjacent: verify the live page too)',
    since: '2026-09-26',
  },
  'xpizza-kitchen/avail-write.test.mjs': {
    reason: 'the KDS module invokes SDK writers beyond the allowed set: removeCancelAck, writeCancelAck (cancel-ack work a6254102 / F2 Q2 8f30280d)',
    owner: 'downloads-5f (F2 Q2 owner)',
    since: '2026-10-12',
  },
};

/* A file that legitimately asserts nothing, with the reason. Empty by design; an entry whose file now
   asserts something fails the run, as does one naming no planned file. */
const ZERO_CELL_OK = {};

const TEST_RE = /\.test\.(?:js|mjs|cjs)$/;
const GLOB_CHARS = /[*?[{]/;
const MARK = /^\s*(?:✓|✔|ok \d)/;   // tools/count-marks.js's mark — kept identical so the two measures agree
const TAP_SUMMARY = /^(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /;

/* cells of ONE file's `node --test --test-reporter=tap <rel>` output — see the header. Pure.
   A result line is COUNTED only once its YAML block has been read (codex app-suites r2): it must be a
   leaf (no result line nested under it), not a SUITE (`type: 'suite'` — a describe(), however empty
   or nested, is grouping, not an assertion), not SKIP/TODO, and not the file wrapper. A result with no
   YAML type keeps the leaf rule. */
function measureTap(out, rel) {
  let cells = 0;
  let inYaml = false;
  let pending = null;                      // the last result line, awaiting its YAML `type`
  const hadChild = {};                     // indent → a result line has appeared deeper since this level's last header
  const settle = () => { if (pending && pending.countable && pending.type !== 'suite') cells += 1; pending = null; };
  for (const line of String(out || '').split('\n')) {
    const ind = line.length - line.trimStart().length;
    const t = line.trim();
    if (inYaml) {
      if (t === '...') inYaml = false;
      else if (pending && ind === pending.ind + 2) { const m = /^type:\s*'?([a-z]+)'?\s*$/.exec(t); if (m) pending.type = m[1]; }
      continue;
    }
    if (t === '---') { inYaml = true; continue; }
    let m;
    if ((m = /^# Subtest: /.exec(t))) { settle(); hadChild[ind] = false; continue; }
    if ((m = /^(not )?ok \d+ - (.*?)(?:\s+#\s+(SKIP|TODO)\b.*)?$/i.exec(t))) {
      settle();
      const leaf = !hadChild[ind];
      hadChild[ind] = false;
      if (ind >= 4) hadChild[ind - 4] = true;
      const wrapper = ind === 0 && leaf && m[2] === rel;
      pending = { ind, countable: leaf && !wrapper && !m[3], type: null };
      continue;
    }
    settle();
    if ((m = /^#\s?(.*)$/.exec(t)) && !(ind === 0 && TAP_SUMMARY.test(m[1])) && MARK.test(m[1])) cells += 1;
  }
  settle();
  return cells;
}

/* the env a measured child runs in: the caller's, minus the count-marks preload (see the header) */
function childEnv(base, extra) {
  const env = { ...base, ...extra };
  if (env.NODE_OPTIONS) env.NODE_OPTIONS = env.NODE_OPTIONS.replace(/--require[= ]\S*count-marks\.js/g, '').replace(/\s+/g, ' ').trim();
  if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;
  return env;
}

/* run ONE planned file and measure it — the function the guard's executable controls drive */
function runFile(e, root = ROOT, base = process.env) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...e.flags, e.rel], { cwd: path.join(root, e.cwd), env: childEnv(base, e.env), encoding: 'utf8', maxBuffer: 256 << 20 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { file: e.file, ok: r.status === 0, cells: measureTap(r.stdout || '', e.rel), out };
}

function trackedFiles(root = ROOT) {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);
}

/* the test files this runner owns the question for: every tracked *.test.{js,mjs,cjs} outside xpizza-functions */
function testFiles(files) {
  return files.filter((f) => TEST_RE.test(f) && !f.startsWith('xpizza-functions/') && !f.split('/').includes('node_modules')).sort();
}

const topOf = (f) => (f.includes('/') ? f.slice(0, f.indexOf('/')) : '.');

function globIn(cwd, pattern, exists) {
  if (!GLOB_CHARS.test(pattern)) return exists(path.posix.join(cwd, pattern)) ? [path.posix.normalize(path.posix.join(cwd, pattern))] : [];
  return fs.globSync(pattern, { cwd: path.join(ROOT, cwd) }).map((m) => path.posix.normalize(path.posix.join(cwd, m.split(path.sep).join('/'))));
}

/* repo paths an xpizza-functions test script already runs: every `../`-relative argument, globs expanded */
function functionsReach(scripts, { glob = globIn, exists = (p) => fs.existsSync(path.join(ROOT, p)) } = {}) {
  const out = new Set();
  for (const [name, body] of Object.entries(scripts || {})) {
    if (!(name === 'test' || name.startsWith('test:'))) continue;
    for (const tok of String(body).split(/\s+/)) {
      const t = tok.replace(/^["']|["';)]+$/g, '');
      if (!t.startsWith('../')) continue;
      const rel = path.posix.normalize(path.posix.join('xpizza-functions', t));
      for (const m of glob('.', rel, exists)) out.add(m);
    }
  }
  return out;
}

/* `[VAR=value ...] node --test [--flag[=v] ...] [glob ...]` → { env, flags, globs }; anything else → null */
function parseManifest(cmd) {
  const toks = String(cmd || '').trim().split(/\s+/).filter(Boolean);
  const env = {};
  let i = 0;
  for (; i < toks.length && /^[A-Z_][A-Z0-9_]*=\S*$/.test(toks[i]); i++) { const k = toks[i].indexOf('='); env[toks[i].slice(0, k)] = toks[i].slice(k + 1); }
  if (toks[i] !== 'node' || toks[i + 1] !== '--test') return null;
  i += 2;
  const flags = [];
  const globs = [];
  for (; i < toks.length; i++) {
    const t = toks[i].replace(/^["']|["']$/g, '');
    if (/[;&|<>`$()]/.test(t)) return null;   // a shell pipeline / chain is not a manifest this runner can honour
    if (t.startsWith('--')) { if (globs.length) return null; flags.push(t); } else globs.push(t);
  }
  return { env, flags, globs };
}

function readManifests(root = ROOT, tops) {
  const m = {};
  for (const top of tops) {
    const p = path.join(root, top, 'package.json');
    if (!fs.existsSync(p)) continue;
    const test = (JSON.parse(fs.readFileSync(p, 'utf8')).scripts || {}).test;
    if (test && String(test).trim()) m[top] = String(test).trim();
  }
  return m;
}

/* THE PLAN — pure over its inputs so the guard can drive it with synthetic trees */
function plan({ files, manifests, reached, glob = (cwd, pattern) => globIn(cwd, pattern, (p) => files.includes(p)) }) {
  const tests = testFiles(files);
  const entries = [];
  const problems = [];
  const covered = {};
  for (const f of tests) {
    if (reached.has(f)) continue;
    const top = topOf(f);
    const cmd = manifests[top];
    let env = {};
    let flags = [];
    if (cmd) {
      const m = parseManifest(cmd);
      if (!m) { problems.push(`${top}/package.json "test" is not \`[VAR=v] node --test [flags] [globs]\` (${cmd}) — this runner cannot honour it`); continue; }
      if (!covered[top]) covered[top] = new Set(m.globs.length ? m.globs.flatMap((g) => glob(top, g)) : tests.filter((x) => topOf(x) === top));
      if (!covered[top].has(f)) { problems.push(`${f}: not run by its own manifest (${top}/package.json "test": ${cmd}) — widen that manifest's globs`); continue; }
      env = m.env;
      flags = m.flags;
    }
    entries.push({ file: f, cwd: top, rel: top === '.' ? f : f.slice(top.length + 1), env, flags });
  }
  return { tests, entries, problems };
}

/* THE VERDICT — pure. pass | fail | excused | stale-excuse | zero-cell | zero-excused | zero-stale, plus
   excuses (either list) naming a file that is not planned. A failing file is judged by KNOWN_RED whatever its
   count; a passing file must ALSO have measured at least one cell, unless ZERO_CELL_OK names it. */
function classify(results, knownRed, plannedFiles, zeroOk = ZERO_CELL_OK) {
  const rows = results.map((r) => {
    if (!r.ok) return { file: r.file, cells: r.cells, state: knownRed[r.file] ? 'excused' : 'fail' };
    if (knownRed[r.file]) return { file: r.file, cells: r.cells, state: 'stale-excuse' };
    if (!(r.cells > 0)) return { file: r.file, cells: r.cells, state: zeroOk[r.file] ? 'zero-excused' : 'zero-cell' };
    return { file: r.file, cells: r.cells, state: zeroOk[r.file] ? 'zero-stale' : 'pass' };
  });
  const orphans = [...Object.keys(knownRed), ...Object.keys(zeroOk)].filter((f) => !plannedFiles.includes(f));
  const n = (s) => rows.filter((x) => x.state === s).length;
  const bad = n('fail') + n('stale-excuse') + n('zero-cell') + n('zero-stale') + orphans.length;
  return { rows, orphans, passed: n('pass') + n('zero-excused'), failed: n('fail'), excused: n('excused'), stale: n('stale-excuse') + n('zero-stale'), zero: n('zero-cell'), cells: rows.reduce((a, r) => a + (r.cells || 0), 0), exitCode: bad ? 1 : 0 };
}

function currentPlan() {
  const files = trackedFiles();
  const tests = testFiles(files);
  const reached = functionsReach(JSON.parse(fs.readFileSync(path.join(FUNCTIONS, 'package.json'), 'utf8')).scripts);
  return plan({ files, manifests: readManifests(ROOT, [...new Set(tests.map(topOf))]), reached });
}

function main() {
  const p = currentPlan();
  if (process.argv.includes('--list')) {
    for (const e of p.entries) console.log(`${e.file}${Object.keys(e.env).length ? `   env ${JSON.stringify(e.env)}` : ''}${e.flags.length ? `   ${e.flags.join(' ')}` : ''}${KNOWN_RED[e.file] ? '   [known-red]' : ''}`);
    console.log(`\n${p.entries.length} app test files to run (${p.tests.length - p.entries.length - p.problems.length} already run by xpizza-functions scripts)`);
    for (const x of p.problems) console.log(`🔴 ${x}`);
    process.exit(p.problems.length ? 1 : 0);
  }
  if (p.problems.length) {
    for (const x of p.problems) console.error(`🔴 app-suites: ${x}`);
    process.exit(1);
  }
  const results = [];
  for (const e of p.entries) {
    console.log(`\n── ${e.file} ─────────────────────────────`);
    const r = runFile(e);
    process.stdout.write(r.out.split('\n').map((l) => `  │ ${l}`).join('\n') + '\n');   // prefixed: nothing echoed reads as a mark or a trailer
    console.log(`  ${r.ok ? 'exit 0' : '🔴 exit ≠ 0'} · ${r.cells} cells measured`);
    console.log(`##CELLS ${r.cells}`);   // this file's measured count, summed by gate-all
    results.push(r);
  }
  const v = classify(results, KNOWN_RED, p.entries.map((e) => e.file));
  const TAG = { pass: 'pass', fail: '🔴 FAIL', excused: 'KNOWN-RED (excused)', 'stale-excuse': '🔴 KNOWN-RED BUT PASSING', 'zero-cell': '🔴 PASSED, 0 ASSERTIONS', 'zero-excused': 'ZERO-CELL (excused)', 'zero-stale': '🔴 ZERO-CELL-OK BUT ASSERTS' };
  console.log('');
  for (const r of v.rows) if (r.state !== 'pass') console.log(`  ${TAG[r.state].padEnd(26)} ${r.file}`);
  for (const f of v.orphans) console.log(`  ${'🔴 EXCUSE WITHOUT A FILE'.padEnd(26)} ${f}`);
  if (v.excused) {
    console.log('\nEXCUSED — these RAN and FAILED:');
    for (const r of v.rows) if (r.state === 'excused') { const k = KNOWN_RED[r.file]; console.log(`  ${r.file}\n    ${k.reason}\n    owner: ${k.owner} · since ${k.since}`); }
  }
  if (v.stale) console.log('\n🔴 AN EXCUSE OUTLIVED ITS CAUSE — delete its KNOWN_RED / ZERO_CELL_OK entry.');
  if (v.zero) console.log('\n🔴 A FILE EXITED 0 WHILE ASSERTING NOTHING — fix it, or add it to ZERO_CELL_OK with a reason.');
  console.log(`\napp-suites: ${v.passed}/${results.length} passing, ${v.failed} failing, ${v.excused} excused, ${v.stale} stale-excuse, ${v.zero} zero-assertion, ${v.orphans.length} orphan excuse(s) — ${v.cells} cells measured per file`);
  process.exit(v.exitCode);
}

module.exports = { KNOWN_RED, ZERO_CELL_OK, MARK, measureTap, childEnv, runFile, TEST_RE, testFiles, functionsReach, parseManifest, plan, classify, currentPlan, trackedFiles, topOf };
if (require.main === module) main();
