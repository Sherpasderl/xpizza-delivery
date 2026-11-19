'use strict';
// «Marcar como revisado» (owner 11-19, option B) — its two index.js edits are REAL code (the syntax tree, never the text: a same-line edit
// once hid code behind an inline comment, Codex #203 P1-3).
//   RAW-DAILY    reconcilePayments' aged_manual_review rule skips a CLOSED review: its test is `o.payment_status === 'manual_review'
//                && !o.manual_review_closed && age > 6 h` (an executable IfStatement of the per-order loop)
//   RAW-EXPORT   `exports.attestManualReview = require('./payments/review-attest').endpoint({ onRequest, authorize: authorizeDispatcherAction,
//                getDatabase, sanitizeText })` is an executable top-level statement — the dispatcher gate, never MAKE_SECRET
//   RAW-BACKSTOP the daily pass completes a pending audit: `if (o.manual_review_closed && o.manual_review_closed.audited === false) … completeAudit(db, orderId)` (Codex #217 P2-3)
//   RAW-EPISODE  `exports.markReviewEpisodeOnPaymentStatus = onValueWritten({ ref: '/orders/{orderId}/payment_status' … }, …onPaymentStatus(…))` (Codex #217 P1)
// (RAW-DAILY now: `!require('./alert-prune').reviewClosed(o)` — a closure counts only in its episode; RAW-EXPORT: authorizeDispatcherActionWithUid)
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
  assert.ok(/^o\.payment_status === 'manual_review' && !require\('\.\/alert-prune'\)\.reviewClosed\(o\) && age > 6 \* 3600 \* 1000$/.test(textOf(rule.test)), `🔴 RAW-DAILY: the rule skips a review closed IN ITS EPISODE (got ${textOf(rule.test)})`);
  const backstop = loopBody.find((s) => s.type === 'IfStatement' && /completeAudit\(db, orderId\)/.test(textOf(s.consequent)));
  assert.ok(backstop && /manual_review_closed\.audited === false/.test(textOf(backstop.test)), '🔴 RAW-BACKSTOP: the daily pass completes a pending audit (real code)');
  ok('RAW-DAILY / RAW-BACKSTOP: the daily rule honours a closure only in its episode; the daily pass completes a pending audit (real code)');
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
