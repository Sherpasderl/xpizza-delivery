'use strict';
// INTL PHONE S-core step 3 — phone/wire.js applyWireContract(strict, body, errors, fields): the flagged wire contract applied to the
// RESULT of validateOrderPayload (which, with sanitizePhone, stays untouched). Run: node phone/wire.test.js
const assert = require('assert');
const { applyWireContract, LEGACY_PHONE_ERROR } = require('./wire');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// the lenient result today's validateOrderPayload produces (sanitizePhone, index.js:584 @ 8a31e2a3) — re-derived here, test-only
function lenient(v) { const raw = String(v == null ? '' : v).trim(); const plus = raw.startsWith('+') ? '+' : ''; const d = raw.replace(/[^\d]/g, ''); return d.length < 8 || d.length > 15 ? '' : plus + d; }
function run(strict, phone) {
  const body = { customer_phone: phone }; const errors = []; const fields = { customer_phone: lenient(phone), other: 'x' };
  if (phone && !fields.customer_phone) errors.push(LEGACY_PHONE_ERROR);
  const before = JSON.stringify({ body, errors, fields });
  applyWireContract(strict, body, errors, fields);
  return { body, errors, fields, before };
}
assert.strictEqual(LEGACY_PHONE_ERROR, 'customer_phone must be 8–15 digits', 'WIRE-EXISTING-COPY (index.js:634)');

// ── OFF: a no-op, byte-for-byte, for every shape ──
const SHAPES = ['+504 9795-0000', '97950000', '+97950000', '+504 9795-000', '+44 7911 123456', '50497950000', '+1 (219) 795-0000', '', null, 12345678, 'abc'];
for (const s of SHAPES) { const r = run(false, s); assert.strictEqual(JSON.stringify({ body: r.body, errors: r.errors, fields: r.fields }), r.before, `WIRE-OFF-NOOP ${JSON.stringify(s)}`); }
for (const s of SHAPES) { const r = run(undefined, s); assert.strictEqual(JSON.stringify({ body: r.body, errors: r.errors, fields: r.fields }), r.before, `WIRE-NON-TRUE-IS-OFF ${JSON.stringify(s)}`); }
ok(`OFF (false / not true): nothing changes — body, errors, fields byte-identical (${SHAPES.length} shapes ×2)`);

// ── ON: valid → canonical, the qualified HN form the forms send is UNCHANGED from today ──
for (const [s, want] of [['+504 9795-0000', '+50497950000'], ['97950000', '+50497950000'], ['9795-0000', '+50497950000'], ['+1 (219) 795-0000', '+12197950000'], ['+501 622-1234', '+5016221234'], ['+34 612 34 56 78', '+34612345678']]) {
  const r = run(true, s);
  assert.deepStrictEqual([r.errors, r.fields.customer_phone, r.fields.other], [[], want, 'x'], `WIRE-ON-CANONICAL ${s}`);
}
assert.strictEqual(run(true, '+504 9795-0000').fields.customer_phone, run(false, '+504 9795-0000').fields.customer_phone, 'WIRE-ON-FORMS-HN-UNCHANGED');
ok('ON: every valid submission → canonical +CCnational; the forms\' "+504 9795-0000" stores exactly what it stores today; only bare-8 changes form');

// ── ON: invalid → the existing error, exactly once, and no phone stored ──
for (const s of ['+97950000', '+504 9795-000', '+44 7911 123456', '50497950000', '2197950000', '+504 1219-7950000', 12345678, 'abc', '+5212345678901']) {
  const r = run(true, s);
  assert.deepStrictEqual([r.errors, r.fields.customer_phone], [[LEGACY_PHONE_ERROR], ''], `WIRE-ON-REJECT ${JSON.stringify(s)}`);
}
ok('ON: \'+\'+8, partial, unsupported, bare non-8, capp member over-length, non-string, junk → the existing error once, no phone kept');

// ── ON: an absent / empty phone is left to the existing required-field check (unchanged) ──
for (const s of ['', null, undefined]) { const r = run(true, s); assert.strictEqual(JSON.stringify({ body: r.body, errors: r.errors, fields: r.fields }), r.before, `WIRE-ON-EMPTY-UNTOUCHED ${s}`); }
ok('ON: absent / empty phone → untouched (the required-field check owns it)');

console.log(`phone-wire: OK (${n})`);
