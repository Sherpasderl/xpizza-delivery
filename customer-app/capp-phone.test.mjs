// Customer app S-picker (PLAN-intl-phone r2.3 §2A; MOCKUP-intl-phone-picker-APPROVED-2026-10-27): the country module and the
// checkout's per-country validation / E.164 wire. Light: no DOM.
// Run: node --test customer-app/capp-phone.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('./capp-phone.js');
const C = require('./capp-checkout.js');

test('S-picker countries: the plan\'s SUPPORTED set, in the mockup\'s order, with its national lengths and placeholders (Honduras the default)', () => {
  assert.deepEqual(P.COUNTRIES.map((c) => [c.name, c.cc, c.len, c.ph]), [
    ['Honduras', '504', 8, '9999-9999'], ['Estados Unidos', '1', 10, '(555) 123-4567'], ['México', '52', 10, '55 1234 5678'],
    ['Guatemala', '502', 8, '9999-9999'], ['El Salvador', '503', 8, '9999-9999'], ['Nicaragua', '505', 8, '9999-9999'],
    ['Costa Rica', '506', 8, '9999-9999'], ['Panamá', '507', 8, '6999-9999'], ['Belice', '501', 7, '622-1234'], ['España', '34', 9, '612 34 56 78']]);
  assert.equal(P.DEFAULT_CC, '504');
  // every placeholder is its own format of a full-length number (one source for the shape)
  for (const c of P.COUNTRIES) assert.equal(P.format(c.cc, c.ph), c.ph, `${c.name}: the format IS the placeholder's shape`);
});
test('S-picker format: the local format while typing, never past the national length', () => {
  assert.equal(P.format('1', '3055550147'), '(305) 555-0147'); assert.equal(P.format('1', '305'), '(305'); assert.equal(P.format('1', '3055'), '(305) 5');
  assert.equal(P.format('1', '305555014799'), '(305) 555-0147', '🔴 capped at 10');
  assert.equal(P.format('52', '5512345678'), '55 1234 5678'); assert.equal(P.format('501', '6221234'), '622-1234'); assert.equal(P.format('34', '612345678'), '612 34 56 78');
  assert.equal(P.format('504', '9999 0000'), '9999-0000'); assert.equal(P.format('504', '+504 9999-0000'), '5049-9990', 'digits only — a pasted +504 is not stripped by the formatter');
  assert.equal(P.format('504', ''), '');
});
test('S-picker E.164: compose only when complete; parse only a QUALIFIED number of a supported country with its exact length (+44 rejected, never guessed)', () => {
  assert.equal(P.toE164('1', '(305) 555-0147'), '+13055550147');
  assert.equal(P.valid('1', '305555014799'), false, '🔴 over the national length is not valid'); assert.equal(P.valid('1', '3055550147'), true); assert.equal(P.toE164('504', '9999-0000'), '+50499990000'); assert.equal(P.toE164('1', '305555014'), '', 'incomplete ⇒ nothing');
  for (const c of P.COUNTRIES) { const n = P.digits(c.ph); assert.deepEqual(P.parseE164('+' + c.cc + n), { cc: c.cc, national: n }, `${c.name} round-trips`); }
  assert.deepEqual(P.parseE164('+1 (305) 555-0147'), { cc: '1', national: '3055550147' }, 'punctuation tolerated');
  assert.equal(P.parseE164('+44 20 7946 0958'), null, '🔴 an unsupported country (+44) is rejected');
  assert.equal(P.parseE164('+130555501'), null, 'a wrong length is rejected');
  assert.equal(P.parseE164('99990000'), null, 'unqualified is not E.164');
  assert.equal(P.parseE164('+504 9999-000'), null);
  assert.equal(P.display('1', '3055550147'), '+1 (305) 555-0147');
});
test('S-picker checkout: a chosen country validates ITS length and sends E.164 (+504 too); no country ⇒ today\'s +504 path, byte for byte', () => {
  const ctx = { restaurantId: 'rid_a', orderId: 'TA1', items: [], itemsText: '' };
  const f = C.freshFlow(null); Object.assign(f, { name: 'Ana', phone: '9999-0000' });
  assert.equal(C.orderBody(f, ctx).customer_phone, '+504 9999-0000', 'no country: the forms\' format, unchanged');
  assert.equal(C.orderBody({ ...f, cc: '504' }, ctx).customer_phone, '+50499990000', 'the picker: E.164 for +504 too');
  assert.equal(C.orderBody({ ...f, cc: '1', phone: '(305) 555-0147' }, ctx).customer_phone, '+13055550147', '🔴 the chosen country on the wire');
  const need = (g) => C.missingStep(g, { member: null });
  assert.equal(need({ ...f, mode: 'pickup', cc: '1', phone: '(305) 555-01' }), C.COPY.phone, '🔴 a US number short of 10 digits is incomplete');
  assert.notEqual(need({ ...f, mode: 'pickup', cc: '1', phone: '(305) 555-0147' }), C.COPY.phone);
  assert.notEqual(need({ ...f, mode: 'pickup', cc: '501', phone: '622-1234' }), C.COPY.phone, 'Belice: 7 digits is complete');
  assert.equal(need({ ...f, mode: 'pickup', phone: '9999-000' }), C.COPY.phone, 'no country: 8 digits, as today');
});
test('no restaurant literal in the country module', () => {
  assert.equal(readFileSync(new URL('./capp-phone.js', import.meta.url), 'utf8').match(/x_pizza|la_musa|xpizza|lamusa|X\.? ?Pizza|La Musa/i), null);
});
test('S-picker checkout guard: with a country, a MEMBER\'s unreadable number is incomplete too (never sent); no country ⇒ the member path as today', () => {
  const f = C.freshFlow(null); Object.assign(f, { name: 'Ana', mode: 'pickup' });
  assert.equal(C.missingStep({ ...f, cc: '504', phone: '' }, { member: { uid: 'u1' } }), C.COPY.phone, '🔴 a member with no readable number is stopped');
  assert.notEqual(C.missingStep({ ...f, cc: '1', phone: '(305) 555-0147' }, { member: { uid: 'u1' } }), C.COPY.phone);
  assert.notEqual(C.missingStep({ ...f, phone: '' }, { member: { uid: 'u1' } }), C.COPY.phone, 'no country: a member is not re-validated, as today');
});
