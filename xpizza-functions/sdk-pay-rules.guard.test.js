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
// D4 (advisor 11-12): every node the in-app card payment server keeps is server-only — the recovery queue carries a raw order id,
// the recovery budget, codes and order tickets, the per-uid card vault, the C6 checkout subject. Clients reach them ONLY through
// the endpoints; the permanent cancel fence (sdk_fence, PLAN-sdk-fence-r1) likewise; an explicit deny pins it (a default deny could be widened silently by a future ancestor grant).
for (const node of SR.D4_SERVER_ONLY) {
  assert.deepStrictEqual(rules[node], { '.read': false, '.write': false }, `SPR-D4-SERVER-ONLY: /${node} must be an explicit server-only deny (got ${JSON.stringify(rules[node])})`);
}
assert.deepStrictEqual([...SR.D4_SERVER_ONLY].sort(), ['customer_cards', 'order_access_tickets', 'order_recovery_otp', 'recovery_phone_budget', 'recovery_verify_pad', 'sdk_checkout_subject', 'sdk_fence', 'sdk_recovery_queue'], 'SPR-D4-SERVER-ONLY: the D4 server-only list');
ok('every D4 server node is server-only');
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
// Codex r1 #1: a decision object can never be forged as a scalar — existence is preserved per object (descendant equality alone
// passes when an absent object becomes `true`), and each object, when written, must carry exactly its fields
for (const [f, leaves] of Object.entries(SR.OBJECT_FIELDS)) {
  assert.ok(o['.write'].includes(`newData.child('${f}').exists() === data.child('${f}').exists()`), `SPR-OBJECT-EXISTENCE: the order .write must preserve the EXISTENCE of ${f}`);
  assert.strictEqual(o[f]['.validate'], `newData.hasChildren([${leaves.map((l) => `'${l}'`).join(', ')}])`, `SPR-OBJECT-SHAPE: ${f} must validate as an object with its fields`);
}
ok('no decision object can be created, removed or forged as a scalar by a client');
assert.ok(SR.SCALAR_FIELDS.includes('sdk_live_pending'), 'SPR-LIVE-PENDING: the go-live pending list is a server-only immutable scalar (Codex r3 A)');
for (const f of SR.SCALAR_FIELDS) assert.strictEqual(o[f] && o[f]['.validate'], SR.LEAF_IMMUTABLE, `SPR-FIELD-SHAPE: ${f} must be immutable for clients`);
ok('every server-only payment field is immutable for clients and admits no extra child');
assert.ok(!JSON.stringify(rules).includes('payment_gate'), 'SPR-NO-GATE: no rule may block a terminal write on a payment gate (advisor amendment: delivery never waits)');
ok('no payment gate blocks a terminal write');
console.log(`\nsdk-pay-rules.guard: OK (${n})`);
