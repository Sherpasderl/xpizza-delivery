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
import { createHash } from 'node:crypto';
// SLICE3 coexistence (see check-2): slice 3 supersedes slice 2. The contract is loaded as NON-EXECUTABLE DATA
// (slice3-regions.json), sha-verified BEFORE parse — never imported/required — so a `process.exit(0)` appended to
// an editable module can't short-circuit this guard (Codex r2 P1). loadContract() below.

const __dir = dirname(fileURLToPath(import.meta.url));
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// SLICE3 contract pins (Codex r1 P1): slice3-regions.js is editable, so this guard pins the contract INDEPENDENTLY
// — a tampered shared module (widened/dropped restore, added/removed region, changed kind) is caught HERE too, not
// just in slice3-freeze. Mirror of slice3-freeze's SLICE3_PINS; both must agree with the byte-frozen contract file.
const SLICE3_PINS = {
  names: ['PRESENTATION-3', 'IMPORT-3', 'LOGIC-3', 'IDLE-3', 'OFFLINE-INIT-3', 'OFFLINE-TEARDOWN-3', 'GPSOFF-RESUME-3', 'GPSOFF-DENIED-3', 'OFFLINE-START-GEN-3', 'RENDER-OFFLINE-3', 'RENDER-BOARD-3', 'HELP-HANDLER', 'CUADRE-CSS', 'CUADRE-DOM', 'CUADRE-RENDER', 'CUADRE-SUBMIT', 'CHIME-FRESH', 'OFFER-TAKEOVER', 'PRESENTATION-INICIO', 'INICIO-LOGIN', 'INICIO-ESPERANDO', 'INICIO-CHECKLIST-FLAG', 'INICIO-POSTACT-ROUTE', 'INICIO-PERFIL', 'INICIO-CHECKLIST', 'INICIO-PRACTICA', 'INICIO-DEMO', 'INICIO-DEMO-TEARDOWN'],
  kinds: ['insert', 'insert', 'insert', 'insert', 'insert', 'insert', 'insert', 'insert', 'insert', 'insert', 'insert', 'replace', 'replace', 'replace', 'replace', 'replace', 'replace', 'replace', 'insert', 'replace', 'replace', 'insert', 'replace', 'replace', 'replace', 'replace', 'insert', 'insert'],
  restoreSha: {
    'HELP-HANDLER': 'e823efd01be83461f6b7b900e8e60a9065d9c44bfedb1b32c2624f1d6c00206f',
    'CUADRE-CSS': '41327b6fa5e535b774d323c235e755019b6020516a10ac20340b004667f8a4ec',
    'CUADRE-DOM': 'ec70f01fe5711aacff4fc4e88ff0fd873bf715abf8ba178d30092c7ec34c2dab',
    'CUADRE-RENDER': 'a285b81838c946e23f46a401786b07a62976ca93f25c3d8152640404021eeaaa',
    'CUADRE-SUBMIT': '06a225a4158eae7c797d0775fec2def67fb01283467b3c6352cff7dc55e8466b',
    'CHIME-FRESH': 'e86e31b5350d14f892d99d38e7bf84fcf2358c262d03d9354bf663864e0de4c9',
    'OFFER-TAKEOVER': '88bdef966a96defc21a3b6bc407f595201c0808456016662832f6ae14c60a855',
    'INICIO-LOGIN': 'c88bdf37eb700d815067bda2ed13a24478b983b0ead7321713095d18c402fc32',
    'INICIO-ESPERANDO': '582717c999424ab08ce8bb1bdeb34fb2378b3563f6c66ca5957c91b695bfa06f',
    'INICIO-POSTACT-ROUTE': '6b94288ed1e68f936c327b57c45ec3d738fc79d791b23bd6707ccfb90ab6d26e',
    'INICIO-PERFIL': 'e3cc6d98b928d95cb49c8b9016ca142730759778e6d6862eb75d68665ff8ca80',
    'INICIO-CHECKLIST': 'f270a45d4f0bc010c18de365e97fd1427138962b2b8d2abbdc07270db8cc4d74',
    'INICIO-PRACTICA': 'dc6e3b5213046e049f1ba47cd428392caca2cfcb84c7ffea4744c83f312e1e13',
  },
  fileSha: '0614efd72727f89ce2bac5f29c3562a58a334e4ce1cc85792c9bd1413cd1b63d',
};
// Load the contract as DATA: read bytes → verify the sha256 pin FIRST → only then JSON.parse (Codex r2 P1). No
// require/import of editable code; a tampered or executable contract fails the sha (and JSON.parse) before use.
function loadContract() {
  const bytes = readFileSync(join(__dir, 'slice3-regions.json'));
  assert.equal(sha256(bytes), SLICE3_PINS.fileSha, 'slice3-regions.json byte-changed — the SLICE3 contract is frozen; re-gate at HIGH effort');
  const data = JSON.parse(bytes);
  assert.ok(data && Array.isArray(data.regions), 'slice3-regions.json has no regions array');
  return data.regions;
}
const SLICE3_REGIONS = loadContract();
function verifySlice3Contract() {
  assert.equal(sha256(readFileSync(join(__dir, 'slice3-regions.json'))), SLICE3_PINS.fileSha,
    'slice3-regions.json byte-changed — the SLICE3 contract is frozen; re-gate any change at HIGH effort');
  assert.deepEqual(SLICE3_REGIONS.map((r) => r.name), SLICE3_PINS.names, 'SLICE3 region names/order tampered');
  assert.deepEqual(SLICE3_REGIONS.map((r) => r.kind), SLICE3_PINS.kinds, 'SLICE3 region kinds tampered');
  for (const r of SLICE3_REGIONS) if (r.kind === 'replace') {
    assert.equal(sha256(r.restore.join('\n')), SLICE3_PINS.restoreSha[r.name],
      `SLICE3 ${r.name} restore bytes tampered (widened to swallow adjacent code, or shrunk?)`);
  }
}
// Strict marker scan (Codex r2 P2): candidate detection is MAXIMALLY BROAD — ANY `${prefix}:` followed by anything
// up to a `:START` or `:END` on the same line is a candidate (so names with a dot, space, slash or Unicode can't
// slip past). EVERY candidate must then validate EXACTLY as `${prefix}:<name>:<START|END>`, name in [A-Za-z0-9-]+
// and (if given) whitelisted — else RED, before any stripping. The ONLY non-marker is a bare `${prefix}:<word>`
// label with NO :START/:END suffix (e.g. the batch-2 `SLICE3:RESUMEN` section labels). CRLF-safe.
function strictMarks(lines, prefix, whitelist) {
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
  { name: 'ACTIVE-POINTER', kind: 'replace', restore: [
    '  const [active, ...rest] = orders;',
  ] },
  { name: 'PICKUP-REVALIDATE', kind: 'replace', restore: [
    '      await XPD.pickupComplete(currentUser.uid, o.pickupTask.id);',
  ] },
  { name: 'DELIVERED-REVALIDATE', kind: 'replace', restore: [
    '      // Capture the acting uid BEFORE completion starts: the error-path role mapping must attribute the role to',
    '      // the account that actually ran the completion, not whatever account is current if the session changed',
    '      // mid-write (codex core r3 P2).',
    '      const actingUid = currentUser.uid;',
  ] },
  { name: 'STACKED-BRANCH', kind: 'replace', restore: [
    '  bannerSlot.innerHTML = renderIncomingBanners(pendingAccept);',
    '  activeSlot.innerHTML = renderActiveCard(active, solo);',
    '  queuedOrders = queue;',
    '  queueSlot.innerHTML = renderQueue(queue);',
  ] },
  // ── The prototype-rebuild regions (owner H2: the approved prototype overrides the old freeze). All PURE
  //    INSERTS (verified absent from baseline): the dep-D observer, the idle reset, the stacked delegate, and the
  //    whole R7 nav-preference surface (Cuenta/navApp CSS + screens + off-shift entry + onboarding row). Stripping
  //    each recovers baseline byte-for-byte. SIGNOUT is the one REPLACE (it extracted the inline #signout listener).
  { name: 'RUN-OBSERVER', kind: 'insert' },
  { name: 'IDLE-RESET', kind: 'insert' },
  { name: 'STACKED-HANDLERS', kind: 'insert' },
  { name: 'NAVPREF-CSS', kind: 'insert' },
  { name: 'NAVPREF', kind: 'insert' },
  { name: 'NAV-SCREENS', kind: 'insert' },
  { name: 'OFFSHIFT-CUENTA', kind: 'insert' },
  { name: 'ONBOARDING-NAV', kind: 'insert' },
  { name: 'OFFER-RING', kind: 'insert' },
  { name: 'FONTFACE', kind: 'insert' },
  { name: 'SIGNOUT', kind: 'replace', restore: [
    "$('signout-btn').addEventListener('click', async () => {",
    '  // Native: drop the FCM token before signing out so this device stops',
    "  // receiving this driver's orders (shared-phone safety).",
    '  if (isNative() && currentUser) {',
    '    try { await unregisterNativePush(XPD.getAuthInstance().app); } catch (e) { /* non-fatal */ }',
    '  }',
    '  await XPD.signOutUser();',
    '});',
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
  'xpizza-driver/nav-view.js',                     // R7 Cuenta/navApp pure builders
  'xpizza-driver/nav-view.test.js',                // R7 Cuenta/navApp builder tests
  // SLICE3 coexistence: slice 3 supersedes slice 2 (same precedent as slice 2 over slice 1). These are ADDs vs
  // the slice-2 baseline; their content is governed by slice3-freeze.guard, not here.
  'xpizza-driver/slice3-regions.json',             // the shared SLICE3 region contract (non-executable data)
  'xpizza-driver/slice3-freeze.guard.test.js',     // the slice-3 freeze guard
  'xpizza-driver/slice3-contrast.test.js',         // batch-3 fg/bg WCAG checks (added with the first batch-3 CSS)
  'xpizza-driver/cuadre-submit.test.js',           // cuadre slide-to-confirm money-submit handler test (SLICE3)
  'xpizza-driver/chime-fresh.test.js',             // new-assignment chime handler test (SLICE3)
  'xpizza-driver/offer-takeover.test.js',          // cross-hub S.oferta takeover handler test (SLICE3)
  'xpizza-driver/oferta-offer.test.js',            // S.oferta offer-branch rebuild output test (SLICE3)
  'xpizza-driver/idle-help-gate.test.js',          // SLICE3:IDLE-3 help-link gate test (SLICE3)
  'xpizza-driver/offline-banner.test.js',          // SLICE3 offline banner handler test (SLICE3)
  'xpizza-driver/gpsoff.test.js',                  // SLICE3 gpsoff builder + apply logic test (SLICE3)
  'xpizza-driver/fa4400-neverships.test.js',       // SLICE3 brand-orange never-ship test, static (SLICE3)
  'xpizza-driver/fa4400-render.browser.test.js',   // SLICE3 brand-orange never-ship test, browser/computed-style (SLICE3)
  'xpizza-driver/fa4400-neverships.proof.sh',      // SLICE3 brand-orange never-ship mutant proof (SLICE3)
  'xpizza-driver/postact-route.js',                // Inicio b: pure post-activation checklist routing decision (SLICE3)
  'xpizza-driver/postact-route.test.js',           // Inicio b: post-activation routing paths test (SLICE3)
  'xpizza-driver/practica-fixture.js',             // Inicio c: synthetic practice ORDER data module (SLICE3)
  'xpizza-driver/practica-demo.test.js',           // Inicio c: practica demo zero-write + isolation spy test (SLICE3)
]);
const REQUIRED_ADDS = ['xpizza-driver/overview-map.js', 'xpizza-driver/stacked-view.js'];
const ALLOWED_MODIFY = 'xpizza-driver/index.html';
// Baseline TEST files slice 2 may MODIFY (advisor ruling 2026-10-24): the SLICE2:ONBOARDING-NAV region injects the
// R7 «App de navegación» row into the companion onboarding via `$('co-practice-row').insertAdjacentHTML('afterend',…)`.
// onboarding-host.test.js's fake-DOM mock had no insertAdjacentHTML, so it must be extended to support the injection
// AND now covers it (asserts co-nav-row is injected + wired). This is a test-only change; no production/baseline
// behaviour moves. The region-restoration byte check still proves index.html's companion code is baseline-identical.
const SLICE2_TEST_MODIFY = new Set(['xpizza-driver/onboarding-host.test.js']);
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
  // R7: add the two nav-pref screen names to showScreen's switch list (single-line, line-count-preserving).
  { from: "  ['config', 'login', 'offshift', 'onshift', 'companion'].forEach(s => {",
    to:   "  ['config', 'login', 'offshift', 'onshift', 'companion', 'cuenta', 'navApp'].forEach(s => {" },
];

// Import allowlists for the two new modules.
const IMPORT_ALLOWLIST = {
  'overview-map.js': {},   // imports NOTHING
  'stacked-view.js': {
    './single-order-view.js': new Set(['navTarget', 'wazeHref', 'mapsHref', 'brandLabel', 'waPhone', 'itemLines']),
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
const EXPECTED_CHECKS = 16;
process.on('exit', () => {
  if (passed !== EXPECTED_CHECKS) {
    console.error(`slice2-freeze.guard INCOMPLETE: ${passed}/${EXPECTED_CHECKS} checks ran — early exit / skipped check`);
    process.exitCode = 1;
  }
});

// ---------- 0. baseline reachable ----------
let baseSha;
t('baseline commit is reachable', () => {
  baseSha = gitStr('rev-parse', '--verify', `${BASELINE}^{commit}`).trim();
  assert.match(baseSha, /^[0-9a-f]{40}$/, `baseline ${BASELINE} did not resolve to a commit`);
});

// Independently pin the SLICE3 contract used by the coexistence splice (Codex r1 P1) — see verifySlice3Contract.
t('SLICE3 contract is byte-frozen + matches the independently-pinned names/kinds/restore bytes', () => {
  verifySlice3Contract();
});

// ---------- 1. every baseline file except index.html byte-identical ----------
// Strip every SLICE2:*:START..END region (inclusive) from a source — used to prove a REGION-BEARING frozen file
// recovers baseline once its (pure-insert) region(s) are removed. Only xpizza-delivery.js carries one (NAV-SDK).
function stripSlice2Regions(text) {
  const out = []; let skip = false;
  for (const line of text.split('\n')) {
    if (/SLICE2:[A-Za-z0-9-]+:START/.test(line)) { skip = true; continue; }
    if (/SLICE2:[A-Za-z0-9-]+:END/.test(line)) { skip = false; continue; }
    if (!skip) out.push(line);
  }
  return out.join('\n');
}
// Baseline .js files that are allowed to carry a SLICE2 region (a PURE INSERT that strips back to baseline). The
// region is still region-contained; this only exempts the file from the raw byte-identity check (it is verified
// byte-identical AFTER stripping). index.html is handled by the region-restoration test, not here.
const ALLOWED_REGION_BEARING = new Set(['xpizza-driver/xpizza-delivery.js']);
// single-order-view.js is editable ONLY inside the SLICE3:OFERTA-OFFER region (the offer branch rebuilt to S.oferta).
// Everything else — svChip/svItems/svPay (money display) + the nav/cash helpers — is pinned: strip the region and the
// rest must hash to the baseline with the old offer branch removed (byte-identical in both baselines).
const SOV_REST_SHA = 'bb7dedaf72355416049accae5d65e854e7089c53b844afb9b1052ca09aafbfa6';
function sovRestHash(text) {
  const lines = text.split('\n');
  const marks = strictMarks(lines, 'SLICE3', ['OFERTA-OFFER']);
  if (marks.length !== 2 || marks[0].kind !== 'START' || marks[1].kind !== 'END') return null;
  return sha256([...lines.slice(0, marks[0].i), ...lines.slice(marks[1].i + 1)].join('\n'));
}

t('frozen: every baseline file under xpizza-driver/ (except index.html) is byte-identical (region-bearing files strip to baseline)', () => {
  const baseFiles = gitStr('ls-tree', '-r', '--name-only', BASELINE, '--', 'xpizza-driver')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  assert.ok(baseFiles.length > 10, 'baseline file list looks empty — wrong ref?');
  const drift = [];
  for (const repoPath of baseFiles) {
    if (repoPath === ALLOWED_MODIFY) continue;
    if (SLICE2_TEST_MODIFY.has(repoPath)) continue;   // the companion test, extended for the ONBOARDING-NAV injection (test-only; see SLICE2_TEST_MODIFY)
    if (ALLOWED_DELETE.has(repoPath)) continue;   // the retired slice-1 harness (see ALLOWED_DELETE); its deletion is checked in the file-level test
    const rel = repoPath.slice(PFX.length);
    const baseBytes = gitBuf('show', `${BASELINE}:${repoPath}`);
    let diskBytes;
    try { diskBytes = readFileSync(join(__dir, rel)); }
    catch { drift.push(`${repoPath} (missing on disk — deleted?)`); continue; }
    if (Buffer.compare(baseBytes, diskBytes) === 0) continue;
    // A region-bearing file is OK iff stripping its SLICE2 region(s) recovers baseline byte-for-byte.
    if (ALLOWED_REGION_BEARING.has(repoPath)
        && Buffer.from(stripSlice2Regions(diskBytes.toString('utf8'))).equals(baseBytes)) continue;
    // single-order-view.js: editable ONLY in the SLICE3:OFERTA-OFFER region — the rest must hash to the baseline.
    if (repoPath === 'xpizza-driver/single-order-view.js' && sovRestHash(diskBytes.toString('utf8')) === SOV_REST_SHA) continue;
    // single-order-card.test.js: a SLICE3-editable TEST (its offer cases updated for the S.oferta rebuild); its
    // content is governed by slice3-freeze.guard, not here (same posture as the SLICE2_TEST_MODIFY companion test).
    if (repoPath === 'xpizza-driver/single-order-card.test.js') continue;
    drift.push(`${repoPath} (byte-changed${ALLOWED_REGION_BEARING.has(repoPath) ? ' — region strip did NOT recover baseline' : (repoPath.endsWith('single-order-view.js') ? ' — edited OUTSIDE the OFERTA-OFFER region' : '')})`);
  }
  assert.deepEqual(drift, [], `frozen files changed:\n  ${drift.join('\n  ')}`);
});

// A region-bearing frozen file must ONLY carry the regions the freeze allows (NAV-SDK), and nothing else may
// smuggle a SLICE2 marker into a frozen .js — any OTHER marker-bearing baseline .js is RED.
t('region-bearing frozen files carry only the allowed SLICE2 region(s)', () => {
  const baseFiles = gitStr('ls-tree', '-r', '--name-only', BASELINE, '--', 'xpizza-driver')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  for (const repoPath of baseFiles) {
    if (repoPath === ALLOWED_MODIFY) continue;
    const rel = repoPath.slice(PFX.length);
    let text; try { text = readFileSync(join(__dir, rel), 'utf8'); } catch { continue; }
    const marks = (text.match(/SLICE2:[A-Za-z0-9-]+:(START|END)/g) || []);
    if (marks.length === 0) continue;
    assert.ok(ALLOWED_REGION_BEARING.has(repoPath), `${repoPath} carries SLICE2 markers but is not an allowed region-bearing file`);
    const names = new Set(marks.map((m) => m.replace(/SLICE2:|:(START|END)/g, '')));
    assert.deepEqual([...names], ['NAV-SDK'], `${repoPath} may only carry the NAV-SDK region, found: ${[...names].join(', ')}`);
  }
});

// Probe: a svPay edit (OUTSIDE the OFERTA-OFFER region) must change the rest-hash — proof the single-order-view.js pin bites.
t('NEG: an edit to single-order-view.js OUTSIDE the OFERTA-OFFER region (svPay) changes the rest-hash → RED', () => {
  const text = readFileSync(join(__dir, 'single-order-view.js'), 'utf8');
  const probed = text.replace('function svPay(order, esc, computeVuelto) {', 'function svPay(order, esc, computeVuelto) { /* probe */');
  assert.notEqual(probed, text, 'the svPay probe anchor must exist');
  assert.notEqual(sovRestHash(probed), SOV_REST_SHA, 'a probe edit to svPay (outside the region) must change the rest-hash → RED');
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

// SLICE3 coexistence helper: locate the PRESENT SLICE3 regions (any subset — slice 3 is in progress) so check-2
// can splice them too. Full SLICE3 validation (whitelist, nesting, pin integrity) is slice3-freeze.guard's job;
// here we only pair the markers we need to splice. Returns [{ r, s, e }] for each paired, known SLICE3 region.
function findSlice3Ranges(lines) {
  const marks = strictMarks(lines, 'SLICE3', SLICE3_PINS.names);   // rejects malformed/unapproved SLICE3 markers (Codex r1 P2)
  const open = {}; const out = [];
  for (const { i, name, kind } of marks) {
    if (kind === 'START') { assert.equal(open[name], undefined, `SLICE3 region ${name} START while open (nested)`); open[name] = i; }
    else {
      assert.ok(open[name] != null, `SLICE3 region ${name} END without START`);
      const r = SLICE3_REGIONS.find((x) => x.name === name);
      if (r) out.push({ r, s: open[name], e: i });
      delete open[name];
    }
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
  // SLICE3 COEXISTENCE (slice 3 supersedes slice 2, advisor 2026-10-25): this guard's SLICE2 strip is blind to
  // SLICE3 markers, so check-2 must ALSO splice PRESENT SLICE3 regions — inserts to nothing, replaces to their
  // pinned span. Those spans are base code byte-identical in e2266b24 and 07e5ab38 (slice3-freeze check 5 proves
  // it), so restoring them recovers THIS baseline too. slice2-freeze's own baseline + SLICE2 guarantees are
  // unchanged. This block is load-bearing: without it a SLICE3 region leaks and this test goes RED (proven below).
  const s3 = findSlice3Ranges(lines);
  // Splice every region out (descending by start so indices stay valid); replacements splice their span in.
  const ordered = [...REGIONS.map((r) => ({ r, s: ranges[r.name][0], e: ranges[r.name][1] })), ...s3]
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

// The SLICE3 coexistence splice (in check-2 above) is LOAD-BEARING: with a SLICE3 region present, removing it
// would leak those bytes and turn slice2-freeze RED. Proven by injecting a well-formed SLICE3 insert into the
// baseline and showing the splice strips it back, while the un-spliced bytes do not match (advisor proof 2026-10-25).
t('SLICE3 coexistence splice is load-bearing (inject a SLICE3 region → recovers only WITH the splice)', () => {
  const baseHtml = gitStr('show', `${BASELINE}:${ALLOWED_MODIFY}`);
  const inj = baseHtml.split('\n');
  inj.splice(2, 0, '/* ===== SLICE3:LOGIC-3:START ===== */', 'noop();', '/* ===== SLICE3:LOGIC-3:END ===== */');   // line 2 is outside every SLICE2 region
  const injected = inj.join('\n');
  assert.notEqual(injected, baseHtml, 'the injected SLICE3 region must actually change the bytes (so un-spliced ⇒ RED)');
  const lines = injected.split('\n');
  for (const { r, s, e } of findSlice3Ranges(lines).sort((a, b) => b.s - a.s)) {
    lines.splice(s, e - s + 1, ...(r.kind === 'replace' ? r.restore : []));
  }
  assert.equal(lines.join('\n'), baseHtml, 'with the SLICE3 splice, the injected region strips back to baseline');
});

// Codex r2 P2: the shared broad scanner must REJECT dotted/spaced/slashed/Unicode marker names here too (a
// malformed SLICE3 marker in the coexistence splice must not be silently ignored then erased).
t('SLICE3 scanner rejects dotted/spaced/slashed/Unicode marker names (coexistence splice path)', () => {
  for (const name of ['BAD.NAME', 'BAD NAME', 'BAD/NAME', 'BÄDÑAME']) {
    for (const w of [(s) => `/* ${s} */`, (s) => `// ${s}`, (s) => `<!-- ${s} -->`]) {
      const lines = [w('SLICE3:LOGIC-3:START'), w(`SLICE3:${name}:START`), w(`SLICE3:${name}:END`), w('SLICE3:LOGIC-3:END')];
      assert.throws(() => findSlice3Ranges(lines), /malformed SLICE3 marker/, `must reject "${name}" via ${w('X')}`);
      assert.throws(() => findSlice3Ranges(lines.map((l) => l + '\r')), /malformed SLICE3 marker/, `must reject "${name}" (CRLF) via ${w('X')}`);
    }
  }
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
  // The sole free-form MODIFY is index.html; a region-bearing file (xpizza-delivery.js, NAV-SDK) may also be
  // modified, but ONLY within its region — verified byte-identical-after-strip by the frozen-files test above.
  const expectedModified = [ALLOWED_MODIFY, ...ALLOWED_REGION_BEARING, ...SLICE2_TEST_MODIFY, 'xpizza-driver/single-order-view.js', 'xpizza-driver/single-order-card.test.js'].sort();   // SLICE3: OFERTA-OFFER region + its test
  assert.deepEqual(modified.slice().sort(), expectedModified, `modified set must be exactly [${expectedModified.join(', ')}], got: ${modified.join(', ')}`);
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
  // PRESENTATION is now immediately followed by the NAVPREF-CSS region (both are CSS before </style>); NAVPREF-CSS
  // ends at </style>. The two CSS insert regions pin each other + the </style> landmark.
  'PRESENTATION': { before: '/* SLICE1:PRESENTATION:END */', after: "/* SLICE2:NAVPREF-CSS:START — Cuenta + «App de navegación» screens (R7); exact to the prototype, mapped to the app's Clean-Light-Pro tokens + Red Hat display face (same language as the stacked screens). */" },
  'NAVPREF-CSS': { before: '/* SLICE2:PRESENTATION:END */', after: '</style>' },
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

// Codex r3/r4: a non-undefined-returning check (promise, generator, async-generator, or any value) must FAIL
// immediately, not be silently counted as complete.
t('NEG: a deferred/value-returning check is rejected before it counts (must return undefined)', () => {
  assert.throws(() => t('promise', async () => {}), /return nothing/, 'an async (thenable) check must be rejected');
  assert.throws(() => t('generator', function* () {}), /return nothing/, 'a generator check must be rejected');
  assert.throws(() => t('async-generator', async function* () {}), /return nothing/, 'an async-generator check must be rejected');
  assert.throws(() => t('value', () => 42), /return nothing/, 'a value-returning check must be rejected');
});

console.log(`✓ slice2-freeze.guard: ${passed} checks passed (baseline ${baseSha.slice(0, 10)})`);
