'use strict';
// Offline structural guard for the SDK payment rules (BRIEF-sdk-payment-coordinator r5 §3, §4a; D1). Semantics per client
// role (leaf / whole-order / multipath / delete, status reversal, legacy untouched, delivery not blocked) are proven in
// test/sdk-pay-rules.emulator.test.js; this guard pins the exact clauses so they cannot drift silently.
// Each failure message starts with its cell label. Run: node sdk-pay-rules.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;
const SR = require('./payments/sdk/rules-clauses');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

for (const node of ['payment_sdk', 'payment_sdk_due']) {
  assert.deepStrictEqual(rules[node], { '.read': false, '.write': false }, `SPR-SERVER-ONLY: /${node} must be an explicit server-only deny (got ${JSON.stringify(rules[node])})`);
}
ok('payment_sdk + payment_sdk_due are server-only');
const o = rules.orders.$order_id;
assert.ok(o['.write'].endsWith(` && ${SR.PRESERVE} && ${SR.NO_REVERSAL_ORDER}`), 'SPR-PRESERVE: the order-level .write must END with the server-field preservation clause (create / change / leaf delete / whole-order replace / order delete) AND the no-reversal clause (a status DELETE runs no .validate)');
ok('order .write preserves every server-only payment field');
assert.ok(o['.validate'].endsWith(` && ${SR.NO_REVERSAL_ORDER}`), 'SPR-NO-REVERSAL-ORDER: the order-level .validate must END with the no-reversal clause (whole-order / multipath writes)');
assert.ok(o.status['.validate'].startsWith('(') && o.status['.validate'].endsWith(`) && (${SR.NO_REVERSAL_STATUS})`), 'SPR-NO-REVERSAL-STATUS: status .validate must be (the existing alternatives) && (the SDK no-reversal clause) — without the parentheses && binds only to the last alternative and dispatchers / kitchen bypass it');
{ // the clause must hold for EVERY alternative: evaluate the expression's top-level structure, not just its text
  const depth0 = (e) => { let d = 0; const tops = []; for (let i = 0; i < e.length; i++) { const c = e[i]; if (c === '(') d++; else if (c === ')') d--; else if (d === 0 && e.startsWith(' || ', i)) tops.push(i); } return tops; };
  assert.deepStrictEqual(depth0(o.status['.validate']), [], 'SPR-NO-REVERSAL-STATUS: no top-level || may escape the no-reversal clause');
}
ok('a terminal SDK order cannot be moved back by a client (leaf + whole-order)');
for (const [f, leaves] of Object.entries(SR.OBJECT_FIELDS)) {
  const node = o[f];
  assert.ok(node, `SPR-FIELD-SHAPE: orders/$order_id/${f} rules missing`);
  for (const leaf of leaves) assert.strictEqual(node[leaf] && node[leaf]['.validate'], SR.LEAF_IMMUTABLE, `SPR-FIELD-SHAPE: ${f}/${leaf} must be immutable for clients`);
  assert.deepStrictEqual(node.$other, { '.validate': false }, `SPR-FIELD-SHAPE: ${f} admits no other child`);
}
for (const f of SR.SCALAR_FIELDS) assert.strictEqual(o[f] && o[f]['.validate'], SR.LEAF_IMMUTABLE, `SPR-FIELD-SHAPE: ${f} must be immutable for clients`);
ok('every server-only payment field is immutable for clients and admits no extra child');
assert.ok(!JSON.stringify(rules).includes('payment_gate'), 'SPR-NO-GATE: no rule may block a terminal write on a payment gate (advisor amendment: delivery never waits)');
ok('no payment gate blocks a terminal write');
console.log(`\nsdk-pay-rules.guard: OK (${n})`);
