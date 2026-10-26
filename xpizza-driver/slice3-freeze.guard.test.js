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
//
// ACCEPTED RESIDUAL (Codex r2): this guard cannot independently protect its OWN bytes — it is an allowed ADD and is
// self-editable, the same standalone posture slice2-freeze had. External review — the HIGH-effort Codex gate on
// every change to this file — is the protector. (slice2-freeze additionally gains this guard's independent sha pin.)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const __dir = dirname(fileURLToPath(import.meta.url));
const PFX = 'xpizza-driver/';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// INDEPENDENT contract pins (Codex r1 P1): the contract is pinned HERE as hardcoded constants — NOT trusted from the
// module. It is loaded as NON-EXECUTABLE DATA (slice3-regions.json), sha-verified BEFORE parse, never imported, so a
// `process.exit(0)` appended to it cannot short-circuit this guard (Codex r2 P1). A tampered contract (widened/
// dropped restore, added/removed/shrunk region, changed kind) is caught even though the file is editable.
const SLICE3_PINS = {
  names: ['PRESENTATION-3', 'IMPORT-3', 'LOGIC-3', 'HELP-HANDLER', 'CUADRE-CSS', 'CUADRE-DOM', 'CUADRE-RENDER', 'CUADRE-SUBMIT', 'CHIME-FRESH', 'OFFER-TAKEOVER'],
  kinds: ['insert', 'insert', 'insert', 'replace', 'replace', 'replace', 'replace', 'replace', 'replace', 'replace'],
  restoreSha: {
    'HELP-HANDLER': 'e823efd01be83461f6b7b900e8e60a9065d9c44bfedb1b32c2624f1d6c00206f',
    'CUADRE-CSS': '41327b6fa5e535b774d323c235e755019b6020516a10ac20340b004667f8a4ec',
    'CUADRE-DOM': 'ec70f01fe5711aacff4fc4e88ff0fd873bf715abf8ba178d30092c7ec34c2dab',
    'CUADRE-RENDER': 'a285b81838c946e23f46a401786b07a62976ca93f25c3d8152640404021eeaaa',
    'CUADRE-SUBMIT': '06a225a4158eae7c797d0775fec2def67fb01283467b3c6352cff7dc55e8466b',
    'CHIME-FRESH': 'e86e31b5350d14f892d99d38e7bf84fcf2358c262d03d9354bf663864e0de4c9',
    'OFFER-TAKEOVER': '88bdef966a96defc21a3b6bc407f595201c0808456016662832f6ae14c60a855',
  },
  fileSha: 'bb29c60d4266c2ae1fc3a7bd34581693cf0f55c2a1da148e8d3d6fe5314fc30c',
};
// SLICE3DEPS carve-outs (advisor 2026-10-26): a REGISTERED exception to the non-nesting rule — a tiny span that MAY
// live inside its declared SLICE2 parent, so slice 3 can edit slice-2-added host code (the fresh-offer deps object)
// without un-freezing the whole SLICE2 region. Each carve is pinned HERE (name / kind / exact parent / baseline sha),
// recovery splices it back to its 07e5ab38 bytes before the SLICE3 strip, and a probe proves an edit just OUTSIDE the
// carve (still inside the parent) still goes RED. An UNREGISTERED carve, or one in the wrong parent / partially
// overlapping / double-nested, FAILS (negative self-tests below).
const SLICE3_DEPS_PINS = {
  names: ['OFFER-RENDER'],
  kinds: ['slice3deps'],
  parents: ['SINGLE-ORDER-MOUNT'],
  restoreSha: { 'OFFER-RENDER': 'f7bd685aa3efa75a6bd3df1757c120d16538876645961bfe5f68cf63170a9c3e' },
};
function loadContract() {   // bytes → sha pin FIRST → JSON.parse; no import/require of editable code (Codex r2 P1)
  const bytes = readFileSync(join(__dir, 'slice3-regions.json'));
  assert.equal(sha256(bytes), SLICE3_PINS.fileSha, 'slice3-regions.json byte-changed — the SLICE3 contract is frozen; re-gate at HIGH effort');
  const data = JSON.parse(bytes);
  assert.ok(data && Array.isArray(data.regions), 'slice3-regions.json has no regions array');
  assert.ok(Array.isArray(data.deps), 'slice3-regions.json has no deps array (SLICE3DEPS carve-outs)');
  return data;
}
const CONTRACT = loadContract();
const SLICE3_REGIONS = CONTRACT.regions;
const SLICE3_DEPS = CONTRACT.deps;
// The approved coexistence revision of slice2-freeze (Codex r1 P3): its WHOLE file is pinned, so unrelated slice2
// protections (e.g. the stacked-view.js purity check) cannot be silently removed under the coexistence exemption.
const SLICE2_GUARD = 'slice2-freeze.guard.test.js';
const SLICE2_GUARD_SHA = 'ecd0b863cb4a2fb13de6723348d1c4f1cad1da3b8ba6efb48da4d6b4239d462c';
const SLICE2_GUARD_CHECKS = 16;   // a removed check drops this count (Codex P3: removing the purity check ⇒ 14)

function assertContract(regions) {   // the names/kinds/restore-bytes half — reusable by the NEG cells on tampered inputs
  assert.deepEqual(regions.map((r) => r.name), SLICE3_PINS.names, 'SLICE3 region names/order tampered (added/removed/shrunk region?)');
  assert.deepEqual(regions.map((r) => r.kind), SLICE3_PINS.kinds, 'SLICE3 region kinds tampered');
  for (const r of regions) if (r.kind === 'replace') {
    assert.equal(sha256(r.restore.join('\n')), SLICE3_PINS.restoreSha[r.name],
      `SLICE3 ${r.name} restore bytes tampered (widened to swallow adjacent code, or shrunk?)`);
  }
}
function assertDepsContract(deps) {   // the SLICE3DEPS registry: names/kinds/parents/restore-bytes, independently pinned
  assert.deepEqual(deps.map((d) => d.name), SLICE3_DEPS_PINS.names, 'SLICE3DEPS carve names/order tampered (added/removed carve?)');
  assert.deepEqual(deps.map((d) => d.kind), SLICE3_DEPS_PINS.kinds, 'SLICE3DEPS carve kinds tampered');
  assert.deepEqual(deps.map((d) => d.parent), SLICE3_DEPS_PINS.parents, 'SLICE3DEPS carve parents tampered (re-pointed to another SLICE2 region?)');
  for (const d of deps) assert.equal(sha256(d.restore.join('\n')), SLICE3_DEPS_PINS.restoreSha[d.name],
    `SLICE3DEPS ${d.name} restore bytes tampered (widened/shrunk, or not the 07e5ab38 branch?)`);
}
function verifySlice3Contract() {
  assert.equal(sha256(readFileSync(join(__dir, 'slice3-regions.json'))), SLICE3_PINS.fileSha,
    'slice3-regions.json byte-changed — the SLICE3 contract is frozen; re-gate any change at HIGH effort');
  assertContract(SLICE3_REGIONS);
  assertDepsContract(SLICE3_DEPS);
}

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
  // single-order-view.js is editable ONLY within the SLICE3:OFERTA-OFFER region (the awaiting_acceptance offer
  // branch, rebuilt to S.oferta). Everything else — svChip/svItems/svPay (money display) and the nav/cash helpers —
  // is pinned by the OFERTA-OFFER rest-hash check below; an edit anywhere else turns this guard RED.
  'xpizza-driver/single-order-view.js',
  'xpizza-driver/single-order-card.test.js',   // its OFFER cases updated for the S.oferta rebuild (other cases unchanged)
]);
// single-order-view.js: SLICE3 may change ONLY the OFERTA-OFFER region. This is the sha256 of the baseline file with
// the offer branch stripped (byte-identical in both baselines); the check strips the current region and must match.
const SOV = 'xpizza-driver/single-order-view.js';
const SOV_REST_SHA = 'bb7dedaf72355416049accae5d65e854e7089c53b844afb9b1052ca09aafbfa6';
function sovRest() {   // the current single-order-view.js with the SLICE3:OFERTA-OFFER region removed (markers + body)
  const lines = readFileSync(join(__dir, 'single-order-view.js'), 'utf8').split('\n');
  const marks = strictMarks(lines, 'SLICE3', ['OFERTA-OFFER']);   // validates the markers (shape + whitelist)
  assert.equal(marks.length, 2, 'single-order-view.js must have exactly the OFERTA-OFFER START + END markers');
  assert.deepEqual([marks[0].kind, marks[1].kind], ['START', 'END'], 'OFERTA-OFFER markers out of order');
  const [s, e] = [marks[0].i, marks[1].i];
  return [...lines.slice(0, s), ...lines.slice(e + 1)].join('\n');
}
// The ONE guard this slice-3 guard commit also edits: slice2-freeze's coexistence splice (see slice3-regions.js).
const SLICE3_COEXIST_MODIFY = new Set(['xpizza-driver/slice2-freeze.guard.test.js']);
// Everything slice 3 is allowed to ADD under xpizza-driver/.
const ALLOWED_ADDS = new Set([
  'xpizza-driver/slice3-regions.json',          // the shared SLICE3 region contract (non-executable data)
  'xpizza-driver/slice3-freeze.guard.test.js',  // this guard
  'xpizza-driver/slice3-contrast.test.js',      // batch-3 fg/bg WCAG checks (added when the first batch-3 CSS lands)
  'xpizza-driver/cuadre-submit.test.js',        // cuadre slide-to-confirm money-submit handler test (lift-real idiom)
  'xpizza-driver/chime-fresh.test.js',          // new-assignment chime (same-hub 'accepted' stacks) handler test
  'xpizza-driver/offer-takeover.test.js',       // cross-hub 2nd-order S.oferta takeover: acceptSecondOrder-not-acceptTask exclusivity
  'xpizza-driver/oferta-offer.test.js',         // S.oferta offer-branch rebuild output test
]);

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dir }).toString('utf8').trim();
const git = (...a) => execFileSync('git', a, { cwd: REPO, maxBuffer: 128 * 1024 * 1024 });
const gitStr = (...a) => git(...a).toString('utf8');

let passed = 0;
// Checks MUST be synchronous and return NOTHING (Codex r3/r4): a callback whose body is deferred — a promise, a
// generator/async-generator iterator, or any non-undefined value — would be counted before its assertions ran.
// Require EXACTLY `undefined` BEFORE incrementing: one rule that rejects that whole class. All shipped checks
// return undefined. (Active-handle hangs still need an external timeout.)
const t = (name, fn) => {
  const r = fn();
  assert.strictEqual(r, undefined, `check "${name}" must be synchronous and return nothing (got a ${typeof r})`);
  passed += 1;
};
// Belt-and-braces (Codex r2 P1): force RED on ANY early exit — if fewer than the expected checks completed (an
// injected process.exit, a thrown/short-circuited load, a skipped check), the process exit code is forced to 1.
const EXPECTED_CHECKS = 22;
process.on('exit', () => {
  if (passed !== EXPECTED_CHECKS) {
    console.error(`slice3-freeze.guard INCOMPLETE: ${passed}/${EXPECTED_CHECKS} checks ran — early exit / skipped check`);
    process.exitCode = 1;
  }
});

// ---------- shared mechanics (also exercised by the negative-proof cells on mutated inputs) ----------
// Strict marker scan (Codex r1 P2): a CANDIDATE is marker-SHAPED — `${prefix}:` … ending in :START/:END (so a
// descriptive `${prefix}:LABEL` comment, e.g. the batch-2 `SLICE3:RESUMEN` section labels, is NOT a marker).
// EVERY candidate must then be EXACTLY `${prefix}:<name>:<START|END>` — a malformed one (SLICE3:START, SLICE3::START,
// SLICE3:BAD_NAME:START) is REJECTED before any name/pairing/nesting validation and before stripping. Whitelist optional.
function strictMarks(lines, prefix, whitelist) {
  // Candidate detection is MAXIMALLY BROAD (Codex r2 P2): ANY `${prefix}:` up to a `:START`/`:END` on the same line
  // is a candidate (names with a dot, space, slash or Unicode can't slip past). Each candidate must then validate
  // EXACTLY as `${prefix}:<name>:<START|END>`, name in [A-Za-z0-9-]+ and (if given) whitelisted — else RED, before
  // stripping. The ONLY non-marker is a bare `${prefix}:<word>` label with NO :START/:END suffix. CRLF-safe.
  const cand = new RegExp(prefix + ':(?:.*?:)?(?:START|END)\\b', 'g');
  const strict = new RegExp('^' + prefix + ':([A-Za-z0-9-]+):(START|END)$');
  const marks = [];
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');   // CRLF-safe
    const hits = line.match(cand) || [];
    assert.ok(hits.length <= 1, `line ${i + 1}: more than one ${prefix} marker`);
    for (const tok of hits) {
      const m = strict.exec(tok);
      assert.ok(m, `malformed ${prefix} marker: "${tok}" (line ${i + 1})`);
      if (whitelist) assert.ok(whitelist.includes(m[1]), `unknown ${prefix} region: ${m[1]}`);
      marks.push({ i, name: m[1], kind: m[2] });
    }
  });
  return marks;
}
function scanSlice2Ranges(lines) {
  // Every SLICE2 region's inclusive [start,end] line range — a SLICE3 marker may not land inside any of them. SLICE2
  // syntax is validated here too (a malformed SLICE2 marker that could skew the ranges is rejected); the SLICE2 NAME
  // whitelist stays slice2-freeze's job, so no whitelist is passed.
  const open = {}; const ranges = [];
  for (const { i, name, kind } of strictMarks(lines, 'SLICE2')) {
    if (kind === 'START') open[name] = i;
    else if (open[name] != null) { ranges.push([open[name], i, name]); delete open[name]; }
  }
  return ranges;
}
// Validate the PRESENT SLICE3 markers: whitelist, pairing, ordering, non-nesting, non-overlap-with-SLICE2.
// Returns the present regions as { name -> [startLine, endLine] }. Throws (RED) on any violation.
function slice3Ranges(lines) {
  const marks = strictMarks(lines, 'SLICE3', SLICE3_PINS.names);   // rejects malformed/unapproved SLICE3 markers (Codex r1 P2)
  const s2 = scanSlice2Ranges(lines);
  const inSlice2 = (i) => s2.some(([a, b]) => i >= a && i <= b);
  let open = null; const started = new Set(), ended = new Set(); const out = {};
  for (const { i, name, kind } of marks) {
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
// Validate the PRESENT SLICE3DEPS carve markers: whitelist, pairing, ordering, non-nesting among themselves, AND each
// carve FULLY inside its DECLARED SLICE2 parent (strictly between that parent's START and END). A carve with an
// unknown name, in the wrong parent, partially overlapping a parent, or outside every parent is RED. Returns
// { name -> [startLine, endLine] }. (SLICE3DEPS markers are invisible to the `SLICE3:`/`SLICE2:` scans — distinct
// token — so this is the ONLY place they are seen; an unregistered one cannot slip through unchecked.)
function slice3DepsRanges(lines) {
  const marks = strictMarks(lines, 'SLICE3DEPS', SLICE3_DEPS_PINS.names);
  const s2 = scanSlice2Ranges(lines);
  const parentOf = Object.fromEntries(SLICE3_DEPS.map((d) => [d.name, d.parent]));
  let open = null; const started = new Set(), ended = new Set(); const out = {};
  for (const { i, name, kind } of marks) {
    if (kind === 'START') {
      assert.equal(open, null, `SLICE3DEPS ${name} START while ${open} still open (nested)`);
      assert.ok(!started.has(name), `SLICE3DEPS ${name} START appears twice`);
      started.add(name); open = name; out[name] = [i, null];
    } else {
      assert.equal(open, name, `SLICE3DEPS ${name} END without a matching open START`);
      assert.ok(!ended.has(name), `SLICE3DEPS ${name} END appears twice`);
      ended.add(name); out[name][1] = i; open = null;
    }
  }
  assert.equal(open, null, `SLICE3DEPS ${open} never closed`);
  for (const [name, [s, e]] of Object.entries(out)) {
    const parent = parentOf[name];
    const pr = s2.find(([, , n]) => n === parent);
    assert.ok(pr, `SLICE3DEPS ${name}: its declared parent SLICE2:${parent} is not present`);
    assert.ok(s > pr[0] && e < pr[1], `SLICE3DEPS ${name} is not FULLY inside its declared parent SLICE2:${parent} (wrong parent / partial overlap?)`);
  }
  return out;
}

// Strip the present SLICE3 regions (inserts → nothing; replaces → their pinned restore span) → recovered text. The
// registered SLICE3DEPS carves are spliced back to their pinned baseline FIRST (they live inside SLICE2 regions, so a
// change there would otherwise leak past the SLICE3 strip); then the SLICE3 regions recover as before.
function recoverSlice3(current) {
  let lines = current.split('\n');
  const depRanges = slice3DepsRanges(lines);   // validates markers + parent containment (RED on any violation)
  const depByName = Object.fromEntries(SLICE3_DEPS.map((d) => [d.name, d]));
  const depsPresent = Object.entries(depRanges).map(([name, [s, e]]) => ({ d: depByName[name], s, e }))
    .sort((a, b) => b.s - a.s);   // descending so splice indices stay valid
  for (const { d, s, e } of depsPresent) lines.splice(s, e - s + 1, ...d.restore);
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

// ---------- P1. independently pin the shared contract (slice3-regions.js is editable) ----------
t('SLICE3 contract is byte-frozen + matches the independently-pinned names/kinds/restore bytes', () => {
  verifySlice3Contract();
});

// ---------- P3. the coexistence exemption is bounded to the reviewed slice2-freeze revision ----------
t('coexistence pin: slice2-freeze.guard.test.js is the approved revision + still reports its exact check count', () => {
  assert.equal(sha256(readFileSync(join(__dir, SLICE2_GUARD))), SLICE2_GUARD_SHA,
    'slice2-freeze.guard.test.js changed from the approved coexistence revision — its content is NOT free under the exemption; re-gate at HIGH effort');
  const out = execFileSync('node', [join(__dir, SLICE2_GUARD)], { cwd: REPO }).toString('utf8');   // the guard runs as a plain script
  assert.match(out, new RegExp(`slice2-freeze\\.guard: ${SLICE2_GUARD_CHECKS} checks passed`),
    `slice2-freeze must still report exactly ${SLICE2_GUARD_CHECKS} checks — removing a check (e.g. the stacked-view.js purity check) drops the count`);
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

t('SLICE3DEPS markers: only registered carves, paired/ordered, each FULLY inside its declared SLICE2 parent', () => {
  const lines = readFileSync(join(__dir, 'index.html'), 'utf8').split('\n');
  slice3DepsRanges(lines);   // throws on unknown name / wrong parent / partial overlap / double-nest
});

t('restore spans are present in the 07e5ab38 baseline (pin integrity)', () => {
  const baseHtml = gitStr('show', `${BASELINE}:${ALLOWED_MODIFY}`);
  for (const r of SLICE3_REGIONS) {
    if (r.kind !== 'replace') continue;
    assert.ok(baseHtml.includes(r.restore.join('\n')), `pinned span for ${r.name} not found in 07e5ab38 — stale pin`);
  }
  for (const d of SLICE3_DEPS) {
    assert.equal(baseHtml.split(d.restore.join('\n')).length - 1, 1, `SLICE3DEPS ${d.name} baseline span must occur exactly once in 07e5ab38 (stale/ambiguous pin)`);
  }
});

t('index.html: strip SLICE3 regions + restore the replace spans recovers 07e5ab38 byte-for-byte', () => {
  const current = readFileSync(join(__dir, 'index.html'), 'utf8');
  const baseHtml = gitStr('show', `${BASELINE}:${ALLOWED_MODIFY}`);
  assert.equal(recoverSlice3(current), baseHtml,
    'strip+restore did NOT recover 07e5ab38 — a change leaked OUTSIDE the SLICE3 regions, or a pinned span is wrong');
});

// single-order-view.js is editable ONLY inside the OFERTA-OFFER region: the rest (svChip/svItems/svPay money
// display + the helpers) must still hash to the baseline. A probe edit to svPay proves the pin bites (advisor).
t('single-order-view.js: everything OUTSIDE the OFERTA-OFFER region is byte-pinned to the baseline', () => {
  assert.equal(sha256(sovRest()), SOV_REST_SHA,
    'single-order-view.js changed OUTSIDE the OFERTA-OFFER region (svChip/svItems/svPay or a helper?) — re-gate at HIGH effort');
});
t('NEG: an edit to single-order-view.js OUTSIDE the region (svPay) → RED', () => {
  const lines = readFileSync(join(__dir, 'single-order-view.js'), 'utf8').split('\n');
  const probe = lines.map((l) => l.includes('function svPay(order, esc, computeVuelto) {') ? l + ' /* probe */' : l);
  const marks = strictMarks(probe, 'SLICE3', ['OFERTA-OFFER']);
  const rest = [...probe.slice(0, marks[0].i), ...probe.slice(marks[1].i + 1)].join('\n');
  assert.notEqual(sha256(rest), SOV_REST_SHA, 'a probe edit to svPay (outside the region) must change the rest-hash → RED');
});

// The SLICE3DEPS carve must NOT give cover to edits ELSEWHERE in its SLICE2 parent. Probe: mutate a line that is
// inside SINGLE-ORDER-MOUNT but OUTSIDE the OFFER-RENDER carve (the spCardDeps line) → recovery must NOT recover 07e5ab38.
t('NEG: an edit inside the SLICE2 parent but OUTSIDE the OFFER-RENDER carve → recovery RED', () => {
  const current = readFileSync(join(__dir, 'index.html'), 'utf8');
  const baseHtml = gitStr('show', `${BASELINE}:${ALLOWED_MODIFY}`);
  const probeLine = '    const spCardDeps = { ICONS, esc: escapeHtml, scheduledBadge, computeVuelto, RESTAURANT: XPD.RESTAURANT, navPref: drv2ReadNavPref(), collapsedBanners };';
  assert.ok(current.includes(probeLine), 'the spCardDeps anchor line must exist inside SINGLE-ORDER-MOUNT (outside the carve)');
  const mutated = current.replace(probeLine, probeLine + '  /* probe */');
  assert.notEqual(recoverSlice3(mutated), baseHtml, 'an edit inside the parent but outside the carve must NOT recover the baseline (RED)');
});

// A registered carve is the ONLY permitted SLICE3DEPS marker. Each of these shapes must be RED via slice3DepsRanges.
t('NEG: SLICE3DEPS carve that is unregistered / wrong parent / partially overlapping / double-nested → RED', () => {
  const base = gitStr('show', `${BASELINE}:${ALLOWED_MODIFY}`).split('\n');
  const s2 = scanSlice2Ranges(base);
  const parentRange = s2.find(([, , n]) => n === 'SINGLE-ORDER-MOUNT');
  assert.ok(parentRange, 'baseline has the SINGLE-ORDER-MOUNT region to carve inside');
  const [ps, pe] = parentRange;
  const otherRange = s2.find(([, , n]) => n !== 'SINGLE-ORDER-MOUNT');
  // (i) unregistered carve name
  const unreg = base.slice();
  unreg.splice(ps + 1, 0, '/* SLICE3DEPS:NOT-REGISTERED:START */', 'x();', '/* SLICE3DEPS:NOT-REGISTERED:END */');
  assert.throws(() => slice3DepsRanges(unreg), /unknown SLICE3DEPS region: NOT-REGISTERED/, 'an unregistered carve must be RED');
  // (ii) right name, WRONG parent (inside a different SLICE2 region, or outside all)
  if (otherRange) {
    const wrong = base.slice();
    wrong.splice(otherRange[0] + 1, 0, '/* SLICE3DEPS:OFFER-RENDER:START */', 'x();', '/* SLICE3DEPS:OFFER-RENDER:END */');
    assert.throws(() => slice3DepsRanges(wrong), /not FULLY inside its declared parent/, 'OFFER-RENDER in the wrong SLICE2 parent must be RED');
  }
  // (iii) partial overlap: START inside the parent, END after the parent's END
  const partial = base.slice();
  partial.splice(pe + 2, 0, '/* SLICE3DEPS:OFFER-RENDER:END */');   // END below the parent
  partial.splice(pe - 1, 0, '/* SLICE3DEPS:OFFER-RENDER:START */');  // START inside the parent
  assert.throws(() => slice3DepsRanges(partial), /not FULLY inside its declared parent|never closed|without a matching/, 'a carve straddling the parent boundary must be RED');
  // (iv) double-nested (two STARTs for the same carve)
  const dbl = base.slice();
  dbl.splice(ps + 1, 0, '/* SLICE3DEPS:OFFER-RENDER:START */', '/* SLICE3DEPS:OFFER-RENDER:START */', 'x();', '/* SLICE3DEPS:OFFER-RENDER:END */');
  assert.throws(() => slice3DepsRanges(dbl), /START appears twice|START while/, 'a double-opened carve must be RED');
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

// ---- Codex r1 bypass reproductions: each must now be RED ----
t('NEG P1: widening a replace restore to swallow adjacent code → RED (restore-sha mismatch)', () => {
  const sub = SLICE3_REGIONS.find((r) => r.name === 'CUADRE-SUBMIT');
  // the bypass Codex found: fold an adjacent statement (here cleanupShift's opener) into the restore to move frozen code
  const widened = { ...sub, restore: [...sub.restore, 'async function cleanupShift() {'] };
  assert.throws(() => assertContract(SLICE3_REGIONS.map((r) => (r.name === 'CUADRE-SUBMIT' ? widened : r))),
    /restore bytes tampered/, 'a widened CUADRE-SUBMIT restore must be RED');
});
t('NEG P1: an added EXTRA region, or a set shrunk to only LOGIC-3 → RED (names mismatch)', () => {
  assert.throws(() => assertContract([...SLICE3_REGIONS, { name: 'EXTRA', kind: 'insert' }]), /names\/order tampered/, 'an added region must be RED');
  assert.throws(() => assertContract(SLICE3_REGIONS.filter((r) => r.name === 'LOGIC-3')), /names\/order tampered/, 'shrinking to only LOGIC-3 must be RED');
});
t('NEG P2: malformed / unapproved SLICE3 markers are REJECTED (not silently ignored); labels are not markers', () => {
  for (const bad of ['/* SLICE3:START */', '/* SLICE3::START */', '/* SLICE3:UNAPPROVED_EXTRA:START */']) {
    assert.throws(() => strictMarks([bad], 'SLICE3', SLICE3_PINS.names), /malformed SLICE3 marker|unknown SLICE3 region/, `must reject: ${bad}`);
  }
  // a nested malformed marker inside a valid region is caught too (the outer strip can't erase it — scan happens first)
  assert.throws(() => strictMarks(['/* SLICE3:LOGIC-3:START */', '/* SLICE3:UNAPPROVED_EXTRA:START */', '/* SLICE3:LOGIC-3:END */'], 'SLICE3', SLICE3_PINS.names),
    /malformed SLICE3 marker/, 'a malformed marker nested in a valid region must be RED');
  // a descriptive `SLICE3:LABEL` comment (no :START/:END) is NOT a marker → ignored, no false positive
  assert.deepEqual(strictMarks(['/* SLICE3:RESUMEN — end-of-run summary */'], 'SLICE3', SLICE3_PINS.names), []);
});

// Codex r2 P2: names with a DOT, SPACE, SLASH or UNICODE, nested inside a valid LOGIC-3 region, across JS-block,
// JS-line and HTML comment syntaxes and with CRLF — all must be RED via the full slice3Ranges path (not just strictMarks).
t('NEG P2 (r2): dotted/spaced/slashed/Unicode marker names are REJECTED across comment syntaxes + CRLF', () => {
  const badNames = ['BAD.NAME', 'BAD NAME', 'BAD/NAME', 'BÄDÑAME'];
  const wraps = [(s) => `/* ===== ${s} ===== */`, (s) => `// ${s}`, (s) => `<!-- ${s} -->`];
  for (const name of badNames) {
    for (const w of wraps) {
      const lines = [w('SLICE3:LOGIC-3:START'), w(`SLICE3:${name}:START`), '  injected payload', w(`SLICE3:${name}:END`), w('SLICE3:LOGIC-3:END')];
      assert.throws(() => slice3Ranges(lines), /malformed SLICE3 marker/, `must reject name "${name}" via ${w('X')}`);
      assert.throws(() => slice3Ranges(lines.map((l) => l + '\r')), /malformed SLICE3 marker/, `must reject name "${name}" (CRLF) via ${w('X')}`);
    }
  }
  // the narrow label exception survives: a bare `SLICE3:<word>` with no :START/:END is still not a marker
  assert.deepEqual(slice3Ranges(['// SLICE3:RESUMEN — see the batch-2 overlay']), {});
});

// Codex r3/r4: a non-undefined-returning check (promise, generator, async-generator, or any value) must FAIL
// immediately, not be silently counted as complete.
t('NEG: a deferred/value-returning check is rejected before it counts (must return undefined)', () => {
  assert.throws(() => t('promise', async () => {}), /return nothing/, 'an async (thenable) check must be rejected');
  assert.throws(() => t('generator', function* () {}), /return nothing/, 'a generator check must be rejected');
  assert.throws(() => t('async-generator', async function* () {}), /return nothing/, 'an async-generator check must be rejected');
  assert.throws(() => t('value', () => 42), /return nothing/, 'a value-returning check must be rejected');
});

console.log(`✓ slice3-freeze.guard: ${passed} checks passed (baseline ${baseSha.slice(0, 10)})`);
