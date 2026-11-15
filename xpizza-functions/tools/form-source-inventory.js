#!/usr/bin/env node
'use strict';
// PLAN-A §5 — THE EXECUTABLE FORM-SOURCE INVENTORY (lands in A-1; every later PLAN-A phase uses it).
//
//   node tools/form-source-inventory.js            → prints the inventory; exit 1 on an unregistered pin
//   node tools/form-source-inventory.js --write    → also writes tools/form-source-inventory.json (committed; its diff is
//                                                    part of every hand-back; form-source-inventory.guard.test.js
//                                                    regenerates it and requires equality)
//
// 1. SURFACES: every test file (.test.js AND .test.mjs, repo-wide) that reads, lifts or regexes an order form, its local
//    JS modules (account.js, form-*.js, …) or a reader surface PLAN-A touches — DIRECTLY, or TRANSITIVELY through a helper
//    it requires/imports (form-harness.mjs, lifters, contract/census.js's page scan, …). A file "touches" a surface when
//    its source names the surface's directory (e.g. 'xpizza-orders', path.join(…, 'la-musa-orders', …)) or, for the repo
//    root page, the root index.html by a path that leaves xpizza-functions.
// 2. SERVER MODULES: the modules this branch edits (re-derived from `git diff --name-only <base>` — never a hand list).
//    For each, every file that HASHES it (sha256 / createHash / a git-show base / baseOf) or LIFTS its source
//    (readFileSync of it), and for each hashing site the registered inverse (a tools/*-inverse.js that names the module
//    and that the site requires). An edited module hashed by a site with NO registered inverse → exit 1 — unless the site is a
//    PROVENANCE pin registered in tools/provenance-pins.json and proven by provenance() below.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FN = path.join(__dirname, '..');
const ROOT = path.join(FN, '..');
const BASE = require('./a1-inverse').BASE;   // the branch base (A-1 is built on it); later phases name theirs here
const OUT = path.join(__dirname, 'form-source-inventory.json');

const FORM_DIRS = ['xpizza-orders', 'la-musa-orders'];
const READER_DIRS = ['xpizza-kitchen', 'xpizza-dispatch', 'xpizza-dispatch-mobile', 'xpizza-driver', 'xpizza-track', 'xpizza-dashboard'];
// THE ⊇ SEED (PLAN-A §5): codex's 40 source-reference test files — ~/Downloads/xpizza-D4c-grill/codex-menu-v5-plan-r1.txt
// finding 11 (lines 162–170), paths under xpizza-functions/, each resolved to its .test.js / .test.mjs. Every one must be
// accounted for: a surface reader (in `surfaces`), or 'named-only' with the line that names a surface, or removed/renamed
// with git evidence — never silently dropped.
const SEED = ['address-autofill-recheckout', 'claim-address-capture', 'createorder-selfheal-client', 'f2-client', 'form-load-execution',
  'n3-weekend-message', 'n4-cancel-verify', 'order-form-location-escape', 'pickup-conflict-modal', 'pin-save-prompt', 'profile-named',
  'recognized-entry', 'rewards-parity.guard', 'pselfupdate-wrapper-lint', 'quote-order',
  'catalog-form-bundle', 'catalog-schemav2', 'form-bundle-splice', 'menu-parity',
  ...['catalog-menu', 'desde-derivation', 'display-safety', 'extras-exposure', 'group-index', 'identity-noop', 'identity-public-contract', 'public-menu', 'renderer-contract'].map((x) => `catalog/${x}`),
  ...['applicability.guard', 'matrix.guard', 'p0-forms.emulator', 'p0-observations.emulator', 'p1a-journey.emulator', 'timer-bounds.guard'].map((x) => `contract/${x}`),
  ...['availability-reset.emulator', 'catalog-generation.emulator', 'order-control.emulator', 'order-exists.emulator'].map((x) => `test/${x}`),
  'secrets-scan-omit.guard', 'tools/endpoint-census.guard'];
const SKIP = new Set(['node_modules', '.git', '.firebase', 'coverage', 'dist']);
// the repo-root review/ tree is evidence + side-by-side harnesses (review/capp-sbs, …): it never ships and is not a surface reader;
// skipped by its EXACT path only (train asm3, codex asm3 P2: capp-guards' S2 SBS cell forbids naming the harness outside review/)
const REVIEW_DIR = path.join(__dirname, '..', '..', 'review');

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory() && p === REVIEW_DIR) continue;
    if (e.isDirectory()) walk(p, out); else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}
const isTest = (f) => /\.test\.m?js$/.test(f);
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };

// which surfaces a source names directly
function directSurfaces(file, src) {
  const hits = new Set();
  const own = rel(file).split('/')[0];
  for (const d of [...FORM_DIRS, ...READER_DIRS]) {
    if (own === d) { if (/readFileSync|index\.html|import\(|require\(/.test(src) && new RegExp(`(['"\`/])(index\\.html|[\\w.-]+\\.js)\\1?`).test(src)) hits.add(d); continue; }
    if (new RegExp(`['"\`/]${d}['"\`/]`).test(src)) hits.add(d);
  }
  // the repo-root page (index.html at the top level), named from xpizza-functions by a path that climbs out of it
  if (/(\.\.\/|'\.\.',\s*)+['"`]?index\.html/.test(src) || /ROOT[^\n]{0,40}index\.html/.test(src)) hits.add('<root>/index.html');
  return hits;
}
// relative requires / imports (static and dynamic)
function deps(file, src) {
  const out = new Set();
  const re = /(?:require\(\s*|import\(\s*|from\s+|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const base = path.resolve(path.dirname(file), m[1]);
    for (const cand of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js')]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { out.add(cand); break; }
    }
  }
  return out;
}

// `extra` ({ 'repo/relative/path.js': source }) adds synthetic files — the guard's sensitivity cells only
// PROVENANCE PINS (advisor 11-15; r2 «reviewed content pins»): a fixture generator that hashes an EXTRACTED tree of a fixed commit
// records history, not the live module, so an edit to the live module cannot break it and an inverse could only be a hand-built proof.
// tools/provenance-pins.json registers each such (site, module) with the sha256 of the generator and of its consumer test AS REVIEWED
// (human + Codex). A row is honoured only while both files are byte-identical to those hashes (any edit ⇒ generator_changed /
// consumer_changed until re-registered by a reviewed diff) AND the fixture's recorded blob is `git rev-parse <sha>:xpizza-functions/<module>`
// (fixture_blob). A refused row exits 1. `live_differs` (the live blob is not the pinned one) is information only, never a failure.
const PROV = path.join(__dirname, 'provenance-pins.json');
const dig = (o, f) => f.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
const sha256 = (s) => (s == null ? null : require('crypto').createHash('sha256').update(s).digest('hex'));
function provenance(rows, srcOf) {
  return rows.map((r) => {
    const site = srcOf(r.site);
    if (site == null) return { site: r.site, module: r.module, status: 'absent' };
    const refuse = (check, why) => ({ site: r.site, module: r.module, status: 'refused', check, why });
    if (sha256(site) !== r.site_sha256) return refuse('generator_changed', `${r.site} is not the reviewed generator (re-register)`);
    if (sha256(srcOf(r.consumer)) !== r.consumer_sha256) return refuse('consumer_changed', `${r.consumer} is missing or not the reviewed consumer (re-register)`);
    let fx; try { fx = JSON.parse(srcOf(r.fixture)); } catch (_) { return refuse('fixture_blob', `fixture ${r.fixture} unreadable`); }
    const sha = dig(fx, r.sha_field), blob = (dig(fx, r.blobs_field) || {})[r.module];
    let want = null; try { want = execFileSync('git', ['rev-parse', '-q', '--verify', `${sha}:xpizza-functions/${r.module}`], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (_) { /* refused below */ }
    if (!/^[0-9a-f]{40}$/.test(sha || '') || !want || blob !== want) return refuse('fixture_blob', `fixture blob ${blob} ≠ ${sha}:${r.module} (${want})`);
    const live = read(path.join(FN, r.module));
    const liveBlob = live === '' ? null : require('crypto').createHash('sha1').update(`blob ${Buffer.byteLength(live)}\0`).update(live).digest('hex');
    return { site: r.site, module: r.module, status: 'ok', sha, blob, consumer: r.consumer, live_differs: liveBlob !== blob };
  });
}

function build({ extra = {}, provenance: provRows } = {}) {
  const SELF = new Set([__filename, OUT, path.join(FN, 'form-source-inventory.guard.test.js')]);   // the tool, its output and its guard (whose synthetic sources would match)
  const files = walk(ROOT).filter((f) => !SELF.has(f));
  const src = new Map(files.map((f) => [f, read(f)]));
  for (const [r, text] of Object.entries(extra)) { const abs = path.join(ROOT, r); if (!src.has(abs)) files.push(abs); src.set(abs, text); }
  const srcOf = (r) => { const abs = path.join(ROOT, r); return src.has(abs) ? src.get(abs) : (fs.existsSync(abs) ? read(abs) : null); };
  const provPins = provenance((provRows || (fs.existsSync(PROV) ? JSON.parse(read(PROV)) : { rows: [] })).rows, srcOf);
  const provOk = new Set(provPins.filter((p) => p.status === 'ok').map((p) => `${p.site}|${p.module}`));
  const direct = new Map(files.map((f) => [f, directSurfaces(f, src.get(f))]));
  const edges = new Map(files.map((f) => [f, deps(f, src.get(f))]));
  // transitive closure (memoised DFS; cycles are fine)
  const memo = new Map();
  const reach = (f, stack = new Set()) => {
    if (memo.has(f)) return memo.get(f);
    if (stack.has(f)) return new Set();
    stack.add(f);
    const acc = new Set(direct.get(f) || []);
    for (const d of edges.get(f) || []) for (const s of reach(d, stack)) acc.add(s);
    stack.delete(f);
    memo.set(f, acc);
    return acc;
  };
  const surfaces = {};
  for (const s of [...FORM_DIRS, ...READER_DIRS, '<root>/index.html']) surfaces[s] = { tests: [], via_helper: [] };
  const helpersUsed = new Set();
  for (const f of files.filter(isTest)) {
    const all = reach(f);
    for (const s of all) {
      const viaDirect = (direct.get(f) || new Set()).has(s);
      surfaces[s].tests.push(rel(f));
      if (!viaDirect) {
        surfaces[s].via_helper.push(rel(f));
        for (const d of edges.get(f) || []) if (reach(d).has(s) && !isTest(d)) helpersUsed.add(rel(d));
      }
    }
  }
  for (const s of Object.keys(surfaces)) { surfaces[s].tests.sort(); surfaces[s].via_helper.sort(); }

  // ── server modules this branch edits ──
  const changed = execFileSync('git', ['diff', '--name-only', BASE, '--', 'xpizza-functions/'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .filter((p) => /\.js$/.test(p) && !isTest(p) && !/\/tools\//.test(p) && !/\/test\//.test(p) && !/\/contract\//.test(p) && fs.existsSync(path.join(ROOT, p)))
    .map((p) => p.replace(/^xpizza-functions\//, '')).sort();
  const inverses = fs.readdirSync(__dirname).filter((n) => /-inverse\.js$/.test(n))
    .map((n) => ({ name: `tools/${n}`, src: read(path.join(__dirname, n)) }));
  const server = {};
  const unregistered = [];
  for (const m of changed) {
    const base = path.basename(m);
    const name = m;                                  // e.g. 'catalog/canonical-binding.js'
    const quoted = new RegExp(`['"\`/]${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"\`]`);
    const entry = { pins: [], lifts: [] };
    for (const f of files) {
      if (rel(f) === `xpizza-functions/${m}`) continue;
      const s = src.get(f);
      if (!quoted.test(s) && !(name === base && new RegExp(`['"\`]${base.replace('.', '\\.')}['"\`]`).test(s))) continue;
      // what the site does WITH this module: a hash / git-base / baseOf operation within 160 chars of its name = a PIN;
      // a read of it (readFileSync / a read helper) = a LIFT. A file that hashes something else and merely names M is not a pin.
      const near = [];
      const reName = new RegExp(`['"\`/]${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"\`]`, 'g');
      let mm; while ((mm = reName.exec(s))) near.push(s.slice(Math.max(0, mm.index - 160), mm.index + name.length + 160));
      // a pin compares the CURRENT bytes: a sha over it, a pinned 64-hex digest beside its name, or a base-equality
      // proof (baseOf / an unapply inverse). A `git show <historical rev>` census of the name alone is not a pin.
      const hashes = near.some((w) => /createHash|sha256|\bsha\(|[0-9a-f]{64}|baseOf\(|unapply/.test(w));
      const lifts = near.some((w) => /readFileSync|\bread\(|lift|fs\.read/.test(w));
      if (!hashes && !lifts) continue;
      if (hashes) {
        // a registered inverse: a tools/*-inverse.js naming this module that the site requires
        const inv = inverses.filter((v) => (v.src.includes(`'${name}'`) || v.src.includes(`"${name}"`) || (name === 'index.js' && /unapply\w*Index|foldPortalSplit|unapply\w*\(src/.test(v.src)))
          && new RegExp(`${v.name.replace('tools/', '').replace('.js', '')}`).test(s)).map((v) => v.name).sort();
        const isInverseItself = /tools\/[\w-]+-inverse\.js$/.test(rel(f));
        const prov = provOk.has(`${rel(f)}|${m}`);
        entry.pins.push({ file: rel(f), inverses: inv, ...(prov ? { provenance: true } : {}) });
        if (!inv.length && !isInverseItself && !prov) unregistered.push({ module: m, site: rel(f) });
      } else entry.lifts.push(rel(f));
    }
    entry.pins.sort((a, b) => a.file.localeCompare(b.file)); entry.lifts.sort();
    server[m] = entry;
  }
  // ── the ⊇ seed: every entry accounted for ──
  const seed = SEED.map((name) => {
    const found = [`${name}.test.js`, `${name}.test.mjs`].map((x) => path.join(FN, x)).find((x) => src.has(x) || fs.existsSync(x));
    if (!found) {
      let evidence = '';
      try { evidence = execFileSync('git', ['log', '--diff-filter=DR', '--format=%h %s', '-1', '--', `xpizza-functions/${name}.test.js`, `xpizza-functions/${name}.test.mjs`], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (_) { /* reported below */ }
      return { seed: name, status: 'removed_or_renamed', evidence: evidence || 'no deletion/rename commit found' };
    }
    const r = rel(found);
    const in_surfaces = Object.keys(surfaces).filter((k) => surfaces[k].tests.includes(r));
    if (in_surfaces.length) return { seed: name, file: r, status: 'reader', surfaces: in_surfaces };
    const lines = (src.get(found) || read(found)).split('\n');
    const i = lines.findIndex((l) => [...FORM_DIRS, ...READER_DIRS].some((d) => l.includes(d)));
    return { seed: name, file: r, status: 'named-only', evidence: i >= 0 ? `${r}:${i + 1}: ${lines[i].trim().slice(0, 160)}` : null };
  });
  const seedProblems = seed.filter((x) => (x.status === 'named-only' && !x.evidence) || (x.status === 'removed_or_renamed' && x.evidence === 'no deletion/rename commit found'));
  // S4 C′ G1 (Codex S4 build r1 P3): DATA-DRIVEN REGION pins, listed explicitly so the hashing heuristic above is answered,
  // not dodged. tools/hours-legacy-pins.js sha-pins literal-anchored REGIONS of legacy hours readers (from its JSON): an edit
  // INSIDE a region fails by design (no module inverse applies); an edit elsewhere in the module does not. HOURS-ONE-SOURCE
  // removes a record when it migrates that consumer.
  const regionPinsFile = path.join(__dirname, 'hours-legacy-pins.json');
  const regionPins = fs.existsSync(regionPinsFile)
    ? JSON.parse(read(regionPinsFile)).map((r) => ({ id: r.id, module: r.file, tool: 'xpizza-functions/tools/hours-legacy-pins.js' }))
    : [];
  return { _doc: 'PLAN-A §5 — generated by tools/form-source-inventory.js; never hand-edit. Regenerate with --write.', base: BASE,
    surfaces, helpers: [...helpersUsed].sort(), seed, seed_problems: seedProblems, server_modules_edited: changed, server, unregistered,
    region_pins: regionPins, provenance_pins: provPins };
}
const verdict = (inv) => (inv.seed_problems.length || inv.unregistered.length || inv.provenance_pins.some((p) => p.status === 'refused') ? 1 : 0);

module.exports = { build, verdict, OUT, SEED };

if (require.main === module) {
  const inv = build();
  const json = `${JSON.stringify(inv, null, 1)}\n`;
  if (process.argv.includes('--write')) fs.writeFileSync(OUT, json);
  const n = Object.values(inv.surfaces).reduce((a, s) => a + s.tests.length, 0);
  console.log(`form-source-inventory: ${n} (test, surface) pairs; ${inv.helpers.length} helpers; ${inv.server_modules_edited.length} edited server modules`);
  for (const [s, v] of Object.entries(inv.surfaces)) console.log(`  ${s}: ${v.tests.length} tests (${v.via_helper.length} via a helper)`);
  for (const [m, v] of Object.entries(inv.server)) console.log(`  ${m}: ${v.pins.length} hashing sites, ${v.lifts.length} lifting sites`);
  console.log(`  seed: ${inv.seed.length} (${inv.seed.filter((x) => x.status === 'reader').length} readers, ${inv.seed.filter((x) => x.status === 'named-only').length} named-only, ${inv.seed.filter((x) => x.status === 'removed_or_renamed').length} removed/renamed)`);
  if (inv.seed_problems.length) console.error('🔴 seed entries not accounted for:', JSON.stringify(inv.seed_problems, null, 1));
  for (const p of inv.provenance_pins) console.log(`  provenance pin ${p.site} → ${p.module}: ${p.status}${p.status === 'refused' ? ` (${p.check}: ${p.why})` : ''}${p.live_differs ? ` — ℹ live blob ≠ pinned blob (fixture at ${p.sha.slice(0, 9)} is stale vs the live module; information only)` : ''}`);
  if (inv.provenance_pins.some((p) => p.status === 'refused')) console.error('🔴 provenance pins refused:', JSON.stringify(inv.provenance_pins.filter((p) => p.status === 'refused'), null, 1));
  if (inv.unregistered.length) console.error('🔴 edited modules hashed with NO registered inverse:', JSON.stringify(inv.unregistered, null, 1));
  if (verdict(inv)) process.exit(1);
}
