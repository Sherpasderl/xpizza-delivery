'use strict';
/* R3 P1 §3a — THE SITE-HIT TRACER (gate B's input; PLAN-R3-P1 rev 4, Amendment A2). A lightweight, semantics-preserving
 * in-memory rewrite of the census units actually loaded: a census read site in the SUPPORTED form becomes
 *     (__r3hit(<n>), <original expression source>)
 * inserted inline (no newline — line numbers, and so the scheduler's line-based sleep authorization, are unchanged).
 * It records reach only: it is never evidence that the read produced an asserted value (gate A does that).
 *
 *  · SITE IDENTITY is the census's own (exact AST pass over the SAME text). A unit is bound by its unit id, its inline-script
 *    index (`<script@N>`, the census's parse5 numbering), the loaded text's sha256 and TRANSFORM_VERSION; a loaded text whose
 *    sha differs from the census unit → RED (`TracerMismatch`), never instrumented by position against other text.
 *  · SUPPORTED FORM: a MemberExpression read whose value is used as a value — or a whole optional chain (instrumented at the
 *    ChainExpression). NOT instrumented (reported "untraced form", still covered by gate A): a call callee (`o.m()`, incl.
 *    `(o.m)()`), a tagged-template tag, any link INSIDE an optional chain, an assignment / update / delete target, a
 *    destructuring pattern (census kinds 'destructure' / 'projection-destructure').
 *
 *  · FUNCTION-ENTRY PROBES (P1-b; codex P1-b b3 r1): for every census function scope a reviewed `no-exec:<unit>#<fn>` context
 *    names (contract/region-applicability.json), each function the census names <fn> in <unit> gets `__r3enter(<k>);` as the
 *    first statement of its body (after any directive prologue), or `(__r3enter(<k>), <expr>)` around an expression body —
 *    inline, line-preserving. The recorder keeps the ENTERED scope keys per context; the transform reports which keys it
 *    PROBED, so an exclusion is decided only over a function that was actually instrumented (untraced → required).
 */
const crypto = require('crypto');
const acorn = require('acorn');

const TRANSFORM_VERSION = 'r3-tracer-1';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
class TracerMismatch extends Error {}

// the probe keys: every `no-exec:<unit>#<fn>` context in the reviewed applicability (ordered → stable indices)
let PROBES = null;
function probeIndex() {
  if (PROBES) return PROBES;
  let doc = { regions: {} }; try { doc = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'region-applicability.json'), 'utf8')); } catch (_) { /* none */ }
  const keys = [...new Set(Object.values(doc.regions).flatMap((e) => (e.context || []).filter((c) => /^no-exec:/.test(c)).map((c) => c.slice('no-exec:'.length))))].sort();
  const byUnit = new Map(); keys.forEach((k, i) => { const j = k.lastIndexOf('#'); const unit = k.slice(0, j); const fn = k.slice(j + 1); if (!byUnit.has(unit)) byUnit.set(unit, new Map()); byUnit.get(unit).set(fn, i); });
  PROBES = { keys, byUnit };
  return PROBES;
}
let CENSUS = null;   // { byFile: Map(file → { sha, sites: [{ n, id, pos }] }), ids: [] }
function censusIndex() {
  if (CENSUS) return CENSUS;
  const { census, sources } = require('./census');
  const MAP = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'census-map.json'), 'utf8'));
  const c = census({ explicit: MAP.explicitProjections || [], keepPos: true });   // exactly the census census-build reviews
  const units = new Map(sources().map((u) => [u.file, u]));
  const byFile = new Map(); const ids = [];
  for (const s of c.sites) {
    if (!byFile.has(s.file)) { const u = units.get(s.file); byFile.set(s.file, { sha: u ? sha(u.code) : null, module: u ? u.module : false, sites: [] }); }
    const n = ids.length; ids.push(s.id);
    byFile.get(s.file).sites.push({ n, id: s.id, pos: s._pos, kind: s.kind, field: s.alias || s.field });
  }
  CENSUS = { byFile, ids };
  return CENSUS;
}

function parse(code, module) {
  const opts = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowReturnOutsideFunction: true, allowImportExportEverywhere: true, allowAwaitOutsideFunction: true };
  try { return acorn.parse(code, { ...opts, sourceType: module ? 'module' : 'script' }); }
  catch (_) { return acorn.parse(code, { ...opts, sourceType: module ? 'script' : 'module' }); }
}

// the node a census member site denotes: the MemberExpression starting at `pos` whose PROPERTY is the site's field (nested
// members share a start — `o.items.list.length` — so the start alone is ambiguous), with its ancestor chain
const propOf = (m) => (m.computed ? (m.property.type === 'Literal' ? String(m.property.value) : null) : m.property.name);
function locate(ast, pos, field) {
  let found = null;
  (function rec(node, anc) {
    if (!node || typeof node.type !== 'string' || found) return;
    if (node.start === pos && node.type === 'MemberExpression' && (field == null || propOf(node) === field)) { found = { node, anc }; return; }
    if (node.start > pos || node.end < pos) return;
    const a2 = anc.concat(node);
    for (const k of Object.keys(node)) { if (k === 'loc') continue; const v = node[k]; if (Array.isArray(v)) for (const c of v) rec(c, a2); else if (v && typeof v.type === 'string') rec(v, a2); }
  })(ast, []);
  return found;
}

// supported → the [start, end) to wrap; else the reason it is untraced
function formOf(node, anc) {
  const p = anc[anc.length - 1];
  if (!p) return { reason: 'no parent' };
  if (p.type === 'CallExpression' && p.callee === node) return { reason: 'call callee' };
  if (p.type === 'TaggedTemplateExpression' && p.tag === node) return { reason: 'tagged-template tag' };
  if (p.type === 'AssignmentExpression' && p.left === node) return { reason: 'assignment target' };
  if (p.type === 'UpdateExpression') return { reason: 'update target' };
  if (p.type === 'UnaryExpression' && p.operator === 'delete') return { reason: 'delete target' };
  const chainIdx = anc.map((a) => a.type).lastIndexOf('ChainExpression');
  if (chainIdx !== -1) {
    // only the WHOLE chain may be wrapped: node must be the chain's expression and not a callee there
    const chain = anc[chainIdx];
    if (chainIdx === anc.length - 1 && chain.expression === node) {
      const cp = anc[chainIdx - 1];
      if (cp && cp.type === 'CallExpression' && cp.callee === chain) return { reason: 'call callee (optional chain)' };
      if (cp && cp.type === 'TaggedTemplateExpression' && cp.tag === chain) return { reason: 'tagged-template tag' };
      return { start: chain.start, end: chain.end };
    }
    return { reason: 'inside an optional chain' };
  }
  if (node.optional) return { reason: 'optional link' };
  return { start: node.start, end: node.end };
}

/* transform(unitFile, code) → { code, traced: [n…], untraced: [{ id, reason }] }. Throws TracerMismatch when the loaded text
 * is not the census's text for that unit. A unit with no census site is returned unchanged. */
function transform(unitFile, code, { module } = {}) {
  const idx = censusIndex(); const u = idx.byFile.get(unitFile);
  const probes = probeIndex().byUnit.get(unitFile) || null;
  if (!u && !probes) return { code, traced: [], untraced: [], probed: [], unit: unitFile, version: TRANSFORM_VERSION };
  if (!u) {
    // a unit with probes but no census read site: bind it to the census source text the same way
    const src = require('./census').sources().find((x) => x.file === unitFile);
    if (!src || sha(code) !== sha(src.code)) throw new TracerMismatch(`r3-tracer: ${unitFile} — the loaded text is not the reviewed census text (probe unit)`);
    return { ...rewrite(code, [], module !== undefined ? module : src.module, probes, unitFile), unit: unitFile, sha: sha(src.code), version: TRANSFORM_VERSION };
  }
  if (sha(code) !== u.sha) throw new TracerMismatch(`r3-tracer: ${unitFile} — the loaded text (sha ${sha(code).slice(0, 12)}) is not the reviewed census text (sha ${String(u.sha).slice(0, 12)}): source changed since the census`);
  return { ...rewrite(code, u.sites, module !== undefined ? module : u.module, probes, unitFile), unit: unitFile, sha: u.sha, version: TRANSFORM_VERSION };
}

// the pure rewrite: `sites` = [{ n, id, pos, kind }] (census positions in `code`)
function rewrite(code, sites, module, probes = null, unitFile = '') {
  const u = { sites };
  const ast = parse(code, module);
  // function-entry probes, at the census's own function naming (census.walk) over the SAME text
  const inserts = []; const probed = [];
  if (probes && probes.size) {
    const { walk } = require('./census');
    walk(ast, (node, fn) => {
      if (!/Function/.test(node.type) || !probes.has(fn)) return;
      const k = probes.get(fn); const key = `${unitFile}#${fn}`;
      if (node.body.type === 'BlockStatement') {
        let at = node.body.start + 1; let afterDirective = false; for (const st of node.body.body) { if (st.type === 'ExpressionStatement' && st.directive) { at = st.end; afterDirective = true; } else break; }
        // after a directive the probe opens with `;` — an ASI-terminated directive ("use strict"⏎…) would otherwise fuse
        // with it into one expression (codex P1-b no-exec P2)
        inserts.push({ at, text: `${afterDirective ? ';' : ''}__r3enter(${k});`, order: 2, len: 0 });
      } else { inserts.push({ at: node.body.start, text: `(__r3enter(${k}),`, order: 0, len: node.body.end - node.body.start }, { at: node.body.end, text: ')', order: 1, len: node.body.end - node.body.start }); }
      if (!probed.includes(key)) probed.push(key);
    });
  }
  const edits = []; const traced = []; const untraced = [];
  for (const s of u.sites) {
    if (s.kind === 'destructure' || s.kind === 'projection-destructure') { untraced.push({ id: s.id, reason: 'destructuring pattern' }); continue; }
    const f = locate(ast, s.pos, s.field);
    if (!f) { untraced.push({ id: s.id, reason: 'not a member expression at the census position' }); continue; }
    const r = formOf(f.node, f.anc);
    if (r.reason) { untraced.push({ id: s.id, reason: r.reason }); continue; }
    if (edits.some((e) => e.start === r.start && e.end === r.end)) { untraced.push({ id: s.id, reason: 'same expression as another traced site' }); continue; }
    edits.push({ start: r.start, end: r.end, n: s.n }); traced.push(s.n);
  }
  // insert right-to-left. At ONE position a later insertion lands LEFT of an earlier one, so: an open is inserted before a
  // close (the close belongs to the expression ending there); among opens the SHORTER (inner) first, so the outer ends up
  // leftmost; among closes the LONGER (outer) first, so the inner close ends up leftmost.
  let out = code;
  const opens = edits.map((e) => ({ at: e.start, text: `(__r3hit(${e.n}),`, order: 0, len: e.end - e.start }));
  const closes = edits.map((e) => ({ at: e.end, text: ')', order: 1, len: e.end - e.start }));
  const all = opens.concat(closes, inserts).sort((a, b) => b.at - a.at || (a.order - b.order) || (a.order === 0 ? a.len - b.len : b.len - a.len));
  for (const ins of all) out = out.slice(0, ins.at) + ins.text + out.slice(ins.at);
  return { code: out, traced, untraced, probed };
}

// a recorder: hit(n) records (context, site id); the context is set by the suite (scenario, LP)
function createRecorder() {
  const idx = censusIndex(); const hits = new Map(); let ctx = 'boot'; const entries = new Map();
  return {
    hit: (n) => { const k = `${ctx}|${idx.ids[n]}`; hits.set(k, (hits.get(k) || 0) + 1); },
    // a probed function was ENTERED (in the current context)
    enter: (i) => { const key = probeIndex().keys[i]; if (!entries.has(ctx)) entries.set(ctx, new Set()); entries.get(ctx).add(key); },
    enteredByContext: () => Object.fromEntries([...entries].map(([c, v]) => [c, [...v].sort()])),
    setContext: (c) => { ctx = c; },
    hitsByContext: () => { const m = {}; for (const k of hits.keys()) { const [c, id] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)]; (m[c] = m[c] || new Set()).add(id); } return m; },
    raw: hits,
  };
}

/* installServer(recorder): test-only — the census's FUNCTIONS units are transformed as Node compiles them (install BEFORE
 * index.js loads, like the R1c clock hook). global.__r3hit records into the recorder. A module already in require.cache is
 * NOT re-transformed: `installServer` refuses if any census functions unit is already loaded (the module-cache bypass). */
function installServer(recorder) {
  const path = require('path'); const Module = require('module');
  const REPO = path.join(__dirname, '..', '..');
  const idx = censusIndex(); const manifest = [];
  const loaded = Object.keys(require.cache).map((f) => path.relative(REPO, f).split(path.sep).join('/')).filter((f) => idx.byFile.has(f));
  if (loaded.length) throw new TracerMismatch(`r3-tracer: census units already loaded before installServer (module cache would bypass the tracer): ${loaded.slice(0, 5).join(', ')}`);
  global.__r3hit = (n) => recorder.hit(n);
  global.__r3enter = (i) => recorder.enter(i);
  const orig = Module._extensions['.js'];
  Module._extensions['.js'] = function (module, filename) {
    const rel = path.relative(REPO, filename).split(path.sep).join('/');
    if (!idx.byFile.has(rel)) return orig(module, filename);
    const code = require('fs').readFileSync(filename, 'utf8');
    const r = transform(rel, code, { module: false });
    manifest.push({ unit: rel, version: r.version, sha: r.sha, traced: r.traced.length, untraced: r.untraced, probed: r.probed || [] });
    module._compile(r.code, filename);
  };
  return { manifest, uninstall: () => { Module._extensions['.js'] = orig; delete global.__r3hit; delete global.__r3enter; } };
}

module.exports = { transform, rewrite, createRecorder, installServer, censusIndex, probeIndex, TRANSFORM_VERSION, TracerMismatch, sha };
