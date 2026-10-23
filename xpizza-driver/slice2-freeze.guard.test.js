// slice2-freeze.guard.test.js — FREEZE-BY-CONSTRUCTION guard for the driver visual-refresh slice 2.
// Run: `node slice2-freeze.guard.test.js`  (ESM, no framework — repo idiom).
//
// Slice 2 contains statement REPLACEMENTS (not only insertions), so unlike slice 1's strip-back proof this
// guard verifies by RESTORATION: it strips each SLICE2:* region and, for the replacement regions, splices
// the EXACT pinned baseline statement back in; the result — plus every other .js — must then equal the
// immutable baseline SHA byte-for-byte. Because the restored tree equals the SHA slice 1's own guard passed,
// slice 1's protections are preserved transitively (slice 1's guard additionally runs UNCHANGED at that SHA
// in a DETACHED worktree — see slice2-slice1guard.detached.test.js).
//
//   1. FROZEN FILES — every path tracked at baseline under xpizza-driver/ is byte-identical on disk now,
//      EXCEPT index.html. (All logic .js — driver-complete / xpizza-delivery / stacking-helpers /
//      single-order-view / cash|brand|order helpers — every baseline test, every baseline asset.)
//   2. index.html REGION-ONLY — strip the SLICE2 regions + restore the pinned baseline spans for the
//      REPLACEMENT regions → recover baseline index.html BYTE-FOR-BYTE. Proves no edit anywhere outside the
//      regions, AND (for replacements) that each region sits exactly where its baseline statement was.
//   3. MARKERS WELL-FORMED — exactly the known SLICE2 region names, each one START + one END, ordered,
//      non-nested, non-duplicated; no unknown SLICE2:*:(START|END) marker anywhere.
//   4. FILE-LEVEL ALLOWLIST — index.html is the sole MODIFY; the only ADDs are the slice-2 allowlist (the
//      two new pure modules, their tests, the contrast gate, this guard + the detached-worktree guard, the
//      proof harness, the jsdom branch harness); nothing deleted/renamed/copied.
//   5. NEW MODULES ARE PURE — overview-map.js imports nothing; stacked-view.js imports ONLY the allowlisted
//      pure helpers (named, no side-effect/dynamic/require); neither carries a DOM/Firebase/global/IO/
//      nondeterminism token in its code.
//   6. INSERT-REGION LOCATION — the pure-insertion regions (which strip-back cannot pin) are anchored to
//      their exact baseline neighbours, so a relocated CSS/import/lifecycle region is rejected.
//
// Mutating ANY byte outside a region — a frozen .js, or index.html outside the regions — turns this RED.
// See slice2-freeze.proof.sh for the mutation-outside-regions → RED proof.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const PFX = 'xpizza-driver/';

// The slice-2 freeze point: feat/driver-refresh-slice2 is a pure delta over this commit (the PROXY base =
// slice-1's approved tip ff045243 + the 2e applicability re-pin). Re-verified + re-pinned at slice 1's
// LANDED main SHA after slice 1 ships (stated in the hand-back).
const BASELINE = 'e2266b24';

// SLICE2 regions in the order they appear in index.html. `insert` regions strip to nothing; `replace`
// regions strip and then restore their pinned baseline statement (verified present in the baseline below).
const REGIONS = [
  { name: 'PRESENTATION', kind: 'insert' },
  { name: 'IMPORT', kind: 'insert' },
  { name: 'QUEUE-IDENTITY', kind: 'replace', restore: [
    "  const i = Number(card.getAttribute('data-q'));",
    '  const o = queuedOrders[i];',
    '  if (!o) return;',
  ] },
  { name: 'QUEUE-SHEET', kind: 'replace', restore: [
    "  $('queue-sheet-body').innerHTML = renderQueueDetail(o, i + 2);",
  ] },
  { name: 'SHIFT-CLEANUP', kind: 'insert' },
  { name: 'MAP-LIFECYCLE', kind: 'insert' },
  { name: 'SINGLE-ORDER-MOUNT', kind: 'replace', restore: [
    '    activeSlot.innerHTML = singleOrderCardHtml(soloOrder, {',
    '      ICONS, esc: escapeHtml, scheduledBadge, computeVuelto,',
    '      RESTAURANT: XPD.RESTAURANT, arrived: spArrived, atRestaurant: spAtRestaurant, navPref: undefined,',
    '      nowMs: Date.now(),   // offer ring: elapsed drives the resume (negative animation-delay); display-only',
    '    });',
  ] },
  { name: 'STACKED-BRANCH', kind: 'replace', restore: [
    '  bannerSlot.innerHTML = renderIncomingBanners(pendingAccept);',
    '  activeSlot.innerHTML = renderActiveCard(active, solo);',
    '  queuedOrders = queue;',
    '  queueSlot.innerHTML = renderQueue(queue);',
  ] },
];
const KNOWN_REGIONS = REGIONS.map((r) => r.name);

// Everything slice 2 is allowed to ADD under xpizza-driver/. index.html is the sole allowed MODIFY.
const ALLOWED_ADDS = new Set([
  'xpizza-driver/overview-map.js',
  'xpizza-driver/overview-map.test.js',
  'xpizza-driver/stacked-view.js',
  'xpizza-driver/stacked-view.test.js',
  'xpizza-driver/slice2-contrast.test.js',
  'xpizza-driver/slice2-branch.test.js',           // jsdom real-writer branch harness
  'xpizza-driver/slice2-freeze.guard.test.js',     // this guard
  'xpizza-driver/slice2-slice1guard.detached.test.js', // runs slice 1's guard UNCHANGED at the landed SHA (detached worktree)
  'xpizza-driver/slice2-freeze.proof.sh',          // the mutation-outside-regions → RED proof harness
]);
const REQUIRED_ADDS = ['xpizza-driver/overview-map.js', 'xpizza-driver/stacked-view.js'];
const ALLOWED_MODIFY = 'xpizza-driver/index.html';
// Exactly ONE baseline file may be DELETED by slice 2: the slice-1 branch harness single-order-branch.test.js.
// Its stub-based proof (the 2-order stacked render is byte-identical to baseline + renderActiveCard is called)
// is superseded — slice 2 intentionally reroutes the stacked path through the builders (renderActiveCard is now
// dead; see the census unreachableOnSurface entries), and the stacked render is now proven by THIS guard's
// restoration check + slice2-branch.test.js's real-writer cells (its unique single-order-gate / arrived-threshold
// / review-latch / drag-defer cells were migrated there verbatim). Advisor ruling 2026-10-21; Codex plan amendment.
const ALLOWED_DELETE = new Set(['xpizza-driver/single-order-branch.test.js']);

// OUT-OF-REGION ALLOW (owner/advisor ruling 2026-10-23): a short, explicit list of exact single-line edits
// permitted OUTSIDE the SLICE2 regions, each documented. The native 2.5.3 build bumps the app's SYSTEM_VERSION
// constant (2.5.2 → 2.5.3); that line is not inside any SLICE2 region. The restoration check applies this list
// to the baseline before the byte-compare, so ONLY these exact lines may differ — any OTHER out-of-region drift
// still goes RED (proven by the sensitivity cell below: the allow is line-count-preserving and changes exactly
// these lines, nothing else).
const OUT_OF_REGION_ALLOW = [
  { from: "const SYSTEM_VERSION = '2.5.2';", to: "const SYSTEM_VERSION = '2.5.3';" },
];

// Import allowlists for the two new modules.
const IMPORT_ALLOWLIST = {
  'overview-map.js': {},   // imports NOTHING
  'stacked-view.js': {
    './single-order-view.js': new Set(['navTarget', 'wazeHref', 'mapsHref', 'brandLabel']),
    './brand-helpers.js': new Set(['brandMeta', 'driverGreeting']),
    './order-helpers.js': new Set(['displayOrderLabel']),
    './cash-helpers.js': new Set(['collectionFor', 'paymentRowHtml', 'queuePayHtml']),
  },
};

const IMPURITY = [
  /\bdocument\b/, /\bwindow\b/, /\bglobalThis\b/, /\bself\b/, /\bfirebase\b/,
  /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/,
  /\bgetElementById\b/, /\bquerySelector\b/, /\baddEventListener\b/, /\.innerHTML\b/, /\bappendChild\b/,
  /\bXPD\b/, /\bDate\s*\.\s*now\b/, /\bMath\s*\.\s*random\b/, /\bnew\s+Date\b/,
  /\bsetTimeout\b/, /\bsetInterval\b/, /\bimport\s*\(/, /\brequire\s*\(/,
];

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dir }).toString('utf8').trim();
const git = (...a) => execFileSync('git', a, { cwd: REPO, maxBuffer: 128 * 1024 * 1024 });
const gitBuf = (...a) => git(...a);
const gitStr = (...a) => git(...a).toString('utf8');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; };

// ---------- 0. baseline reachable ----------
let baseSha;
t('baseline commit is reachable', () => {
  baseSha = gitStr('rev-parse', '--verify', `${BASELINE}^{commit}`).trim();
  assert.match(baseSha, /^[0-9a-f]{40}$/, `baseline ${BASELINE} did not resolve to a commit`);
});

// ---------- 1. every baseline file except index.html byte-identical ----------
t('frozen: every baseline file under xpizza-driver/ (except index.html) is byte-identical', () => {
  const baseFiles = gitStr('ls-tree', '-r', '--name-only', BASELINE, '--', 'xpizza-driver')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  assert.ok(baseFiles.length > 10, 'baseline file list looks empty — wrong ref?');
  const drift = [];
  for (const repoPath of baseFiles) {
    if (repoPath === ALLOWED_MODIFY) continue;
    if (ALLOWED_DELETE.has(repoPath)) continue;   // the retired slice-1 harness (see ALLOWED_DELETE); its deletion is checked in the file-level test
    const rel = repoPath.slice(PFX.length);
    const baseBytes = gitBuf('show', `${BASELINE}:${repoPath}`);
    let diskBytes;
    try { diskBytes = readFileSync(join(__dir, rel)); }
    catch { drift.push(`${repoPath} (missing on disk — deleted?)`); continue; }
    if (Buffer.compare(baseBytes, diskBytes) !== 0) drift.push(`${repoPath} (byte-changed)`);
  }
  assert.deepEqual(drift, [], `frozen files changed:\n  ${drift.join('\n  ')}`);
});

// ---------- 2 & 3. markers well-formed + restoration recovers baseline ----------
function scanMarkers(lines) {
  const marks = [];
  const re = /SLICE2:([A-Za-z0-9-]+):(START|END)\b/g;
  lines.forEach((line, i) => {
    let m, n = 0;
    while ((m = re.exec(line)) !== null) { marks.push({ i, name: m[1], kind: m[2] }); n += 1; }
    assert.ok(n <= 1, `line ${i + 1}: more than one SLICE2 marker on a line`);
  });
  return marks;
}

t('markers: exactly the known regions, each one START + one END, ordered, non-nested, non-duplicated', () => {
  const lines = readFileSync(join(__dir, 'index.html'), 'utf8').split('\n');
  const marks = scanMarkers(lines);
  let open = null;
  const started = new Set(), ended = new Set();
  for (const { name, kind } of marks) {
    assert.ok(KNOWN_REGIONS.includes(name), `unknown SLICE2 region: ${name}`);
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

t('restore spans are present in the baseline (pin integrity)', () => {
  const baseHtml = gitStr('show', `${BASELINE}:${ALLOWED_MODIFY}`);
  for (const r of REGIONS) {
    if (r.kind !== 'replace') continue;
    assert.ok(baseHtml.includes(r.restore.join('\n')),
      `pinned baseline span for ${r.name} not found in baseline index.html — the pin is stale`);
  }
});

t('index.html: strip SLICE2 regions + restore the replacement spans recovers baseline byte-for-byte', () => {
  const current = readFileSync(join(__dir, 'index.html'), 'utf8');
  const baseHtml = gitStr('show', `${BASELINE}:${ALLOWED_MODIFY}`);
  const lines = current.split('\n');
  const ranges = regionRanges(lines);
  // Splice each region out (descending by start so indices stay valid); replacements splice their span in.
  const ordered = REGIONS.map((r) => ({ r, s: ranges[r.name][0], e: ranges[r.name][1] }))
    .sort((a, b) => b.s - a.s);
  for (const { r, s, e } of ordered) {
    lines.splice(s, e - s + 1, ...(r.kind === 'replace' ? r.restore : []));
  }
  // Apply the documented out-of-region allow to the BASELINE before comparing (native 2.5.3 SYSTEM_VERSION bump).
  let expected = baseHtml;
  for (const a of OUT_OF_REGION_ALLOW) {
    assert.equal(baseHtml.split(a.from).length - 1, 1, `freeze allow: baseline must contain "${a.from}" exactly once`);
    expected = expected.replace(a.from, a.to);
  }
  assert.equal(lines.join('\n'), expected,
    'strip+restore did NOT recover baseline (modulo the documented OUT_OF_REGION_ALLOW) — a change leaked OUTSIDE the SLICE2 regions, or a pinned span is wrong');
});

// ---------- 3b. the out-of-region allow is EXACTLY its documented line(s) — nothing else is exempt ----------
t('out-of-region allow changes exactly its documented line(s); any other out-of-region change still RED', () => {
  const baseHtml = gitStr('show', `${BASELINE}:${ALLOWED_MODIFY}`);
  const baseLines = baseHtml.split('\n');
  let allowed = baseHtml;
  for (const a of OUT_OF_REGION_ALLOW) {
    assert.notEqual(a.from, a.to, 'an allow entry must actually change something');
    assert.equal(baseHtml.split(a.from).length - 1, 1, `allow "from" must occur exactly once in baseline: ${a.from}`);
    allowed = allowed.replace(a.from, a.to);
  }
  const allowLines = allowed.split('\n');
  assert.equal(allowLines.length, baseLines.length, 'the allow must be line-count-preserving (no inserts/deletes outside regions)');
  const changed = baseLines.map((l, i) => (l === allowLines[i] ? null : i)).filter((x) => x !== null);
  assert.equal(changed.length, OUT_OF_REGION_ALLOW.length,
    `the allow must change exactly ${OUT_OF_REGION_ALLOW.length} line(s); it changed ${changed.length}`);
  // Sensitivity: a DIFFERENT out-of-region line is NOT absorbed — tampering it would still fail the restore compare.
  const probe = 'el.textContent = `v${SYSTEM_VERSION} · driver`;';
  assert.equal(baseHtml.split(probe).length - 1, 1, 'sensitivity probe line present exactly once');
  assert.notEqual(allowed.replace(probe, 'el.textContent = `vX`;'), allowed,
    'a non-allowed out-of-region edit is not covered by the allow (would be RED)');
});

// ---------- 4. file-level allowlist ----------
t('file-level: only index.html modified; only the slice-2 allowlist added; nothing deleted/renamed', () => {
  const ns = gitStr('diff', '--name-status', BASELINE, '--', 'xpizza-driver')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const modified = [], added = [], deleted = [], otherOps = [];
  for (const row of ns) {
    const [status, ...paths] = row.split('\t');
    const code = status[0];
    if (code === 'M') modified.push(paths[0]);
    else if (code === 'A') added.push(paths[0]);
    else if (code === 'D' && ALLOWED_DELETE.has(paths[0])) deleted.push(paths[0]);  // exactly the retired slice-1 harness
    else otherOps.push(row);
  }
  const untracked = gitStr('ls-files', '--others', '--exclude-standard', '--', 'xpizza-driver')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  for (const p of untracked) added.push(p);

  assert.deepEqual(otherOps, [], `forbidden op(s) (unlisted delete/rename/copy/type):\n  ${otherOps.join('\n  ')}`);
  assert.deepEqual(modified, [ALLOWED_MODIFY], `modified set must be exactly [${ALLOWED_MODIFY}], got: ${modified.join(', ')}`);
  assert.deepEqual(deleted.sort(), [...ALLOWED_DELETE].sort(), `deleted set must be exactly the allowed-DELETE list, got: ${deleted.join(', ')}`);
  const strayAdds = added.filter((p) => !ALLOWED_ADDS.has(p));
  assert.deepEqual(strayAdds, [], `added path(s) outside the slice-2 allowlist:\n  ${strayAdds.join('\n  ')}`);
  for (const req of REQUIRED_ADDS) assert.ok(added.includes(req), `the new module ${req} must be present`);
});

// ---------- 5. new modules are pure ----------
function assertPure(file) {
  const src = readFileSync(join(__dir, file), 'utf8');
  assert.ok(!/^\s*import\s+[A-Za-z_$]/m.test(src), `${file}: default/namespace import is not allowed`);
  assert.ok(!/^\s*import\s+['"]/m.test(src), `${file}: side-effect import is not allowed`);
  assert.ok(!/\bimport\s*\(/.test(src), `${file}: dynamic import() is not allowed`);
  assert.ok(!/\brequire\s*\(/.test(src), `${file}: require() is not allowed`);
  const allow = IMPORT_ALLOWLIST[file];
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const mod = m[2];
    assert.ok(allow[mod], `${file}: import from a non-allowlisted module: ${mod}`);
    for (const n of names) assert.ok(allow[mod].has(n), `${file}: import "${n}" from ${mod} not allowlisted`);
  }
  const codeLines = src.split('\n').filter((line) => {
    const s = line.trim();
    return !(s.startsWith('//') || s.startsWith('/*') || s.startsWith('*') || s === '*/' || s.startsWith('*/'));
  });
  const hits = IMPURITY.filter((rx) => rx.test(codeLines.join('\n'))).map((rx) => rx.source);
  assert.deepEqual(hits, [], `impurity token(s) in ${file} code:\n  ${hits.join('\n  ')}`);
}
t('overview-map.js is pure (no imports, no impurity tokens)', () => assertPure('overview-map.js'));
t('stacked-view.js is pure (allowlisted named imports only, no impurity tokens)', () => assertPure('stacked-view.js'));

// ---------- 6. insert-region LOCATION pins (strip-back cannot catch a relocated insertion) ----------
const INSERT_ANCHORS = {
  'PRESENTATION': { before: '/* SLICE1:PRESENTATION:END */', after: '</style>' },
  'SHIFT-CLEANUP': { before: 'async function cleanupShift() {', after: '  if (watchId) {' },
  'MAP-LIFECYCLE': { before: "document.addEventListener('visibilitychange', async () => {", after: "  if (document.visibilityState === 'visible' && driverState?.active) {" },
};
t('insert regions are pinned at their exact baseline neighbours (PRESENTATION, MAP-LIFECYCLE)', () => {
  const lines = readFileSync(join(__dir, 'index.html'), 'utf8').split('\n');
  const ranges = regionRanges(lines);
  for (const [name, exp] of Object.entries(INSERT_ANCHORS)) {
    const [s, e] = ranges[name];
    assert.equal(lines[s - 1], exp.before, `region ${name}: line BEFORE its START is not the pinned baseline anchor (relocated?)`);
    assert.equal(lines[e + 1], exp.after, `region ${name}: line AFTER its END is not the pinned baseline anchor (relocated?)`);
  }
  // IMPORT must sit in the module script, after SLICE1:IMPORT:END and before the stacked branch.
  const l = lines;
  const s1End = l.findIndex((x) => /SLICE1:IMPORT:END/.test(x));
  const [impS] = ranges['IMPORT'];
  const [brS] = ranges['STACKED-BRANCH'];
  assert.ok(s1End >= 0 && impS > s1End && impS < brS, 'IMPORT region must sit after SLICE1:IMPORT and before STACKED-BRANCH');
});

console.log(`✓ slice2-freeze.guard: ${passed} checks passed (baseline ${baseSha.slice(0, 10)})`);
