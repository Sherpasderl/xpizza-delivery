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

// (b) SOURCE inventory: every `exports.X = …` / `module.exports.X = …` at any depth of index.js. A right-hand side that
// is an Identifier or a member of one is resolved through that identifier's TOP-LEVEL binding (const X = require('m') →
// a re-export; const f = onRequest(…) → that constructor; a function / any other value → not an endpoint).
function sourceInventory(file = INDEX) {
  const ast = parse(file);
  const out = []; const unclassified = [];
  const bindings = new Map();   // top-level name → init node | 'function'
  for (const st of ast.body) {
    if (st.type === 'FunctionDeclaration' && st.id) bindings.set(st.id.name, 'function');
    if (st.type === 'VariableDeclaration') for (const d of st.declarations) if (d.id.type === 'Identifier') bindings.set(d.id.name, d.init);
  }
  const baseOf = (n) => { const chain = []; while (n && n.type === 'MemberExpression' && !n.computed) { chain.unshift(n.property.name); n = n.object; } return n && n.type === 'Identifier' ? { id: n.name, chain } : null; };
  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && !node.left.computed) {
      const obj = node.left.object;
      const isExports = (obj.type === 'Identifier' && obj.name === 'exports') || (obj.type === 'MemberExpression' && obj.object.type === 'Identifier' && obj.object.name === 'module' && obj.property.name === 'exports');
      if (isExports) {
        const name = node.left.property.name; const r = node.right; const line = node.loc.start.line;
        if (r.type === 'CallExpression' && CTOR_CATEGORY[calleeName(r.callee)]) {
          const ctor = calleeName(r.callee);
          const opts = r.arguments[0];
          let ref = null;
          if (opts && opts.type === 'ObjectExpression') { const p = opts.properties.find((q) => q.key && (q.key.name === 'ref' || q.key.value === 'ref')); if (p && p.value.type === 'Literal') ref = p.value.value; }
          out.push({ name, line, how: 'direct', category: CTOR_CATEGORY[ctor], kind: DB_KIND[ctor] || null, ref: ref ? normRef(ref) : null });
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
    }
    for (const k of Object.keys(node)) { const v = node[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v); }
  })(ast);
  // classify re-exports by loading the required module's export (its own endpoint)
  for (const e of out.filter((x) => x.how === 'reexport')) {
    let v = require(path.resolve(path.dirname(file), e.module));
    for (const k of e.chain) v = v == null ? v : v[k];
    const cls = classifyRuntime(v);
    Object.assign(e, cls || { category: 'not-endpoint' });
  }
  return { entries: out, unclassified };
}

const normRef = (r) => String(r).replace(/^\/+/, '');

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

module.exports = { sourceInventory, runtimeInventory, classifyRuntime, compare, dbTriggers, INDEX };
