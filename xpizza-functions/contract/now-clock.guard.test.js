'use strict';
// Soundness guard for write-provenance's COMMON 'now' (advisor ruling 2026-11-07, condition 1; Codex MEDIUM r1 → a WHITELIST).
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
  'xpizza-functions/stats/stats-fixtures.js::param at@71': 'the fixture materialize helper: its callers pass timestamp numbers',
  'xpizza-functions/stats/stats-gen.js::T.dayStartMs(date) + Math.floor(r() * 86400000)': 'a synthetic fixture timestamp',
});
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
const isClockRef = (x) => isDateNowRef(x) || (x && x.type === 'LogicalExpression' && x.operator === '||' && isMemberNow(x.left) && (isDateNowRef(x.right) || isClockFn(x.right)));
function isDataExpr(x) {
  if (!x) return false;
  if (isNumLit(x) || (x.type === 'Literal' && x.value === null) || isDateNowCall(x) || isDelegate(x) || isNewDateIso(x)) return true;
  if (x.type === 'CallExpression' && x.arguments.length === 0) {
    const c = x.callee;
    if (c.type === 'Identifier' && c.name === 'now') return true;                                        // now()
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
  const out = []; const declsByName = new Map();
  const scopes = (ast) => { const fs = []; C.walk(ast, (x) => { if (/Function/.test(x.type)) fs.push([x.start, x.end]); }); return fs; };
  const innermost = (fs, pos) => fs.filter(([a, b]) => a <= pos && pos < b).reduce((m, r) => (!m || r[0] > m[0] ? r : m), null) || [-1, Infinity];
  const keyNow = (k, computed) => (!computed && k && (k.name === 'now' || k.value === 'now')) || (computed && k && ((k.type === 'Literal' && k.value === 'now') || (k.type === 'TemplateLiteral' && !k.expressions.length && k.quasis[0].value.cooked === 'now')));
  for (const u of units) {
    const ast = C.parseUnit(u); const fs = scopes(ast); u.scopeAt = (pos) => innermost(fs, pos);
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
      if (x.type === 'Property' && x.computed && !keyNow(x.key, true) && x.value && /Function/.test(x.value.type)) out.push({ where: at, kind: 'computed-key', value: null, unit: u, fail: 'a function under a computed key could be named now at runtime' });
      if (x.type === 'Property' && keyNow(x.key, x.computed)) {
        if (x.kind !== 'init') out.push({ where: at, kind: `property-${x.kind}`, value: null, unit: u, fail: 'a getter / setter named now' });
        else if (x.shorthand && x.value.type === 'AssignmentPattern') out.push({ where: at, kind: 'pattern-default', value: x.value.right, unit: u });
        else if (!x.shorthand) out.push({ where: at, kind: 'property', value: x.value, unit: u });
        // a plain shorthand { now } refers to a `now` binding of its scope, itself checked here
      }
      if ((x.type === 'MethodDefinition' || x.type === 'PropertyDefinition') && keyNow(x.key, x.computed)) out.push({ where: at, kind: x.type, value: x.type === 'MethodDefinition' && x.kind !== 'method' ? null : x.value, unit: u, fail: x.type === 'MethodDefinition' && x.kind !== 'method' ? 'a class getter / setter named now' : undefined });
      if (x.type === 'AssignmentExpression' && ((x.left.type === 'MemberExpression' && keyNow(x.left.property, x.left.computed)) || (x.left.type === 'Identifier' && x.left.name === 'now'))) out.push({ where: at, kind: 'assignment', value: x.right, unit: u });
      if (x.type === 'VariableDeclarator' && x.id.type === 'Identifier' && x.id.name === 'now') out.push({ where: at, kind: 'variable', value: x.init, unit: u });
      if (x.type === 'FunctionDeclaration' && x.id && x.id.name === 'now') out.push({ where: at, kind: 'function', value: x, unit: u });
      if (x.type === 'AssignmentPattern' && x.left.type === 'Identifier' && x.left.name === 'now') out.push({ where: at, kind: 'param-default', value: x.right, unit: u });
      if (x.type === 'CallExpression' && x.callee.type === 'MemberExpression' && !x.callee.computed && x.callee.property.name === 'defineProperty' && x.arguments[1] && x.arguments[1].type === 'Literal' && x.arguments[1].value === 'now') out.push({ where: at, kind: 'defineProperty', value: null, unit: u, fail: 'Object.defineProperty(…, "now", …)' });
    });
  }
  return { out, declsByName };
}
function verdict(b, declsByName) {
  if (b.fail) return b.fail;
  const v = b.value; const u = b.unit;
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
    return null;
  }
  return `not an allowed clock / timestamp form (${v.type}): ${srcOf(u, v).slice(0, 80)}`;
}
function scan(units) {
  const { out, declsByName } = bindings(units);
  return { count: out.length, offenders: out.map((b) => { const w = verdict(b, declsByName); return w && `${b.where} [${b.kind}] ${w}`; }).filter(Boolean) };
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
];
for (const [code, why] of NEGATIVES) assert.ok(neg(code) >= 1, `NEGATIVE: ${why} must fail closed — ${code}`);
for (const code of ['const d = { now: () => Date.now() };', 'const d = { now: () => 0 };', 'const d = { now: () => (deps.now ? deps.now() : Date.now()) };', 'const now = deps.now || Date.now;', 'const t = Date.now(); const d = { now: t };', 'function f(now = Date.now()) { return now; }', 'const now = deps.clock();']) {
  assert.strictEqual(neg(code), 0, `NEGATIVE control: an allowed form passes — ${code}`);
}
ok(`negatives: ${NEGATIVES.length} unsafe forms fail closed; 7 allowed forms pass`);
console.log(`\nnow-clock.guard: OK (${n})`);
