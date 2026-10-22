// slice1-freeze.guard.test.js — FREEZE-BY-CONSTRUCTION guard for the driver visual-refresh slice 1.
// Run: `node slice1-freeze.guard.test.js`  (ESM, no framework — repo idiom).
//
// Proves the slice-1 WORKING TREE is a pure, bounded delta over the baseline commit — i.e. every line
// of behaviour the LIVE money path depends on is provably untouched, and the refresh lives only in the
// three delimited regions + one new pure module:
//
//   1. FROZEN FILES — every path tracked at baseline under xpizza-driver/ is byte-identical on disk now,
//      EXCEPT index.html. (Covers all logic .js, every baseline test, and any baseline asset.)
//   2. index.html REGION-ONLY — stripping the three SLICE1 regions (each START..END line inclusive)
//      recovers the baseline index.html BYTE-FOR-BYTE. One assertion proves there is no edit, deletion,
//      or insertion anywhere outside the three regions (pure insertion + nothing else moved).
//   3. MARKERS WELL-FORMED — exactly the three known region names, each with one START and one END,
//      in order, non-nested, non-duplicated, and no unknown SLICE1:* marker anywhere.
//   4. FILE-LEVEL ALLOWLIST — the only modified path is index.html; the only added paths are the slice-1
//      allowlist (the new pure module, the two slice tests, this guard, the self-hosted fonts); nothing
//      is deleted, renamed or copied.
//   5. NEW MODULE IS PURE — single-order-view.js imports ONLY the allowlisted pure helpers (named
//      imports, no side-effect/dynamic/require), and carries no DOM / Firebase / global / IO /
//      nondeterminism token in its code.
//
// Mutating ANY byte outside a region — in a frozen .js, or in index.html outside the three regions —
// turns this guard RED. See slice1-freeze.proof.sh for the mutation-outside-regions → RED proof.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));   // .../xpizza-driver
const PFX = 'xpizza-driver/';                            // repo-relative prefix for this app

// The slice-1 freeze point: feat/driver-refresh-slice1 is a pure delta over this commit.
const BASELINE = 'eac09cdd';

// The three regions, in the order they must appear in index.html.
const KNOWN_REGIONS = ['PRESENTATION', 'IMPORT', 'SINGLE-ORDER-BRANCH'];

// Everything slice 1 is allowed to ADD under xpizza-driver/ (repo-relative). index.html is the sole
// allowed MODIFY; nothing may be deleted/renamed.
const ALLOWED_ADDS = new Set([
  'xpizza-driver/single-order-view.js',         // the one new production module (pure markup builder)
  'xpizza-driver/single-order-view.test.js',    // its pure-helper tests
  'xpizza-driver/single-order-card.test.js',    // its jsdom card tests
  'xpizza-driver/single-order-branch.test.js',  // the renderActiveAndQueue branch-gate harness
  'xpizza-driver/slice1-font-resolution.test.js', // the self-hosted-font-resolution proof
  'xpizza-driver/slice1-font-resolution.proof.sh', // the exact-weight-pin mutant proof harness
  'xpizza-driver/slice1-contrast.test.js',      // the WCAG AA contrast gate
  'xpizza-driver/slice1-freeze.guard.test.js',  // this guard
  'xpizza-driver/slice1-freeze.proof.sh',       // the mutation-outside-regions → RED proof harness
  'xpizza-driver/fonts/OFL.txt',                // self-hosted Red Hat license
  'xpizza-driver/fonts/redhatdisplay-var.woff2',
  'xpizza-driver/fonts/redhattext-var.woff2',
]);
const REQUIRED_ADD = 'xpizza-driver/single-order-view.js';
const ALLOWED_MODIFY = 'xpizza-driver/index.html';

// single-order-view.js may import ONLY these names from ONLY these pure-helper modules.
const IMPORT_ALLOWLIST = {
  './brand-helpers.js': new Set(['brandLabel', 'brandMeta', 'driverGreeting']),
  './cash-helpers.js': new Set(['collectionFor']),
  './order-helpers.js': new Set(['displayOrderLabel']),
};

// Tokens that would betray impurity (DOM / Firebase / globals / IO / nondeterminism) in code.
const IMPURITY = [
  /\bdocument\b/, /\bwindow\b/, /\bglobalThis\b/, /\bself\b/, /\bfirebase\b/,
  /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/,
  /\bgetElementById\b/, /\bquerySelector\b/, /\baddEventListener\b/, /\.innerHTML\b/, /\bappendChild\b/,
  /\bXPD\b/, /\bDate\s*\.\s*now\b/, /\bMath\s*\.\s*random\b/, /\bnew\s+Date\b/,
  /\bsetTimeout\b/, /\bsetInterval\b/, /\bimport\s*\(/, /\brequire\s*\(/,
];

// Run git from the repo root so pathspecs like `xpizza-driver` and `BASELINE:xpizza-driver/x` resolve
// regardless of this worktree's layout (cwd=__dir is INSIDE xpizza-driver, where that pathspec is empty).
const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dir }).toString('utf8').trim();
const git = (...a) => execFileSync('git', a, { cwd: REPO, maxBuffer: 128 * 1024 * 1024 });
const gitBuf = (...a) => git(...a);                 // Buffer (byte-exact)
const gitStr = (...a) => git(...a).toString('utf8');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; };

// ---------- 0. baseline is reachable ----------
let baseSha;
t('baseline commit is reachable', () => {
  baseSha = gitStr('rev-parse', '--verify', `${BASELINE}^{commit}`).trim();
  assert.match(baseSha, /^[0-9a-f]{40}$/, `baseline ${BASELINE} did not resolve to a commit`);
});

// ---------- 1. every baseline file except index.html is byte-identical on disk ----------
t('frozen: every baseline file under xpizza-driver/ (except index.html) is byte-identical', () => {
  const baseFiles = gitStr('ls-tree', '-r', '--name-only', BASELINE, '--', 'xpizza-driver')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  assert.ok(baseFiles.length > 10, 'baseline file list looks empty — wrong ref?');
  const drift = [];
  for (const repoPath of baseFiles) {
    if (repoPath === ALLOWED_MODIFY) continue;        // index.html handled by the region checks
    const rel = repoPath.slice(PFX.length);           // path under xpizza-driver/
    const baseBytes = gitBuf('show', `${BASELINE}:${repoPath}`);
    let diskBytes;
    try { diskBytes = readFileSync(join(__dir, rel)); }
    catch { drift.push(`${repoPath} (missing on disk — deleted?)`); continue; }
    if (Buffer.compare(baseBytes, diskBytes) !== 0) drift.push(`${repoPath} (byte-changed)`);
  }
  assert.deepEqual(drift, [], `frozen files changed:\n  ${drift.join('\n  ')}`);
});

// ---------- 2 & 3. index.html: markers well-formed, and stripping the regions recovers baseline ----------
function scanMarkers(lines) {
  const marks = [];
  const re = /SLICE1:([A-Za-z0-9-]+):(START|END)/g;
  lines.forEach((line, i) => {
    let m, n = 0;
    while ((m = re.exec(line)) !== null) { marks.push({ i, name: m[1], kind: m[2] }); n += 1; }
    assert.ok(n <= 1, `line ${i + 1}: more than one SLICE1 marker on a line`);
  });
  return marks;
}

t('markers: exactly the known regions, each one START + one END, ordered, non-nested, non-duplicated', () => {
  const lines = readFileSync(join(__dir, 'index.html'), 'utf8').split('\n');
  const marks = scanMarkers(lines);
  let open = null;
  const started = new Set(), ended = new Set();
  for (const { name, kind } of marks) {
    assert.ok(KNOWN_REGIONS.includes(name), `unknown SLICE1 region: ${name}`);
    if (kind === 'START') {
      assert.equal(open, null, `region ${name} START while ${open} still open (nested)`);
      assert.ok(!started.has(name), `region ${name} START appears twice`);
      started.add(name); open = name;
    } else {
      assert.equal(open, name, `region ${name} END without a matching open START`);
      assert.ok(!ended.has(name), `region ${name} END appears twice`);
      ended.add(name); open = null;
    }
  }
  assert.equal(open, null, `region ${open} never closed`);
  assert.deepEqual([...started].sort(), [...KNOWN_REGIONS].sort(), 'not exactly the known START markers');
  assert.deepEqual([...ended].sort(), [...KNOWN_REGIONS].sort(), 'not exactly the known END markers');
});

t('index.html: stripping the three regions recovers the baseline byte-for-byte', () => {
  const current = readFileSync(join(__dir, 'index.html'), 'utf8');
  const baseHtml = gitStr('show', `${BASELINE}:${ALLOWED_MODIFY}`);
  const lines = current.split('\n');
  const marks = scanMarkers(lines);
  // Pair each START with its END, build [startIdx..endIdx] ranges.
  const ranges = [];
  for (const name of KNOWN_REGIONS) {
    const s = marks.find((x) => x.name === name && x.kind === 'START');
    const e = marks.find((x) => x.name === name && x.kind === 'END');
    assert.ok(s && e, `region ${name}: missing START or END`);
    assert.ok(e.i >= s.i, `region ${name}: END before START`);
    ranges.push([s.i, e.i]);
  }
  // Splice out each range (descending by start so indices stay valid).
  ranges.sort((a, b) => b[0] - a[0]);
  for (const [s, e] of ranges) lines.splice(s, e - s + 1);
  const stripped = lines.join('\n');
  assert.equal(stripped, baseHtml,
    'stripping the SLICE1 regions did NOT recover baseline — something changed OUTSIDE the regions');
});

// ---------- 4. file-level allowlist: only index.html modified, only the allowlist added, no deletions ----------
t('file-level: only index.html modified; only the slice-1 allowlist added; nothing deleted/renamed', () => {
  // Tracked changes baseline → working tree.
  const ns = gitStr('diff', '--name-status', BASELINE, '--', 'xpizza-driver')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const modified = [], added = [], otherOps = [];
  for (const row of ns) {
    const [status, ...paths] = row.split('\t');
    const code = status[0];
    if (code === 'M') modified.push(paths[0]);
    else if (code === 'A') added.push(paths[0]);
    else otherOps.push(row);   // D (delete), R (rename), C (copy), T (type-change), etc.
  }
  // Untracked (not yet `git add`ed) new files count as adds too.
  const untracked = gitStr('ls-files', '--others', '--exclude-standard', '--', 'xpizza-driver')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  for (const p of untracked) added.push(p);

  assert.deepEqual(otherOps, [], `forbidden op(s) (delete/rename/copy/type):\n  ${otherOps.join('\n  ')}`);
  assert.deepEqual(modified, [ALLOWED_MODIFY], `modified set must be exactly [${ALLOWED_MODIFY}]`);
  const strayAdds = added.filter((p) => !ALLOWED_ADDS.has(p));
  assert.deepEqual(strayAdds, [], `added path(s) outside the slice-1 allowlist:\n  ${strayAdds.join('\n  ')}`);
  assert.ok(added.includes(REQUIRED_ADD), `the new module ${REQUIRED_ADD} must be present`);
});

// ---------- 5. single-order-view.js is pure: allowlisted imports only, no impurity tokens ----------
t('single-order-view.js: imports ONLY the allowlisted pure helpers (named, no side-effect/dynamic)', () => {
  const src = readFileSync(join(__dir, 'single-order-view.js'), 'utf8');
  // No default / namespace / side-effect / dynamic imports, no require.
  assert.ok(!/^\s*import\s+[A-Za-z_$]/m.test(src), 'default/namespace import is not allowed');
  assert.ok(!/^\s*import\s+['"]/m.test(src), 'side-effect import is not allowed');
  assert.ok(!/\bimport\s*\(/.test(src), 'dynamic import() is not allowed');
  assert.ok(!/\brequire\s*\(/.test(src), 'require() is not allowed');
  // Named imports: module → set of names. Must be a subset of the allowlist.
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m; const seen = {};
  while ((m = re.exec(src)) !== null) {
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const mod = m[2];
    assert.ok(IMPORT_ALLOWLIST[mod], `import from a non-allowlisted module: ${mod}`);
    seen[mod] = new Set([...(seen[mod] || []), ...names]);
    for (const n of names) assert.ok(IMPORT_ALLOWLIST[mod].has(n), `${mod}: import "${n}" not allowlisted`);
  }
  assert.ok(Object.keys(seen).length > 0, 'expected at least one allowlisted import');
});

t('single-order-view.js: no DOM / Firebase / global / IO / nondeterminism token in code', () => {
  const src = readFileSync(join(__dir, 'single-order-view.js'), 'utf8');
  // Drop whole-line comments (// …, /* …, * …, */) so prose that names XPD/Date etc. is not flagged.
  const codeLines = src.split('\n').filter((line) => {
    const s = line.trim();
    return !(s.startsWith('//') || s.startsWith('/*') || s.startsWith('*') || s === '*/' || s.startsWith('*/'));
  });
  const code = codeLines.join('\n');
  const hits = IMPURITY.filter((rx) => rx.test(code)).map((rx) => rx.source);
  assert.deepEqual(hits, [], `impurity token(s) found in single-order-view.js code:\n  ${hits.join('\n  ')}`);
});

// ---------- 6, 7, 8. region LOCATION is pinned (codex r1 P2-1) ----------
// Strip-to-baseline (check 2) proves the regions are pure insertions, but NOT that they sit in the right
// place: moving the whole SINGLE-ORDER-BRANCH above `const orders = …` still strips back to baseline while
// breaking at runtime (the branch reads `orders` before it exists). Pin each region to its exact baseline
// neighbours (the line just before its START and just after its END — both baseline lines), add a relocation
// negative, and assert each region carries only its declared kind of content.
const REGION_ANCHORS = {
  'PRESENTATION': { before: '}', after: '</style>' },
  'IMPORT': { before: "import { makeCompanionController } from './onboarding-helpers.js';   // controller owns companion state + the pure decision", after: '' },
  'SINGLE-ORDER-BRANCH': { before: '', after: '  const [active, ...rest] = orders;' },
};
function regionRanges(lines) {
  const marks = scanMarkers(lines);
  const out = {};
  for (const name of KNOWN_REGIONS) {
    const s = marks.find((x) => x.name === name && x.kind === 'START');
    const e = marks.find((x) => x.name === name && x.kind === 'END');
    assert.ok(s && e && e.i >= s.i, `region ${name}: missing or mis-ordered markers`);
    out[name] = [s.i, e.i];
  }
  return out;
}
function checkAnchors(lines) {
  const ranges = regionRanges(lines);
  for (const name of KNOWN_REGIONS) {
    const [s, e] = ranges[name];
    const exp = REGION_ANCHORS[name];
    assert.equal(lines[s - 1], exp.before, `region ${name}: the line BEFORE its START is not the pinned baseline anchor (relocated?)`);
    assert.equal(lines[e + 1], exp.after, `region ${name}: the line AFTER its END is not the pinned baseline anchor (relocated?)`);
  }
}

t('regions: each region is pinned at its exact baseline location (before/after anchors)', () => {
  checkAnchors(readFileSync(join(__dir, 'index.html'), 'utf8').split('\n'));
});

t('relocation NEGATIVE: moving SINGLE-ORDER-BRANCH above `const orders` is rejected by the anchors', () => {
  const lines = readFileSync(join(__dir, 'index.html'), 'utf8').split('\n');
  const [s, e] = regionRanges(lines)['SINGLE-ORDER-BRANCH'];
  const block = lines.slice(s, e + 1);
  const without = [...lines.slice(0, s), ...lines.slice(e + 1)];
  const ordersIdx = without.findIndex((l) => /const orders = XPD\.getDriverOrders/.test(l));
  assert.ok(ordersIdx > 0, 'found the `const orders` declaration to relocate the branch above');
  const moved = [...without.slice(0, ordersIdx), ...block, ...without.slice(ordersIdx)];
  assert.throws(() => checkAnchors(moved), /SINGLE-ORDER-BRANCH: the line AFTER its END/,
    'a branch moved above `const orders` MUST fail the anchor check (it would read orders before declaration)');
});

t('content: each region carries only its declared kind (presentation CSS / import / branch logic)', () => {
  const lines = readFileSync(join(__dir, 'index.html'), 'utf8').split('\n');
  const ranges = regionRanges(lines);
  const bodyOf = (name) => { const [s, e] = ranges[name]; return lines.slice(s + 1, e).join('\n'); };   // strictly between the markers
  const P = bodyOf('PRESENTATION'), I = bodyOf('IMPORT'), B = bodyOf('SINGLE-ORDER-BRANCH');
  // PRESENTATION = Cuadra/Red Hat CSS only — no JS logic.
  assert.ok(/\.sv-card\b/.test(P) && /@font-face/.test(P), 'PRESENTATION must be the slice CSS (.sv-card + @font-face)');
  assert.ok(!/\bimport\s/.test(P) && !/\bfunction\b/.test(P) && !/singleOrderCardHtml\s*\(/.test(P), 'PRESENTATION must carry NO JS logic');
  // IMPORT = the view import + the latch binding only.
  assert.ok(/import\s*\{[^}]*\}\s*from\s*'\.\/single-order-view\.js'/.test(I) && /slice1ReviewLatch/.test(I), 'IMPORT must import the view + declare the latch');
  assert.ok(!/@font-face/.test(I) && !/\bfunction\s/.test(I) && !/renderActiveAndQueue\s*\(/.test(I), 'IMPORT must carry no CSS / function / branch call');
  // SINGLE-ORDER-BRANCH = the gate logic only.
  assert.ok(/orders\.length === 1/.test(B) && /singleOrderCardHtml\s*\(/.test(B), 'BRANCH must be the single-order gate');
  assert.ok(!/@font-face/.test(B) && !/\bimport\s/.test(B), 'BRANCH must carry no CSS / import');
});

console.log(`✓ slice1-freeze.guard: ${passed} checks passed (baseline ${baseSha.slice(0, 10)})`);
