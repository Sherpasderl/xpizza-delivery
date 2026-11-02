#!/usr/bin/env node
'use strict';
/* THE BRAND-LITERAL RATCHET — PLAN-brand-agnostic-convergence §4 STEP 0 + §3-G (Codex r2 #9). The Phase A census (brand-census.js)
 * reports; this ENFORCES. The exact existing debt is the baseline; a NEW occurrence fails at once; the baseline only shrinks.
 *
 *   node tools/brand-literal-guard.js            check the tree against the baseline (exit 1 on any NEW occurrence)
 *   node tools/brand-literal-guard.js --write    SHRINK the baseline to what is still present (never adds, never raises a count)
 *   node tools/brand-literal-guard.js --init     write the first baseline (refuses when one exists)
 *
 * WHAT IS RATCHETED (§3-G «restaurant ids/names, host→brand maps»), over every shipped file the census collects (JS, inline HTML
 * scripts / attributes / text, CSS, JSON / manifests, netlify.toml / _redirects / _headers):
 *   rid    a restaurant id (x_pizza, la_musa) — exact, identifier-normalised, embedded or in a URL; keys and members too
 *   name   a brand name / alias (X. Pizza, La Musa, xpizza, lamusa …) — case-, accent- and punctuation-normalised
 *   host   a brand host (the host → brand maps)
 *   rid-predicate   ARCHITECTURE: a rid-like value compared with ANY string literal (=== / !== / == / != / switch-case /
 *          [literals].includes(rid)) — future restaurants cannot be enumerated by a literal list, so the PATTERN is ratcheted
 *   unscanned       a shipped file the census could not collect (parse error / unsupported type) — a blind spot cannot grow
 * Normalisation is the census's own: string escapes and HTML entities are decoded by the parsers, constant concatenation /
 * templates / same-file const aliases are folded (collectJs), comments are never tokens. Platform INFRA names (the Firebase
 * project id etc., brand-vocabulary.json `infra`) are stripped by EXACT string before matching — scoped precisely, never a file.
 * KEY = file + kind + brand + normalised snippet, with a COUNT: line moves do not churn the baseline, and a second copy of an
 * existing literal in the same file is NEW. There are NO whole-file exemptions. */
const fs = require('fs');
const path = require('path');
const C = require('./brand-census');

const FUNCTIONS = path.join(__dirname, '..');
const ROOT = path.join(FUNCTIONS, '..');
const BASELINE = path.join(__dirname, 'brand-literal.baseline.json');
const KINDS = new Set(['rid', 'name', 'host']);
const RID_NAME = /^(rid|rids|restaurant_?id|restaurantid|restaurant|brand|brand_?id|brandid|tenant|tenant_?id|site_?id|siteid)$/i;

const snip = (v) => String(v).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
const keyOf = (r) => `${r.file}\u0000${r.kind}\u0000${r.brand}\u0000${r.snippet}`;

/* ── rid-predicate: an AST pass over every JS source of a file (whole .js / .mjs / .cjs; inline <script> and on* handlers) ── */
const ridLike = (n) => n && ((n.type === 'Identifier' && RID_NAME.test(n.name))
  || (n.type === 'MemberExpression' && !n.computed && n.property && RID_NAME.test(n.property.name))
  || (n.type === 'MemberExpression' && n.computed && n.property && n.property.type === 'Literal' && RID_NAME.test(String(n.property.value))));
const strOf = (n) => (n && n.type === 'Literal' && typeof n.value === 'string' ? n.value
  : n && n.type === 'TemplateLiteral' && n.expressions.length === 0 ? n.quasis.map((q) => q.value.cooked).join('') : null);
function predicatesIn(src, file, lineOffset = 0) {
  const out = [];
  let ast; try { ast = C.parseJs(src); } catch (_) { return { out, error: true }; }
  const push = (lit, node) => out.push({ file, kind: 'rid-predicate', brand: '*', snippet: snip(lit), line: node.loc.start.line + lineOffset });
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'BinaryExpression' && /^[!=]==?$/.test(n.operator)) {
      if (ridLike(n.left) && strOf(n.right) !== null) push(strOf(n.right), n);
      else if (ridLike(n.right) && strOf(n.left) !== null) push(strOf(n.left), n);
    }
    if (n.type === 'SwitchStatement' && ridLike(n.discriminant)) for (const c of n.cases) if (strOf(c.test) !== null) push(strOf(c.test), c);
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.property.name === 'includes'
      && n.callee.object.type === 'ArrayExpression' && n.arguments.length && ridLike(n.arguments[0])) {
      for (const e of n.callee.object.elements) if (strOf(e) !== null) push(strOf(e), n);
    }
    for (const k of Object.keys(n)) { if (k === 'loc') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
  };
  walk(ast);
  return { out, error: false };
}
function jsSourcesOf(file, src) {
  if (/\.(m|c)?js$/.test(file)) return [{ src, off: 0 }];
  if (!/\.html?$/.test(file)) return [];
  const parse5 = require('parse5');
  const doc = parse5.parse(src, { sourceCodeLocationInfo: true });
  const out = [];
  const visit = (node) => {
    if (node.tagName === 'script' && node.childNodes && node.childNodes[0] && node.childNodes[0].sourceCodeLocation) {
      const type = ((node.attrs || []).find((a) => a.name === 'type') || {}).value || '';
      if (!type || /^(module|text\/javascript|application\/javascript)$/i.test(type)) out.push({ src: node.childNodes[0].value, off: node.childNodes[0].sourceCodeLocation.startLine - 1 });
    }
    const loc = node.sourceCodeLocation;
    for (const a of node.attrs || []) if (/^on/i.test(a.name)) out.push({ src: a.value, off: ((loc && loc.attrs && loc.attrs[a.name]) || loc || { startLine: 1 }).startLine - 1 });
    for (const c of node.childNodes || []) visit(c);
    if (node.content) visit(node.content);
  };
  visit(doc);
  return out;
}

/* ── ONE per-file path, used by the real check AND by the bypass cells (brand-literal.guard.test.js) ── */
function rowsOfFile(file, src, match) {
  const col = C.COLLECTOR.find((c) => c.re.test(file));
  if (!col) return { rows: [], unscanned: 'unsupported' };
  let r; try { r = col.fn(src, file); } catch (e) { return { rows: [], unscanned: `parse error: ${String(e.message).slice(0, 80)}` }; }
  const rows = [];
  for (const o of r.occ) {
    if (o.kind === 'number') continue;
    const seen = new Set();   // one row per (occurrence, kind, brand): two aliases that normalise alike are ONE literal
    // a KEY / member is matched for rids by the census; a host → brand MAP keys on the host (and a name can be a key), so keys
    // also go through the string matcher for host / name (bypass cell «host → brand map»)
    const hits = match(o).concat(/^(key|member|json-key)$/.test(o.kind) ? match({ ...o, kind: 'string' }).filter((h) => h.kind === 'host' || h.kind === 'name') : []);
    for (const h of hits) { const k = `${h.kind}|${h.brand}`; if (KINDS.has(h.kind) && !seen.has(k)) { seen.add(k); rows.push({ file, kind: h.kind, brand: h.brand, snippet: snip(o.value), line: o.line }); } }
  }
  let predErr = false;
  for (const s of jsSourcesOf(file, src)) { const p = predicatesIn(s.src, file, s.off); rows.push(...p.out); predErr = predErr || p.error; }
  const errs = (r.errors || []).length;
  return { rows, unscanned: errs ? `${errs} inline parse error(s)` : (predErr ? 'predicate parse error' : null) };
}

/* the shipped file set = the census's own roots + exclusions (tests, fixtures, generated tooling artifacts, docs, media) */
function collect(root = ROOT, { overrides = {}, vocab } = {}) {
  vocab = vocab || JSON.parse(fs.readFileSync(path.join(__dirname, 'brand-vocabulary.json'), 'utf8'));
  const match = C.matcher(vocab);
  const res = C.scan({ root, vocab });
  const files = new Set([...res.scanned.map((s) => s.file), ...res.unsupported, ...res.errors.map((e) => e.file).filter(Boolean), ...Object.keys(overrides)]);
  const rows = [];
  for (const f of [...files].sort()) {
    const src = Object.prototype.hasOwnProperty.call(overrides, f) ? overrides[f] : fs.readFileSync(path.join(root, f), 'utf8');
    const r = rowsOfFile(f, src, match);
    rows.push(...r.rows);
    if (r.unscanned) rows.push({ file: f, kind: 'unscanned', brand: '-', snippet: r.unscanned, line: 0 });
  }
  return rows;
}
const tally = (rows) => { const m = new Map(); for (const r of rows) { const k = keyOf(r); const e = m.get(k) || { file: r.file, kind: r.kind, brand: r.brand, snippet: r.snippet, count: 0, lines: [] }; e.count++; e.lines.push(r.line); m.set(k, e); } return m; };
const readBaseline = (p = BASELINE) => { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return new Map(j.entries.map((e) => [keyOf(e), e])); };

/* NEW = a key absent from the baseline, or present more times than the baseline allows */
function diff(rows, base) {
  const cur = tally(rows); const added = []; const shrinkable = [];
  for (const [k, e] of cur) { const b = base.get(k); const allowed = b ? b.count : 0; if (e.count > allowed) added.push({ ...e, allowed }); }
  for (const [k, b] of base) { const e = cur.get(k); if (!e || e.count < b.count) shrinkable.push({ ...b, now: e ? e.count : 0 }); }
  return { added, shrinkable, cur };
}
function writeBaseline(entries, p = BASELINE) {
  const sorted = [...entries].sort((a, b) => a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind) || a.brand.localeCompare(b.brand) || a.snippet.localeCompare(b.snippet));
  fs.writeFileSync(p, JSON.stringify({
    _doc: 'brand-literal ratchet baseline (tools/brand-literal-guard.js). The EXACT existing brand-literal debt, keyed by file + kind + brand + normalised snippet with a count. Shrink only: `--write` lowers counts / drops entries; nothing may be added by hand. PLAN-brand-agnostic-convergence §3-G.',
    scanner: C.SCANNER_VERSION, kinds: ['rid', 'name', 'host', 'rid-predicate', 'unscanned'],
    entries: sorted.map(({ file, kind, brand, snippet, count }) => ({ file, kind, brand, snippet, count })),
  }, null, 1) + '\n');
}

function main() {
  const args = process.argv.slice(2);
  const bad = args.filter((a) => !['--write', '--init'].includes(a));
  if (bad.length) { console.error(`brand-literal-guard: unknown argument(s) ${bad.join(' ')}\nusage: node tools/brand-literal-guard.js [--write | --init]`); process.exit(2); }
  const rows = collect();
  if (args.includes('--init')) {
    if (fs.existsSync(BASELINE)) { console.error('brand-literal-guard: REFUSED — a baseline exists; it only shrinks (--write)'); process.exit(2); }
    writeBaseline([...tally(rows).values()]); console.log(`brand-literal-guard: baseline written — ${tally(rows).size} keys, ${rows.length} occurrences`); return;
  }
  const base = readBaseline();
  const { added, shrinkable, cur } = diff(rows, base);
  if (added.length) {
    console.error(`🔴 brand-literal-guard: ${added.length} NEW brand-literal occurrence key(s) — a per-restaurant difference must be portal-sourced DATA (STANDING-RULES §1-3), never a new literal:`);
    for (const a of added) console.error(`  ${a.file}:${a.lines.join(',')}  ${a.kind} ${a.brand}  «${a.snippet}»  (${a.count} now, baseline allows ${a.allowed})`);
    process.exit(1);
  }
  if (args.includes('--write')) {
    const next = [...base.values()].map((b) => { const e = cur.get(keyOf(b)); return e ? { ...b, count: Math.min(b.count, e.count) } : null; }).filter(Boolean);
    writeBaseline(next); console.log(`brand-literal-guard: baseline SHRUNK — ${base.size} → ${next.length} keys`); return;
  }
  console.log(`brand-literal-guard: OK — 0 new; ${cur.size} keys at or below the baseline (${base.size} keys)${shrinkable.length ? `; ${shrinkable.length} key(s) can shrink — run --write` : ''}`);
}

module.exports = { collect, rowsOfFile, predicatesIn, tally, diff, readBaseline, keyOf, snip, BASELINE };
if (require.main === module) main();
