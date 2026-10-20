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
 * ##CELLS: gate-all preloads tools/count-marks.js through NODE_OPTIONS; every child here inherits the
 * environment, so each `node --test` process emits its own trailer exactly as test:portal's does.
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

const TEST_RE = /\.test\.(?:js|mjs|cjs)$/;
const GLOB_CHARS = /[*?[{]/;

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

/* THE VERDICT — pure. pass | fail | excused | stale-excuse, plus excuses naming a file that is not planned */
function classify(results, knownRed, plannedFiles) {
  const rows = results.map((r) => ({ file: r.file, state: r.ok ? (knownRed[r.file] ? 'stale-excuse' : 'pass') : (knownRed[r.file] ? 'excused' : 'fail') }));
  const orphans = Object.keys(knownRed).filter((f) => !plannedFiles.includes(f));
  const n = (s) => rows.filter((x) => x.state === s).length;
  const bad = n('fail') + n('stale-excuse') + orphans.length;
  return { rows, orphans, passed: n('pass'), failed: n('fail'), excused: n('excused'), stale: n('stale-excuse'), exitCode: bad ? 1 : 0 };
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
    const r = spawnSync(process.execPath, ['--test', ...e.flags, e.rel], { cwd: path.join(ROOT, e.cwd), env: { ...process.env, ...e.env }, stdio: 'inherit' });
    results.push({ file: e.file, ok: r.status === 0 });
  }
  const v = classify(results, KNOWN_RED, p.entries.map((e) => e.file));
  const TAG = { pass: 'pass', fail: '🔴 FAIL', excused: 'KNOWN-RED (excused)', 'stale-excuse': '🔴 KNOWN-RED BUT PASSING' };
  console.log('');
  for (const r of v.rows) if (r.state !== 'pass') console.log(`  ${TAG[r.state].padEnd(26)} ${r.file}`);
  for (const f of v.orphans) console.log(`  ${'🔴 EXCUSE WITHOUT A FILE'.padEnd(26)} ${f}`);
  if (v.excused) {
    console.log('\nEXCUSED — these RAN and FAILED:');
    for (const r of v.rows) if (r.state === 'excused') { const k = KNOWN_RED[r.file]; console.log(`  ${r.file}\n    ${k.reason}\n    owner: ${k.owner} · since ${k.since}`); }
  }
  if (v.stale) console.log('\n🔴 A KNOWN-RED FILE PASSED — delete its KNOWN_RED entry.');
  console.log(`\napp-suites: ${v.passed}/${results.length} passing, ${v.failed} failing, ${v.excused} excused, ${v.stale} stale-excuse, ${v.orphans.length} orphan excuse(s)`);
  process.exit(v.exitCode);
}

module.exports = { KNOWN_RED, TEST_RE, testFiles, functionsReach, parseManifest, plan, classify, currentPlan, trackedFiles, topOf };
if (require.main === module) main();
