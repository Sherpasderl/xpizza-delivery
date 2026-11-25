'use strict';
// RTDB ref-operation scan (PLAN-rtdb-get-once-race-r3 §2.4 / §3.1 / RG-FAMILY-DU). ONE static pass over production JS: every RTDB
// operation call — get / once / on / transaction / set / update / push / remove — with the PATH TEMPLATE of its receiver
// (`db.ref('a/' + x)` → 'a/{}', `ref.child(k)` appends, a same-function `const r = db.ref(...)` is followed). A receiver it cannot
// trace is reported as UNRESOLVED (never guessed); Firestore receivers (`.doc(` / `.collection(` chains) are skipped as FIRESTORE.
//   node tools/rtdb-ref-scan.js [--json] [--op get] [--path deleted_uids]      → the operations, one per line
//   require('./tools/rtdb-ref-scan').scan(files, root) → [{ file, line, op, path, how }]
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

// HAND RULINGS for receivers built by helpers IMPORTED from another file (the scan follows same-file helpers only). Keyed by the
// file and the receiver's exact source text (never a line number): a NEW unresolved receiver, or an edited one, is UNRESOLVED again.
const RULINGS = {
  'catalog/catalog-publish.js|sourceRefOf(db, rid)': { firestore: true },
  'catalog/context-source.js|contextRefOf(rtdb, rid)': { path: 'catalog_snapshot_ctx/{}' },
  'catalog/context-writer.js|activePointerRef(db, rid)': { firestore: true },
  'catalog/identity-record-writer.js|activePointerRef(needIo(io).db, rid)': { firestore: true },
  'catalog/portal-reads.js|_sourceRefOf(fsdb, rid)': { firestore: true },
  'catalog/publish-request.js|sourceRefOf(fs, rid)': { firestore: true },
  'catalog/reserved-keys-audit.js|idsColOf(db, rid, kind)': { firestore: true },
  'catalog/reserved-keys-audit.js|keysColOf(db, rid, kind)': { firestore: true },
  'catalog/reserved-keys-audit.js|sourceRefOf(db, rid)': { firestore: true },
  'contract/third-brand.js|sourceRefOf(fs, rid)': { firestore: true },
  'platform-config/source.js|sourceRef(fs, rid)': { firestore: true },
  'portal/functions.js|sourceRefOfForEdit(getFirestore(), rid)': { firestore: true },
  'catalog/add-product-io.js|readReservedKeys|RK.reservedRefOf(fs, rid)': { firestore: true },
  'catalog/catalog-firestore.js|readFlatDocs|rref': { firestore: true },
  'catalog/catalog-firestore.js|readVersionDocs|vref': { firestore: true },
  'catalog/catalog-menu.js|readFlatMenu|rref': { firestore: true },
  'catalog/catalog-menu.js|readVersionMenu|vref': { firestore: true },
  'catalog/catalog-publish.js|assertDraftPartition|vref': { firestore: true },
  'catalog/catalog-publish.js|previewVersion|vref': { firestore: true },
  'catalog/catalog-publish.js|serverNow|ref': { firestore: true },
  'catalog/edit-catalog-handler.js|editCatalogCore|hwmRef': { firestore: true },
  'catalog/edit-catalog-handler.js|editCatalogCore|ref': { firestore: true },
  'catalog/identity-bootstrap.js|bootstrapIdentityStamps|srcRef': { firestore: true },
  'catalog/identity-bootstrap.js|readActiveVersion|vref': { firestore: true },
  'catalog/identity-bootstrap.js|resolveKind|q': { firestore: true },
  "catalog/identity-record-writer.js|versionPage|q.limit(limit).select('seq')": { firestore: true },
  'catalog/identity-sweep.js|sweepIdentityIntegrity|q': { firestore: true },
  'catalog/portal-reads.js|getEditableCatalogCore|RK.reservedRefOf(fsdb, rid)': { firestore: true },
  'catalog/reset-draft.js|resetDraftToLiveCore|ref': { firestore: true },
  'catalog/seed-catalog-core.js|seedCatalog|col': { firestore: true },
  'stats/stats-store.js|readShards|ref': { firestore: true },
  'stats/stats-store.js|serverNow|ref': { firestore: true },
  // readCursor(ref): one of the four cursor refs (catalog_ctx_cursor/{rid}, catalog_ctx_restaurant_cursor, catalog_ctx_verify_cursor/{rid},
  // catalog_ctx_verify_restaurant_cursor) — audit row 8 / plan row 17
  'catalog/identity-record-writer.js|readCursor|ref': { path: 'catalog_ctx_cursor/{}' },
};
const OPS = new Set(['get', 'once', 'on', 'transaction', 'set', 'update', 'push', 'remove', 'setWithPriority']);
const FS_HINT = new Set(['doc', 'collection', 'collectionGroup', 'where', 'orderBy', 'limit', 'getAll', 'runTransaction', 'batch']);
const QUERY = new Set(['orderByChild', 'orderByKey', 'orderByValue', 'equalTo', 'startAt', 'endAt', 'startAfter', 'endBefore', 'limitToFirst', 'limitToLast']);

// a template from a path expression: literals kept, every dynamic part → {}
function tpl(n) {
  if (!n) return null;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral') return n.quasis.map((q, i) => q.value.cooked + (i < n.expressions.length ? '{}' : '')).join('');
  if (n.type === 'BinaryExpression' && n.operator === '+') { const a = tpl(n.left); const b = tpl(n.right); return (a == null ? '{}' : a) + (b == null ? '{}' : b); }
  return '{}';
}
const norm = (p) => (p == null ? null : String(p).replace(/\/+/g, '/').replace(/^\/|\/$/g, '').replace(/\{\}[^/]*\{\}/g, '{}'));

function walk(node, visit, parents = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parents);
  const next = parents.concat(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit, next));
    else if (v && typeof v.type === 'string') walk(v, visit, next);
  }
}
const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
// the innermost NAMED enclosing function (declaration / `const f = …` / an object method `k: …`) — rulings key on it
function fnName(parents) {
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i];
    if (p.type === 'FunctionDeclaration' && p.id) return p.id.name;
    if (FN.has(p.type)) {
      const up = parents[i - 1];
      if (up && up.type === 'VariableDeclarator' && up.id.type === 'Identifier') return up.id.name;
      if (up && up.type === 'Property' && up.key) return up.key.name || up.key.value;
      // an inline handler: exports.X = onRequest(opts, async (req, res) => …) / onSchedule(…) → X
      const call = up && up.type === 'CallExpression' ? up : null; const asg = call && parents[i - 2];
      if (asg && asg.type === 'AssignmentExpression' && asg.left.type === 'MemberExpression' && asg.left.object.name === 'exports') return `exports.${asg.left.property.name}`;
    }
  }
  return '(top)';
}

// the path of a RECEIVER expression → { path } | { firestore: true } | { unresolved: why }
function receiverPath(n, scopeVars, depth = 0, helpers = new Map()) {
  if (!n || depth > 12) return { unresolved: 'depth' };
  if (n.type === 'AwaitExpression' || n.type === 'ParenthesizedExpression') return receiverPath(n.argument || n.expression, scopeVars, depth + 1, helpers);
  if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed) {
    const m = n.callee.property.name;
    if (m === 'ref') return n.arguments.length ? { path: norm(tpl(n.arguments[0])) } : { path: '' };
    if (m === 'child') { const b = receiverPath(n.callee.object, scopeVars, depth + 1, helpers); return b.path != null ? { path: norm(`${b.path}/${tpl(n.arguments[0])}`) } : b; }
    if (QUERY.has(m)) { const b = receiverPath(n.callee.object, scopeVars, depth + 1, helpers); return b.path != null ? { ...b, query: true } : b; }
    if (FS_HINT.has(m)) return { firestore: true };
    return { unresolved: `call .${m}()` };
  }
  // a same-file HELPER returning a ref (const nodeRef = (gr) => db.ref(`x/${gr}`) / function metaRef(…) { return …; }): its returned
  // expression, parameters as {} — one helper deep per hop
  if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && helpers.has(n.callee.name)) return receiverPath(helpers.get(n.callee.name), scopeVars, depth + 1, helpers);
  if (n.type === 'Identifier' && scopeVars.has(n.name)) return receiverPath(scopeVars.get(n.name), scopeVars, depth + 1, helpers);
  if (n.type === 'Identifier') return { unresolved: `identifier ${n.name}` };
  if (n.type === 'MemberExpression') return { unresolved: 'member' };
  return { unresolved: n.type };
}

// the KEY templates of an update(obj): an object literal's keys, or — for an identifier — its same-function literal init keys plus every
// `obj[k] = …` / `obj.k = …` assignment; a spread / an untraceable object ⇒ ['{UNRESOLVED}'] (ruled by hand)
const keyOf = (k, computed) => (computed ? tpl(k) : (k.type === 'Identifier' ? k.name : String(k.value)));
function updateKeys(arg, parents) {
  if (!arg) return ['{UNRESOLVED}'];
  const fromObject = (o) => o.properties.map((p) => (p.type === 'SpreadElement' ? '{UNRESOLVED}' : keyOf(p.key, p.computed)));
  if (arg.type === 'ObjectExpression') return fromObject(arg);
  if (arg.type !== 'Identifier') return ['{UNRESOLVED}'];
  let fnBody = null; for (let i = parents.length - 1; i >= 0; i--) if (FN.has(parents[i].type)) { fnBody = parents[i].body; break; }
  if (!fnBody) return ['{UNRESOLVED}'];
  const keys = []; let seen = false;
  walk(fnBody, (d) => {
    if (d.type === 'VariableDeclarator' && d.id.type === 'Identifier' && d.id.name === arg.name && d.init) { seen = true; if (d.init.type === 'ObjectExpression') keys.push(...fromObject(d.init)); else keys.push('{UNRESOLVED}'); }
    if (d.type === 'AssignmentExpression' && d.left.type === 'MemberExpression' && d.left.object.type === 'Identifier' && d.left.object.name === arg.name) keys.push(keyOf(d.left.property, d.left.computed));
    if (d.type === 'CallExpression' && d.callee.type === 'MemberExpression' && d.callee.object.type === 'Identifier' && d.callee.object.name === 'Object' && d.callee.property.name === 'assign' && d.arguments[0] && d.arguments[0].type === 'Identifier' && d.arguments[0].name === arg.name) keys.push('{UNRESOLVED}');
  });
  return seen || keys.length ? [...new Set(keys.map((k) => norm(k)))] : ['{UNRESOLVED}'];
}

function scanFile(file, root) {
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true, allowReturnOutsideFunction: true }); }
  catch (e) { return [{ file: path.relative(root, file), line: 0, op: 'PARSE', path: null, how: e.message }]; }
  const out = [];
  const helpers = new Map();
  const retOf = (fn) => { if (!fn) return null; if (fn.body && fn.body.type !== 'BlockStatement') return fn.body; const st = fn.body && fn.body.body; if (st && st.length === 1 && st[0].type === 'ReturnStatement') return st[0].argument; return null; };
  walk(ast, (d) => {
    if (d.type === 'FunctionDeclaration' && d.id) { const r = retOf(d); if (r) helpers.set(d.id.name, r); }
    if (d.type === 'VariableDeclarator' && d.id.type === 'Identifier' && d.init && FN.has(d.init.type)) { const r = retOf(d.init); if (r) helpers.set(d.id.name, r); }
  });
  // same-function const/let bindings of ref expressions (r = db.ref(...) / r = x.child(...))
  const varsOf = (parents) => {
    const vars = new Map();
    for (const p of parents) {
      const body = FN.has(p.type) ? p.body : (p.type === 'Program' ? p : null);
      if (!body) continue;
      walk(body, (d) => { if (d.type === 'VariableDeclarator' && d.id.type === 'Identifier' && d.init && d.init.type === 'CallExpression' && d.init.callee.type === 'MemberExpression' && ['ref', 'child'].includes(d.init.callee.property && d.init.callee.property.name)) vars.set(d.id.name, d.init); });
    }
    return vars;
  };
  walk(ast, (n, parents) => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.computed) return;
    const op = n.callee.property.name;
    if (!OPS.has(op)) return;
    if (op === 'get' && n.arguments.length) return;                       // Map#get / headers get(k): an RTDB get takes no arguments
    if (op === 'on' && !(n.arguments[0] && n.arguments[0].type === 'Literal' && /^(value|child_)/.test(n.arguments[0].value))) return;
    if (op === 'once' && !(n.arguments[0] && n.arguments[0].type === 'Literal' && /^(value|child_)/.test(n.arguments[0].value))) return;
    if (op === 'push' && !(n.callee.object.type === 'CallExpression' || n.callee.object.type === 'Identifier')) return;
    let r = receiverPath(n.callee.object, varsOf(parents), 0, helpers);
    const fn = fnName(parents); const text = src.slice(n.callee.object.start, n.callee.object.end); const rel = path.relative(root, file);
    if (r.unresolved) { const ru = RULINGS[`${rel}|${text}`] || RULINGS[`${rel}|${fn}|${text}`]; if (ru) r = ru; }
    if (r.firestore) return;
    // a zero-argument .get() on an untraceable receiver (a parameter, a member) IS reported (UNRESOLVED, ruled by hand): an RTDB read
    // must never vanish from the inventory because its ref arrived as an argument (identity-record-writer readCursor(ref))
    if (r.unresolved && ['set', 'update', 'push', 'remove'].includes(op) && !/call \.(ref|child)/.test(r.unresolved)) {
      // set/update/push/remove/get on an arbitrary receiver (Map, Set, array, Firestore doc ref held in a variable…) — reported
      // only when the receiver is VISIBLY an RTDB ref; anything else is not this scan's business
      if (r.unresolved.startsWith('identifier') || r.unresolved === 'member' || r.unresolved.startsWith('call')) return;
    }
    const row = { file: path.relative(root, file), line: n.loc.start.line, fn, op, path: r.path != null ? r.path : null, how: r.path != null ? (r.query ? 'query' : 'ref') : `UNRESOLVED ${r.unresolved}` };
    if (op === 'update' && r.path != null) row.keys = updateKeys(n.arguments[0], parents);   // multipath: each key is a written path under the receiver
    out.push(row);
  });
  return out;
}

const SKIP = /(^|\/)(node_modules|test|tests|tools|scripts|deploy|coverage|contract)(\/|$)|(^|\/)catalog\/identity-fixture\.js$|\.test\.(js|mjs)$|(^|\/)_[^/]*\.js$|-fake\.js$|fake-db\.js$/;
function productionFiles(root) {
  const files = [];
  const rec = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const rel = path.relative(root, p); if (SKIP.test(rel)) continue; if (e.isDirectory()) rec(p); else if (e.name.endsWith('.js')) files.push(p); } };
  rec(root);
  return files.sort();
}
function scan(files = null, root = path.join(__dirname, '..')) { return (files || productionFiles(root)).flatMap((f) => scanFile(f, root)); }

module.exports = { scan, scanFile, productionFiles, tpl, norm };

if (require.main === module) {
  const a = process.argv.slice(2); const flag = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  let rows = scan();
  if (flag('--op')) rows = rows.filter((r) => r.op === flag('--op'));
  if (flag('--path')) rows = rows.filter((r) => r.path && r.path.startsWith(flag('--path')));
  if (a.includes('--json')) console.log(JSON.stringify(rows, null, 1));
  else for (const r of rows) console.log(`${r.file}:${r.line}\t${r.op}\t${r.path == null ? '-' : r.path}\t${r.how}`);
}
