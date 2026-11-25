'use strict';
// RTDB in-flight-get gate: COMPLETENESS guard (PLAN-rtdb-get-once-race r7 §4 + r9 §3, Codex #403). A fresh tools/rtdb-ref-scan.js
// pass over production is compared against the REVIEWED manifest tools/rtdb-gate-manifest.json: one row per RTDB read op (get / once /
// on) on a gated path family or an ANCESTOR of one, keyed file | function | op | path, with its disposition and count:
//   GATED-GET / GATED-LISTEN  — must go through lib/rtdb-gate (gatedGet / afterGets)
//   SAFE / RETAIN-GET / ANCESTOR — reviewed: no gated get on its path or an ancestor in any deployed function that reaches it, or an
//                                ancestor listener / a get no listener overlaps (r9/listener-classification.md, the r3 audit)
// plus, per ruled function, its CALLER FINGERPRINT (r9 §3, Codex #404 P2): every call PATH from a deployed entry (a function nothing
// calls: an export / a route / a trigger) down to it, «entry > … > fn», through same-file calls and require / destructured /
// inline-require imports (and M.fn.call / .apply). RED when: a scanned op is not in the manifest (new / moved / renamed), a row is
// stale, a GATED row is not gated, an op is UNRESOLVED, counts differ, any ruled function's call paths changed (a new caller of
// liveCheckoutProbe, an import-renamed caller, a caller in another module, a TRANSITIVE caller such as memberUidOf() added to
// verifyOtp ⇒ re-review), or a call edge on such a path cannot be resolved (M[k](), require(expr)) without a hand ruling in
// UNRESOLVED_EDGE_RULINGS. `--write` regenerates after a REVIEW.
//   node tools/rtdb-gate.guard.test.js [--write]
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const S = require('./rtdb-ref-scan');
const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(__dirname, 'rtdb-gate-manifest.json');

// the gated path families (r9 §2): a row is in scope when its path is under one of these, or is an ANCESTOR of one
const FAMILIES = ['orders/{}', 'payment_attempts/{}', 'deleted_uids/{}', 'restaurants/{}/identity/brand_id', 'user_rewards/{}/{}/reservations/{}', 'user_profiles/{}'];
const seg = (p) => String(p || '').split('/').filter(Boolean);
const segEq = (a, b) => a === b || a === '{}' || b === '{}';
const under = (q, p) => { const Q = seg(q), P = seg(p); if (Q.length < P.length) return false; for (let i = 0; i < P.length; i++) if (!segEq(Q[i], P[i])) return false; return true; };
const inScope = (p) => p != null && FAMILIES.some((f) => under(p, f) || under(f, p));
const keyOf = (r) => `${r.file}|${r.fn}|${r.op}|${r.path}`;

// ── the caller graph (direct edges; fingerprints walk it to the entries) ────────────────────────────────────────────────────────────────────
function callGraph(files) {
  const callers = new Map();   // 'file|fn' → Set('file|caller')
  const unresolved = new Map();   // 'file|caller' → Set('<what> @file:line') — a call edge that cannot be resolved statically
  const resolveMod = (from, spec) => { if (!/^\.\.?\//.test(spec)) return null; let f = path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, from)), spec)); if (!f.endsWith('.js')) f += '.js'; return f; };
  const fnName = (ps) => { for (let i = ps.length - 1; i >= 0; i--) { const p = ps[i]; if (p.type === 'FunctionDeclaration' && p.id) return p.id.name;
    if (['FunctionExpression', 'ArrowFunctionExpression'].includes(p.type)) { const up = ps[i - 1]; if (up && up.type === 'VariableDeclarator' && up.id.type === 'Identifier') return up.id.name; if (up && up.type === 'Property' && up.key) return up.key.name || up.key.value;
      const call = up && up.type === 'CallExpression' ? up : null; const asg = call && ps[i - 2]; if (asg && asg.type === 'AssignmentExpression' && asg.left.type === 'MemberExpression' && asg.left.object.name === 'exports') return `exports.${asg.left.property.name}`;
      if (call && call.callee.type === 'MemberExpression' && !call.callee.computed && call.callee.object.type === 'Identifier' && ['all', 'post', 'get', 'use', 'put'].includes(call.callee.property.name)) return `${call.callee.object.name}.${call.callee.property.name}`; } }
    return '(top)'; };
  for (const abs of files) {
    const file = path.relative(ROOT, abs); const src = fs.readFileSync(abs, 'utf8');
    let ast; try { ast = acorn.parse(src, { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowReturnOutsideFunction: true }); } catch (_) { continue; }
    const mods = new Map(); const named = new Map();   // X → module ; a → [module, exportName]
    const reqOf = (n) => (n && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments[0] && typeof n.arguments[0].value === 'string' ? resolveMod(file, n.arguments[0].value) : null);
    (function walk(n) { if (!n || typeof n.type !== 'string') return;
      if (n.type === 'VariableDeclarator' && n.init) { const m = reqOf(n.init); if (m) { if (n.id.type === 'Identifier') mods.set(n.id.name, m); else if (n.id.type === 'ObjectPattern') for (const pr of n.id.properties) if (pr.type === 'Property' && pr.value.type === 'Identifier') named.set(pr.value.name, [m, pr.key.name || pr.key.value]); } }
      for (const k of Object.keys(n)) { if (k === 'loc') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); } })(ast);
    const odd = (caller, what, n) => { if (!unresolved.has(caller)) unresolved.set(caller, new Set()); unresolved.get(caller).add(`${what} @${file}:${n.loc.start.line}`); };
    const add = (target, caller) => { if (!callers.has(target)) callers.set(target, new Set()); callers.get(target).add(caller); };
    (function walk(n, ps) { if (!n || typeof n.type !== 'string') return;
      if (n.type === 'CallExpression') {
        const c = n.callee; const me = `${file}|${fnName(ps)}`;
        if (c.type === 'Identifier') { if (named.has(c.name)) { const [m, e] = named.get(c.name); add(`${m}|${e}`, me); } else add(`${file}|${c.name}`, me); }
        else if (c.type === 'MemberExpression' && !c.computed) { const o = c.object; const m = o.type === 'Identifier' ? mods.get(o.name) : reqOf(o); if (m) add(`${m}|${c.property.name}`, me);
          // M.fn.call(…) / M.fn.apply(…) / M.fn.bind(…)(…) is a call of M.fn
          else if (['call', 'apply', 'bind'].includes(c.property.name) && o.type === 'MemberExpression' && !o.computed && o.object.type === 'Identifier' && mods.has(o.object.name)) add(`${mods.get(o.object.name)}|${o.property.name}`, me);
          else if (o.type === 'MemberExpression' && o.computed && o.object.type === 'Identifier' && mods.has(o.object.name)) odd(me, `${o.object.name}[…].${c.property.name}()`, n); }
        else if (c.type === 'MemberExpression' && c.computed && !(c.property.type === 'Literal')) { const o = c.object; odd(me, `${o.type === 'Identifier' ? o.name : o.type === 'MemberExpression' && !o.computed ? `…${o.property.name}` : reqOf(o) ? 'require(…)' : '(expr)'}[…]()`, n); }
        if (c.type === 'Identifier' && c.name === 'require' && n.arguments[0] && !(n.arguments[0].type === 'Literal' && typeof n.arguments[0].value === 'string')) odd(me, 'require(<computed>)', n);
      }
      for (const k of Object.keys(n)) { if (k === 'loc') continue; const v = n[k]; if (Array.isArray(v)) v.forEach((x) => walk(x, ps.concat(n))); else if (v && typeof v.type === 'string') walk(v, ps.concat(n)); } })(ast, []);
  }
  return { callers, unresolved };
}

// every call path from an entry (a node with no callers) down to f, as «entry > … > f» (cycle-safe: a node never repeats on a path)
function callPaths(callers, f) {
  const out = new Set();
  (function up(node, chain) {
    const cs = [...(callers.get(node) || [])].filter((c) => !chain.includes(c));
    if (!cs.length) { out.add([...chain].reverse().join(' > ')); return; }
    for (const c of cs) up(c, chain.concat(c));
  })(f, [f]);
  return [...out].sort();
}
// the hand-ruled unresolved edges ('file|caller' → the reviewed set of '<what> @file:line') (Codex #404 P2). Each is a REVIEW: a new
// or moved computed call on a fingerprint path is red until it is ruled here.
const UNRESOLVED_EDGE_RULINGS = {
  // handlerOf(name) = makeHandlers(deps)[name](…): the deployed SDK exports (placeSdkStatus, listCards, …) each pass their OWN
  // literal name into the ONE handler table, whose handlers are attributed to the node endpoints.js|makeHandlers (handlerOf → makeHandlers
  // is a resolved edge); a new table entry that calls a ruled function adds a makeHandlers edge ⇒ RG-FINGERPRINT red
  'payments/sdk/functions.js|handlerOf': ['(expr)[…]() @payments/sdk/functions.js:32'],
};

function current() {
  const files = S.productionFiles(ROOT);
  const rows = S.scan(files, ROOT).filter((r) => ['get', 'once', 'on'].includes(r.op) && (inScope(r.path) || /UNRESOLVED/.test(r.how)));
  const ops = {}; for (const r of rows) { const k = keyOf(r); ops[k] = ops[k] || { count: 0, gated: 0, unresolved: /UNRESOLVED/.test(r.how) }; ops[k].count += 1; if (r.gated) ops[k].gated += 1; }
  const { callers, unresolved } = callGraph(files);
  const fns = [...new Set(rows.map((r) => `${r.file}|${r.fn}`))].sort();
  const fingerprints = Object.fromEntries(fns.map((f) => [f, callPaths(callers, f)]));
  // an unresolvable edge in any function ON a fingerprint path (or in a ruled function itself) is red unless hand-ruled
  const onPath = new Set(); for (const ps of Object.values(fingerprints)) for (const p of ps) for (const x of p.split(' > ')) onPath.add(x);
  const odd = {}; for (const x of [...onPath].sort()) if (unresolved.has(x)) { const ruled = new Set(UNRESOLVED_EDGE_RULINGS[x] || []); const left = [...unresolved.get(x)].filter((w) => !ruled.has(w)).sort(); if (left.length) odd[x] = left; }
  return { ops, fingerprints, odd };
}

function disposition(k, o, prev) {
  if (prev && prev.ops[k] && prev.ops[k].disposition) return prev.ops[k].disposition;   // a reviewed row keeps its reviewed disposition
  if (o.gated === o.count) return k.split('|')[2] === 'get' ? 'GATED-GET' : 'GATED-LISTEN';
  const p = k.split('|')[3];
  if (FAMILIES.some((f) => under(f, p) && seg(f).length > seg(p).length)) return k.split('|')[2] === 'get' ? 'ANCESTOR-GET: reviewed (r3 audit RETAIN / class P)' : 'ANCESTOR: an ancestor listener is clean (RG-ANC)';
  return k.split('|')[2] === 'get' ? 'RETAIN-GET: r3 audit RETAIN / dropped row (no listener overlap in its functions)' : 'SAFE: no shared deployed function with a gated get on its path or an ancestor (r9/listener-classification.md)';
}

if (process.argv.includes('--write')) {
  const prev = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : null;
  const cur = current(); const ops = {};
  if (Object.keys(cur.odd).length) throw new Error(`UNRESOLVED call edges on fingerprint paths: ${JSON.stringify(cur.odd)} — hand-rule them in UNRESOLVED_EDGE_RULINGS first`);
  for (const [k, o] of Object.entries(cur.ops)) { if (o.unresolved) throw new Error(`UNRESOLVED op ${k}: add a hand ruling in rtdb-ref-scan.js first`); ops[k] = { count: o.count, disposition: disposition(k, o, prev) }; }
  fs.writeFileSync(MANIFEST, `${JSON.stringify({ _doc: 'GENERATED by tools/rtdb-gate.guard.test.js --write after a REVIEW (PLAN-rtdb-get-once-race r9). Dispositions are reviewed; a new / moved op or a changed fingerprint is red until re-reviewed.', ops, fingerprints: cur.fingerprints }, null, 1)}\n`);
  console.log(`wrote ${path.relative(ROOT, MANIFEST)}: ${Object.keys(ops).length} ops, ${Object.keys(cur.fingerprints).length} fingerprints`);
  process.exit(0);
}

let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const M = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); const cur = current();
cell('RG-MANIFEST-RESOLVED: every in-scope op resolves (an UNRESOLVED receiver needs a hand ruling)', (L) => {
  assert.deepStrictEqual(Object.entries(cur.ops).filter(([, o]) => o.unresolved).map(([k]) => k), [], `🔴 ${L}`);
});
cell('RG-MANIFEST-COMPLETE: every scanned in-scope op is a reviewed manifest row, with the reviewed count (new / moved / renamed ops are red)', (L) => {
  const bad = Object.entries(cur.ops).filter(([k, o]) => !o.unresolved && (!M.ops[k] || M.ops[k].count !== o.count)).map(([k, o]) => `${k} ×${o.count}${M.ops[k] ? ` (manifest ×${M.ops[k].count})` : ' (not in the manifest)'}`);
  assert.deepStrictEqual(bad, [], `🔴 ${L}`);
});
cell('RG-MANIFEST-STALE: no manifest row is stale', (L) => {
  assert.deepStrictEqual(Object.keys(M.ops).filter((k) => !cur.ops[k]), [], `🔴 ${L}`);
});
cell('RG-GATED-SITES: every GATED row goes through the gate (gatedGet / afterGets), every occurrence', (L) => {
  const bad = Object.entries(M.ops).filter(([k, m]) => /^GATED/.test(m.disposition) && cur.ops[k] && cur.ops[k].gated !== cur.ops[k].count).map(([k]) => k);
  assert.deepStrictEqual(bad, [], `🔴 ${L}`);
});
cell('RG-FINGERPRINT-RESOLVED: every call edge on a fingerprint path resolves (M[k](), require(expr) need a hand ruling)', (L) => {
  assert.deepStrictEqual(cur.odd, {}, `🔴 ${L}: ${JSON.stringify(cur.odd)}`);
});
cell('RG-FINGERPRINT: every ruled function\'s deployed-entry call paths are the reviewed ones (a new / renamed / moved / transitive caller re-opens the review)', (L) => {
  const bad = [];
  for (const [f, callers] of Object.entries(M.fingerprints)) { const now = cur.fingerprints[f] || []; if (JSON.stringify(now) !== JSON.stringify(callers)) bad.push(`${f}: +[${now.filter((c) => !callers.includes(c)).join(', ')}] -[${callers.filter((c) => !now.includes(c)).join(', ')}]`); }
  for (const f of Object.keys(cur.fingerprints)) if (!(f in M.fingerprints)) bad.push(`${f}: not fingerprinted`);
  assert.deepStrictEqual(bad, [], `🔴 ${L}`);
});
if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
console.log(`rtdb-gate.guard: OK (${n}) — ${Object.keys(M.ops).length} reviewed ops, ${Object.keys(M.fingerprints).length} fingerprinted functions`);
