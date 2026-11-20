'use strict';
// «Marcar como revisado» (owner 11-19, option B) — its two index.js edits are REAL code (the syntax tree, never the text: a same-line edit
// once hid code behind an inline comment, Codex #203 P1-3).
//   RAW-DAILY    reconcilePayments' aged_manual_review rule skips a CLOSED review: its test is `o.payment_status === 'manual_review'
//                && !o.manual_review_closed && age > 6 h` (an executable IfStatement of the per-order loop)
//   RAW-EXPORT   `exports.attestManualReview = require('./payments/review-attest').endpoint({ onRequest, authorize: authorizeDispatcherAction,
//                getDatabase, sanitizeText })` is an executable top-level statement — the dispatcher gate, never MAKE_SECRET
//   RAW-CLOSED-SET `const reviewClosedIds = await require('./payments/review-attest').closedOrderIds(db, orders)` before the loop; the prune gets
//                withClosedReviews(orders, reviewClosedIds) (structural rebuild 11-19: closedness lives in server-only roots, not on the order)
//   RAW-EPISODE  `exports.markReviewEpisodeOnPaymentStatus = onValueWritten({ ref: '/orders/{orderId}/payment_status' … }, …onPaymentStatus(…))` (Codex #217 P1)
// (RAW-DAILY now: `!reviewClosedIds.has(orderId)`, no audit backstop; RAW-EXPORT: authorizeDispatcherActionWithUid)
// Run: node payments/review-attest-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowHashBang: true });
const walk = (node, fn) => { if (!node || typeof node.type !== 'string') return; fn(node); for (const k of Object.keys(node)) { const v = node[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, fn)); else if (v && typeof v.type === 'string') walk(v, fn); } };
const textOf = (node) => src.slice(node.start, node.end);

{
  let handler = null;
  walk(ast, (node) => { if (node.type === 'AssignmentExpression' && textOf(node.left) === 'exports.reconcilePayments' && node.right.type === 'CallExpression') handler = node.right.arguments.find((a) => /FunctionExpression$/.test(a.type)); });
  assert.ok(handler, 'premise: exports.reconcilePayments');
  let loopBody = null;
  walk(handler.body, (node) => { if (!loopBody && /^For(Of|In)Statement$/.test(node.type) && node.body.type === 'BlockStatement' && node.body.body.some((s) => s.type === 'IfStatement' && /aged_manual_reconciliation/.test(textOf(s.consequent)))) loopBody = node.body.body; });
  assert.ok(loopBody, 'premise: the per-order loop');
  const rule = loopBody.find((s) => s.type === 'IfStatement' && /kind: 'aged_manual_review'/.test(textOf(s.consequent)));
  assert.ok(rule, 'premise: the aged_manual_review rule is an executable statement');
  assert.ok(/^o\.payment_status === 'manual_review' && !reviewClosedIds\.has\(orderId\) && age > 6 \* 3600 \* 1000$/.test(textOf(rule.test)), `🔴 RAW-DAILY: the rule skips a review closed in its CURRENT episode (got ${textOf(rule.test)})`);
  assert.ok(!/completeAudit\(|manual_review_closed\.audited/.test(textOf(handler.body)), '🔴 RAW-DAILY: no audit backstop (the closure is the audit, written atomically)');
  // RAW-CLOSED-SET: the set is computed ONCE, as real code, before the loop, from the server-only roots; the prune receives the same view
  const body = handler.body.body;
  const decl = body.findIndex((s) => s.type === 'VariableDeclaration' && s.declarations.some((d) => d.id.name === 'reviewClosedIds' && /^await require\('\.\/payments\/review-attest'\)\.closedOrderIds\(db, orders\)$/.test(textOf(d.init))));
  const loopAt = body.findIndex((s) => /^For(Of|In)Statement$/.test(s.type) && s.body.body === loopBody);
  assert.ok(decl >= 0 && loopAt > decl, `🔴 RAW-CLOSED-SET: \`const reviewClosedIds = await require('./payments/review-attest').closedOrderIds(db, orders)\` is a real statement before the loop (${decl} < ${loopAt})`);
  let prune = null; walk(handler.body, (node) => { if (!prune && node.type === 'CallExpression' && textOf(node.callee) === 'alertsToPrune') prune = node; });
  assert.ok(prune && textOf(prune.arguments[1]) === "require('./payments/review-attest').withClosedReviews(orders, reviewClosedIds)", `🔴 RAW-CLOSED-SET: the prune gets the review's view of the orders (got ${prune ? textOf(prune) : 'none'})`);
  ok('RAW-DAILY / RAW-CLOSED-SET: the daily rule and the prune read closedness from the server-only set, computed once before the loop (real code)');
}
{
  const hits = [];
  for (const st of ast.body) {
    if (st.type !== 'ExpressionStatement' || st.expression.type !== 'AssignmentExpression') continue;
    if (textOf(st.expression.left) === 'exports.attestManualReview') hits.push(st.expression.right);
  }
  assert.strictEqual(hits.length, 1, '🔴 RAW-EXPORT: exactly one top-level `exports.attestManualReview = …`');
  const call = hits[0];
  assert.ok(call.type === 'CallExpression' && textOf(call.callee) === "require('./payments/review-attest').endpoint", `🔴 RAW-EXPORT: it is the module's endpoint factory (got ${textOf(call).slice(0, 80)})`);
  const arg = call.arguments[0];
  const prop = (k) => arg && arg.type === 'ObjectExpression' && arg.properties.find((p) => p.key && p.key.name === k);
  assert.ok(prop('authorize') && textOf(prop('authorize').value) === 'authorizeDispatcherActionWithUid', '🔴 RAW-EXPORT: authorize is authorizeDispatcherActionWithUid (the module then requires a dispatcher identity)');
  for (const k of ['onRequest', 'getDatabase', 'sanitizeText']) assert.ok(prop(k) && textOf(prop(k).value) === k, `RAW-EXPORT: ${k} is passed through`);
  assert.ok(!/MAKE_SECRET/.test(textOf(call)), 'RAW-EXPORT: never the order-intake secret');
  ok('RAW-EXPORT: the endpoint is wired with authorizeDispatcherAction (real code)');
}
{
  // RAW-EPISODE (Codex #217 P1): the episode trigger is an executable top-level export on /orders/{orderId}/payment_status → the module
  const hits = [];
  for (const st of ast.body) { if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression' && textOf(st.expression.left) === 'exports.markReviewEpisodeOnPaymentStatus') hits.push(st.expression.right); }
  assert.strictEqual(hits.length, 1, '🔴 RAW-EPISODE: exactly one top-level `exports.markReviewEpisodeOnPaymentStatus = onValueWritten(…)`');
  const t = textOf(hits[0]);
  assert.ok(/^onValueWritten\(\{ ref: '\/orders\/\{orderId\}\/payment_status'/.test(t) && /require\('\.\/payments\/review-attest'\)\.onPaymentStatus\(getDatabase\(\), \{ orderId: event\.params\.orderId, before: event\.data\.before\.val\(\), after: event\.data\.after\.val\(\), eventTime: Date\.parse\(event\.time\) \}\)/.test(t), `🔴 RAW-EPISODE: the trigger feeds the module the before/after payment_status (got ${t.slice(0, 160)})`);
  ok('RAW-EPISODE: the episode trigger on payment_status is wired (real code)');
}
console.log(`review-attest-wiring.guard: OK (${n})`);
