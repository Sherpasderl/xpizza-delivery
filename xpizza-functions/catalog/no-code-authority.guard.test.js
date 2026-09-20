'use strict';
// Portal 2a Task 9 — THE LANDMINE GUARD. Run: node catalog/no-code-authority.guard.test.js
//
// This phase inverted the source of truth: the Firestore catalog is the authority for everything
// menu-derived, and menu-pricing.js / rewards-redeem-config.js are FALLBACK-ONLY. Nothing enforces
// that but this file. The failure it exists to prevent is not a crash — it is a new consumer quietly
// reading a code constant, passing every test (the constants are still correct today), and drifting
// the moment a merchant edits their menu. That is invisible in review and invisible in CI.
//
// So: every production reference to a retired authority must be EXPLICITLY allow-listed here, with a
// reason. Adding a reference means adding a line to this file, which is the point — it turns a silent
// drift into a decision someone has to write down.
const assert = require('assert');
const { readFileSync, readdirSync, statSync } = require('fs');
const { join, relative, resolve } = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const ROOT = join(__dirname, '..');

// The constants that STOPPED being authoritative in this phase.
const RETIRED = {
  MENU_BY_RESTAURANT: 'item prices — resolve them from the catalog (resolvePricingTables → tables)',
  EXTRAS_BY_RESTAURANT: 'extra prices — resolve them from the catalog (tables.extras)',
  EXTRA_PRICES: 'the x_pizza extras alias — resolve them from the catalog',
  X_PIZZA_WEEKEND_ONLY: 'the weekend gate — read it from the catalog (menu-gates.weekendOnlyKeysFor)',
  X_PIZZA_REDEEM_ELIGIBLE: 'redemption eligibility — read it from the catalog (menu-gates.redeemEligibleFor)',
  LA_MUSA_ACOMP: 'redemption eligibility — read it from the catalog (menu-gates.redeemEligibleFor)',
};

// The ONLY legitimate readers, each with the reason it is legitimate. `null` = the whole file.
// Deliberately keyed per (file, identifier): a file allowed one constant is not thereby allowed another.
const ALLOWED = {
  'menu-pricing.js': { why: 'DEFINES them. Its own resolvePriceTables(rid, null) is the documented fallback.', ids: null },
  'restaurant-id.js': { why: 'the KNOWN_RESTAURANTS FLOOR — the registry may only add to it, never subtract (Task 8).', ids: ['MENU_BY_RESTAURANT'] },
  'catalog/menu-gates.js': { why: 'the static weekend fallback, used only when the catalog is unreadable or unauthored (Task 5).', ids: ['X_PIZZA_WEEKEND_ONLY'] },
  'rewards-redeem-config.js': { why: 'the static redemption fallback, used only when the catalog is unreadable or unauthored (Task 6).', ids: ['X_PIZZA_REDEEM_ELIGIBLE', 'LA_MUSA_ACOMP'] },
  'catalog/redeem-source.js': { why: 'AUTHORS the store FROM the code allowlists at seed time — the one-way derivation, verified as a no-op (Task 6/6b).', ids: ['X_PIZZA_REDEEM_ELIGIBLE', 'LA_MUSA_ACOMP'] },
  'catalog/form-menu-source.js': { why: 'the code-side build the pre-flip parity gate compares the store against — bootstrap, never a serving path.', ids: ['MENU_BY_RESTAURANT', 'EXTRAS_BY_RESTAURANT'] },
};

// tools/ is the seed + publish + verify CLIs: bootstrapping the store FROM code is their entire job,
// and none of them runs in a request. Tests read the constants to compare against.
const SKIP_DIRS = new Set(['node_modules', 'tools', '.git', 'public', 'coverage']);
const isTest = (f) => f.endsWith('.test.js') || f.endsWith('.guard.test.js');

function productionFiles(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) productionFiles(full, out);
    else if (name.endsWith('.js') && !isTest(name)) out.push(full);
  }
  return out;
}

// CODE only. A comment naming a retired constant — including the ones explaining why it is retired —
// is not a read of it.
const codeOf = (full) => readFileSync(full, 'utf8').split('\n')
  .map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, ''))
  .join('\n');

// THE one check. Everything below calls this — the guard, the staleness sweep, and the planted-landmine
// probe — so a mutation to it cannot leave any of them passing.
const idsReadIn = (code) => Object.keys(RETIRED).filter((id) => new RegExp(`\\b${id}\\b`).test(code));
const isAllowed = (rel, id) => { const e = ALLOWED[rel]; return !!(e && (e.ids === null || e.ids.includes(id))); };
const violationsIn = (rel, code) => idsReadIn(code).filter((id) => !isAllowed(rel, id));

function scan() {
  const found = [];
  for (const full of productionFiles()) {
    const rel = relative(ROOT, full);
    for (const id of idsReadIn(codeOf(full))) found.push({ rel, id });
  }
  return found;
}

const FILES = productionFiles();
assert.ok(FILES.length > 40, `non-vacuity: the scanner must actually find the production tree (found ${FILES.length} files)`);
assert.ok(FILES.some((f) => f.endsWith('index.js')) && FILES.some((f) => f.endsWith('rewards-redeem.js')),
  'non-vacuity: the biggest consumers must be in the scanned set');
ok(`the scanner sees ${FILES.length} production files (tests and the seed/publish CLIs excluded, with reasons)`);

// ── THE GUARD ──────────────────────────────────────────────────────────────────────────────────
{
  const violations = [];
  for (const { rel, id } of scan()) {
    if (isAllowed(rel, id)) continue;
    violations.push(`${rel} reads ${id} — ${RETIRED[id]}`);
  }
  assert.deepStrictEqual(violations, [],
    `CODE-AUTHORITY LANDMINE. These files read a constant this phase retired:\n    ${violations.join('\n    ')}\n` +
    '  The catalog is the authority. Thread the resolved value in (see Tasks 5-8), or — if this really is a\n' +
    '  fallback/bootstrap — add it to ALLOWED in this file with the reason. Do not widen ALLOWED to a whole\n' +
    '  file to silence one identifier.');
  ok('no production file reads a retired code constant as a live authority');
}

// ── THE ALLOWLIST MUST NOT ROT ─────────────────────────────────────────────────────────────────
// An allowlist nobody prunes becomes a blanket permission. Every entry must still correspond to a real
// reference, so a fallback that is later removed cannot leave a standing licence behind for a future
// consumer to inherit.
{
  const actual = new Set(scan().map(({ rel, id }) => `${rel}::${id}`));
  const stale = [];
  for (const [rel, entry] of Object.entries(ALLOWED)) {
    if (entry.ids === null) { if (![...actual].some((k) => k.startsWith(`${rel}::`))) stale.push(`${rel} (whole file)`); continue; }
    for (const id of entry.ids) if (!actual.has(`${rel}::${id}`)) stale.push(`${rel}::${id}`);
  }
  assert.deepStrictEqual(stale, [], `stale allowlist entries — remove them so they cannot license a future reader:\n    ${stale.join('\n    ')}`);
  ok(`all ${Object.keys(ALLOWED).length} allowlist entries are live (no standing licence for a future reader)`);
}

// ── NON-VACUITY: the guard must actually catch a planted landmine ──────────────────────────────
{
  // Runs the REAL check over synthetic source — same functions the guard above uses, not a re-implementation.
  const detect = (rel, code) => violationsIn(rel, code.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n'));
  assert.deepStrictEqual(detect('index.js', "const p = MENU_BY_RESTAURANT[rid][key];"), ['MENU_BY_RESTAURANT'], 'a planted price read in index.js must be caught');
  assert.deepStrictEqual(detect('availability-gate.js', "if (X_PIZZA_WEEKEND_ONLY.has(n)) return;"), ['X_PIZZA_WEEKEND_ONLY'], 'a planted weekend read in a new file must be caught');
  // ...including in a file that IS allow-listed, but for a DIFFERENT identifier
  assert.deepStrictEqual(detect('restaurant-id.js', "const x = EXTRAS_BY_RESTAURANT.x_pizza;"), ['EXTRAS_BY_RESTAURANT'],
    'a file allowed ONE constant must not thereby be allowed another');
  assert.deepStrictEqual(detect('restaurant-id.js', "new Set(Object.keys(MENU_BY_RESTAURANT))"), [], 'while its own allowed use still passes');
  // a comment must never count as a read, or the guard would fire on its own documentation
  assert.deepStrictEqual(detect('index.js', "// MENU_BY_RESTAURANT is no longer imported here"), [], 'a comment is not a read');
  assert.deepStrictEqual(detect('index.js', "const t = tables.menu;   // was MENU_BY_RESTAURANT"), [], 'nor is a trailing comment');
  ok('non-vacuity: the guard catches planted reads (including in an allow-listed file, for another id) and ignores comments');
}

// ── EVERY TEST IN THE SUITE MUST ACTUALLY RUN ──────────────────────────────────────────────────
// A test file that exists but is not in the npm test chain is worse than no test: it looks like
// coverage in review and proves nothing in CI. Every test this phase added is wired.
{
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
  const ALL = Object.values(scripts).join(' || ');
  // Emulator suites live in their own `test:*` scripts (they need a running emulator), so the rule is
  // "referenced by SOME script", not "in the default chain".
  //
  // These two predate this phase and are NOT adopted by it. They need an emulator script that nobody
  // can verify from here, so they are recorded rather than quietly ignored — the list may shrink, never
  // grow, which is what stops "unwired" from becoming a habit.
  /* 🔴 EMPTIED, NOT RELAXED. Both entries — claim-order and claim-prefill — are wired now: they have
     npm scripts, they run in the aggregate, and every emulator suite on disk is reachable
     (tools/emulator-ports.guard.test.js cell 11 asserts that from the filesystem, so the list cannot
     regrow unnoticed). claim-order turned out to be a MONEY-PATH suite that had never executed at
     all: it requires otp-lib, which fails closed without OTP_SALT, so it threw before its first cell
     for anyone following its own header. Fourteen cells run now. This guard is what forced the
     cleanup — it refuses to let an entry outlive its cause, which is the rule the list existed for. */
  /* 🔴 THIS WALK USED TO STOP AT xpizza-functions, WHICH IS HOW EIGHT PORTAL FILES HID. The check
     that exists to find unreachable tests could not see the most unreachable tests in the repo,
     because they live in ../xpizza-portal — and test:portal, in no chain and no aggregate, LOOKED
     like their coverage. It also skipped tools/, exempting the guards themselves. It now walks the
     whole repo, and every package.json in it, both discovered from disk rather than declared, so a
     new app or directory cannot appear outside the check. */
  const REPO = join(ROOT, '..');
  const SKIP_WALK = new Set(['node_modules', '.git', 'coverage', 'public', '.firebase']);

  const manifests = [];
  const collectManifests = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_WALK.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) collectManifests(full);
      else if (name === 'package.json') manifests.push(full);
    }
  };
  collectManifests(REPO);

  /* Several sibling apps carry their own manifest and their own `node --test` — xpizza-portal,
     xpizza-factura, xpizza-dispatch-mobile — so judging reachability from this package's scripts
     alone would condemn suites that ARE run, and say nothing about directories with no manifest at
     all. Matching is on PATHS, not substrings: a substring test once called claim-order wired
     because the chain happened to contain "claim-order.test.js", a different file. Three shapes
     reach a file — an exact path, a glob (../xpizza-portal/*.test.mjs), and a bare `node --test`
     with no path, which walks its own package directory. */
  const exactPaths = new Set();
  const globPatterns = [];
  const bareTestDirs = [];
  for (const m of manifests) {
    const dir = join(m, '..');
    const here = JSON.parse(readFileSync(m, 'utf8')).scripts || {};
    for (const cmd of Object.values(here)) {
      const text = String(cmd);
      const toks = text.match(/[A-Za-z0-9_.\/*-]+\.(?:js|mjs)/g) || [];
      if (/\bnode\s+--test\b/.test(text) && !toks.length) bareTestDirs.push(dir);
      for (const tok of toks) {
        const abs = resolve(dir, tok);
        if (tok.includes('*')) {
          globPatterns.push(new RegExp(`^${abs.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`));
        } else exactPaths.add(abs);
      }
    }
  }
  const isReachable = (abs) => exactPaths.has(abs)
    || globPatterns.some((g) => g.test(abs))
    || bareTestDirs.some((d) => abs.startsWith(`${d}/`));

  /* 🔴 TWENTY-FOUR TEST FILES THAT NOTHING RUNS — found the moment the walk widened, and NOT
     excused so much as finally written down. Every one was invisible before: xpizza-dispatch and
     xpizza-kitchen have no package.json at all, xpizza-driver's has no test script,
     xpizza-factura's globs test/*.test.js so a suite in src/ falls outside it, and the root and
     scripts/ files belong to no package. Nothing here is a judgement that they should not run —
     wiring twenty-four suites across five apps is a scoping decision for the advisor and owner, not
     something to smuggle into a test-infra commit, and some of them may well be stale or red the
     first time they execute (resolve-manual and claim-order both were).
     They are recorded so the number is in front of us on every run instead of nowhere. The list may
     shrink, never grow: the loop below fails the moment an entry becomes reachable, so an exception
     cannot outlive its cause — the same rule that forced claim-order and claim-prefill off this
     list, and the same rule the gate runner applies to KNOWN_RED. */
  const KNOWN_UNWIRED = [
    'agotado-failopen.test.mjs',
    'avail-key.test.mjs',
    'scripts/backfill-pickup-completion.test.mjs',
    'xpizza-dispatch/dispatch-aging.test.js',
    'xpizza-dispatch/dispatch-alert-nav.test.js',
    'xpizza-dispatch/dispatch-alerts.test.js',
    'xpizza-dispatch/dispatch-comms-thread.test.js',
    'xpizza-dispatch/dispatch-delivery-risk.test.js',
    'xpizza-dispatch/dispatch-eta-snapshot.test.js',
    'xpizza-dispatch/dispatch-stalled.test.js',
    'xpizza-dispatch/driver-eta.test.js',
    'xpizza-dispatch/driver-glide.test.js',
    'xpizza-driver/cash-helpers.test.js',
    'xpizza-driver/order-helpers.test.js',
    'xpizza-driver/stacking-helpers.test.js',
    'xpizza-factura/src/print-recovery.test.js',
    'xpizza-kitchen/avail-write.test.mjs',
    'xpizza-kitchen/card-model.test.mjs',
    'xpizza-kitchen/kds-smoke.test.mjs',
    'xpizza-kitchen/order-filter.test.mjs',
    'xpizza-kitchen/rail-count.test.mjs',
    'xpizza-kitchen/ready-nudge.test.mjs',
    'xpizza-kitchen/scheduled-view.test.mjs',
    'xpizza-track/driver-eta.test.js',
  ];
  const everyTest = [];
  const walkTests = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_WALK.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walkTests(full);
      else if (/\.test\.(js|mjs)$/.test(name)) everyTest.push(full);
    }
  };
  walkTests(REPO);

  const missing = everyTest.filter((f) => !isReachable(f))
    .map((f) => relative(REPO, f))
    .filter((rel) => !KNOWN_UNWIRED.includes(rel))
    .sort();
  assert.deepStrictEqual(missing, [],
    `test files that exist but no npm script reaches — coverage in review, nothing in CI:\n    ${missing.join('\n    ')}`);
  assert.ok(everyTest.length >= 200, `premise — the walk really covered the repo (${everyTest.length} test files)`);
  assert.ok(scripts.test.includes('catalog/no-code-authority.guard.test.js'), 'this guard must itself be in the default chain');
  // the exception list must not rot either: an entry that IS now reachable must be removed from it
  for (const rel of KNOWN_UNWIRED) assert.ok(!isReachable(resolve(REPO, rel)), `${rel} is reachable now — remove it from KNOWN_UNWIRED`);
  if (KNOWN_UNWIRED.length) {
    console.log(`    🔴 ${KNOWN_UNWIRED.length} test files are reached by NO script in any manifest — recorded, not running:`);
    console.log(`       ${[...new Set(KNOWN_UNWIRED.map((r) => (r.includes('/') ? r.split('/')[0] : '(repo root)')))].join(', ')}`);
  }
  ok(`all ${everyTest.length} test files across the repo are accounted for (walked from disk, ${manifests.length} manifests, globs expanded; ${KNOWN_UNWIRED.length} reached by nothing and recorded)`);
}
// ── THE RUNBOOK MUST STAY TRUE ─────────────────────────────────────────────────────────────────
// The cutover runbook quotes exact counts, CLI output and log lines. A runbook is read once, under
// pressure, by someone checking reality against it — so a drifted quote is worse than no quote. These
// pin the claims to the code that produces them.
{
  const RB = join(ROOT, '..', 'docs', 'superpowers', 'runbooks', '2026-09-06-portal-2a-cutover.md');
  const doc = readFileSync(RB, 'utf8');
  const { buildSourceFromCode } = require('../tools/seed-source-store');
  for (const rid of ['x_pizza', 'la_musa']) {
    const src = buildSourceFromCode(rid);
    const line = `${rid}: ${src.items.length} items + ${src.extras.length} extras`;
    assert.ok(doc.includes(line), `the runbook quotes stale counts for ${rid} — code now produces "${line}"`);
  }
  // A pure predicate over (doc, source), so the probe below can run the REAL logic against mismatched
  // inputs. Written inline, this check could be mutated into `doc.includes(...)` on both sides — the doc
  // asserting against itself, always true, proving nothing. That mutation survived until this shape.
  const unbacked = (docText, srcText, needles, wrap) =>
    needles.filter((x) => !docText.includes(x) || !srcText.includes(wrap ? wrap(x) : x));

  const emitted = productionFiles().map((f) => readFileSync(f, 'utf8')).join('\n');
  const TAGS = ['menu_gates_read_failed', 'menu_gates_unauthored', 'redeem_eligibility_read_failed',
    'redeem_eligible_malformed_set', 'restaurant_registry_read_failed', 'weekend_gate_malformed_set'];
  assert.deepStrictEqual(unbacked(doc, emitted, TAGS, (t) => `'${t}'`), [],
    'every log line the runbook tells the owner to watch for must actually be emitted by the code');

  const tools = ['tools/seed-source-store.js', 'tools/publish-version.js', 'tools/verify-catalog.js']
    .map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
  const QUOTES = ['parity gate PASSED', 'source store seeded — NOTHING published', 'no source store yet (pre-2a)', 'production catalog == code tables'];
  assert.deepStrictEqual(unbacked(doc, tools, QUOTES), [], 'every CLI line the runbook quotes must actually be printed by a CLI');

  // NON-VACUITY, both directions: a needle the doc names but nothing emits must be REPORTED, and one
  // that is genuinely backed must not be. Without this the predicate could ignore its source argument.
  assert.deepStrictEqual(unbacked('watch for ghost_tag', '', ['ghost_tag']), ['ghost_tag'], 'an unbacked quote must be caught');
  assert.deepStrictEqual(unbacked('watch for ghost_tag', "console.warn('ghost_tag')", ['ghost_tag'], (t) => `'${t}'`), [], 'a backed one must pass');
  assert.deepStrictEqual(unbacked('', "console.warn('ghost_tag')", ['ghost_tag']), ['ghost_tag'], 'and a line the runbook forgot to mention is caught too');
  ok('the cutover runbook\'s counts, log lines and CLI output all still match the code that produces them');
}
console.log(`no-code-authority.guard: OK (${n})`);
