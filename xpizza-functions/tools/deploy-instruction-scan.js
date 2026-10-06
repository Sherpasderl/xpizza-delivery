'use strict';
// ---------------------------------------------------------------------------
// RAW-LINE scan of the repo for deploy instructions and force-flag lines (codex stats build r6; advisor
// ruling 2026-10-05: no normalizer — rebuilding commands from text is what leaks; pin RAW LINES instead).
//
// SCOPE: `git ls-files` — every tracked file, no extension list — skipping binaries by a NUL-byte check.
// Narrow, explicit exclusions only: this scanner's test, the pins file, the mutant catalogue (their strings
// are deliberately unpinned fixtures).
//
// A DEPLOY LINE: any raw line matching /\bdeploy\b/i where that line, or any of the 3 lines above it,
// matches /firebase/i — so CLI, firebase-tools, npx, comment-wrapped and continued forms are all lines.
// A FORCE LINE: any raw line containing the CLI force flag (`--` + `force`).
// Lines are compared RAW, byte-for-byte after stripping only trailing whitespace (incl. a CR).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FIXTURES = new Set([
  'xpizza-functions/tools/deploy-instruction-scan.test.js',
  'xpizza-functions/tools/deploy-instruction-pins.js',
  'xpizza-functions/tools/mutation-sweep.mutants.json',
]);
const DEPLOY = /\bdeploy\b/i;
const FIREBASE = /firebase/i;
const FORCE = /--force/;
const WINDOW = 3;

// → { deploy: [{ line, text }], force: [{ line, text }] } for one file's text.
function scanText(text) {
  const L = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  const deploy = [], force = [];
  for (let i = 0; i < L.length; i++) {
    if (DEPLOY.test(L[i])) {
      for (let k = Math.max(0, i - WINDOW); k <= i; k++) if (FIREBASE.test(L[k])) { deploy.push({ line: i + 1, text: L[i] }); break; }
    }
    if (FORCE.test(L[i])) force.push({ line: i + 1, text: L[i] });
  }
  return { deploy, force };
}

function trackedFiles(repo) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
}

function scanRepo(repo, { files = null } = {}) {
  const deploy = [], force = [];
  let text = 0, binary = 0;
  for (const rel of files || trackedFiles(repo)) {
    if (FIXTURES.has(rel)) continue;
    let buf;
    try { buf = fs.readFileSync(path.join(repo, rel)); } catch (_) { continue; }   // tracked but deleted in the worktree
    if (buf.includes(0)) { binary++; continue; }
    text++;
    const r = scanText(buf.toString('latin1'));   // latin1: every byte maps to one char — exact, NUL-safe
    for (const d of r.deploy) deploy.push({ file: rel, ...d });
    for (const f of r.force) force.push({ file: rel, ...f });
  }
  return { deploy, force, text, binary };
}

module.exports = { scanText, scanRepo, trackedFiles, FIXTURES, WINDOW };
