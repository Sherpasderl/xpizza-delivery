'use strict';
// Soundness guard for write-provenance's COMMON 'now' (advisor ruling 2026-11-07, condition 1). COMMON means "never followed":
// a call named `now` is treated as a library clock and its callees are never searched for order writes. That is sound only
// while EVERY function named `now` in the census scope is a pure clock — so this guard scans them all and fails LOUDLY if
// one writes, assigns, awaits or calls anything but another `.now()`. Negatives prove the scanner is not vacuous.
// Run: node contract/now-clock.guard.test.js
const assert = require('assert');
const C = require('./census');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

function nameOf(node, parent) {
  if (node.id && node.id.name) return node.id.name;
  if (parent && parent.type === 'Property' && parent.value === node) return parent.key && (parent.key.name || parent.key.value);
  if (parent && parent.type === 'MethodDefinition' && parent.value === node) return parent.key && (parent.key.name || parent.key.value);
  if (parent && parent.type === 'VariableDeclarator' && parent.init === node) return parent.id && parent.id.name;
  if (parent && parent.type === 'AssignmentExpression' && parent.right === node && parent.left.type === 'MemberExpression') return parent.left.property && (parent.left.property.name || parent.left.property.value);
  return null;
}
// a pure clock: no assignment / update / await / new / delete, and every call is a member call named `now`
function impurities(fnNode) {
  const bad = [];
  C.walk(fnNode, (x) => {
    if (x === fnNode) return;
    if (['AssignmentExpression', 'UpdateExpression', 'AwaitExpression', 'NewExpression', 'YieldExpression'].includes(x.type)) bad.push(x.type);
    if (x.type === 'UnaryExpression' && x.operator === 'delete') bad.push('delete');
    if (x.type === 'CallExpression') {
      const c = x.callee;
      const nm = c.type === 'MemberExpression' && !c.computed ? c.property.name : (c.type === 'Identifier' ? c.name : null);
      if (!(c.type === 'MemberExpression' && nm === 'now')) bad.push(`call ${nm || '<computed>'}()`);
    }
  });
  return bad;
}
function scan(units) {
  const found = []; const offenders = [];
  for (const u of units) {
    const ast = C.parseUnit(u);
    C.walk(ast, (node, fn, parent) => {
      if (!/Function/.test(node.type)) return;
      if (nameOf(node, parent) !== 'now') return;
      const where = `${u.file}:${node.loc.start.line}`;
      found.push(where);
      const bad = impurities(node);
      if (bad.length) offenders.push(`${where} — ${[...new Set(bad)].join(', ')}`);
    });
  }
  return { found, offenders };
}

const real = scan(C.sources().filter((u) => u.kind === 'fn'));
assert.ok(real.found.length > 0, 'non-vacuity: the census scope has functions named `now` (got none — is the scanner broken?)');
assert.deepStrictEqual(real.offenders, [], `🔴 a function named \`now\` is not a pure clock — write-provenance's COMMON 'now' would hide its effects from the order-write census. Rename it, or remove 'now' from COMMON:\n${real.offenders.join('\n')}`);
ok(`every function named now in the census scope is a pure clock (${real.found.length})`);

const neg = (code) => scan([{ file: 'tb/neg.js', scope: 'functions', kind: 'fn', code, lineOffset: 0, module: false }]).offenders;
assert.strictEqual(neg("const deps = { now: () => db.ref('orders/x').set(1) };").length, 1, 'NEGATIVE: a `now` that WRITES an order path must be flagged');
assert.strictEqual(neg('const deps = { now: () => stamp() };').length, 1, 'NEGATIVE: a `now` that calls a helper (which could write) must be flagged');
assert.strictEqual(neg('function now() { last = Date.now(); return last; }').length, 1, 'NEGATIVE: a `now` that assigns must be flagged');
assert.strictEqual(neg('class K { async now() { await x; return 1; } }').length, 1, 'NEGATIVE: a `now` method that awaits must be flagged');
assert.strictEqual(neg('const deps = { now: () => (d.now ? d.now() : Date.now()) };').length, 0, 'NEGATIVE control: a clock delegating to another clock passes');
ok('negatives: a writing / helper-calling / assigning / awaiting `now` is flagged; a delegating clock passes');
console.log(`\nnow-clock.guard: OK (${n})`);
