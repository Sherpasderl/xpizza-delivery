'use strict';
/* R3 §2b.7 — TRIGGER / ENDPOINT DISCOVERY, two independent derivations compared PER CATEGORY.
 *
 *   (a) RUNTIME: the loaded index.js exports, classified by their firebase-functions v2 endpoint field —
 *       eventTrigger (DB event: written | created, with its ref pattern), scheduleTrigger, httpsTrigger,
 *       callableTrigger. `.run(event)` is the handler taking a formed event.
 *   (b) SOURCE: an acorn inventory of index.js — direct `exports.X = onValueWritten|onValueCreated|onSchedule|
 *       onRequest|onCall(…)` AND re-exports (`exports.X = require('./m').Y` / `require('./m')` member chains),
 *       each re-export classified by loading THAT module's export and reading its endpoint.
 *
 * compare() returns per-category diffs; a non-empty diff is RED for the caller. Neither side is a hand list.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const FN = path.join(__dirname, '..');
const INDEX = path.join(FN, 'index.js');
const CTOR_CATEGORY = { onValueWritten: 'db', onValueCreated: 'db', onValueDeleted: 'db', onValueUpdated: 'db', onSchedule: 'schedule', onRequest: 'http', onCall: 'callable', beforeUserCreated: 'blocking', beforeUserSignedIn: 'blocking' };
const DB_KIND = { onValueWritten: 'written', onValueCreated: 'created', onValueDeleted: 'deleted', onValueUpdated: 'updated' };
const EVENT_KIND = { 'google.firebase.database.ref.v1.written': 'written', 'google.firebase.database.ref.v1.created': 'created', 'google.firebase.database.ref.v1.deleted': 'deleted', 'google.firebase.database.ref.v1.updated': 'updated' };

function parse(file) {
  return acorn.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true, allowReturnOutsideFunction: true });
}

// the callee name of a call like onValueWritten(...) or functions.v2.onSchedule(...)
const calleeName = (c) => (c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' && !c.computed ? c.property.name : null));

// require('./m') / require('./m').Y.Z → { module, chain }
function requireChain(node) {
  const chain = [];
  let n = node;
  while (n && n.type === 'MemberExpression' && !n.computed) { chain.unshift(n.property.name); n = n.object; }
  if (n && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments[0] && n.arguments[0].type === 'Literal') return { module: n.arguments[0].value, chain };
  return null;
}

// (b) SOURCE inventory — a STRICT ALLOWLIST of the export surface (2e asm7 r3; Codex r2 5×P2, advisor ruling 11-12: stop
// chasing shapes). exportSurface() accepts ONLY:
//  (a) a TOP-LEVEL statement `exports.X = …` / `module.exports.X = …`;
//  (b) a TOP-LEVEL `for (const k of B.LIST) exports[k] = B[k];` where B is declared once in the file, by a top-level
//      `const B = require('./m')`, and B is referenced ONLY there, as `B.LIST` in that loop header, as `B[k]` in its body, and
//      as the whole right side of a top-level `exports.X = B.Y`. ./m's own surface must be top-level `exports.Y = …` only,
//      with exactly one `exports.LIST = Object.freeze([<distinct string literals>])`, each listed name exported by ./m, and
//      nothing else touching exports / module / a module-level this;
//  (c) the FUNCTION_TARGET isolated-entry branch: `const S = new Set([<string literals>])` (optionally Object.freeze(…)),
//      S declared once and referenced only by exactly `if (S.has(process.env.FUNCTION_TARGET)) { …; module.exports =
//      require('./x'); return; }` — listed in `isolated`, never an export.
// ANY write to a builtin global / its members / a prototype (index.js or ./m), ANY other reference to exports / module /
// module.exports / a module-level this (a function-scoped this is the call's receiver, not export surface), at any depth, any redeclaration of
// exports / module / require / process / Set / Object, is UNRESOLVED with a reason (the callers fail on a non-empty list).
// Pure: it reads source text only (index.js + each loop's ./m through readModule), so deploy-closure2 runs it on `git show`.
const parseSrc = (src) => acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true, allowReturnOutsideFunction: true });
const kidsOf = (n, f) => { for (const key of Object.keys(n)) { if (key === 'loc') continue; const v = n[key]; if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && f(c, key)); else if (v && typeof v === 'object' && typeof v.type === 'string') f(v, key); } };
const patNames = (p, acc = []) => {
  if (!p) return acc;
  if (p.type === 'Identifier') acc.push(p.name);
  else if (p.type === 'ObjectPattern') p.properties.forEach((q) => patNames(q.type === 'RestElement' ? q.argument : q.value, acc));
  else if (p.type === 'ArrayPattern') p.elements.forEach((q) => patNames(q, acc));
  else if (p.type === 'RestElement') patNames(p.argument, acc);
  else if (p.type === 'AssignmentPattern') patNames(p.left, acc);
  return acc;
};
const isModExports = (o) => o.type === 'MemberExpression' && !o.computed && o.object.type === 'Identifier' && o.object.name === 'module' && o.property.name === 'exports';
const isId = (n, name) => n && n.type === 'Identifier' && (name === undefined || n.name === name);
const bareRequire = (n) => (n && n.type === 'CallExpression' && isId(n.callee, 'require') && n.arguments.length === 1 && n.arguments[0].type === 'Literal' && typeof n.arguments[0].value === 'string' ? n.arguments[0].value : null);
const strList = (arr) => (arr && arr.type === 'ArrayExpression' && arr.elements.length && arr.elements.every((e) => e && e.type === 'Literal' && typeof e.value === 'string' && e.value) ? arr.elements.map((e) => e.value) : null);
const freezeArg = (n) => (n && n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && isId(n.callee.object, 'Object') && n.callee.property.name === 'freeze' && n.arguments.length === 1 ? n.arguments[0] : null);
// every binding name declared anywhere → count; and every Identifier REFERENCE (not a declaration id, not a property key) → [{ node, parent, key }]
function scan(ast) {
  const declared = new Map(); const refs = new Map(); const declIds = new Set();
  const bump = (nm) => declared.set(nm, (declared.get(nm) || 0) + 1);
  const decl = (p) => { const walkP = (q) => { if (!q) return; if (q.type === 'Identifier') { bump(q.name); declIds.add(q); } else if (q.type === 'ObjectPattern') q.properties.forEach((r) => walkP(r.type === 'RestElement' ? r.argument : r.value)); else if (q.type === 'ArrayPattern') q.elements.forEach(walkP); else if (q.type === 'RestElement') walkP(q.argument); else if (q.type === 'AssignmentPattern') walkP(q.left); }; walkP(p); };
  (function w(n, parent, key) {
    if (n.type === 'VariableDeclarator') decl(n.id);
    if (/Function/.test(n.type)) { if (n.id) decl(n.id); n.params.forEach(decl); }
    if (/^Class/.test(n.type) && n.id) decl(n.id);
    if (n.type === 'CatchClause' && n.param) decl(n.param);
    if (n.type === 'Identifier' && !declIds.has(n) && !(parent && ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed) || ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && key === 'key' && !parent.computed)))) {
      if (!refs.has(n.name)) refs.set(n.name, []); refs.get(n.name).push({ node: n, parent, key });
    }
    kidsOf(n, (c, k) => w(c, n, k));
  })(ast, null, null);
  return { declared, refs };
}
// the module-level `this` occurrences (outside every non-arrow function). A function-scoped `this` is the call's receiver, not
// the export surface (advisor ruling on Codex r3 P3): only the module-level one (=== exports) is refused.
// Codex r3 P2-3: every WRITE to a builtin global or one of its members (`Object.freeze = …`, `Set.prototype.has = …`,
// `process.env.X = …`, `require.cache[k] = …`, `Object = …`), through any `prototype` / `__proto__`, or by
// Object.assign / defineProperty / defineProperties / setPrototypeOf / Reflect.set / deleteProperty onto one — anywhere in the
// file. The allowlist trusts Object.freeze, Set#has, process.env.FUNCTION_TARGET and require; a file that can rewrite them is refused.
const BUILTIN_ROOTS = new Set(['Object', 'Set', 'Array', 'Function', 'JSON', 'process', 'require', 'Reflect', 'globalThis', 'global']);
const MUTATORS = new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf', 'set', 'deleteProperty']);
function builtinWrites(ast) {
  const out = [];
  const touches = (n) => { const ks = []; while (n && n.type === 'MemberExpression') { if (!n.computed) ks.push(n.property.name); n = n.object; } return (isId(n) && BUILTIN_ROOTS.has(n.name)) || ks.includes('prototype') || ks.includes('__proto__'); };
  const target = (n) => (n.type === 'AssignmentExpression' ? n.left : n.type === 'UpdateExpression' || (n.type === 'UnaryExpression' && n.operator === 'delete') ? n.argument : (n.type === 'ForInStatement' || n.type === 'ForOfStatement') && n.left.type !== 'VariableDeclaration' ? n.left : null);
  (function w(n) {
    const t = target(n);
    if (t && ((t.type === 'MemberExpression' && touches(t)) || (isId(t) && BUILTIN_ROOTS.has(t.name)))) out.push(n);
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && (isId(n.callee.object, 'Object') || isId(n.callee.object, 'Reflect')) && MUTATORS.has(n.callee.property.name) && n.arguments[0]
      && ((isId(n.arguments[0]) && BUILTIN_ROOTS.has(n.arguments[0].name)) || (n.arguments[0].type === 'MemberExpression' && touches(n.arguments[0])))) out.push(n);
    kidsOf(n, w);
  })(ast);
  return out;
}
function moduleThis(ast) { const out = []; (function w(n, inFn) { if (n.type === 'ThisExpression' && !inFn) out.push(n); const f = inFn || n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression'; kidsOf(n, (c) => w(c, f)); })(ast, false); return out; }
// ./m for a loop: top-level `exports.Y = …` only; exactly one LIST = Object.freeze([strings]); each listed name exported → { names } | { why }
function moduleList(src, list, label) {
  if (src == null) return { why: `${label} could not be read` };
  let ast; try { ast = parseSrc(src); } catch (e) { return { why: `${label} does not parse` }; }
  const { declared, refs } = scan(ast);
  for (const nm of ['exports', 'module', 'Object']) if (declared.has(nm)) return { why: `${label} redeclares \`${nm}\`` };
  const topAssign = new Map();   // the allowed `exports.Y` member nodes → name
  const names = [];
  for (const st of ast.body) {
    const e = st.type === 'ExpressionStatement' ? st.expression : null;
    if (e && e.type === 'AssignmentExpression' && e.operator === '=' && e.left.type === 'MemberExpression' && !e.left.computed && isId(e.left.object, 'exports')) { topAssign.set(e.left, e); names.push(e.left.property.name); }
  }
  for (const r of refs.get('exports') || []) if (!(r.key === 'object' && topAssign.has(r.parent))) return { why: `${label} L${r.node.loc.start.line}: \`exports\` is used other than as a top-level \`exports.Y = …\`` };
  if ((refs.get('module') || []).length) return { why: `${label} L${refs.get('module')[0].node.loc.start.line}: \`module\` is used` };
  const th = moduleThis(ast); if (th.length) return { why: `${label} L${th[0].loc.start.line}: a module-level \`this\`` };
  const bw = builtinWrites(ast); if (bw.length) return { why: `${label} L${bw[0].loc.start.line}: a write to a builtin global / prototype` };
  const lists = [...topAssign.values()].filter((e) => e.left.property.name === list);
  if (lists.length !== 1) return { why: `${label} assigns exports.${list} ${lists.length}×` };
  const arr = freezeArg(lists[0].right); const vals = arr ? strList(arr) : null;
  if (!vals) return { why: `${label}: exports.${list} is not Object.freeze([<non-empty string literals>])` };
  if (new Set(vals).size !== vals.length) return { why: `${label}: ${list} repeats a name` };
  const missing = vals.filter((v) => !names.includes(v)); if (missing.length) return { why: `${label}: ${list} names ${missing.join(', ')}, not exported by it` };
  return { names: vals };
}
function exportSurface(src, readModule) {
  const ast = typeof src === 'string' ? parseSrc(src) : src;
  const { declared, refs } = scan(ast);
  const unresolved = []; const exportsOut = []; const isolated = [];
  const bad = (node, why, type = 'export-surface') => unresolved.push({ name: null, line: node ? node.loc.start.line : null, type, why });
  for (const nm of ['exports', 'module', 'require', 'process', 'Set', 'Object']) if (declared.has(nm)) bad(null, `\`${nm}\` is redeclared in the file`);
  const bw = builtinWrites(ast);   // a file that rewrites a builtin gets NO loop and NO isolated branch (each write is also refused below)
  const okExportsMember = new Set(); const okModuleExports = new Set();   // the member nodes an allowed form owns
  const topConst = new Map();   // name → { kind, init, stmt } for single-identifier top-level declarations
  for (const st of ast.body) if (st.type === 'VariableDeclaration') for (const d of st.declarations) if (d.id.type === 'Identifier') topConst.set(d.id.name, { kind: st.kind, init: d.init, stmt: st });
  // (a)
  const assigns = [];
  for (const st of ast.body) {
    const e = st.type === 'ExpressionStatement' ? st.expression : null;
    if (!(e && e.type === 'AssignmentExpression' && e.operator === '=' && e.left.type === 'MemberExpression' && !e.left.computed)) continue;
    const o = e.left.object;
    if (isId(o, 'exports')) { okExportsMember.add(e.left); assigns.push(e); }
    else if (isModExports(o)) { okModuleExports.add(o); assigns.push(e); }
  }
  for (const e of assigns) exportsOut.push({ name: e.left.property.name, line: e.loc.start.line, how: 'assign', node: e, rhs: e.right, stmt: ast.body.find((st) => st.expression === e), via: isId(e.left.object) ? 'exports' : 'module.exports' });
  // (b)
  for (const st of ast.body) {
    if (st.type !== 'ForOfStatement') continue;
    const k = st.left.type === 'VariableDeclaration' && st.left.kind === 'const' && st.left.declarations.length === 1 && isId(st.left.declarations[0].id) ? st.left.declarations[0].id.name : null;
    const it = st.right; const B = it.type === 'MemberExpression' && !it.computed && isId(it.object) ? it.object.name : null;
    const s1 = st.body.type === 'BlockStatement' && st.body.body.length === 1 ? st.body.body[0] : st.body;
    const a = s1 && s1.type === 'ExpressionStatement' ? s1.expression : null;
    const shape = !st.await && k && B && a && a.type === 'AssignmentExpression' && a.operator === '=' && a.left.type === 'MemberExpression' && a.left.computed && isId(a.left.object, 'exports') && isId(a.left.property, k)
      && a.right.type === 'MemberExpression' && a.right.computed && isId(a.right.object, B) && isId(a.right.property, k);
    if (!shape) continue;   // not the loop: whatever it does to exports is caught below
    // (k === B needs no guard of its own: the loop then declares B a second time, so "declared exactly once" refuses it)
    const line = st.loc.start.line; const d = topConst.get(B); const spec = d && d.kind === 'const' ? bareRequire(d.init) : null;
    let why = null;
    if (bw.length) why = `the file writes a builtin global / prototype (L${bw[0].loc.start.line})`;
    else if (['require', 'Object'].some((nm) => declared.has(nm))) why = 'the file redeclares `require` / `Object` (the loop trusts both)';
    else if (declared.get(B) !== 1 || !d) why = `${B} is declared ${declared.get(B) || 0}× in the file (must be exactly once, a top-level const)`;
    else if (!spec) why = `${B} is not \`const ${B} = require('./m')\``;
    else {
      const allowed = new Set([it.object, a.right.object]);
      for (const e of assigns) if (isId(e.left.object, 'exports') && e.right.type === 'MemberExpression' && !e.right.computed && isId(e.right.object, B)) allowed.add(e.right.object);
      const stray = (refs.get(B) || []).find((r) => !allowed.has(r.node));
      if (stray) why = `${B} is referenced outside the allowlisted forms (L${stray.node.loc.start.line})`;
    }
    if (!why) { const L = moduleList(readModule(spec), it.property.name, spec); if (L.why) why = L.why; else { okExportsMember.add(a.left); for (const name of L.names) exportsOut.push({ name, line, how: 'loop', stmt: st, B, module: spec, list: it.property.name, listNames: L.names }); continue; } }
    bad(st, why, 'computed-export');
  }
  // (c)
  for (const st of ast.body) {
    if (st.type !== 'IfStatement' || st.alternate || st.consequent.type !== 'BlockStatement') continue;
    const t = st.test;
    const S = t.type === 'CallExpression' && t.callee.type === 'MemberExpression' && !t.callee.computed && isId(t.callee.object) && t.callee.property.name === 'has' && t.arguments.length === 1 ? t.callee.object.name : null;
    const g = S ? t.arguments[0] : null;
    if (!(g && g.type === 'MemberExpression' && !g.computed && g.property.name === 'FUNCTION_TARGET' && g.object.type === 'MemberExpression' && !g.object.computed && isId(g.object.object, 'process') && g.object.property.name === 'env')) continue;
    const b = st.consequent.body; const last = b[b.length - 1]; const prev = b[b.length - 2];
    const e = prev && prev.type === 'ExpressionStatement' ? prev.expression : null;
    const spec = e && e.type === 'AssignmentExpression' && e.operator === '=' && isModExports(e.left) ? bareRequire(e.right) : null;
    if (!(spec && last.type === 'ReturnStatement' && !last.argument)) continue;
    const d = topConst.get(S); const nw = d && d.kind === 'const' ? (freezeArg(d.init) || d.init) : null;
    const names = nw && nw.type === 'NewExpression' && isId(nw.callee, 'Set') && nw.arguments.length === 1 ? strList(nw.arguments[0]) : null;
    let why = null;
    if (bw.length) why = `the file writes a builtin global / prototype (L${bw[0].loc.start.line})`;
    else if (['process', 'Set', 'Object'].some((nm) => declared.has(nm))) why = 'the file redeclares `process` / `Set` / `Object` (the branch trusts all three)';
    else if (declared.get(S) !== 1 || !d) why = `${S} is declared ${declared.get(S) || 0}× (must be exactly once, a top-level const)`;
    else if (!names) why = `${S} is not \`const ${S} = new Set([<non-empty string literals>])\``;
    else { const stray = (refs.get(S) || []).find((r) => r.node !== t.callee.object); if (stray) why = `${S} is referenced outside its FUNCTION_TARGET test (L${stray.node.loc.start.line})`; }
    if (why) { bad(st, why); continue; }
    okModuleExports.add(e.left); isolated.push({ line: e.loc.start.line, set: S, module: spec, names });
  }
  // everything else that touches the export objects
  for (const r of refs.get('exports') || []) if (!(r.key === 'object' && okExportsMember.has(r.parent))) bad(r.node, '`exports` is used other than as a top-level `exports.X = …` (or the allowlisted loop)');
  for (const r of refs.get('module') || []) if (!(r.key === 'object' && okModuleExports.has(r.parent))) bad(r.node, '`module` is used other than as a top-level `module.exports.X = …` (or the isolated-entry branch)');
  for (const th of moduleThis(ast)) bad(th, 'a module-level `this` (=== exports)');
  for (const x of bw) bad(x, 'a write to a builtin global / prototype (the allowlist trusts Object.freeze, Set, process.env, require)');
  const seen = new Set(); for (const x of exportsOut) { if (seen.has(x.name)) bad(x.node || x.stmt, `${x.name} is exported more than once`); seen.add(x.name); }
  return { exports: exportsOut, isolated, unresolved };
}
// read ./m next to `file` the way require resolves a relative spec (spec.js, spec, spec/index.js)
function readRel(file, spec) {
  const p = path.resolve(path.dirname(file), spec);
  for (const c of [p, `${p}.js`, path.join(p, 'index.js')]) { try { if (fs.statSync(c).isFile()) return fs.readFileSync(c, 'utf8'); } catch (_) { /* next */ } }
  return null;
}

// SOURCE inventory of index.js: exportSurface's allowlisted exports, each classified — a direct constructor call, a factory call
// `require('./m').f(…)` (classified by what f RETURNS), a require chain / a member of a top-level require binding (a re-export,
// classified by loading THAT module's export), a top-level constructor binding, or any other value (not an endpoint). A loop's
// names are re-exports of ./m, and the loaded list must equal the static one. Every unresolved surface use is UNCLASSIFIED.
function sourceInventory(file = INDEX) {
  const ast = parse(file);
  const out = []; const unclassified = [];
  const bindings = new Map();   // top-level name → init node | 'function'
  for (const st of ast.body) {
    if (st.type === 'FunctionDeclaration' && st.id) bindings.set(st.id.name, 'function');
    if (st.type === 'VariableDeclaration') for (const d of st.declarations) if (d.id.type === 'Identifier') bindings.set(d.id.name, d.init);
  }
  const baseOf = (n) => { const chain = []; while (n && n.type === 'MemberExpression' && !n.computed) { chain.unshift(n.property.name); n = n.object; } return n && n.type === 'Identifier' ? { id: n.name, chain } : null; };
  const surf = exportSurface(ast, (spec) => readRel(file, spec));
  for (const u of surf.unresolved) unclassified.push(u);
  for (const x of surf.exports) {
    const name = x.name; const line = x.line;
    if (x.how === 'loop') {
      let m = require(path.resolve(path.dirname(file), x.module)); const listed = m == null ? null : m[x.list];
      if (!Array.isArray(listed) || !Object.isFrozen(listed) || JSON.stringify(listed) !== JSON.stringify(x.listNames)) { if (name === x.listNames[0]) unclassified.push({ name: null, line, type: 'computed-export', module: x.module, why: `the loaded ${x.list} is not the frozen static list` }); continue; }
      out.push({ name, line, how: 'reexport', module: x.module, chain: [name], via: x.list });
      continue;
    }
    const r = x.rhs;
    if (r.type === 'CallExpression' && CTOR_CATEGORY[calleeName(r.callee)]) {
      const ctor = calleeName(r.callee);
      const opts = r.arguments[0];
      let ref = null;
      if (opts && opts.type === 'ObjectExpression') { const p = opts.properties.find((q) => q.key && (q.key.name === 'ref' || q.key.value === 'ref')); if (p && p.value.type === 'Literal') ref = p.value.value; }
      out.push({ name, line, how: 'direct', category: CTOR_CATEGORY[ctor], kind: DB_KIND[ctor] || null, ref: ref ? normRef(ref) : null });
    } else if (r.type === 'CallExpression' && r.callee.type === 'MemberExpression' && !r.callee.computed && requireChain(r.callee.object)) {
      // 2e 11-01 (r3-p0-scheduler D0): a FACTORY-CALL export, `exports.X = require('./m').f(…)` — classified STATICALLY by the
      // constructor f RETURNS in ./m (e.g. whatsappInstanceHealth: instance-health.js makeHealthFunction → return onSchedule(…)).
      // Any other shape is pushed to `unclassified` with a reason — never silently dropped.
      const mod = requireChain(r.callee.object); const fname = r.callee.property.name;
      const f = factoryCtor(path.resolve(path.dirname(file), mod.module), [...mod.chain, fname]);
      if (f.ctor) out.push({ name, line, how: 'factory', module: mod.module, factory: fname, category: CTOR_CATEGORY[f.ctor], kind: DB_KIND[f.ctor] || null, ref: f.ref ? normRef(f.ref) : null });
      else unclassified.push({ name, line, type: 'factory-call', module: mod.module, factory: fname, why: f.why });
    } else {
      let rc = requireChain(r);
      const base = rc ? null : baseOf(r);
      if (!rc && base && bindings.has(base.id)) {
        const init = bindings.get(base.id);
        const viaReq = init && init !== 'function' ? requireChain(init) : null;
        if (viaReq) rc = { module: viaReq.module, chain: [...viaReq.chain, ...base.chain] };
        else if (!base.chain.length && init && init !== 'function' && init.type === 'CallExpression' && CTOR_CATEGORY[calleeName(init.callee)]) {
          const ctor = calleeName(init.callee);
          out.push({ name, line, how: 'binding', category: CTOR_CATEGORY[ctor], kind: DB_KIND[ctor] || null, ref: null });
          rc = 'done';
        } else if (!base.chain.length) { out.push({ name, line, how: 'binding', category: 'not-endpoint' }); rc = 'done'; }
      }
      if (rc && rc !== 'done') out.push({ name, line, how: 'reexport', module: rc.module, chain: rc.chain });
      else if (!rc) unclassified.push({ name, line, type: r.type });
    }
  }
  // classify re-exports by loading the required module's export (its own endpoint)
  for (const e of out.filter((x) => x.how === 'reexport')) {
    let v = require(path.resolve(path.dirname(file), e.module));
    for (const k of e.chain) v = v == null ? v : v[k];
    const cls = classifyRuntime(v);
    Object.assign(e, cls || { category: 'not-endpoint' });
  }
  return { entries: out, unclassified, isolated: surf.isolated };
}

const normRef = (r) => String(r).replace(/^\/+/, '');

// a factory's RETURNED constructor, statically: module file + export chain [name] → { ctor, ref } | { why }. FAIL CLOSED (codex r1):
//  • the EXPORT BINDING is resolved, not a name match: `module.exports = { f }` / `{ f: g }` / `module.exports.f = g` / `exports.f = g`
//    → the top-level function it NAMES (declaration, or const = function / arrow). A missing, remapped-to-nothing or non-function
//    export → { why } (an unexported function that merely shares the name is NOT followed);
//  • EVERY code path must return the SAME constructor with the SAME ref: the body must END in a return (no fallthrough), every
//    return must be a constructor call, one constructor, one ref. Anything else → { why }.
function factoryCtor(absModule, chain) {
  if (chain.length !== 1) return { why: `nested export chain ${chain.join('.')}` };
  const fname = chain[0];
  let file = absModule; if (!/\.m?js$/.test(file)) file = fs.existsSync(`${file}.js`) ? `${file}.js` : path.join(file, 'index.js');
  if (!fs.existsSync(file)) return { why: `module not found: ${path.relative(path.dirname(INDEX), file)}` };
  const ast = parse(file);
  const fns = new Map();   // top-level name → function node
  for (const st of ast.body) {
    if (st.type === 'FunctionDeclaration' && st.id) fns.set(st.id.name, st);
    if (st.type === 'VariableDeclaration') for (const d of st.declarations) if (d.id.type === 'Identifier' && d.init && /Function/.test(d.init.type)) fns.set(d.id.name, d.init);
  }
  // the identifier the module EXPORTS under `fname` (null = not exported)
  let target; let seen = 0;
  const isModExports = (n) => n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === 'module' && n.property.name === 'exports';
  for (const st of ast.body) {
    if (st.type !== 'ExpressionStatement' || st.expression.type !== 'AssignmentExpression') continue;
    const { left, right } = st.expression;
    if (isModExports(left) && right.type === 'ObjectExpression') {
      for (const pr of right.properties) {
        if (pr.type !== 'Property' || pr.computed) continue;
        const key = pr.key.type === 'Identifier' ? pr.key.name : pr.key.value;
        if (key === fname) { seen += 1; target = pr.value.type === 'Identifier' ? pr.value.name : null; }
      }
    } else if (left.type === 'MemberExpression' && !left.computed && left.property.name === fname
      && ((left.object.type === 'Identifier' && left.object.name === 'exports') || isModExports(left.object))) {
      seen += 1; target = right.type === 'Identifier' ? right.name : (/Function/.test(right.type) ? right : null);
    }
  }
  // advisor verify of 94f8a213 — an export assignment anywhere but a TOP-LEVEL statement (inside an if / a function / an
  // expression) cannot be resolved statically ⇒ fail closed. The whole AST is walked, not just ast.body.
  const isExportLhs = (l) => isModExports(l) || (l.type === 'MemberExpression' && !l.computed && ((l.object.type === 'Identifier' && l.object.name === 'exports') || isModExports(l.object)));
  const topLevel = new Set(ast.body.filter((st) => st.type === 'ExpressionStatement').map((st) => st.expression));
  let nested = 0;
  (function walkX(n) { if (!n || typeof n.type !== 'string') return; if (n.type === 'AssignmentExpression' && isExportLhs(n.left) && !topLevel.has(n)) nested += 1; for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(walkX); else if (v && typeof v === 'object' && typeof v.type === 'string') walkX(v); } })(ast);
  if (nested) return { why: `an export assignment is not a top-level statement (${nested}×) in ${path.basename(file)}` };
  // codex r2 P2 — FAIL CLOSED on any overwritten / spread export surface (no attempt to resolve a final binding):
  const modAssigns = ast.body.filter((st) => st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression' && isModExports(st.expression.left));
  if (modAssigns.length > 1) return { why: `module.exports is assigned ${modAssigns.length}× in ${path.basename(file)}` };
  const lit = modAssigns[0] && modAssigns[0].expression.right.type === 'ObjectExpression' ? modAssigns[0].expression.right : null;
  if (lit && lit.properties.some((pr) => pr.type === 'SpreadElement')) return { why: `module.exports literal contains a spread in ${path.basename(file)}` };
  if (lit && lit.properties.some((pr) => pr.type === 'Property' && pr.computed)) return { why: `module.exports literal has a computed key in ${path.basename(file)}` };
  if (lit) { const keys = lit.properties.filter((pr) => pr.type === 'Property' && !pr.computed).map((pr) => (pr.key.type === 'Identifier' ? pr.key.name : pr.key.value)); if (new Set(keys).size !== keys.length) return { why: `module.exports literal repeats a key in ${path.basename(file)}` }; }
  const viaExports = ast.body.some((st) => st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression' && st.expression.left.type === 'MemberExpression' && st.expression.left.object.type === 'Identifier' && st.expression.left.object.name === 'exports');
  if (modAssigns.length && viaExports) return { why: `module.exports is reassigned while exports.* is also used in ${path.basename(file)}` };
  if (!seen) return { why: `${fname} is not exported by ${path.basename(file)}` };
  if (seen > 1) return { why: `${fname} is exported more than once in ${path.basename(file)}` };
  const fnNode = target && typeof target === 'object' ? target : (typeof target === 'string' ? fns.get(target) : null);
  if (!fnNode) return { why: `${fname}: its export does not name a top-level function (${target === null ? 'non-identifier value' : `\`${target}\` is not a function`})` };
  if (fnNode.body.type !== 'BlockStatement') {
    const c = fnNode.body; return c.type === 'CallExpression' && CTOR_CATEGORY[calleeName(c.callee)] ? { ctor: calleeName(c.callee), ref: refOf(c.arguments[0]) } : { why: `${fname}: expression body is not a constructor call` };
  }
  const body = fnNode.body.body;
  if (!body.length || body[body.length - 1].type !== 'ReturnStatement') return { why: `${fname}: a code path can fall through (the body does not end in a return)` };
  const rets = [];
  (function walkR(n) { if (!n || typeof n.type !== 'string') return; if (n !== fnNode && /Function/.test(n.type)) return; if (n.type === 'ReturnStatement') rets.push(n.argument); for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(walkR); else if (v && typeof v === 'object' && typeof v.type === 'string') walkR(v); } })(fnNode.body);
  const ctors = rets.map((x) => (x && x.type === 'CallExpression' && CTOR_CATEGORY[calleeName(x.callee)] ? calleeName(x.callee) : null));
  if (ctors.some((c) => !c)) return { why: `${fname}: a return is not a constructor call` };
  if (new Set(ctors).size !== 1) return { why: `${fname}: returns different constructors (${[...new Set(ctors)].join(', ')})` };
  const refs = rets.map((x) => refOf(x.arguments[0]));
  if (new Set(refs.map((r) => JSON.stringify(r))).size !== 1) return { why: `${fname}: returns the same constructor with different refs` };
  return { ctor: ctors[0], ref: refs[0] };
}
function refOf(opts) { if (!opts || opts.type !== 'ObjectExpression') return null; const p = opts.properties.find((q) => q.key && (q.key.name === 'ref' || q.key.value === 'ref')); return p && p.value.type === 'Literal' ? p.value.value : null; }

// (a) one runtime export → { category, kind, ref } or null when it is not a Cloud Function
function classifyRuntime(fn) {
  const ep = fn && fn.__endpoint;
  if (!ep) return null;
  if (ep.eventTrigger) {
    const kind = EVENT_KIND[ep.eventTrigger.eventType] || `unknown:${ep.eventTrigger.eventType}`;
    const ref = ep.eventTrigger.eventFilterPathPatterns && ep.eventTrigger.eventFilterPathPatterns.ref;
    return { category: 'db', kind, ref: ref ? normRef(ref) : null };
  }
  if (ep.scheduleTrigger) return { category: 'schedule', kind: null, ref: null };
  if (ep.httpsTrigger) return { category: 'http', kind: null, ref: null };
  if (ep.callableTrigger) return { category: 'callable', kind: null, ref: null };
  if (ep.blockingTrigger) return { category: 'blocking', kind: null, ref: null };
  return { category: 'unknown-endpoint', kind: null, ref: null };
}
function runtimeInventory(app) {
  const out = [];
  for (const name of Object.keys(app)) {
    const c = classifyRuntime(app[name]);
    if (c) out.push({ name, ...c, hasRun: typeof app[name].run === 'function' });
  }
  return out;
}

// per-category comparison: names + (db) kind + ref pattern must agree exactly
function compare(runtime, source) {
  const key = (e) => (e.category === 'db' ? `${e.name}|${e.kind}|${e.ref}` : e.name);
  const cats = [...new Set([...runtime, ...source].map((e) => e.category))].sort();
  const diffs = {};
  for (const c of cats) {
    const a = new Set(runtime.filter((e) => e.category === c).map(key));
    const b = new Set(source.filter((e) => e.category === c && e.category !== 'not-endpoint').map(key));
    const onlyRuntime = [...a].filter((k) => !b.has(k)).sort();
    const onlySource = [...b].filter((k) => !a.has(k)).sort();
    if (onlyRuntime.length || onlySource.length) diffs[c] = { onlyRuntime, onlySource };
  }
  const counts = {};
  for (const e of runtime) counts[e.category] = (counts[e.category] || 0) + 1;
  return { diffs, counts };
}

// the DB trigger table the scheduler fans out to
function dbTriggers(runtime) {
  return runtime.filter((e) => e.category === 'db').map((e) => ({ name: e.name, kind: e.kind, ref: e.ref, segs: e.ref.split('/') }));
}

module.exports = { sourceInventory, exportSurface, runtimeInventory, classifyRuntime, compare, dbTriggers, INDEX };
