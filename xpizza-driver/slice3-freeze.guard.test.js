// slice3-freeze.guard.test.js — FREEZE-BY-CONSTRUCTION guard for the driver visual-refresh slice 3.
// Run: `node slice3-freeze.guard.test.js`  (ESM, no framework — repo idiom; mirrors slice2-freeze.guard).
//
// Slice 3 is a pure, bounded delta over the slice-2 LANDED tip (07e5ab38, where slice2-freeze is green). Like
// slice 2, it verifies by RESTORATION: strip each SLICE3:* region and, for the REPLACE regions, splice the EXACT
// pinned baseline statement back in; the result — plus every other file frozen to 07e5ab38 — must equal 07e5ab38
// byte-for-byte. Slice 3 is IN PROGRESS, so the region set is a WHITELIST: any SUBSET of the named regions may be
// present (none at the guard commit), but NOTHING outside the named set, and nothing nested in / overlapping a
// SLICE2 region. The region contract lives in slice3-regions.js, shared with slice2-freeze's coexistence splice.
//
//   1. FROZEN FILES — every path tracked at 07e5ab38 under xpizza-driver/ is byte-identical on disk now, EXCEPT
//      index.html (region-only, below), the slice-3-editable builder/test set, and this guard commit's coexistence
//      edit to slice2-freeze.guard.test.js.
//   2. index.html REGION-ONLY — strip the PRESENT SLICE3 regions + restore the pinned spans for the REPLACE
//      regions → recover 07e5ab38 BYTE-FOR-BYTE. Proves every slice-3 index.html change is inside a SLICE3 region.
//   3. MARKERS WELL-FORMED — only names from the whitelist, each a paired START+END, ordered, non-nested,
//      non-duplicated; AND no SLICE3 marker falls inside (nests in / overlaps) any SLICE2 region or replace-span.
//   4. FILE-LEVEL — only the allowed MODIFY set changed; only the slice-3 allowlist added; nothing deleted/renamed.
//   5. REPLACE-SPAN SAFETY — each SLICE3 replace span is byte-identical in BOTH e2266b24 AND 07e5ab38 (so a single
//      shared restore list recovers EITHER baseline — this is what lets slice2-freeze reuse it; proven, not stated).
//   6. NEGATIVE PROOFS — an unnamed/extra region, a SLICE3 region nested in a SLICE2 region, and an out-of-region
//      mutation each turn the recovery/markers checks RED (shown by in-test injection, since no real violation exists).
//
// Mutating ANY byte outside a SLICE3 region — a frozen file, or index.html outside the regions — turns this RED.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SLICE3_REGIONS, SLICE3_NAMES } from './slice3-regions.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PFX = 'xpizza-driver/';

// The slice-3 freeze point: the slice-2 LANDED tip where slice2-freeze is green (batch 2 + the whatsapp fixes).
const BASELINE = '07e5ab38';
// The slice-2 freeze point — used only to PROVE each SLICE3 replace span is identical in both baselines (check 5).
const SLICE2_BASELINE = 'e2266b24';

const ALLOWED_MODIFY = 'xpizza-driver/index.html';
// The builder/test files slice 3 extends in place (exactly these three — advisor-confirmed 2026-10-25).
const SLICE3_EDITABLE = new Set([
  'xpizza-driver/stacked-view.js',
  'xpizza-driver/stacked-view.test.js',
  'xpizza-driver/slice2-branch.test.js',
]);
// The ONE guard this slice-3 guard commit also edits: slice2-freeze's coexistence splice (see slice3-regions.js).
const SLICE3_COEXIST_MODIFY = new Set(['xpizza-driver/slice2-freeze.guard.test.js']);
// Everything slice 3 is allowed to ADD under xpizza-driver/.
const ALLOWED_ADDS = new Set([
  'xpizza-driver/slice3-regions.js',            // the shared SLICE3 region contract
  'xpizza-driver/slice3-freeze.guard.test.js',  // this guard
  'xpizza-driver/slice3-contrast.test.js',      // batch-3 fg/bg WCAG checks (added when the first batch-3 CSS lands)
]);

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dir }).toString('utf8').trim();
const git = (...a) => execFileSync('git', a, { cwd: REPO, maxBuffer: 128 * 1024 * 1024 });
const gitStr = (...a) => git(...a).toString('utf8');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; };

// ---------- shared mechanics (also exercised by the negative-proof cells on mutated inputs) ----------
function scanSlice3(lines) {
  const marks = [];
  const re = /SLICE3:([A-Za-z0-9-]+):(START|END)\b/g;
  lines.forEach((line, i) => {
    let m, n = 0;
    while ((m = re.exec(line)) !== null) { marks.push({ i, name: m[1], kind: m[2] }); n += 1; }
    assert.ok(n <= 1, `line ${i + 1}: more than one SLICE3 marker on a line`);
  });
  return marks;
}
function scanSlice2Ranges(lines) {
  // Every SLICE2 region's inclusive [start,end] line range — a SLICE3 marker may not land inside any of them.
  const re = /SLICE2:([A-Za-z0-9-]+):(START|END)\b/g;
  const open = {}; const ranges = [];
  lines.forEach((line, i) => {
    let m;
    while ((m = re.exec(line)) !== null) {
      if (m[2] === 'START') open[m[1]] = i;
      else if (open[m[1]] != null) { ranges.push([open[m[1]], i, m[1]]); delete open[m[1]]; }
    }
  });
  return ranges;
}
// Validate the PRESENT SLICE3 markers: whitelist, pairing, ordering, non-nesting, non-overlap-with-SLICE2.
// Returns the present regions as { name -> [startLine, endLine] }. Throws (RED) on any violation.
function slice3Ranges(lines) {
  const marks = scanSlice3(lines);
  const s2 = scanSlice2Ranges(lines);
  const inSlice2 = (i) => s2.some(([a, b]) => i >= a && i <= b);
  let open = null; const started = new Set(), ended = new Set(); const out = {};
  for (const { i, name, kind } of marks) {
    assert.ok(SLICE3_NAMES.includes(name), `unknown SLICE3 region: ${name}`);
    assert.ok(!inSlice2(i), `SLICE3:${name}:${kind} (line ${i + 1}) is nested inside / overlaps a SLICE2 region`);
    if (kind === 'START') {
      assert.equal(open, null, `region ${name} START while ${open} still open (nested)`);
      assert.ok(!started.has(name), `region ${name} START appears twice`);
      started.add(name); open = name; out[name] = [i, null];
    } else {
      assert.equal(open, name, `region ${name} END without a matching open START`);
      assert.ok(!ended.has(name), `region ${name} END appears twice`);
      ended.add(name); out[name][1] = i; open = null;
    }
  }
  assert.equal(open, null, `region ${open} never closed`);
  return out;
}
// Strip the present SLICE3 regions (inserts → nothing; replaces → their pinned restore span) → recovered text.
function recoverSlice3(current) {
  const lines = current.split('\n');
  const ranges = slice3Ranges(lines);
  const byName = Object.fromEntries(SLICE3_REGIONS.map((r) => [r.name, r]));
  const present = Object.entries(ranges).map(([name, [s, e]]) => ({ r: byName[name], s, e }))
    .sort((a, b) => b.s - a.s);   // descending so splice indices stay valid
  for (const { r, s, e } of present) {
    lines.splice(s, e - s + 1, ...(r.kind === 'replace' ? r.restore : []));
  }
  return lines.join('\n');
}

// ---------- 0. baselines reachable ----------
let baseSha;
t('baselines reachable (07e5ab38 slice-3, e2266b24 slice-2)', () => {
  baseSha = gitStr('rev-parse', '--verify', `${BASELINE}^{commit}`).trim();
  assert.match(baseSha, /^[0-9a-f]{40}$/, `baseline ${BASELINE} did not resolve`);
  assert.match(gitStr('rev-parse', '--verify', `${SLICE2_BASELINE}^{commit}`).trim(), /^[0-9a-f]{40}$/, `baseline ${SLICE2_BASELINE} did not resolve`);
});

// ---------- 5. replace-span safety (proven first — the other checks rely on it) ----------
t('each SLICE3 replace span is byte-identical in BOTH e2266b24 and 07e5ab38 (so a shared restore recovers either)', () => {
  const s3 = gitStr('show', `${BASELINE}:${ALLOWED_MODIFY}`);
  const s2 = gitStr('show', `${SLICE2_BASELINE}:${ALLOWED_MODIFY}`);
  for (const r of SLICE3_REGIONS) {
    if (r.kind !== 'replace') continue;
    const span = r.restore.join('\n');
    assert.equal(s3.split(span).length - 1, 1, `replace span for ${r.name} must occur exactly once in 07e5ab38`);
    assert.equal(s2.split(span).length - 1, 1, `replace span for ${r.name} must occur exactly once in e2266b24 (so restoring it recovers the slice-2 baseline too)`);
  }
});

// ---------- 1. frozen files ----------
t('frozen: every file tracked at 07e5ab38 is byte-identical, except index.html, the editable set, and the coexistence guard', () => {
  const baseFiles = gitStr('ls-tree', '-r', '--name-only', BASELINE, '--', 'xpizza-driver')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  assert.ok(baseFiles.length > 10, 'baseline file list looks empty — wrong ref?');
  const exempt = new Set([ALLOWED_MODIFY, ...SLICE3_EDITABLE, ...SLICE3_COEXIST_MODIFY]);
  const drift = [];
  for (const repoPath of baseFiles) {
    if (exempt.has(repoPath)) continue;
    const rel = repoPath.slice(PFX.length);
    const baseBytes = git('show', `${BASELINE}:${repoPath}`);
    let diskBytes;
    try { diskBytes = readFileSync(join(__dir, rel)); }
    catch { drift.push(`${repoPath} (missing on disk — deleted?)`); continue; }
    if (Buffer.compare(baseBytes, diskBytes) !== 0) drift.push(`${repoPath} (byte-changed)`);
  }
  assert.deepEqual(drift, [], `frozen files changed:\n  ${drift.join('\n  ')}`);
});

// ---------- 2 & 3. markers + restoration ----------
t('markers: only whitelisted SLICE3 names, paired/ordered/non-nested, none nested in a SLICE2 region', () => {
  const lines = readFileSync(join(__dir, 'index.html'), 'utf8').split('\n');
  slice3Ranges(lines);   // throws on any violation
});

t('restore spans are present in the 07e5ab38 baseline (pin integrity)', () => {
  const baseHtml = gitStr('show', `${BASELINE}:${ALLOWED_MODIFY}`);
  for (const r of SLICE3_REGIONS) {
    if (r.kind !== 'replace') continue;
    assert.ok(baseHtml.includes(r.restore.join('\n')), `pinned span for ${r.name} not found in 07e5ab38 — stale pin`);
  }
});

t('index.html: strip SLICE3 regions + restore the replace spans recovers 07e5ab38 byte-for-byte', () => {
  const current = readFileSync(join(__dir, 'index.html'), 'utf8');
  const baseHtml = gitStr('show', `${BASELINE}:${ALLOWED_MODIFY}`);
  assert.equal(recoverSlice3(current), baseHtml,
    'strip+restore did NOT recover 07e5ab38 — a change leaked OUTSIDE the SLICE3 regions, or a pinned span is wrong');
});

// ---------- 4. file-level ----------
t('file-level: only the allowed MODIFY set changed; only the slice-3 allowlist added; nothing deleted/renamed', () => {
  const ns = gitStr('diff', '--name-status', BASELINE, '--', 'xpizza-driver')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const modified = [], added = [], otherOps = [];
  for (const row of ns) {
    const [status, ...paths] = row.split('\t');
    const code = status[0];
    if (code === 'M') modified.push(paths[0]);
    else if (code === 'A') added.push(paths[0]);
    else otherOps.push(row);   // D/R/C/T are all forbidden in slice 3
  }
  for (const p of gitStr('ls-files', '--others', '--exclude-standard', '--', 'xpizza-driver').split('\n').map((s) => s.trim()).filter(Boolean)) added.push(p);

  assert.deepEqual(otherOps, [], `forbidden op(s) (delete/rename/copy/type):\n  ${otherOps.join('\n  ')}`);
  const allowedModify = new Set([ALLOWED_MODIFY, ...SLICE3_EDITABLE, ...SLICE3_COEXIST_MODIFY]);
  const strayMods = modified.filter((p) => !allowedModify.has(p));
  assert.deepEqual(strayMods, [], `modified outside the allowed set:\n  ${strayMods.join('\n  ')}`);
  const strayAdds = added.filter((p) => !ALLOWED_ADDS.has(p));
  assert.deepEqual(strayAdds, [], `added outside the slice-3 allowlist:\n  ${strayAdds.join('\n  ')}`);
});

// ---------- 6. negative proofs (in-test injection; no real violation exists yet) ----------
t('NEG: an unnamed/extra SLICE3 region anywhere → RED', () => {
  const base = gitStr('show', `${BASELINE}:${ALLOWED_MODIFY}`).split('\n');
  const inject = base.slice();
  inject.splice(5, 0, '/* ===== SLICE3:FOO:START ===== */', 'const x = 1;', '/* ===== SLICE3:FOO:END ===== */');
  assert.throws(() => slice3Ranges(inject), /unknown SLICE3 region: FOO/, 'an out-of-whitelist region must be RED');
});

t('NEG: a SLICE3 region nested inside a SLICE2 region → RED', () => {
  const base = gitStr('show', `${BASELINE}:${ALLOWED_MODIFY}`).split('\n');
  const s2 = scanSlice2Ranges(base);
  assert.ok(s2.length > 0, 'baseline has SLICE2 regions to nest inside');
  const [s] = s2[0];                       // just inside the first SLICE2 region's START
  const inject = base.slice();
  inject.splice(s + 1, 0, '/* ===== SLICE3:LOGIC-3:START ===== */', 'noop();', '/* ===== SLICE3:LOGIC-3:END ===== */');
  assert.throws(() => slice3Ranges(inject), /nested inside \/ overlaps a SLICE2 region/, 'a SLICE3 region inside a SLICE2 region must be RED');
});

t('NEG: an out-of-region mutation → recovery RED', () => {
  const current = gitStr('show', `${BASELINE}:${ALLOWED_MODIFY}`);
  const baseHtml = current;
  // flip a byte on a line that is in NO region (the <title>), with no SLICE3 markers present anywhere
  const mutated = current.replace('<title>Sherpa Driver</title>', '<title>Sherpa Driver X</title>');
  assert.notEqual(mutated, current, 'the probe line must exist to mutate');
  assert.notEqual(recoverSlice3(mutated), baseHtml, 'an out-of-region edit must NOT recover the baseline (RED)');
});

console.log(`✓ slice3-freeze.guard: ${passed} checks passed (baseline ${baseSha.slice(0, 10)})`);
