#!/usr/bin/env node
'use strict';
/* THE BRAND-LITERAL CENSUS — PHASE A, REPORT ONLY (no enforcement; the ratchet is Phase C).
 *
 * OWNER DIRECTIVE: the whole Sherpa delivery platform behaves brand-agnostic. This tool inventories every
 * place SHIPPED code names, styles, routes or locates one specific brand, so each lane can burn its list
 * down before the first new restaurant. It cannot PROVE independence (that is Phase B's behavioural
 * 'brand_c' suite); it makes the debt visible, per lane and per shared root.
 *
 *   node tools/brand-census.js                 scan + print the summary
 *   node tools/brand-census.js --write [dir]   also write BRAND-LITERAL-CENSUS.md + .jsonl into dir
 *                                              (default ~/Downloads/xpizza-D4c-grill)
 *   node tools/brand-census.js --build-vocab   rebuild tools/brand-vocabulary.json from the authorities
 *
 * WHAT IS SCANNED. Roots come from platform/sites.json (every deployment folder + entrypoint) plus the
 * runtimes it does not list (driver, handheld, factura agent, functions, platform/, the deployed rules).
 * EVERY tracked file under a root is either collected or LISTED — excluded (with the rule), unsupported,
 * or a parse error. Nothing is skipped silently.
 *
 * HOW. JS/.mjs/.cjs (acorn, module → script fallback), HTML (parse5: text, attributes, inline on*
 * handlers, <script>, <style>, JSON script blocks), CSS (own tokenizer, comments stripped), JSON and
 * manifests (keys + values), text configs (netlify.toml, _redirects). COMMENTS ARE NEVER TOKENS.
 * In JS: bounded constant folding (string literals, constant templates, `+`, same-file const aliases —
 * a name declared more than once in a file is UNRESOLVED, never guessed), static object keys, member
 * names, computed constant keys, URL / path / query context, signed coordinates (unary minus folded,
 * tolerance COORD_TOL, a PAIR only when lat and lng share one object / array / argument list), and
 * weak evidence (display-name aliases, phones, colours). STRUCTURAL = a FIXED brand/location selection
 * or fallback (a const, default or `||` / `??` alternative whose value is a brand id or brand
 * coordinates) — a location value read from data is not structural.
 *
 * Classification is a HEURISTIC first pass; what it cannot place is UNCLASSIFIED, and the lanes confirm
 * their rows. AUTHORITY binds to exact declarations (file + symbol), never to every reference.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const acorn = require('acorn');

const FUNCTIONS = path.join(__dirname, '..');
const ROOT = path.join(FUNCTIONS, '..');
const VOCAB_FILE = path.join(__dirname, 'brand-vocabulary.json');
const SCANNER_VERSION = 'phase-a.2';
const COORD_TOL = 1e-4;   // degrees ≈ 11 m: tighter than any two venues, looser than float re-spellings (15.50414 vs 15.504137854…)

/* ── ROOTS & FILE RULES ──────────────────────────────────────────────────────────────────────────── */
const EXTRA_ROOTS = [   // runtimes platform/sites.json does not list (not Netlify sites)
  { folder: 'xpizza-driver', why: 'driver app (Capacitor native + PWA)' },
  { folder: 'xpizza-handheld', why: 'SUNMI order handheld' },
  { folder: 'xpizza-factura', why: 'factura print agent (Surface Pro)' },
  { folder: 'xpizza-functions', why: 'Cloud Functions runtime (firebase.json source)' },
  { folder: 'platform', why: 'shared platform config (sites, compat)' },
  { folder: 'xpizza-reference', why: 'the deployed database rules + derived narrowed rules' },
];
/* excluded from the census, each with its rule — reported with counts */
const EXCLUDE = [
  { rule: 'test', re: /(^|\/)(test|tests|__tests__)\/|\.test\.[cm]?js$|\.spec\.[cm]?js$|(^|\/)_[^/]*(harness|loader|seed)[^/]*\.m?js$/ },
  { rule: 'fixture / golden', re: /(^|\/)fixtures?\/|golden/ },
  { rule: 'vendored SDK copy', re: /^xpizza-functions\/contract\/sdk-[^/]+\// },
  { rule: 'generated R3 / tooling artifact', re: /^xpizza-functions\/(contract|tools)\/[^/]+\.json$|^xpizza-functions\/contract\/outputs\// },
  { rule: 'lockfile', re: /(^|\/)package-lock\.json$/ },
  { rule: 'docs', re: /\.(md|txt|diff|patch)$|(^|\/)LICENSE$/ },
  { rule: 'binary / media', re: /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|eot|pdf|mp3|mp4|wav|zip|gz|jar|keystore|apk|aab)$/i },
];
const OPS_PATHS = [/^xpizza-functions\/tools\//, /^xpizza-functions\/deploy\//, /^xpizza-functions\/scripts\//, /^xpizza-factura\/tools\//];
const SEED_PATHS = [/(^|\/)seed[_-][^/]*\.m?js$/, /^xpizza-factura\/seed_[^/]*\.js$/, /(^|\/)publish-menus\.mjs$/];
/* AUTHORITY: exact declarations (file + symbol) that legitimately DEFINE brand-specific data */
const AUTHORITY = [
  { file: 'xpizza-functions/factura/eligibility.js', symbol: 'FACTURA_PLATFORM_RESTAURANTS', why: 'OWNER STANDING RULE: only X. Pizza issues facturas through the platform' },
  { file: 'platform/sites.json', symbol: '*', why: 'the deployment manifest: which folder serves which brand context' },
];

/* SENTINEL (owner ruling 2026-10-20): deliberate platform values that are NOT brand debt — reported, never
   counted as coupling. GEO_DEFAULT is a spot where no customer is; seeing it on an order is the ops tell
   that geolocation failed (both order forms). */
const SENTINELS = [
  { lat: 15.5003, lng: -88.025, name: 'GEO_DEFAULT', why: 'OWNER RULING: deliberate geolocation-failed sentinel — no customer lives there; the ops tell that GPS failed' },
];

/* ── LANES ──────────────────────────────────────────────────────────────────────────────────────── */
const LANE_BY_FOLDER = {
  'xpizza-orders': 'forms', 'la-musa-orders': 'forms', 'xpizza-catering': 'forms', 'xpizza-kitchen': 'kitchen',
  'xpizza-dispatch': 'dispatch', 'xpizza-dispatch-mobile': 'dispatch', 'xpizza-driver': 'driver', 'xpizza-track': 'tracker',
  'xpizza-dashboard': 'dashboard', 'xpizza-portal': 'portal', 'xpizza-handheld': 'handheld', 'xpizza-factura': 'factura',
  legal: 'legal', platform: 'platform', 'xpizza-reference': 'rules',
};
function laneOf(file) {
  const top = file.split('/')[0];
  if (top === 'xpizza-functions') {
    const parts = file.split('/');
    return `functions-${parts.length > 2 ? parts[1] : 'core'}`;
  }
  return LANE_BY_FOLDER[top] || top;
}

/* ── VOCABULARY ─────────────────────────────────────────────────────────────────────────────────── */
const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const digits = (s) => String(s).replace(/\D/g, '');
function normColour(c) {
  let s = String(c).trim().toLowerCase();
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (m) return '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s.slice(1).split('').map((x) => x + x).join('');
  if (/^#[0-9a-f]{8}$/.test(s)) s = s.slice(0, 7);
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

/* Built OFFLINE from the authorities; the census never reads them at scan time, so a changed authority
   shows as vocabulary DRIFT in the report instead of silently changing what is detected. */
function buildVocabulary(root = ROOT, { at = 'HEAD' } = {}) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const prov = [];
  const brands = {};
  const brand = (id) => (brands[id] = brands[id] || { id, kind: 'location', names: [], phones: [], coords: [], colours: [], hosts: [], provenance: [] });
  // 1. the identity seed — parsed statically (it requires firebase-admin / dotenv at load)
  const seedRel = 'xpizza-functions/seed_identity.js';
  const seedAst = acorn.parse(read(seedRel), { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
  for (const st of seedAst.body) {
    if (st.type !== 'VariableDeclaration') continue;
    for (const d of st.declarations) {
      if (!(d.id.name === 'IDENTITIES' && d.init && d.init.type === 'ObjectExpression')) continue;
      for (const p of d.init.properties) {
        const id = p.key.name || p.key.value;
        const b = brand(id);
        const val = {};
        for (const q of p.value.properties) {
          const k = q.key.name || q.key.value;
          const v = q.value.type === 'Literal' ? q.value.value : (q.value.type === 'UnaryExpression' && q.value.operator === '-' && q.value.argument.type === 'Literal' ? -q.value.argument.value : undefined);
          if (v !== undefined) val[k] = v;
        }
        if (val.name) b.names.push(val.name);
        if (val.phone) b.phones.push(val.phone);
        if (typeof val.hub_lat === 'number') b.coords.push({ lat: val.hub_lat, lng: val.hub_lng });
        b.provenance.push(`${seedRel} IDENTITIES.${id}`);
      }
    }
  }
  prov.push(seedRel);
  // 2. the deployment manifest — contexts, origins, Netlify sites
  const sitesRel = 'platform/sites.json';
  const sites = JSON.parse(read(sitesRel));
  for (const d of sites.deployments || []) {
    if (!d.context || d.context === 'platform') continue;
    const b = brand(d.context);
    for (const o of d.origins || []) { try { b.hosts.push(new URL(o).hostname); } catch (_) {} }
    if (d.netlify_site) b.hosts.push(`${d.netlify_site}.netlify.app`);
    b.provenance.push(`${sitesRel} ${d.id}`);
  }
  prov.push(sitesRel);
  // 3. theme authorities — the per-brand form palettes (brand-distinct accents only) and the brand tokens
  const palette = (rel, id, vars) => {
    const src = read(rel);
    for (const v of vars) { const m = new RegExp(`--${v}\\s*:\\s*(#[0-9a-fA-F]{3,8})`).exec(src); if (m) brand(id).colours.push(normColour(m[1])); }
    brand(id).provenance.push(`${rel} :root --${vars.join('/--')}`);
    prov.push(rel);
  };
  palette('xpizza-orders/index.html', 'x_pizza', ['gold', 'gold-dk', 'red']);
  palette('la-musa-orders/index.html', 'la_musa', ['gold', 'gold-dk', 'red']);
  const disp = read('xpizza-dispatch/index.html');
  for (const [v, id] of [['brand-x', 'x_pizza'], ['brand-lamusa', 'la_musa']]) for (const m of disp.matchAll(new RegExp(`--${v}\\s*:\\s*(#[0-9a-fA-F]{3,8})`, 'g'))) brand(id).colours.push(normColour(m[1]));
  prov.push('xpizza-dispatch/index.html');
  // 4. historical / display aliases — kept so an authority edit never silently stops detecting old literals
  const HIST = { x_pizza: ['X. Pizza', 'X Pizza', 'XPizza', 'xpizza'], la_musa: ['La Musa', 'LaMusa', 'lamusa'] };
  for (const [id, al] of Object.entries(HIST)) { brand(id).names.push(...al); brand(id).provenance.push('historical aliases (reviewed list in tools/brand-census.js)'); }
  for (const b of Object.values(brands)) for (const k of ['names', 'phones', 'colours', 'hosts', 'provenance']) b[k] = [...new Set(b[k].filter(Boolean))].sort();
  // 5. PLATFORM INFRA named after a brand (Firebase project, emulator project, repo folders, the SDK file name) —
  //    one platform-level naming item, NOT lane debt; matched first and stripped before brand matching
  const infra = new Set();
  const rc = JSON.parse(read('xpizza-functions/.firebaserc'));
  for (const id of Object.values(rc.projects || {})) { infra.add(id); infra.add(`${id}-default-rtdb`); infra.add(`us-central1-${id}`); }
  prov.push('xpizza-functions/.firebaserc');
  infra.add('demo-xpizza');   // the emulator project id used by every emulator script (package.json)
  for (const dir of execFileSync('git', ['ls-tree', '-d', '--name-only', at], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)) if (/pizza|musa/i.test(dir)) infra.add(dir);
  infra.add('xpizza-delivery.js');
  const market = [
    { token: 'America/Tegucigalpa', what: 'Honduras timezone' }, { token: 'es-HN', what: 'Honduras locale' },
    { token: 'HNL', what: 'lempira currency code' }, { token: '+504', what: 'Honduras phone prefix' },
  ];
  const vocab = { _doc: 'Generated by tools/brand-census.js --build-vocab from the authorities listed in `sources`; never hand-edit. Phase A, report only.', version: 1, built_at_commit: at, scanner: SCANNER_VERSION, sources: [...new Set(prov)].sort(), brands: Object.values(brands).sort((a, b) => a.id.localeCompare(b.id)), infra: [...infra].sort((a, b) => b.length - a.length || a.localeCompare(b)), market };
  return vocab;
}

/* ── COLLECTORS: every source becomes a list of OCCURRENCES ─────────────────────────────────────── */
// occurrence = { file, line, col, scope, kind: 'string'|'key'|'member'|'ident'|'number'|'text'|'attr'|'css'|'json-key'|'json-value',
//                value, ctx, pairId?, fold? }
const STRUCT_NAME = /^(DEFAULT_)?(RESTAURANT|RESTAURANT_ID|RID|BRAND|BRAND_ID|HUB|LOCATION)(_[A-Z0-9]+)*$|_(HUB|RESTAURANT|RID)$|^(X_?PIZZA|LA_?MUSA)_/i;

function parseJs(src) {
  const base = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true };
  try { return acorn.parse(src, { ...base, sourceType: 'module' }); } catch (e1) {
    try { return acorn.parse(src, { ...base, sourceType: 'script' }); } catch (e2) { const err = new Error(e2.message); err.loc = e2.loc; throw err; }
  }
}

function collectJs(src, file, scopePrefix = '', lineOffset = 0, colOffset = 0) {
  const ast = parseJs(src);
  const out = [];
  // same-file const aliases: name → folded value, only when the name is declared exactly once (any kind)
  const declCount = {};
  const constInit = {};
  (function scan(n) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') { declCount[n.id.name] = (declCount[n.id.name] || 0) + 1; if (n.init) constInit[n.id.name] = { node: n.init, kind: n.__kind }; }
    if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) declCount[n.id.name] = (declCount[n.id.name] || 0) + 1;
    if (/Function/.test(n.type)) for (const p of n.params || []) if (p.type === 'Identifier') declCount[p.name] = (declCount[p.name] || 0) + 1;
    if (n.type === 'VariableDeclaration') for (const d of n.declarations) d.__kind = n.kind;
    for (const k of Object.keys(n)) { if (k === '__kind') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(scan); else if (v && typeof v.type === 'string') scan(v); }
  })(ast);
  const unresolved = new Set();
  const fold = (n, depth = 0) => {
    if (!n || depth > 8) return null;
    if (n.type === 'Literal' && typeof n.value === 'string') return { v: n.value };
    if (n.type === 'TemplateLiteral') {
      let s = '';
      for (let i = 0; i < n.quasis.length; i++) { s += n.quasis[i].value.cooked; if (i < n.expressions.length) { const f = fold(n.expressions[i], depth + 1); if (!f) return null; s += f.v; } }
      return { v: s };
    }
    if (n.type === 'BinaryExpression' && n.operator === '+') { const a = fold(n.left, depth + 1); const b = fold(n.right, depth + 1); return a && b ? { v: a.v + b.v, alias: a.alias || b.alias } : null; }
    if (n.type === 'Identifier' && constInit[n.name] && constInit[n.name].kind === 'const') {
      if (declCount[n.name] !== 1) { unresolved.add(n.name); return null; }
      const f = fold(constInit[n.name].node, depth + 1);
      return f ? { v: f.v, alias: n.name } : null;
    }
    return null;
  };
  const num = (n) => (n && n.type === 'Literal' && typeof n.value === 'number' ? n.value : (n && n.type === 'UnaryExpression' && n.operator === '-' && n.argument.type === 'Literal' && typeof n.argument.value === 'number' ? -n.argument.value : null));
  const at = (n) => ({ line: n.loc.start.line + lineOffset, col: (n.loc.start.line === 1 ? colOffset : 0) + n.loc.start.column + 1 });
  let pairSeq = 0;
  const walk = (n, scope, parent, pkey, pairId) => {
    if (!n || typeof n.type !== 'string') return;
    let sc = scope;
    if (/Function/.test(n.type)) {
      let name = n.id && n.id.name;
      if (!name && parent) {
        if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') name = parent.id.name;
        else if ((parent.type === 'Property' || parent.type === 'MethodDefinition') && parent.key) name = parent.key.name || parent.key.value;
        else if (parent.type === 'AssignmentExpression' && parent.left.type === 'MemberExpression' && !parent.left.computed) name = parent.left.property.name;
      }
      sc = scope ? `${scope}>${name || 'anon'}` : (name || 'anon');
    }
    // numbers: carry a pair id for the container (object / array / call arguments)
    let myPair = pairId;
    if (n.type === 'ObjectExpression' || n.type === 'ArrayExpression' || n.type === 'CallExpression' || n.type === 'NewExpression') myPair = `${file}#${++pairSeq}`;
    const v = num(n);
    if (v !== null && !(parent && parent.type === 'UnaryExpression')) { out.push({ file, ...at(n), scope: scopePrefix + (sc || '<top>'), kind: 'number', value: v, pairId: myPair, ctx: ctxOf(n, parent, pkey) }); }
    // strings at the MAXIMAL foldable expression only
    const parentFolds = parent && ((parent.type === 'BinaryExpression' && parent.operator === '+') || parent.type === 'TemplateLiteral') && fold(parent);
    const isStrNode = n.type === 'Literal' || n.type === 'TemplateLiteral' || (n.type === 'BinaryExpression' && n.operator === '+') || (n.type === 'Identifier' && pkey !== 'key' && pkey !== 'property' && !(parent && parent.type === 'VariableDeclarator' && pkey === 'id'));
    if (isStrNode && !parentFolds) {
      const f = fold(n);
      if (f && !(parent && parent.type === 'Property' && pkey === 'key')) out.push({ file, ...at(n), scope: scopePrefix + (sc || '<top>'), kind: 'string', value: f.v, alias: f.alias || null, ctx: ctxOf(n, parent, pkey) });
    }
    if ((n.type === 'Property' || n.type === 'MethodDefinition' || n.type === 'PropertyDefinition') && n.key) {
      const kv = n.computed ? (fold(n.key) || {}).v : (n.key.name !== undefined ? n.key.name : n.key.value);
      if (typeof kv === 'string') out.push({ file, ...at(n.key), scope: scopePrefix + (sc || '<top>'), kind: 'key', value: kv, ctx: 'object-key', pairId: myPair });
    }
    if (n.type === 'MemberExpression') {
      const mv = n.computed ? (fold(n.property) || {}).v : n.property.name;
      if (typeof mv === 'string') out.push({ file, ...at(n.property), scope: scopePrefix + (sc || '<top>'), kind: 'member', value: mv, ctx: 'member-access' });
    }
    if (n.type === 'Identifier' && (pkey !== 'property' || (parent && parent.computed))) {
      if (!(parent && parent.type === 'Property' && pkey === 'key' && !parent.computed)) out.push({ file, ...at(n), scope: scopePrefix + (sc || '<top>'), kind: 'ident', value: n.name, ctx: ctxOf(n, parent, pkey), decl: parent && parent.type === 'VariableDeclarator' && pkey === 'id' ? { init: parent.init, kind: parent.__kind } : null });
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === '__kind' || k === 'start' || k === 'end') continue;
      const c = n[k];
      if (Array.isArray(c)) c.forEach((x) => walk(x, sc, n, k, (n.type === 'CallExpression' || n.type === 'NewExpression') && k === 'arguments' ? myPair : (n.type === 'ObjectExpression' || n.type === 'ArrayExpression' ? myPair : (x && (x.type === 'Property') ? myPair : undefined))));
      else if (c && typeof c.type === 'string') walk(c, sc, n, k, n.type === 'Property' ? pairId : undefined);
    }
  };
  walk(ast, '', null, null, undefined);
  // structural: declarations + fallbacks whose value folds/points to a brand value are decided in classify()
  for (const o of out) if (o.kind === 'ident' && o.decl) { const init = o.decl.init; o.declInit = init ? (fold(init) || { type: init.type }) : null; if (init) o.declRange = [init.loc.start.line + lineOffset, init.loc.end.line + lineOffset]; }
  // unresolved: a multiply-declared name with at least one const init that folds to a string (filtered against the vocabulary by scan())
  const unresolvedOut = [];
  for (const name of unresolved) { const vals = []; (function find(n) { if (!n || typeof n.type !== 'string') return; if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === name && n.init) { const f = fold(n.init); if (f) vals.push(f.v); } for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(find); else if (v && typeof v.type === 'string') find(v); } })(ast); if (vals.length) unresolvedOut.push({ file, name, values: vals }); }
  return { occ: out, unresolved: unresolvedOut };
}

/* the syntactic role of a node — the classification heuristic's only input from JS */
function ctxOf(n, parent, pkey) {
  if (!parent) return 'top';
  if (parent.type === 'BinaryExpression' && /^(===|!==|==|!=)$/.test(parent.operator)) return 'compare';
  if (parent.type === 'SwitchCase' && pkey === 'test') return 'switch-case';
  if (parent.type === 'LogicalExpression' && /^(\|\||\?\?)$/.test(parent.operator) && pkey === 'right') return 'fallback';
  if (parent.type === 'AssignmentPattern' && pkey === 'right') return 'default-param';
  if (parent.type === 'ConditionalExpression' && pkey !== 'test') return 'ternary-branch';
  if (parent.type === 'CallExpression' && pkey === 'arguments' && parent.callee.type === 'MemberExpression' && /^(includes|indexOf|startsWith|endsWith|has|get|test|match)$/.test(parent.callee.property.name || '')) return 'lookup-call';
  if (parent.type === 'CallExpression' && pkey === 'arguments' && parent.callee.type === 'MemberExpression' && /^(ref|child|doc|collection)$/.test(parent.callee.property.name || '')) return 'db-path';
  if (parent.type === 'AssignmentExpression' && parent.left.type === 'MemberExpression' && /^(textContent|innerHTML|innerText|title|placeholder|alt)$/.test(parent.left.property.name || '')) return 'dom-text';
  if (parent.type === 'VariableDeclarator' && pkey === 'init') return 'const-init';
  if (parent.type === 'Property' && pkey === 'value') return 'object-value';
  if (parent.type === 'ArrayExpression') return 'array-item';
  if (parent.type === 'TemplateLiteral') return 'template';
  return parent.type;
}

/* HTML via parse5: text, attributes, inline on* handlers, <script>, <style>, JSON blocks */
function collectHtml(src, file) {
  const parse5 = require('parse5');
  const doc = parse5.parse(src, { sourceCodeLocationInfo: true });
  const occ = [];
  const unresolved = [];
  const errors = [];
  let scriptN = 0;
  const lineOf = (offset) => src.slice(0, offset).split('\n').length;
  const visit = (node, inTemplate) => {
    const loc = node.sourceCodeLocation;
    if (node.nodeName === '#text' && loc) {
      const parentTag = node.parentNode && node.parentNode.tagName;
      if (parentTag !== 'script' && parentTag !== 'style' && node.value.trim()) occ.push({ file, line: loc.startLine, col: loc.startCol, scope: '<html>', kind: 'text', value: node.value, ctx: 'html-text' });
    }
    if (node.tagName === 'script' && node.childNodes && node.childNodes[0] && node.childNodes[0].sourceCodeLocation) {
      const type = ((node.attrs || []).find((a) => a.name === 'type') || {}).value || '';
      const t = node.childNodes[0];
      const tl = t.sourceCodeLocation;
      const label = `<script@${scriptN++}>`;
      if (/json/i.test(type)) {
        try { occ.push(...collectJsonValue(JSON.parse(t.value), file, `${label}`, tl.startLine)); } catch (e) { errors.push({ file, where: label, error: `JSON: ${e.message}` }); }
      } else if (!type || /^(module|text\/javascript|application\/javascript)$/i.test(type)) {
        try { const r = collectJs(t.value, file, `${label}#`, tl.startLine - 1, tl.startCol - 1); occ.push(...r.occ); unresolved.push(...r.unresolved); } catch (e) { errors.push({ file, where: `${label} line ${(e.loc && e.loc.line || 0) + tl.startLine - 1}`, error: e.message }); }
      } else if (t.value.trim()) occ.push({ file, line: tl.startLine, col: tl.startCol, scope: label, kind: 'text', value: t.value, ctx: `script-type:${type}` });
    }
    if (node.tagName === 'style' && node.childNodes && node.childNodes[0] && node.childNodes[0].sourceCodeLocation) {
      occ.push(...collectCss(node.childNodes[0].value, file, '<style>', node.childNodes[0].sourceCodeLocation.startLine - 1));
    }
    for (const a of node.attrs || []) {
      const al = loc && loc.attrs && loc.attrs[a.name];
      const line = al ? al.startLine : (loc ? loc.startLine : 0);
      if (/^on/i.test(a.name)) {
        try { const r = collectJs(a.value, file, `<attr:${a.name}>#`, line - 1, 0); occ.push(...r.occ); unresolved.push(...r.unresolved); } catch (e) { errors.push({ file, where: `<attr:${a.name}> line ${line}`, error: e.message }); }
      } else if (a.name === 'style') occ.push(...collectCss(a.value, file, `<attr:style>`, line - 1));
      else occ.push({ file, line, col: al ? al.startCol : 0, scope: `<attr:${a.name}>`, kind: 'attr', value: a.value, ctx: `html-attr:${a.name}` });
    }
    for (const c of node.childNodes || []) visit(c, inTemplate);
    if (node.content) visit(node.content, true);   // <template>
  };
  visit(doc, false);
  return { occ, unresolved, errors };
}

/* CSS: comments stripped; strings, colours, url()s and selector/ident tokens */
function collectCss(src, file, scope, lineOffset = 0) {
  const occ = [];
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lines = clean.split('\n');
  lines.forEach((l, i) => {
    const line = i + 1 + lineOffset;
    for (const m of l.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) occ.push({ file, line, col: m.index + 1, scope, kind: 'css', value: m[0], ctx: 'css-colour' });
    for (const m of l.matchAll(/(["'])(.*?)\1/g)) occ.push({ file, line, col: m.index + 1, scope, kind: 'css', value: m[2], ctx: 'css-string' });
    for (const m of l.matchAll(/[.#]?-?[A-Za-z_][\w-]*/g)) if (!/^#[0-9a-fA-F]{3,8}$/.test(m[0])) occ.push({ file, line, col: m.index + 1, scope, kind: 'css', value: m[0], ctx: 'css-ident' });
  });
  return occ;
}

function collectJsonValue(v, file, scope, line, out = [], pairId = null, seq = { n: 0 }) {
  if (Array.isArray(v)) { const id = `${file}#j${++seq.n}`; v.forEach((x) => collectJsonValue(x, file, scope, line, out, id, seq)); }
  else if (v && typeof v === 'object') {
    const id = `${file}#j${++seq.n}`;
    for (const [k, x] of Object.entries(v)) { out.push({ file, line, col: 0, scope, kind: 'json-key', value: k, ctx: 'json-key', pairId: id }); collectJsonValue(x, file, scope, line, out, id, seq); }
  } else if (typeof v === 'string') out.push({ file, line, col: 0, scope, kind: 'json-value', value: v, ctx: 'json-value', pairId });
  else if (typeof v === 'number') out.push({ file, line, col: 0, scope, kind: 'number', value: v, ctx: 'json-value', pairId });
  return out;
}

function collectJson(src, file) {
  // line numbers: locate each string key/value's first occurrence after the previous one (good enough for a report)
  const v = JSON.parse(src);
  const occ = collectJsonValue(v, file, '<json>', 0);
  const lines = src.split('\n');
  let cursor = 0;
  for (const o of occ) {
    const needle = o.kind === 'number' ? String(o.value) : JSON.stringify(String(o.value)).slice(1, -1);
    for (let i = cursor; i < lines.length; i++) if (lines[i].includes(needle)) { o.line = i + 1; cursor = i; break; }
  }
  return { occ, unresolved: [], errors: [] };
}

function collectText(src, file) {
  const occ = [];
  src.split('\n').forEach((l, i) => {
    const code = l.replace(/^\s*#.*$/, '');
    for (const m of code.matchAll(/(["'])(.*?)\1|[^\s"'=]+/g)) occ.push({ file, line: i + 1, col: m.index + 1, scope: '<config>', kind: 'text', value: m[2] !== undefined ? m[2] : m[0], ctx: 'config' });
  });
  return { occ, unresolved: [], errors: [] };
}

const COLLECTOR = [
  { re: /\.(m|c)?js$/, name: 'js', fn: (src, file) => collectJs(src, file) },
  { re: /\.html?$/, name: 'html', fn: collectHtml },
  { re: /\.css$/, name: 'css', fn: (src, file) => ({ occ: collectCss(src, file, '<css>'), unresolved: [], errors: [] }) },
  { re: /\.(json|webmanifest)$/, name: 'json', fn: collectJson },
  { re: /(^|\/)(netlify\.toml|_redirects|_headers)$/, name: 'config', fn: collectText },
];

/* ── MATCHING ───────────────────────────────────────────────────────────────────────────────────── */
function matcher(vocab) {
  const ids = vocab.brands.map((b) => b.id);
  const idNorm = new Map(ids.map((id) => [norm(id), id]));
  const aliases = [];
  for (const b of vocab.brands) for (const n of b.names) if (norm(n).length >= 5) aliases.push({ id: b.id, n: norm(n), raw: n });
  const phones = [];
  for (const b of vocab.brands) for (const p of b.phones) { const d = digits(p); phones.push({ id: b.id, d: d.length > 8 ? d.slice(-8) : d }); }
  const colours = new Map();
  for (const b of vocab.brands) for (const c of b.colours) colours.set(c, b.id);
  const hosts = [];
  for (const b of vocab.brands) for (const h of b.hosts) hosts.push({ id: b.id, h: h.toLowerCase() });
  const coords = [];
  for (const b of vocab.brands) for (const c of b.coords) coords.push({ id: b.id, ...c });
  const infra = (vocab.infra || []).slice();
  const idRe = new RegExp(`(^|[^a-z0-9])(${ids.map((i) => i.replace(/[^a-z0-9_]/gi, '')).join('|')})(?=$|[^a-z0-9])`, 'i');

  return function match(o) {
    const hits = [];
    const v = o.value;
    if (o.kind === 'number') return hits;   // handled pairwise
    const s = String(v);
    if (o.kind === 'key' || o.kind === 'member' || o.kind === 'json-key') {
      if (ids.includes(s)) hits.push({ brand: s, kind: 'rid', match: 'exact', strength: 'strong' });
      else if (idNorm.has(norm(s))) hits.push({ brand: idNorm.get(norm(s)), kind: 'rid', match: 'ident', strength: 'strong' });
      else { const m = idRe.exec(s); if (m) hits.push({ brand: m[2].toLowerCase(), kind: 'rid', match: 'embedded', strength: 'medium' }); }
      return hits;
    }
    if (o.kind === 'ident') {
      const n = norm(s);
      for (const id of ids) if (n.includes(norm(id)) && n !== norm(id)) { hits.push({ brand: id, kind: 'rid', match: 'ident', strength: 'medium' }); break; }
      return hits;
    }
    // strings / text / attrs / css / json values — platform infra names first, then stripped
    let s2 = s;
    for (const inf of infra) if (s2.includes(inf)) { hits.push({ brand: '-', kind: 'infra', match: 'infra', strength: 'weak', infra: inf }); s2 = s2.split(inf).join(' '); }
    if (s2 !== s) return hits.concat(match({ ...o, value: s2, __stripped: true }).filter((h) => h.kind !== 'infra'));
    if (ids.includes(s)) hits.push({ brand: s, kind: 'rid', match: 'exact', strength: 'strong' });
    else {
      const m = idRe.exec(s);
      if (m) {
        const urlish = /[/?=&]|https?:|\.app\b|\.com\b|\.hn\b/.test(s);
        hits.push({ brand: m[2].toLowerCase(), kind: 'rid', match: urlish ? 'url' : 'embedded', strength: urlish ? 'strong' : 'medium' });
      }
    }
    const low = s.toLowerCase();
    for (const h of hosts) if (low.includes(h.h)) { hits.push({ brand: h.id, kind: 'host', match: 'url', strength: 'strong' }); break; }
    if (o.ctx !== 'css-colour') {
      const ns = norm(s);
      if (ns.length >= 5 && ns.length <= 400) for (const a of aliases) if (ns.includes(a.n)) { if (!hits.some((x) => x.brand === a.id && x.kind === 'rid')) hits.push({ brand: a.id, kind: 'name', match: 'alias', strength: 'weak', alias: a.raw }); break; }
      const ds = digits(s);
      if (ds.length >= 8) for (const p of phones) if (ds.includes(p.d)) { hits.push({ brand: p.id, kind: 'phone', match: 'phone', strength: 'weak' }); break; }
    }
    for (const c of s.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) || []) { const nc = normColour(c); if (nc && colours.has(nc)) { hits.push({ brand: colours.get(nc), kind: 'colour', match: 'colour', strength: 'weak', colour: nc }); break; } }
    return hits;
  };
}

function coordHits(occ, vocab) {
  const coords = [];
  for (const b of vocab.brands) for (const c of b.coords) coords.push({ id: b.id, ...c });
  const near = (x, y) => Math.abs(x - y) <= COORD_TOL;
  const nums = occ.filter((o) => o.kind === 'number' && Math.abs(o.value) > 1 && String(o.value).includes('.'));
  const byPair = new Map();
  for (const o of nums) if (o.pairId) (byPair.get(o.pairId) || byPair.set(o.pairId, []).get(o.pairId)).push(o);
  const out = [];
  const used = new Set();
  for (const c of coords) {
    for (const [, group] of byPair) {
      const la = group.find((o) => near(o.value, c.lat));
      const ln = group.find((o) => near(o.value, c.lng));
      if (la && ln) { out.push({ o: la, hit: { brand: c.id, kind: 'coord', match: 'coord-pair', strength: 'strong', pair: [la.value, ln.value] } }); used.add(la); used.add(ln); }
    }
  }
  for (const sn of SENTINELS) {
    for (const [, group] of byPair) {
      const la = group.find((o) => near(o.value, sn.lat));
      const ln = group.find((o) => near(o.value, sn.lng));
      if (la && ln && !used.has(la)) { out.push({ o: la, hit: { brand: '-', kind: 'sentinel', match: 'coord-pair', strength: 'strong', sentinel: sn } }); used.add(la); used.add(ln); }
    }
  }
  for (const o of nums) if (!used.has(o)) for (const c of coords) if (near(o.value, c.lat) || near(o.value, c.lng)) { out.push({ o, hit: { brand: c.id, kind: 'coord', match: 'coord-lone', strength: 'weak' } }); break; }
  return out;
}

const MARKET_RE = [
  { re: /America\/Tegucigalpa/, what: 'Honduras timezone' }, { re: /\bes-HN\b/, what: 'Honduras locale' },
  { re: /\bHNL\b/, what: 'lempira currency code' }, { re: /\+504\b|\b504(?=\d{8}\b)/, what: 'Honduras phone prefix' },
  { re: /(^|[^A-Za-z])L\s?(\$\{|\d)|^L\s$/, what: 'lempira «L» money format' },
];

/* ── CLASSIFICATION (heuristic, report-only) ────────────────────────────────────────────────────── */
function classify(row) {
  const f = row.file;
  if (row.kind === 'sentinel') return ['SENTINEL', row.sentinelWhy || 'platform sentinel'];
  if (row.kind === 'infra') return ['INFRA', `platform infrastructure named after a brand (${row.infra}) — one platform-level rename item`];
  for (const a of AUTHORITY) if (f === a.file && (a.symbol === '*' || row.scope.includes(a.symbol) || row.near === a.symbol)) return ['AUTHORITY', a.why];
  if (SEED_PATHS.some((re) => re.test(f))) return ['SEED', 'seed / bootstrap source'];
  if (OPS_PATHS.some((re) => re.test(f))) return ['OPS', 'operator CLI / deploy tooling (report-only)'];
  if (row.structural) return ['STRUCTURAL', row.structural];
  const c = row.ctx || '';
  if (/^(compare|switch-case|lookup-call)$/.test(c)) return ['BEHAVIOUR', `a ${c} decides on it`];
  if (/^(fallback|default-param)$/.test(c) && row.kind === 'rid') return ['STRUCTURAL', `a fixed ${c}`];
  if (c === 'db-path' || row.match === 'url') return ['BEHAVIOUR', 'routes / addresses data by it'];
  if (c === 'object-key' && row.kind === 'rid') return ['BEHAVIOUR', 'a per-brand lookup table key'];
  if (c === 'member-access' && row.kind === 'rid') return ['BEHAVIOUR', 'selects a per-brand entry'];
  if (row.kind === 'coord' && row.match === 'coord-pair') return ['BEHAVIOUR', 'a fixed brand location'];
  if (/^(html-text|html-attr|css-|dom-text|config$)/.test(c) || /^css-/.test(c) || c.startsWith('html-attr')) return ['DISPLAY', `shown or styled (${c})`];
  if (row.kind === 'colour') return ['DISPLAY', 'a brand colour'];
  if (row.kind === 'name' && /\s/.test(String(row.value))) return ['DISPLAY', 'brand name in copy'];
  if (c === 'json-key' || c === 'json-value') return ['UNCLASSIFIED', 'config data — lane to confirm'];
  return ['UNCLASSIFIED', `role ${c || '?'} — lane to confirm`];
}

const ROOT_BY_KIND = { coord: 'hub-coords', colour: 'brand-colour', name: 'brand-name', phone: 'brand-phone', host: 'brand-url' };
function rootOf(row) {
  if (row.class === 'STRUCTURAL') return 'fixed-selection';
  if (ROOT_BY_KIND[row.kind]) return ROOT_BY_KIND[row.kind];
  if (row.match === 'url') return 'brand-url';
  if (row.ctx === 'object-key' || row.ctx === 'member-access') return 'rid-table';
  if (/^(compare|switch-case|lookup-call)$/.test(row.ctx)) return 'rid-branch';
  if (/^css|html/.test(row.ctx)) return 'brand-style';
  return 'rid-literal';
}

/* ── THE SCAN ───────────────────────────────────────────────────────────────────────────────────── */
function rootsOf(root = ROOT) {
  const sites = JSON.parse(fs.readFileSync(path.join(root, 'platform/sites.json'), 'utf8'));
  const roots = new Map();
  for (const d of sites.deployments || []) if (!roots.has(d.folder)) roots.set(d.folder, { folder: d.folder, why: `platform/sites.json: ${(sites.deployments.filter((x) => x.folder === d.folder).map((x) => x.id)).join(', ')}`, entrypoints: d.entrypoints || [] });
  for (const e of EXTRA_ROOTS) if (!roots.has(e.folder)) roots.set(e.folder, e);
  return [...roots.values()].sort((a, b) => a.folder.localeCompare(b.folder));
}

function scan({ root = ROOT, vocab, files } = {}) {
  vocab = vocab || JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8'));
  const roots = rootsOf(root);
  const all = files || execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);
  const inRoot = all.filter((f) => roots.some((r) => f === r.folder || f.startsWith(`${r.folder}/`)));
  const excluded = {};
  const unsupported = [];
  const errors = [];
  const unresolved = [];
  const scanned = [];
  const match = matcher(vocab);
  const rows = [];
  const market = [];
  for (const f of inRoot.sort()) {
    const ex = EXCLUDE.find((e) => e.re.test(f));
    if (ex) { (excluded[ex.rule] = excluded[ex.rule] || []).push(f); continue; }
    const col = COLLECTOR.find((c) => c.re.test(f));
    if (!col) { unsupported.push(f); continue; }
    let src;
    try { src = fs.readFileSync(path.join(root, f), 'utf8'); } catch (e) { errors.push({ file: f, where: 'read', error: e.message }); continue; }
    let r;
    try { r = col.fn(src, f); } catch (e) { errors.push({ file: f, where: col.name, error: e.message }); continue; }
    scanned.push({ file: f, collector: col.name });
    errors.push(...(r.errors || []));
    for (const u of r.unresolved || []) { const hit = u.values.some((v) => match({ kind: 'string', value: v, ctx: 'const-init' }).some((h) => h.kind === 'rid' || h.kind === 'host')); if (hit) unresolved.push({ file: u.file, name: u.name, values: u.values.slice(0, 3) }); }
    // structural declarations in this file: a const whose name says "the restaurant" or whose value is a brand value
    const coordSet = new Map();
    for (const { o, hit } of coordHits(r.occ, vocab)) coordSet.set(o, hit);
    // STRUCTURAL = a const whose VALUE is a fixed brand selection: it folds to a brand id, or its initializer
    // holds a brand coordinate PAIR. Value-based (codex P1): a per-restaurant table or a host-derived id is not.
    const structNames = new Set();
    const pairHits = [...coordSet.entries()].filter(([, h]) => h.kind === 'coord' && h.match === 'coord-pair').map(([o, h]) => ({ line: o.line, brand: h.brand }));
    for (const o of r.occ) {
      if (o.kind !== 'ident' || !o.decl || o.decl.kind !== 'const' || !o.declInit) continue;
      const init = o.declInit;
      const brandVal = typeof init.v === 'string' && match({ kind: 'string', value: init.v, ctx: 'const-init' }).some((h) => h.kind === 'rid' && h.match === 'exact');
      // ONE brand's coordinate pair = a fixed location selection; a table of several brands' hubs is location DATA
      // embedded in code (reported under the hub-coords root as BEHAVIOUR), not a selection
      const inRange = o.declRange && init.type === 'ObjectExpression' ? pairHits.filter((h) => h.line >= o.declRange[0] && h.line <= o.declRange[1]) : [];
      const brandKeys = o.declRange ? new Set(r.occ.filter((k) => k.kind === 'key' && k.line >= o.declRange[0] && k.line <= o.declRange[1]).flatMap((k) => match(k).filter((h) => h.kind === 'rid' && h.match === 'exact').map((h) => h.brand))) : new Set();
      const brandCoords = inRange.length === 1 && brandKeys.size < 2;   // ≥2 brand keys = a per-brand TABLE
      if (brandVal || brandCoords) structNames.add(o.value);
    }
    for (const o of r.occ) {
      let hits = o.kind === 'number' ? (coordSet.has(o) ? [coordSet.get(o)] : []) : match(o);
      if (o.kind === 'ident' && structNames.has(o.value) && !(o.decl)) hits = hits.concat([{ brand: '*', kind: 'structural-use', match: 'ident', strength: 'medium' }]);
      if (o.kind === 'ident' && o.decl && structNames.has(o.value)) hits = hits.concat([{ brand: '*', kind: 'structural-decl', match: 'ident', strength: 'strong' }]);
      for (const h of hits) {
        const row = { file: f, line: o.line, col: o.col, scope: o.scope, token: String(o.value).length > 80 ? String(o.value).slice(0, 77) + '…' : String(o.value), value: o.value, kind: h.kind, brand: h.brand, match: h.match, strength: h.strength, ctx: o.ctx, alias: o.alias || h.alias || null, lane: laneOf(f) };
        if (h.kind === 'infra') row.infra = h.infra;
        if (h.kind === 'sentinel') row.sentinelWhy = `${h.sentinel.name}: ${h.sentinel.why}`;
        if (h.kind === 'structural-decl') row.structural = `fixed selection: const ${o.value}`;
        if (h.kind === 'structural-use') row.structural = `use of fixed selection ${o.value}`;
        if (o.kind === 'string' && /^(fallback|default-param)$/.test(o.ctx) && h.kind === 'rid' && h.match === 'exact') row.structural = `fixed ${o.ctx} '${o.value}'`;
        [row.class, row.why] = classify(row);
        row.root = rootOf(row);
        rows.push(row);
      }
      if (o.kind !== 'number' && o.kind !== 'ident' && o.kind !== 'key' && o.kind !== 'member') {
        for (const m of MARKET_RE) if (m.re.test(String(o.value))) market.push({ file: f, line: o.line, what: m.what, lane: laneOf(f) });
      }
    }
  }
  // de-duplicate (same file, line, col, kind, brand)
  const seen = new Set();
  const uniq = rows.filter((r) => { const k = `${r.file}|${r.line}|${r.col}|${r.kind}|${r.brand}|${r.match}`; if (seen.has(k)) return false; seen.add(k); return true; });
  uniq.sort((a, b) => a.lane.localeCompare(b.lane) || a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col || a.kind.localeCompare(b.kind));
  return { vocab, roots, scanned, excluded, unsupported, errors, unresolved, rows: uniq, market };
}

/* ── FORK REPORT: per-brand app copies (report-only) ────────────────────────────────────────────── */
function forkReport(root = ROOT, a = 'xpizza-orders', b = 'la-musa-orders') {
  const ls = (d) => execFileSync('git', ['ls-files', d], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => f.slice(d.length + 1));
  const A = new Set(ls(a));
  const B = new Set(ls(b));
  const rows = [];
  for (const f of [...new Set([...A, ...B])].sort()) {
    if (A.has(f) && B.has(f)) {
      let add = 0, del = 0;
      try { const ns = execFileSync('git', ['diff', '--no-index', '--numstat', `${a}/${f}`, `${b}/${f}`], { cwd: root, encoding: 'utf8' }); } catch (e) { const m = /^(\d+|-)\s+(\d+|-)/m.exec(String(e.stdout || '')); if (m) { add = m[1] === '-' ? 0 : +m[1]; del = m[2] === '-' ? 0 : +m[2]; } }
      const lines = fs.readFileSync(path.join(root, a, f), 'utf8').split('\n').length;
      rows.push({ file: f, both: true, lines, differing: Math.max(add, del), identical: add === 0 && del === 0 });
    } else rows.push({ file: f, both: false, only: A.has(f) ? a : b });
  }
  return rows;
}

/* ── RECONCILIATION with a lane's own rows (e.g. the dispatch exec's BRAND-DEBT jsonl) ──────────── */
function reconcile(rows, laneRows) {
  const out = { agree: [], disagree: [], onlyLane: [] };
  for (const lr of laneRows) {
    const m = rows.find((r) => r.file === lr.file && Math.abs(r.line - lr.line) <= 3 && (String(r.value).includes(lr.token) || r.token === lr.token || r.brand === lr.token));
    if (!m) out.onlyLane.push(lr);
    else if ((m.class === lr.class) || (lr.class === 'DEAD')) out.agree.push({ lane: lr, census: m });
    else out.disagree.push({ lane: lr, census: m });
  }
  return out;
}

/* ── REPORT ─────────────────────────────────────────────────────────────────────────────────────── */
function report(res, { fork, recon, head } = {}) {
  const L = [];
  const p = (s = '') => L.push(s);
  const { rows } = res;
  const enforce = rows.filter((r) => !/^(AUTHORITY|SEED|OPS|SENTINEL|INFRA)$/.test(r.class));
  p('# BRAND-LITERAL CENSUS — Phase A (report only)');
  p('');
  p(`Generated by \`xpizza-functions/tools/brand-census.js\` (scanner ${SCANNER_VERSION}, vocabulary v${res.vocab.version} built at ${res.vocab.built_at_commit}) on ${head || 'HEAD'}. Deterministic ordering. Classification is a heuristic first pass — each lane confirms its rows; UNCLASSIFIED rows need a lane decision. Weak evidence (names, phones, colours, lone coordinates) is listed but is not by itself coupling.`);
  p('');
  p('## Summary per lane × class (excluding AUTHORITY / SEED / OPS, which are listed separately)');
  const classes = ['BEHAVIOUR', 'STRUCTURAL', 'DISPLAY', 'UNCLASSIFIED'];
  const lanes = [...new Set(rows.map((r) => r.lane))].sort();
  p('');
  p(`| lane | ${classes.join(' | ')} | strong | weak | total |`);
  p(`|---|${classes.map(() => '---:').join('|')}|---:|---:|---:|`);
  const tot = { strong: 0, weak: 0, all: 0 };
  const ctot = Object.fromEntries(classes.map((c) => [c, 0]));
  for (const l of lanes) {
    const lr = enforce.filter((r) => r.lane === l);
    if (!lr.length) continue;
    const cs = classes.map((c) => lr.filter((r) => r.class === c).length);
    classes.forEach((c, i) => (ctot[c] += cs[i]));
    const st = lr.filter((r) => r.strength !== 'weak').length;
    tot.strong += st; tot.weak += lr.length - st; tot.all += lr.length;
    p(`| ${l} | ${cs.join(' | ')} | ${st} | ${lr.length - st} | ${lr.length} |`);
  }
  p(`| **total** | ${classes.map((c) => ctot[c]).join(' | ')} | ${tot.strong} | ${tot.weak} | ${tot.all} |`);
  p('');
  p('## Summary per root (shared cause) × class');
  p('');
  const rootsList = [...new Set(enforce.map((r) => r.root))].sort();
  p(`| root | ${classes.join(' | ')} | lanes |`);
  p(`|---|${classes.map(() => '---:').join('|')}|---|`);
  for (const r of rootsList) { const rr = enforce.filter((x) => x.root === r); p(`| ${r} | ${classes.map((c) => rr.filter((x) => x.class === c).length).join(' | ')} | ${[...new Set(rr.map((x) => x.lane))].sort().join(', ')} |`); }
  p('');
  p('## Exempt / report-only classes');
  for (const c of ['AUTHORITY', 'SEED', 'OPS', 'SENTINEL', 'INFRA']) { const cr = rows.filter((r) => r.class === c); p(`- **${c}**: ${cr.length} rows in ${new Set(cr.map((r) => r.file)).size} files${c === 'AUTHORITY' ? ` (${AUTHORITY.map((a) => `${a.file}#${a.symbol} — ${a.why}`).join('; ')})` : ''}`); }
  p(`- **MARKET** (report-only, never ratcheted): ${res.market.length} occurrences — ${Object.entries(res.market.reduce((m, x) => ((m[x.what] = (m[x.what] || 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  p('');
  p('## Coverage');
  p(`- Roots (${res.roots.length}): ${res.roots.map((r) => `\`${r.folder}\``).join(', ')} — from platform/sites.json + the runtimes it does not list.`);
  p(`- Scanned: ${res.scanned.length} files (${Object.entries(res.scanned.reduce((m, x) => ((m[x.collector] = (m[x.collector] || 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(', ')}).`);
  p(`- Excluded by rule: ${Object.entries(res.excluded).map(([k, v]) => `${k} ${v.length}`).join(', ')}.`);
  p(`- Unsupported (listed, not scanned): ${res.unsupported.length}${res.unsupported.length ? ' — ' + res.unsupported.map((f) => `\`${f}\``).join(', ') : ''}.`);
  p(`- Parse errors: ${res.errors.length}${res.errors.length ? '' : ' (none)'}`);
  for (const e of res.errors) p(`  - \`${e.file}\` ${e.where}: ${e.error}`);
  p(`- Unresolved aliases (a name declared more than once in a file where at least one const value is a brand value — review): ${res.unresolved.length}`);
  for (const u of [...new Map(res.unresolved.map((x) => [`${x.file}|${x.name}`, x])).values()]) p(`  - \`${u.file}\` \`${u.name}\` (values: ${u.values.map((v) => JSON.stringify(String(v).slice(0, 40))).join(', ')})`);
  p('');
  p('## Vocabulary');
  for (const b of res.vocab.brands) p(`- \`${b.id}\`: names ${b.names.map((n) => `“${n}”`).join(', ')}; phones ${b.phones.length}; hub coords ${b.coords.map((c) => `(${c.lat}, ${c.lng})`).join(' ')}; colours ${b.colours.join(' ')}; hosts ${b.hosts.join(', ')}`);
  p(`- Sources: ${res.vocab.sources.join(', ')}. Coordinate tolerance ±${COORD_TOL}° (≈11 m); a PAIR needs lat and lng in one object / array / argument list.`);
  if (res.drift && res.drift.length) { p(`- 🔴 VOCABULARY DRIFT vs the authorities at this commit (rebuild with --build-vocab and review): ${res.drift.join('; ')}`); }
  if (fork) {
    p('');
    p('## Per-brand fork: xpizza-orders ↔ la-musa-orders (report-only)');
    const both = fork.filter((x) => x.both);
    p(`- ${both.length} file pairs, ${both.filter((x) => x.identical).length} identical; ${both.reduce((a, x) => a + x.differing, 0)} differing lines in total; files only on one side: ${fork.filter((x) => !x.both).map((x) => `\`${x.only}/${x.file}\``).join(', ') || 'none'}.`);
    for (const x of both.filter((y) => !y.identical)) p(`  - \`${x.file}\`: ${x.differing} differing / ${x.lines} lines`);
  }
  if (recon) {
    p('');
    p('## Reconciliation with the dispatch exec rows (BRAND-DEBT-dispatch.jsonl)');
    p(`- agree ${recon.agree.length}, DISAGREE ${recon.disagree.length}, only in the lane file ${recon.onlyLane.length}.`);
    for (const d of recon.disagree) p(`  - \`${d.lane.file}:${d.lane.line}\` \`${d.lane.token}\`: lane says ${d.lane.class} (${d.lane.root}), census says ${d.census.class} (${d.census.why})`);
    for (const d of recon.onlyLane) p(`  - only in lane: \`${d.file}:${d.line}\` \`${d.token}\` ${d.class} (${d.root})${d.class === 'DEAD' ? ' — comments are not tokens here' : ''}`);
  }
  p('');
  p('## Rows (lane → file → line). Columns: line · class · kind/match/strength · brand · token · scope · why');
  let lane = null;
  let file = null;
  for (const r of enforce) {
    if (r.lane !== lane) { lane = r.lane; file = null; p(''); p(`### ${lane}`); }
    if (r.file !== file) { file = r.file; p(`- \`${file}\``); }
    p(`  - ${r.line} · **${r.class}** · ${r.kind}/${r.match}/${r.strength} · ${r.brand} · \`${String(r.token).replace(/`/g, "'").replace(/\n/g, ' ').slice(0, 60)}\` · ${r.scope} · ${r.why}`);
  }
  return L.join('\n') + '\n';
}

function vocabDrift(root = ROOT) {
  const committed = JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8'));
  const fresh = buildVocabulary(root, { at: committed.built_at_commit });
  const strip = (v) => JSON.stringify(v.brands);
  if (strip(committed) === strip(fresh)) return [];
  const out = [];
  for (const b of fresh.brands) { const c = committed.brands.find((x) => x.id === b.id); if (!c) out.push(`new brand ${b.id}`); else for (const k of ['names', 'phones', 'colours', 'hosts']) if (JSON.stringify(c[k]) !== JSON.stringify(b[k])) out.push(`${b.id}.${k}`); else if (k === 'names' && JSON.stringify(c.coords) !== JSON.stringify(b.coords)) out.push(`${b.id}.coords`); }
  for (const c of committed.brands) if (!fresh.brands.some((b) => b.id === c.id)) out.push(`brand ${c.id} no longer in the authorities (kept: historical)`);
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--build-vocab')) {
    const head = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const v = buildVocabulary(ROOT, { at: head });
    fs.writeFileSync(VOCAB_FILE, JSON.stringify(v, null, 1) + '\n');
    console.log(`brand-vocabulary.json: ${v.brands.length} brands from ${v.sources.length} sources (built at ${head})`);
    return;
  }
  const res = scan();
  res.drift = vocabDrift();
  const head = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const fork = forkReport();
  const wi = argv.indexOf('--write');
  const dir = wi >= 0 ? (argv[wi + 1] && !argv[wi + 1].startsWith('--') ? argv[wi + 1] : path.join(os.homedir(), 'Downloads', 'xpizza-D4c-grill')) : null;
  let recon = null;
  const laneFile = path.join(dir || path.join(os.homedir(), 'Downloads', 'xpizza-D4c-grill'), 'BRAND-DEBT-dispatch.jsonl');
  if (fs.existsSync(laneFile)) recon = reconcile(res.rows, fs.readFileSync(laneFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const md = report(res, { fork, recon, head });
  const enforce = res.rows.filter((r) => !/^(AUTHORITY|SEED|OPS|SENTINEL|INFRA)$/.test(r.class));
  console.log(`brand-census (${SCANNER_VERSION}, vocab v${res.vocab.version}): ${res.scanned.length} files scanned in ${res.roots.length} roots; ${res.rows.length} rows (${enforce.length} outside AUTHORITY/SEED/OPS: ${['BEHAVIOUR', 'STRUCTURAL', 'DISPLAY', 'UNCLASSIFIED'].map((c) => `${c} ${enforce.filter((r) => r.class === c).length}`).join(', ')}); ${res.unsupported.length} unsupported, ${res.errors.length} parse errors, ${res.unresolved.length} unresolved; MARKET ${res.market.length}${res.drift.length ? `; 🔴 vocab drift: ${res.drift.join(', ')}` : ''}`);
  if (dir) {
    fs.writeFileSync(path.join(dir, 'BRAND-LITERAL-CENSUS.md'), md);
    fs.writeFileSync(path.join(dir, 'BRAND-LITERAL-CENSUS.jsonl'), res.rows.map((r) => JSON.stringify({ file: r.file, line: r.line, col: r.col, scope: r.scope, token: r.token, kind: r.kind, brand: r.brand, match: r.match, strength: r.strength, ctx: r.ctx, class: r.class, why: r.why, lane: r.lane, root: r.root })).join('\n') + '\n');
    console.log(`wrote ${path.join(dir, 'BRAND-LITERAL-CENSUS.md')} + .jsonl`);
  }
}

module.exports = { SCANNER_VERSION, COORD_TOL, SENTINELS, buildVocabulary, collectJs, collectHtml, collectCss, collectJson, matcher, coordHits, classify, scan, rootsOf, laneOf, reconcile, forkReport, report, normColour, norm };
if (require.main === module) main();
