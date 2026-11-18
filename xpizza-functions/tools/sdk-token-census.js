'use strict';
// owner 11-18 «airtight» (advisor, Codex #150 REVISE): the TREE-WIDE census behind payments/sdk/record-token.guard.test.js. ONE module
// (payments/sdk/record-token.js) owns payment_sdk/{orderId}.token; this census finds, over EVERY tracked non-test JS file of
// xpizza-functions, the two ways anything else could still reach it:
//   1. TOKEN SITES — any `token` key: `x.token`, `x['token']` / `x[`token`]`, a destructured `{ token }`, an object key `token:` and any
//      other string literal 'token' (a computed key built from it) — ANY receiver, so an alias or an argument-only helper is a site too;
//   3. ACCESSOR CALLS — every call into the owner (tokenOf / setToken / dropToken), so a new reader through it is reviewed as well;
//   2. RECORD ESCAPES — a value that came from a payment_sdk read (taint below) leaving whole: spread, Object.assign, JSON.stringify,
//      structuredClone, Object.values / entries, for-in, a non-literal computed key, a property value or array element of another object,
//      or an argument to a call the census cannot follow (a whole-record forward). A call it CAN follow (a function of the tree, resolved
//      by same-file name or by its require binding) taints that function's parameter instead, and its body is scanned the same way.
// Taint: readRecord / casRecord / createRecord results (and their `.record`), `.val()` of a snapshot read from a ref whose path mentions
// payment_sdk, the first parameter of a casRecord callback or of a payment_sdk ref's transaction callback, an alias, and a call to a
// function that returns a tainted value — or returns its i-th parameter when the i-th argument is tainted (to a fixpoint across files).
// Each site prints as `file | exact line text` (trimmed, one entry per occurrence): the guard pins the reviewed set with a reason per
// line, so a new or moved site fails until it is reviewed.
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const acorn = require('acorn');
const FN = path.join(__dirname, '..');
const OWNER = 'payments/sdk/record-token.js';
const KEY = 'token';
const SOURCE_FNS = new Set(['readRecord', 'casRecord', 'createRecord']);
const ESCAPE_FNS = new Set(['JSON.stringify', 'structuredClone', 'Object.assign', 'Object.values', 'Object.entries', 'Object.fromEntries']);
const SAFE_FNS = new Set(['Array.isArray', 'Object.keys', 'Boolean']);   // see the object, never a value out of it

const trackedFiles = (cwd = FN) => execFileSync('git', ['ls-files', '*.js', ':!*.test.js', ':!test/**', ':!**/node_modules/**'], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean).sort();
function parse(src) {
  const o = { ecmaVersion: 'latest', allowHashBang: true, locations: true, allowReturnOutsideFunction: true };
  try { return acorn.parse(src, { ...o, sourceType: 'script' }); } catch (_) { return acorn.parse(src, { ...o, sourceType: 'module' }); }
}
const isKey = (k, computed) => !!k && ((!computed && k.type === 'Identifier' && k.name === KEY) || (k.type === 'Literal' && k.value === KEY)
  || (k.type === 'TemplateLiteral' && k.expressions.length === 0 && k.quasis[0].value.cooked === KEY));
const calleeName = (c) => (c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' ? c.property.name : null);
const calleeText = (c) => (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.property.type === 'Identifier' ? `${c.object.name}.${c.property.name}` : calleeName(c));
const isFn = (n) => n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');
const each = (n, parent, f) => {   // generic child walk
  for (const [k, v] of Object.entries(n)) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    if (Array.isArray(v)) v.forEach((x) => x && typeof x.type === 'string' && f(x, n)); else if (v && typeof v.type === 'string') f(v, n);
  }
};
const mentionsSdk = (n, src) => !!n && /payment_sdk(?![A-Za-z0-9_])/.test(src.slice(n.start, n.end));   // the records, not payment_sdk_due etc.
function refOfSdk(n, src) {   // ...ref(<payment_sdk path>) anywhere down a call/member chain
  for (let x = n; x;) {
    if (x.type === 'CallExpression') { if (calleeName(x.callee) === 'ref' && x.arguments[0] && mentionsSdk(x.arguments[0], src)) return true; x = x.callee; continue; }
    if (x.type === 'MemberExpression') { x = x.object; continue; }
    if (x.type === 'AwaitExpression') { x = x.argument; continue; }
    return false;
  }
  return false;
}
const requireArg = (n) => (n && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments[0] && n.arguments[0].type === 'Literal' && typeof n.arguments[0].value === 'string' ? n.arguments[0].value : null);
function resolveModule(fromFile, spec, files) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  for (const c of [base, `${base}.js`, `${base}/index.js`]) if (files.has(c)) return c;
  return null;
}
const fnName = (f, parent) => (f.id && f.id.name) || (parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier' ? parent.id.name
  : parent && parent.type === 'Property' && !parent.computed && parent.key.type === 'Identifier' ? parent.key.name
  // module.exports.x = fn / exports.x = fn
  : parent && parent.type === 'AssignmentExpression' && parent.right === f && parent.left.type === 'MemberExpression' && !parent.left.computed && parent.left.property.type === 'Identifier' ? parent.left.property.name : null);

// per file: its top-level function definitions and its require bindings (X → module, name → [module, export])
function indexFile(file, ast, files) {
  const defs = new Set(); const mods = new Map(); const named = new Map();
  const w = (n, parent) => {
    if (isFn(n)) { const nm = fnName(n, parent); if (nm) defs.add(nm); }
    if (n.type === 'VariableDeclarator') {
      const spec = requireArg(n.init); const m = spec && resolveModule(file, spec, files);
      if (m && n.id.type === 'Identifier') mods.set(n.id.name, m);
      if (m && n.id.type === 'ObjectPattern') for (const q of n.id.properties) if (q.type === 'Property' && !q.computed && q.key.type === 'Identifier' && q.value.type === 'Identifier') named.set(q.value.name, [m, q.key.name]);
    }
    each(n, parent, w);
  };
  w(ast, null);
  return { defs, mods, named };
}

function census(fileList, read) {
  const files = new Set(fileList);
  const S = new Map(); for (const f of fileList) { const src = read(f); S.set(f, { src, ast: parse(src), lines: src.split('\n') }); }
  for (const [f, x] of S) Object.assign(x, indexFile(f, x.ast, files));
  // keys `file#name`; cb: `file#name|argIndex|prop` → param indices of a callback property the function calls with the record;
  // cbNodes: `file@start` of an inline function passed as such a property → its tainted param indices
  // props: `file#name` → properties of the object it returns that hold the record (a caller's `res.record` is the record)
  const K = { src: new Set(), pass: new Map(), params: new Map(), cb: new Map(), cbNodes: new Map(), props: new Map() };
  const resolve = (file, callee) => {
    const x = S.get(file);
    if (callee.type === 'Identifier') { if (x.defs.has(callee.name)) return `${file}#${callee.name}`; const nm = x.named.get(callee.name); return nm && S.get(nm[0]).defs.has(nm[1]) ? `${nm[0]}#${nm[1]}` : null; }
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
      let m = null;
      if (callee.object.type === 'Identifier') m = x.mods.get(callee.object.name) || null;
      else { const spec = requireArg(callee.object); m = spec && resolveModule(file, spec, files); }
      return m && S.get(m).defs.has(callee.property.name) ? `${m}#${callee.property.name}` : null;
    }
    return null;
  };

  function scan(file, out) {
    const { ast, lines, src } = S.get(file);
    const owner = file === OWNER;
    const site = (kind, n) => { if (out && !owner) out[kind].push(`${file} | ${lines[n.loc.start.line - 1].trim()}`); };
    let changed = false;
    const learnSrc = (k) => { if (k && !K.src.has(k)) { K.src.add(k); changed = true; } };
    const learnPass = (k, i) => { if (!k) return; if (!K.pass.has(k)) K.pass.set(k, new Set()); if (!K.pass.get(k).has(i)) { K.pass.get(k).add(i); changed = true; } };
    const learnSet = (m, k, i) => { if (!m.has(k)) m.set(k, new Set()); if (!m.get(k).has(i)) { m.get(k).add(i); changed = true; } };
    const learnParam = (k, i) => { if (!K.params.has(k)) K.params.set(k, new Set()); if (!K.params.get(k).has(i)) { K.params.get(k).add(i); changed = true; } };
    for (let pass = 0; pass < 2; pass++) {
      const record = pass === 1;
      const scopes = [{ t: new Set(), p: new Map(), cb: new Map(), key: null }];   // t: tainted names; p: name → param index (pass-through); cb: name → [param index, prop]
      const cbOf = (name) => { for (let i = scopes.length - 1; i >= 0; i--) { if (scopes[i].cb.has(name)) return { key: scopes[i].key, at: scopes[i].cb.get(name) }; if (scopes[i].t.has(name) || scopes[i].p.has(name)) return null; } return null; };
      const lookup = (name) => { for (let i = scopes.length - 1; i >= 0; i--) { if (scopes[i].t.has(name)) return { t: true }; if (scopes[i].p.has(name)) return { p: scopes[i].p.get(name), key: scopes[i].key }; if (scopes[i].o && scopes[i].o.has(name)) return { o: scopes[i].o.get(name) }; } return null; };
      // value of an expression: { t } tainted, { p } the current function's p-th parameter, or null
      const val = (n) => {
        if (!n) return null;
        switch (n.type) {
          case 'Identifier': return lookup(n.name);
          case 'AwaitExpression': return val(n.argument);
          case 'ChainExpression': return val(n.expression);
          case 'LogicalExpression': {   // `a && b` is b (a falsy left is never the record); `a || b` / `a ?? b` is either
            if (n.operator === '&&') return val(n.right);
            const a = val(n.left), b = val(n.right); return (a && a.t) || (b && b.t) ? { t: true } : a || b;
          }
          case 'ConditionalExpression': { const a = val(n.consequent), b = val(n.alternate); return (a && a.t) || (b && b.t) ? { t: true } : a || b; }
          case 'AssignmentExpression': return val(n.right);
          case 'SequenceExpression': return val(n.expressions[n.expressions.length - 1]);
          case 'MemberExpression': {
            const o = !n.computed && n.property.type === 'Identifier' ? val(n.object) : null;
            if (!n.computed && n.property.type === 'Identifier' && n.property.name === 'record' && ((o && o.t) || isSource(n.object))) return { t: true };
            if (o && o.o && o.o.has(n.property.name)) return { t: true };
            return null;   // a sub-object of the record never holds the token (it is top-level)
          }
          case 'ObjectExpression': {   // an object holding the record under some keys
            const ks = new Set(); for (const q of n.properties) if (q.type === 'Property' && !q.computed && (q.key.type === 'Identifier' || q.key.type === 'Literal')) { const v = val(q.value); if (v && v.t) ks.add(q.key.name || String(q.key.value)); }
            return ks.size ? { o: ks } : null;
          }
          case 'CallExpression': {
            if (isSource(n)) return { t: true };
            const nm = calleeName(n.callee);
            if (nm === 'val' && n.callee.type === 'MemberExpression') { const o = n.callee.object; if (refOfSdk(o, src) || isSource(o)) return { t: true }; const v = val(o); if (v && v.t) return { t: true }; }
            if (calleeText(n.callee) === 'JSON.parse' && n.arguments[0] && n.arguments[0].type === 'CallExpression' && calleeText(n.arguments[0].callee) === 'JSON.stringify') return val(n.arguments[0].arguments[0]);
            const k = resolve(file, n.callee);
            if (k && K.src.has(k)) return { t: true };
            if (k && K.props.has(k)) return { o: K.props.get(k) };
            if (k && K.pass.has(k)) { let r = null; for (const i of K.pass.get(k)) { const a = val(n.arguments[i]); if (a && a.t) return { t: true }; if (a && !r) r = a; } return r; }
            return null;
          }
          default: return null;
        }
      };
      function isSource(n) {
        if (!n) return false;
        if (n.type === 'AwaitExpression') return isSource(n.argument);
        if (n.type !== 'CallExpression') return false;
        const nm = calleeName(n.callee);
        if (nm && SOURCE_FNS.has(nm)) return true;
        if ((nm === 'once' || nm === 'get') && n.callee.type === 'MemberExpression' && refOfSdk(n.callee.object, src)) return true;   // the snapshot
        return false;
      }
      const bind = (p, v) => {
        if (!p || !v) return;
        const top = scopes[scopes.length - 1];
        if (p.type === 'Identifier') { if (v.t) top.t.add(p.name); else if (v.o) { top.o = top.o || new Map(); top.o.set(p.name, v.o); } else if (v.p !== undefined && v.key === top.key) top.p.set(p.name, v.p); return; }
        if (p.type === 'ObjectPattern' && v.t) for (const q of p.properties) if (q.type === 'Property' && !q.computed && q.key.type === 'Identifier' && q.key.name === 'record') bind(q.value, v);
        if (p.type === 'ObjectPattern' && v.o) for (const q of p.properties) if (q.type === 'Property' && !q.computed && q.key.type === 'Identifier' && v.o.has(q.key.name)) bind(q.value, { t: true });
        if (p.type === 'AssignmentPattern') bind(p.left, v);
      };
      const curKey = () => scopes[scopes.length - 1].key;
      const paramTainted = (v) => v && v.p !== undefined && v.key && K.params.has(v.key) && K.params.get(v.key).has(v.p);
      const ret = (v) => { const k = curKey(); if (!v || !k) return; if (v.t) learnSrc(k); else if (v.o) for (const q of v.o) learnSet(K.props, k, q); else if (v.p !== undefined && v.key === k) learnPass(k, v.p); };
      const walk = (n, parent) => {
        if (record) {
          if (n.type === 'MemberExpression' && isKey(n.property, n.computed)) site('token', n);
          if (n.type === 'ObjectPattern') for (const q of n.properties) if (q.type === 'Property' && isKey(q.key, q.computed)) site('token', q);
          if (n.type === 'Property' && parent && parent.type === 'ObjectExpression' && isKey(n.key, n.computed)) site('token', n);
          if (n.type === 'Literal' && n.value === KEY && !(parent && ((parent.type === 'MemberExpression' && parent.property === n) || (parent.type === 'Property' && parent.key === n)))) site('token', n);
        }
        if (isFn(n)) {
          const nm = fnName(n, parent);
          const key = nm && S.get(file).defs.has(nm) && (parent && (parent.type === 'Program' || n.type === 'FunctionDeclaration' || parent.type === 'VariableDeclarator' || parent.type === 'Property' || parent.type === 'AssignmentExpression')) ? `${file}#${nm}` : null;
          const sc = { t: new Set(), p: new Map(), cb: new Map(), key };
          if (key) n.params.forEach((p, i) => { if (p.type === 'ObjectPattern') for (const q of p.properties) if (q.type === 'Property' && !q.computed && q.key.type === 'Identifier' && q.value.type === 'Identifier') sc.cb.set(q.value.name, [i, q.key.name]); });
          const cbt = K.cbNodes.get(`${file}@${n.start}`);
          if (cbt) n.params.forEach((p, i) => { if (cbt.has(i) && p.type === 'Identifier') sc.t.add(p.name); });
          const tp = key ? K.params.get(key) : null;
          // a parameter is ALWAYS a pass-through slot (a function returning it is not a source); it is ALSO tainted inside the body when
          // some caller passes a tainted value there (K.params) — sinks see that, returns do not
          n.params.forEach((p, i) => { const id = p.type === 'AssignmentPattern' ? p.left : p; if (id.type !== 'Identifier') return; if (key) sc.p.set(id.name, i); else if (tp && tp.has(i)) sc.t.add(id.name); });
          if (parent && parent.type === 'CallExpression' && n.params[0] && n.params[0].type === 'Identifier') {
            const c = calleeName(parent.callee);
            if ((c === 'casRecord' && parent.arguments[2] === n) || (c === 'transaction' && parent.callee.type === 'MemberExpression' && refOfSdk(parent.callee.object, src) && parent.arguments[0] === n)) sc.t.add(n.params[0].name);
          }
          scopes.push(sc);
          if (n.body.type !== 'BlockStatement') ret(val(n.body));
          walk(n.body, n);
          scopes.pop();
          return;
        }
        if (n.type === 'VariableDeclarator') bind(n.id, isSource(n.init) && n.id.type === 'ObjectPattern' ? { t: true } : val(n.init));
        if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') bind(n.left, val(n.right));
        if (n.type === 'ReturnStatement' && n.argument) ret(val(n.argument));
        const T = (x) => { const v = val(x); return !!(v && (v.t || paramTainted(v))); };
        if (record) {
          if (n.type === 'SpreadElement' && T(n.argument)) site('escape', n);
          if (n.type === 'ForInStatement' && T(n.right)) site('escape', n);
          if (n.type === 'MemberExpression' && n.computed && !(n.property.type === 'Literal' || (n.property.type === 'TemplateLiteral' && !n.property.expressions.length)) && T(n.object)) site('escape', n);
          if (n.type === 'Property' && parent && parent.type === 'ObjectExpression' && T(n.value)) site('escape', n);
          if (n.type === 'ArrayExpression' && n.elements.some((e) => e && e.type !== 'SpreadElement' && T(e))) site('escape', n);
        }
        if (n.type === 'CallExpression' || n.type === 'NewExpression') {
          const txt = calleeText(n.callee);
          const k = n.type === 'CallExpression' ? resolve(file, n.callee) : null;
          if (record && k && k.startsWith(`${OWNER}#`)) site('accessor', n);   // every reader / writer through the owner is a reviewed site too
          // a callback property: `f(...)` / `f.call(thisArg, ...)` where f is a destructured property of this function's parameter
          let cb = null; let shift = 0;
          if (n.type === 'CallExpression') {
            if (n.callee.type === 'Identifier') cb = cbOf(n.callee.name);
            else if (n.callee.type === 'MemberExpression' && !n.computed && n.callee.object.type === 'Identifier' && n.callee.property.type === 'Identifier' && n.callee.property.name === 'call') { cb = cbOf(n.callee.object.name); shift = 1; }
            if (cb && !cb.key) cb = null;
          }
          // a resolved call passing inline callbacks: taint the parameters the callee is known to feed the record to
          if (k) n.arguments.forEach((a, i) => { if (a.type === 'ObjectExpression') for (const q of a.properties) if (q.type === 'Property' && !q.computed && q.key.type === 'Identifier' && isFn(q.value)) { const t = K.cb.get(`${k}|${i}|${q.key.name}`); if (t) for (const j of t) learnSet(K.cbNodes, `${file}@${q.value.start}`, j); } });
          n.arguments.forEach((a, i) => {
            if (a.type === 'SpreadElement') return;
            const v = val(a);
            if (!v || !(v.t || paramTainted(v))) return;
            if (txt && SAFE_FNS.has(txt)) return;
            if (txt && ESCAPE_FNS.has(txt)) { if (record) site('escape', n); return; }
            if (k) { learnParam(k, i); return; }
            if (cb && i >= shift) { learnSet(K.cb, `${cb.key}|${cb.at[0]}|${cb.at[1]}`, i - shift); return; }
            if (record) site('escape', n);   // a whole-record forward to code the census cannot follow
          });
        }
        each(n, parent, walk);
      };
      walk(ast, null);
    }
    return changed;
  }
  for (let round = 0; ; round++) {
    let changed = false;
    for (const f of fileList) if (scan(f, null)) changed = true;
    if (!changed) break;
    if (round > 20) throw new Error('sdk-token-census: no fixpoint in 20 rounds');
  }
  const out = { token: [], escape: [], accessor: [] };
  for (const f of fileList) scan(f, out);
  return { token: out.token.sort(), escape: out.escape.sort(), accessor: out.accessor.sort(), sources: [...K.src].sort(), params: [...K.params].map(([k, v]) => `${k}(${[...v].sort()})`).sort() };
}

module.exports = { census, trackedFiles, OWNER, FN };
