'use strict';
// Soundness guard for write-provenance's COMMON 'now' (advisor ruling 2026-11-07, condition 1; Codex MEDIUM r1 → a WHITELIST;
// r2: computed class members, alias reassignment, call results — `clock` bindings are guarded too, so `X.now()` / `X.clock()`
// are timestamps by induction; a positional now / clock that its body CALLS must be a verified forward of a guarded name;
// r3: destructuring targets, a positional now / clock escaping as a shorthand `{ now }`, recursive forward proofs).
//
// THREAT MODEL (advisor 2026-11-07): this guard protects the census against ACCIDENTAL writer naming in OUR code — a function
// that writes an order, or a value that can become one, given the name `now` / `clock` and thereby skipped by the census. It
// does NOT try to defeat adversarial obfuscation (eval, Function, Proxy, Reflect, prototype tricks, cross-file data flow through
// option bags): those forms are out of scope by design. A new exotic form found later is handled by a REVIEWED exception here
// (exact file + anchor + reason), not by extending the analysis into an arms race.
// COMMON means "a call named `now` is a library clock — never followed". That is sound only while EVERY binding named `now`
// in the census scope is exactly one of:
//   CLOCK  — a function of an allowed pure-clock shape (() => Date.now(), () => <number>, () => new Date().toISOString(),
//            () => (X.now ? X.now() : Date.now()), function () { return Date.now(); });
//   CLOCKREF — a reference to a clock (Date.now, X.now || Date.now, X.now || (() => Date.now()));
//   DATA   — a timestamp value (Date.now(), X.now(), now(), X.clock(), X.now ? X.now() : Date.now(), (X.now || Date.now)(),
//            new Date().toISOString(), ServerValue.TIMESTAMP, a number literal, null, a timestamp member such as op.at,
//            an object / Set value, or an identifier whose declarations in its file are all DATA, a CLOCK, or parameters);
//   a REVIEWED exception (exact file + source text below; any change to the text re-opens it).
// Anything else — an aliased / unresolved function, a getter or setter, a computed key, a class field, an assignment of a
// non-clock — FAILS CLOSED. Negatives prove each refusal. Run: node contract/now-clock.guard.test.js
const assert = require('assert');
const C = require('./census');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const REVIEWED = Object.freeze({
  'xpizza-functions/branches/branch-store.js::clk()': 'clk is the injected clock of branch-store (a timestamp value)',
  'xpizza-functions/merchant/_fake-db.js::get(path)': 'the merchant fake database reads a stored timestamp',
  'xpizza-functions/stats/stats-store.js::await serverNow(db, rid)': 'the RTDB server-time read (a timestamp value)',
  'xpizza-functions/access/membership-admin-core.js::{ ...(await operationResults(db, uid, rid, authorizeCatalogEdit)), ...(await deviceResults(db, uid, rid, authorizeManager)) }': 'a results OBJECT named now (not callable)',
  'xpizza-functions/phone/flag.js::_clock()': 'the module clock of the phone flag (Date.now unless a test installs one once)',
  'xpizza-functions/cancel-order-core.js::positional now@healLedgerRepair': 'a timestamp: its only caller (same file) forwards the sweep\'s timestamp now into option bags of the reward reversals',
  'xpizza-functions/materialize-guard.js::positional now@holdIfClosedAtMaterialize': 'a timestamp: confirmAndMaterialize and the manual resolve pass their timestamp now; it reaches option bags as data',
  'xpizza-functions/pixelpay-hosted-webhook.js::positional now@handleHostedCallback': 'a timestamp: index.js passes Date.now()',
  'xpizza-functions/scheduled-release-core.js::positional now@finalizeRelease': 'a timestamp: releaseOne / recoverStaleReleasing (same file) forward their timestamp now (the sweep\'s Date.now())',
  'xpizza-functions/branches/branches-admin-core.js::pattern nowMs→now@runBranchesAdmin': 'the CLI passes a millisecond timestamp under nowMs',
  'xpizza-functions/superseded-capture.js::positional clock@acquireLease': 'exported for its tests; the only production call (the same file) forwards the guarded `clock`',
  'xpizza-functions/stats/stats-fixtures.js::param at@71': 'the fixture materialize helper: its callers pass timestamp numbers',
  'xpizza-functions/stats/stats-gen.js::T.dayStartMs(date) + Math.floor(r() * 86400000)': 'a synthetic fixture timestamp',
});
// the guarded names: `now` (write-provenance COMMON) and `clock` (so a call `X.clock()` is a timestamp by the same induction)
const NAMES = new Set(['now', 'clock']);
const DATA_MEMBERS = new Set(['op.at', 'sample.at', 'opts.now', 'ServerValue.TIMESTAMP']);

const srcOf = (u, x) => u.code.slice(x.start, x.end).replace(/\s+/g, ' ').trim();
const isDateNowCall = (x) => x && x.type === 'CallExpression' && x.arguments.length === 0 && x.callee.type === 'MemberExpression' && !x.callee.computed && x.callee.object.type === 'Identifier' && x.callee.object.name === 'Date' && x.callee.property.name === 'now';
const isDateNowRef = (x) => x && x.type === 'MemberExpression' && !x.computed && x.object.type === 'Identifier' && x.object.name === 'Date' && x.property.name === 'now';
const isMemberNow = (x) => x && x.type === 'MemberExpression' && !x.computed && x.object.type === 'Identifier' && x.property.name === 'now';
const isNumLit = (x) => x && x.type === 'Literal' && typeof x.value === 'number';
// X.now ? X.now() : Date.now()   (the same X both times)
const isDelegate = (x) => x && x.type === 'ConditionalExpression' && isMemberNow(x.test) && x.consequent.type === 'CallExpression' && x.consequent.arguments.length === 0 && isMemberNow(x.consequent.callee) && x.consequent.callee.object.name === x.test.object.name && isDateNowCall(x.alternate);
const isNewDateIso = (x) => x && x.type === 'CallExpression' && x.arguments.length === 0 && x.callee.type === 'MemberExpression' && !x.callee.computed && x.callee.property.name === 'toISOString' && x.callee.object.type === 'NewExpression' && x.callee.object.callee.type === 'Identifier' && x.callee.object.callee.name === 'Date' && x.callee.object.arguments.length === 0;
const clockBody = (b) => isDateNowCall(b) || isNumLit(b) || isDelegate(b) || isNewDateIso(b);
function isClockFn(f) {
  if (!f || !/Function/.test(f.type) || f.params.length || f.async || f.generator) return false;
  if (f.type === 'ArrowFunctionExpression' && f.expression) return clockBody(f.body);
  const b = f.body && f.body.body;
  return Array.isArray(b) && b.length === 1 && b[0].type === 'ReturnStatement' && clockBody(b[0].argument);
}
const isNamedRef = (x) => x && x.type === 'MemberExpression' && !x.computed && NAMES.has(x.property.name);   // X.now / X.clock — itself guarded
const isClockRef = (x) => isDateNowRef(x) || isNamedRef(x) || (x && x.type === 'LogicalExpression' && x.operator === '||' && isMemberNow(x.left) && (isDateNowRef(x.right) || isClockFn(x.right)));
function isDataExpr(x) {
  if (!x) return false;
  if (isNumLit(x) || (x.type === 'Literal' && x.value === null) || isDateNowCall(x) || isDelegate(x) || isNewDateIso(x)) return true;
  if (x.type === 'CallExpression' && x.arguments.length === 0) {
    const c = x.callee;
    if (c.type === 'Identifier' && NAMES.has(c.name)) return true;                                       // now() / clock(): every such binding is guarded here
    if (c.type === 'MemberExpression' && !c.computed && ['now', 'clock'].includes(c.property.name)) return true;   // X.now() / X.clock()
    if (isClockRef(c)) return true;                                                                       // (X.now || Date.now)()
  }
  if (x.type === 'MemberExpression' && !x.computed) return DATA_MEMBERS.has(`${x.object.type === 'Identifier' ? x.object.name : '?'}.${x.property.name}`);
  if (x.type === 'ConditionalExpression') return isDataExpr(x.consequent) && isDataExpr(x.alternate);
  if (x.type === 'NewExpression' && x.callee.type === 'Identifier' && x.callee.name === 'Set') return true;
  return false;
}

// every binding named `now`: [{ where, kind, value, unit }]
function bindings(units) {
  const out = []; const declsByName = new Map(); const assignsByName = new Map();
  const scopes = (ast) => { const fs = []; C.walk(ast, (x) => { if (/Function/.test(x.type)) fs.push([x.start, x.end]); }); return fs; };
  const innermost = (fs, pos) => fs.filter(([a, b]) => a <= pos && pos < b).reduce((m, r) => (!m || r[0] > m[0] ? r : m), null) || [-1, Infinity];
  const keyNow = (k, computed) => (!computed && k && (NAMES.has(k.name) || NAMES.has(k.value))) || (computed && k && ((k.type === 'Literal' && NAMES.has(k.value)) || (k.type === 'TemplateLiteral' && !k.expressions.length && NAMES.has(k.quasis[0].value.cooked))));
  for (const u of units) {
    const ast = C.parseUnit(u); const fs = scopes(ast);
    // (positional-parameter helpers below)
    // a NAMED function declared once whose name is used ONLY as the callee of direct calls in its file, every one passing a
    // guarded name (now / clock) at index i: its parameter i is that guarded binding forwarded, never an unverified value
    const sensitive = (fn, name) => {
      let hit = false;
      C.walk(fn.body, (y) => {
        if (y.type === 'CallExpression' && y.callee.type === 'Identifier' && y.callee.name === name) hit = true;
        if (y.type === 'ObjectExpression' && y.properties.some((q) => q.type === 'Property' && q.shorthand && q.value.type === 'Identifier' && q.value.name === name)) hit = true;
      });
      return hit;
    };
    // the innermost function (if any) whose POSITIONAL parameter is `name` and that encloses position `pos`
    const fnsWithParam = []; C.walk(ast, (y) => { if (/Function/.test(y.type)) y.params.forEach((q, i) => { if (q.type === 'Identifier' && NAMES.has(q.name)) fnsWithParam.push({ fn: y, name: q.name, i }); }); });
    const paramOwner = (name, pos) => fnsWithParam.filter((e) => e.name === name && e.fn.start <= pos && pos < e.fn.end).sort((a, b) => b.fn.start - a.fn.start)[0] || null;
    const forwardedOnly = (root, fn, i, seen = new Set()) => {
      if (fn.type !== 'FunctionDeclaration' || !fn.id || seen.has(fn)) return false;
      seen.add(fn);
      let ok = true; let calls = 0; let refs = 0;
      C.walk(root, (y) => {
        if (y.type === 'Identifier' && y.name === fn.id.name && y !== fn.id) refs += 1;
        if (y.type === 'CallExpression' && y.callee.type === 'Identifier' && y.callee.name === fn.id.name) {
          calls += 1; const a = y.arguments[i];
          if (!(a && a.type === 'Identifier' && NAMES.has(a.name))) { ok = false; return; }
          // the forwarded name is itself a positional parameter of the caller: that caller must be a proven forward too
          const own = paramOwner(a.name, y.start);
          if (own && !forwardedOnly(root, own.fn, own.i, seen)) ok = false;
        }
      });
      return ok && calls > 0 && refs === calls;
    }; u.scopeAt = (pos) => innermost(fs, pos);
    const PARAM = { type: 'Param' };
    const record = (name, init, pos) => { const l = declsByName.get(`${u.file}#${name}`) || []; l.push({ init, scope: u.scopeAt(pos) }); declsByName.set(`${u.file}#${name}`, l); };
    const patNames = (p, f) => { if (!p) return; if (p.type === 'Identifier') f(p.name); else if (p.type === 'AssignmentPattern') patNames(p.left, f); else if (p.type === 'RestElement') patNames(p.argument, f); else if (p.type === 'ArrayPattern') p.elements.forEach((e) => patNames(e, f)); else if (p.type === 'ObjectPattern') p.properties.forEach((q) => patNames(q.type === 'RestElement' ? q.argument : q.value, f)); };
    C.walk(ast, (x) => {
      if (/Function/.test(x.type)) for (const p of x.params) patNames(p, (nm) => record(nm, PARAM, (x.body || x).start));
      if (x.type === 'FunctionDeclaration' && x.id) record(x.id.name, x, x.start);
      if ((x.type === 'ClassDeclaration' || x.type === 'ClassExpression') && x.id) record(x.id.name, x, x.start);
      if (x.type === 'CatchClause' && x.param) patNames(x.param, (nm) => record(nm, PARAM, x.body.start));
      if (x.type === 'VariableDeclarator' && x.id.type !== 'Identifier') patNames(x.id, (nm) => record(nm, x.init && x.init.type === 'Identifier' ? PARAM : { type: 'Destructured' }, x.start));
      const at = `${u.file}:${x.loc ? x.loc.start.line : '?'}`;
      if (x.type === 'VariableDeclarator' && x.id.type === 'Identifier') record(x.id.name, x.init, x.start);
      const staticKey = (k) => k && ((k.type === 'Literal') || (k.type === 'TemplateLiteral' && !k.expressions.length));
      if ((x.type === 'MethodDefinition' || x.type === 'PropertyDefinition') && x.computed && !staticKey(x.key)) out.push({ where: at, kind: 'computed-class-member', value: null, unit: u, fail: 'a class member under a non-literal computed key could be named now at runtime' });
      if (x.type === 'AssignmentExpression' && x.operator === '=' && x.left.type !== 'Identifier' && x.left.type !== 'MemberExpression') patNames(x.left, (nm) => { const l = assignsByName.get(`${u.file}#${nm}`) || []; l.push({ type: 'Destructured' }); assignsByName.set(`${u.file}#${nm}`, l); });
      // a guarded name bound by DESTRUCTURING from anything but its own key (`[now] = …`, `{ x: now } = …`) is unverified
      if (x.type === 'ArrayPattern') x.elements.forEach((e) => { const id = e && (e.type === 'AssignmentPattern' ? e.left : e); if (id && id.type === 'Identifier' && NAMES.has(id.name)) out.push({ where: at, kind: 'array-pattern', value: null, unit: u, fail: `${id.name} bound by array destructuring (unverified)` }); });
      if (x.type === 'ObjectPattern') x.properties.forEach((q) => { if (q.type !== 'Property') return; const id = q.value.type === 'AssignmentPattern' ? q.value.left : q.value; const kn = q.computed ? q.key.value : (q.key.name || q.key.value); const fnName = (() => { let f = null; C.walk(ast, (z) => { if (/Function/.test(z.type) && z.id && z.start <= x.start && x.start < z.end) f = z.id.name; }); return f || '?'; })();
        if (id.type === 'Identifier' && NAMES.has(id.name) && !(keyNow(q.key, q.computed) && kn === id.name) && !REVIEWED[`${u.file}::pattern ${kn}→${id.name}@${fnName}`]) out.push({ where: at, kind: 'renamed-pattern', value: null, unit: u, fail: `${id.name} bound by destructuring a different key (unverified)` }); });
      if (x.type === 'AssignmentExpression' && x.operator === '=' && x.left.type === 'Identifier') { const l = assignsByName.get(`${u.file}#${x.left.name}`) || []; l.push(x.right); assignsByName.set(`${u.file}#${x.left.name}`, l); }
      if (x.type === 'Property' && x.computed && !keyNow(x.key, true) && x.value && /Function/.test(x.value.type)) out.push({ where: at, kind: 'computed-key', value: null, unit: u, fail: 'a function under a computed key could be named now at runtime' });
      if (x.type === 'Property' && keyNow(x.key, x.computed)) {
        if (x.kind !== 'init') out.push({ where: at, kind: `property-${x.kind}`, value: null, unit: u, fail: 'a getter / setter named now' });
        else if (x.shorthand && x.value.type === 'AssignmentPattern') out.push({ where: at, kind: 'pattern-default', value: x.value.right, unit: u });
        else if (!x.shorthand) out.push({ where: at, kind: 'property', value: x.value, unit: u });
        // a plain shorthand { now } refers to a `now` binding of its scope, itself checked here
      }
      if ((x.type === 'MethodDefinition' || x.type === 'PropertyDefinition') && keyNow(x.key, x.computed)) out.push({ where: at, kind: x.type, value: x.type === 'MethodDefinition' && x.kind !== 'method' ? null : x.value, unit: u, fail: x.type === 'MethodDefinition' && x.kind !== 'method' ? 'a class getter / setter named now' : undefined });
      if (x.type === 'AssignmentExpression' && ((x.left.type === 'MemberExpression' && keyNow(x.left.property, x.left.computed)) || (x.left.type === 'Identifier' && NAMES.has(x.left.name)))) out.push({ where: at, kind: 'assignment', value: x.right, unit: u });
      if (x.type === 'VariableDeclarator' && x.id.type === 'Identifier' && NAMES.has(x.id.name)) out.push({ where: at, kind: 'variable', value: x.init, unit: u });
      // a POSITIONAL parameter named now / clock receives the caller's argument (unverified): sound only as DATA — its own body
      // never calls it (a nested function rebinding the name is its own binding, checked where it is declared)
      if (/Function/.test(x.type)) x.params.forEach((p) => {
        if (!(p.type === 'Identifier' && NAMES.has(p.name))) return;
        // CALLED, or ESCAPING as a shorthand `{ now }` / `{ clock }` in an object (Codex r3: a factory returning it). Every other
        // escape lands in a binding this guard checks where it lands: `x: now` / `x.now = now` / `now = p` (an alias of a parameter
        // fails), `const now = make(p)` (an unresolved call fails), a callee's own parameter (checked in its own file)
        const called = sensitive(x, p.name);
        if (called && !forwardedOnly(ast, x, x.params.indexOf(p)) && !REVIEWED[`${u.file}::positional ${p.name}@${x.id ? x.id.name : '?'}`]) out.push({ where: at, kind: 'positional-param', value: null, unit: u, fail: `the positional parameter ${p.name} is CALLED or ESCAPES in its body — its caller's argument is unverified (review it or pass a named clock)` });
        else out.push({ where: at, kind: 'positional-param-data', value: null, unit: u, data: true });
      });
      if (x.type === 'FunctionDeclaration' && x.id && NAMES.has(x.id.name)) out.push({ where: at, kind: 'function', value: x, unit: u });
      if (x.type === 'AssignmentPattern' && x.left.type === 'Identifier' && NAMES.has(x.left.name)) out.push({ where: at, kind: 'param-default', value: x.right, unit: u });
      if (x.type === 'CallExpression' && x.callee.type === 'MemberExpression' && !x.callee.computed && x.callee.property.name === 'defineProperty' && x.arguments[1] && x.arguments[1].type === 'Literal' && x.arguments[1].value === 'now') out.push({ where: at, kind: 'defineProperty', value: null, unit: u, fail: 'Object.defineProperty(…, "now", …)' });
    });
  }
  return { out, declsByName, assignsByName };
}
function verdict(b, declsByName, assignsByName) {
  if (b.fail) return b.fail;
  const v = b.value; const u = b.unit;
  if (b.data) return null;
  if (v === null || v === undefined) return b.kind === 'variable' ? null : `no value (${b.kind})`;
  if (REVIEWED[`${u.file}::${srcOf(u, v)}`]) return null;
  if (/Function/.test(v.type)) return isClockFn(v) ? null : `a function named now that is not an allowed clock shape: ${srcOf(u, v).slice(0, 80)}`;
  if (isClockRef(v) || isDataExpr(v)) return null;
  if (v.type === 'AwaitExpression') return `an awaited value named now (not reviewed): ${srcOf(u, v).slice(0, 80)}`;
  if (v.type === 'Identifier') {
    // the declarations visible at the reference: those of the innermost enclosing function that declares the name
    const all = (declsByName.get(`${u.file}#${v.name}`) || []).filter((d) => d.scope[0] <= v.start && v.start < d.scope[1]);
    if (!all.length) return `now aliases ${v.name}, which has no declaration in its file (unresolved — fail closed)`;
    const near = all.reduce((m, d) => Math.max(m, d.scope[0]), -Infinity);
    for (const { init: d } of all.filter((x) => x.scope[0] === near)) {
      if (d && d.type === 'Param') { if (REVIEWED[`${u.file}::param ${v.name}@${v.loc.start.line - u.lineOffset}`]) continue; return `now aliases the parameter ${v.name} (its value is the caller's — review it or pass a clock form)`; }
      if (d == null || isDataExpr(d) || isClockRef(d) || isClockFn(d) || REVIEWED[`${u.file}::${srcOf(u, d)}`]) continue;
      return `now aliases ${v.name}, whose declaration is neither a clock nor timestamp data: ${srcOf(u, d).slice(0, 80)}`;
    }
    // a later REASSIGNMENT of the alias counts as a declaration too (anywhere in the file — conservative)
    for (const d of assignsByName.get(`${u.file}#${v.name}`) || []) {
      if (isDataExpr(d) || isClockRef(d) || isClockFn(d) || REVIEWED[`${u.file}::${srcOf(u, d)}`]) continue;
      return `now aliases ${v.name}, which is reassigned to neither a clock nor timestamp data: ${srcOf(u, d).slice(0, 80)}`;
    }
    return null;
  }
  return `not an allowed clock / timestamp form (${v.type}): ${srcOf(u, v).slice(0, 80)}`;
}
function scan(units) {
  const { out, declsByName, assignsByName } = bindings(units);
  return { count: out.length, offenders: out.map((b) => { const w = verdict(b, declsByName, assignsByName); return w && `${b.where} [${b.kind}] ${w}`; }).filter(Boolean) };
}

const real = scan(C.sources().filter((u) => u.kind === 'fn'));
assert.ok(real.count > 0, 'non-vacuity: the census scope has bindings named now');
assert.deepStrictEqual(real.offenders, [], `🔴 a binding named \`now\` is not an allowed clock / timestamp form — write-provenance's COMMON 'now' would hide it from the order-write census. Use an allowed form, review it here, or remove 'now' from COMMON:\n${real.offenders.join('\n')}`);
ok(`every binding named now in the census scope is an allowed clock / timestamp form (${real.count})`);

const neg = (code) => scan([{ file: 'tb/neg.js', scope: 'functions', kind: 'fn', code, lineOffset: 0, module: false }]).offenders.length;
const NEGATIVES = [
  ["const d = { now: () => db.ref('orders/x').set(1) };", 'a now that writes'],
  ['const d = { now: function writer() { db.ref("orders/x").set(1); return 1; } };', 'a named function expression that writes'],
  ['function writer() { db.ref("orders/x").set(1); } const d = { now: writer };', 'an alias to a non-clock function'],
  ['function writer() {} let now; now = writer;', 'a reassignment to a non-clock'],
  ['class K { now = () => db.ref("o").set(1); }', 'a class field'],
  ['class K { get now() { return 1; } }', 'a class getter'],
  ['const d = { get now() { return Date.now(); } };', 'an object getter'],
  ["const d = { ['now']: () => db.ref('o').set(1) };", "a computed 'now' key"],
  ['const k = "now"; const d = { [k]: () => 1 };', 'a function under a non-literal computed key'],
  ['const d = { now: () => tag`x${1}` };', 'a tagged template'],
  ['const d = { now: () => ({ payload: 1 }) };', 'a pure now returning a payload'],
  ['const d = { now: () => deps.now() };', 'an unconditional delegation (not the reviewed shape)'],
  ['const d = { now: makeClock() };', 'an unresolved call result'],
  ['function f(w) { return { now: w }; }', 'an alias to an unreviewed parameter'],
  ['const d = { now: imported };', 'an alias with no declaration in the file'],
  ['Object.defineProperty(d, "now", { value: () => 1 });', 'defineProperty'],
  ['const k = "now"; class K { [k](p) { db.ref("o").set(p); } }', 'a computed class member (method)'],
  ['const k = "now"; class K { [k] = () => db.ref("o").set(1); }', 'a computed class member (field)'],
  ['function writer() { db.ref("o").set(1); } let w = () => Date.now(); w = writer; const d = { now: w };', 'an alias REASSIGNED to a non-clock'],
  ['const d = { clock: () => db.ref("o").set(1) }; const now = d.clock();', 'a clock that writes (so `X.clock()` is never trusted unverified)'],
  ['function f(a, now) { return now(); } f(1, () => db.ref("o").set(1));', 'a positional now that is called, fed an arbitrary argument'],
  ['function writer() { db.ref("o").set(1); } let w = () => Date.now(); [w] = [writer]; const d = { now: w };', 'an alias reassigned by ARRAY destructuring'],
  ['function writer() { db.ref("o").set(1); } let w = () => Date.now(); ({ x: w } = { x: writer }); const d = { now: w };', 'an alias reassigned by OBJECT destructuring'],
  ['const [now] = [() => db.ref("o").set(1)];', 'now bound by array destructuring'],
  ['const { x: now } = { x: () => db.ref("o").set(1) };', 'now bound by destructuring a different key'],
  ['function make(clock) { return { clock }; } const d = make(() => db.ref("o").set(1)); d.clock();', 'a positional clock escaping through a factory'],
  ['function g(clock) { return h(clock); } function h(clock) { return clock(); } g(() => db.ref("o").set(1));', 'a positional clock forwarded from an UNPROVEN parameter'],
];
for (const [code, why] of NEGATIVES) assert.ok(neg(code) >= 1, `NEGATIVE: ${why} must fail closed — ${code}`);
for (const code of ['function h(clock) { return clock(); } function g() { const clock = () => Date.now(); return h(clock); }', 'const { now } = deps;', 'const d = { now: () => Date.now() };', 'const d = { now: () => 0 };', 'const d = { now: () => (deps.now ? deps.now() : Date.now()) };', 'const now = deps.now || Date.now;', 'const t = Date.now(); const d = { now: t };', 'function f(now = Date.now()) { return now; }', 'const now = deps.clock();']) {
  assert.strictEqual(neg(code), 0, `NEGATIVE control: an allowed form passes — ${code}`);
}
ok(`negatives: ${NEGATIVES.length} unsafe forms fail closed; 9 allowed forms pass`);
console.log(`\nnow-clock.guard: OK (${n})`);
