'use strict';
// PLAN-5f-cancel-park r1 option A — the daily re-raise is REAL code (read from the syntax tree, never the text: a same-line edit once hid
// code behind an inline comment, Codex #203 P1-3). Inside reconcilePayments' per-order loop, an executable
// `if (o.payment_status === 'manual_review' && age > …) breaches.push({ orderId, kind: 'aged_manual_review' })` exists beside the
// aged_manual_reconciliation rule.
//   CPW-AGED   the aged_manual_review rule is an executable IfStatement of the loop, pushing that breach kind
//   CPW-PEER   it sits beside (after) the aged_manual_reconciliation rule, in the same loop
//   CPW-SCHED  Codex #211 P2-4: the scheduled/releasing exemption's `continue` is CONDITIONAL on `!unresolvedMoney(o)` (alert-prune's one
//              definition), so a parked scheduled order still meets the aged money-state rules
// Run: node payments/cancel-park-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowHashBang: true });
const walk = (node, fn) => { if (!node || typeof node.type !== 'string') return; fn(node); for (const k of Object.keys(node)) { const v = node[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, fn)); else if (v && typeof v.type === 'string') walk(v, fn); } };
const textOf = (node) => src.slice(node.start, node.end);

let handler = null;
walk(ast, (node) => {
  if (node.type === 'AssignmentExpression' && textOf(node.left) === 'exports.reconcilePayments' && node.right.type === 'CallExpression') {
    handler = node.right.arguments.find((a) => a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression');
  }
});
assert.ok(handler, 'premise: exports.reconcilePayments = onSchedule(…, async () => …)');
// the loop body that holds the aged_manual_reconciliation rule
let loopBody = null;
walk(handler.body, (node) => {
  if (!loopBody && (node.type === 'ForOfStatement' || node.type === 'ForInStatement') && node.body.type === 'BlockStatement'
    && node.body.body.some((s) => s.type === 'IfStatement' && /aged_manual_reconciliation/.test(textOf(s.consequent)))) loopBody = node.body.body;
});
assert.ok(loopBody, 'premise: the per-order loop with the aged_manual_reconciliation rule');
const idxOf = (kind, field) => loopBody.findIndex((s) => s.type === 'IfStatement' && new RegExp(`o\\.payment_status === '${field}'`).test(textOf(s.test)) && new RegExp(`kind: '${kind}'`).test(textOf(s.consequent)));
const mr = idxOf('aged_manual_reconciliation', 'manual_reconciliation');
const rv = idxOf('aged_manual_review', 'manual_review');
assert.ok(rv >= 0, '🔴 CPW-AGED: `if (o.payment_status === \'manual_review\' && …) breaches.push({ … kind: \'aged_manual_review\' })` is an EXECUTABLE statement of the loop');
assert.ok(/age > 6 \* 3600 \* 1000/.test(textOf(loopBody[rv].test)), 'CPW-AGED: the same 6 h age bound as aged_manual_reconciliation');
ok('CPW-AGED: the aged_manual_review re-raise is real code in reconcilePayments\' loop (6 h bound)');
assert.ok(mr >= 0 && rv > mr, `🔴 CPW-PEER: it sits right after the aged_manual_reconciliation rule (${mr} < ${rv})`);
ok('CPW-PEER: beside the aged_manual_reconciliation rule, in the same loop');
{
  const sched = loopBody.find((s) => s.type === 'IfStatement' && /o\.status === 'scheduled'/.test(textOf(s.test)));
  assert.ok(sched && sched.consequent.type === 'BlockStatement', 'premise: the scheduled/releasing exemption block');
  const body = sched.consequent.body; const last = body[body.length - 1];
  assert.ok(!body.some((s) => s.type === 'ContinueStatement'), '🔴 CPW-SCHED: the scheduled exemption has NO unconditional continue (a parked scheduled order must reach the money-state rules)');
  assert.ok(last && last.type === 'IfStatement' && last.consequent.type === 'ContinueStatement' && /^!require\('\.\/alert-prune'\)\.unresolvedMoney\(o\)$/.test(textOf(last.test)),
    `🔴 CPW-SCHED: it ends with \`if (!require('./alert-prune').unresolvedMoney(o)) continue;\` (got ${last ? textOf(last).slice(0, 120) : 'nothing'})`);
  const schedIdx = loopBody.indexOf(sched);
  assert.ok(schedIdx < rv, 'CPW-SCHED: the money-state rules come after the exemption (reached through its conditional continue)');
  ok('CPW-SCHED: a scheduled/releasing order in an unresolved money state is NOT exempted — it meets the aged money-state rules');
}
console.log(`cancel-park-wiring.guard: OK (${n})`);
