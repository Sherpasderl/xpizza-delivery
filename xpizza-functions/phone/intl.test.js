'use strict';
// INTL PHONE S-core step 1 (PLAN-intl-phone r2.3 §2/§2A/§3/§3A) — phone/intl.js, the server's ONE wire-contract parser. Pure.
// Run: node phone/intl.test.js
const assert = require('assert');
const I = require('./intl');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── 1. the supported set mirrors the capp picker (customer-app/capp-phone.js COUNTRIES @ feat/capp-intl-phone 12f63661) ──
const CAPP_GOLDEN = [['504', 8], ['1', 10], ['52', 10], ['502', 8], ['503', 8], ['505', 8], ['506', 8], ['507', 8], ['501', 7], ['34', 9]];
assert.deepStrictEqual(I.SUPPORTED.map((c) => [c.cc, c.len]), CAPP_GOLDEN, 'INTL-SUPPORTED-PARITY with the capp picker');
assert.ok(Object.isFrozen(I.SUPPORTED) && I.SUPPORTED.every(Object.isFrozen), 'INTL-SUPPORTED-FROZEN');
ok('SUPPORTED == the capp picker table (10 countries, national lengths), frozen');

// ── 2. qualified submissions: '+' + supported CC + exact national length ──
const Q = [
  ['+504 9795-0000', '504', '97950000'], ['+50497950000', '504', '97950000'], ['+1 (219) 795-0000', '1', '2197950000'],
  ['+52 55 1234 5678', '52', '5512345678'], ['+502 5555-1234', '502', '55551234'], ['+503 7000-1234', '503', '70001234'],
  ['+505 8888-1234', '505', '88881234'], ['+506 8888-1234', '506', '88881234'], ['+507 6999-9999', '507', '69999999'],
  ['+501 622-1234', '501', '6221234'], ['+34 612 34 56 78', '34', '612345678'], ['  +504 9795 0000  ', '504', '97950000'],
];
for (const [raw, cc, nat] of Q) {
  assert.deepStrictEqual(I.parseSubmitted(raw), { cc, national: nat, canonical: `+${cc}${nat}`, identity: `${cc}${nat}` }, `INTL-QUALIFIED ${JSON.stringify(raw)}`);
}
ok(`qualified: every supported country, with the usual punctuation → {cc, national, canonical '+CCnat', identity 'CCnat'} (${Q.length})`);

// ── 3. legacy bare: EXACTLY 8 digits ⇒ +504; any other bare length is rejected (never guessed as NANP etc.) ──
assert.deepStrictEqual(I.parseSubmitted('9795-0000'), { cc: '504', national: '97950000', canonical: '+50497950000', identity: '50497950000' }, 'INTL-BARE-8-IS-HN');
assert.deepStrictEqual(I.parseSubmitted('97950000'), I.parseSubmitted('+504 9795 0000'), 'INTL-BARE-8-EQUALS-QUALIFIED-HN');
for (const raw of ['2197950000', '50497950000', '12197950000', '9795000', '979500001', '']) assert.strictEqual(I.parseSubmitted(raw), null, `INTL-BARE-NOT-8-REJECTED ${JSON.stringify(raw)}`);
ok('bare: exactly 8 digits ⇒ +504; a bare 10 / 11 / 7 / 9-digit number or empty → rejected');

// ── 4. rejects: malformed qualification, unsupported CC, wrong length, junk — never a fallback ──
const R = [
  '+97950000',            // the plan §2 bug: '+' with 8 digits must NOT become +504
  '+44 7911 123456',      // unsupported (the plan's fixture)
  '+504 9795-000', '+504 9795-00001', '+1 219 795 000', '+52 55 1234 567', '+501 622-12345', '+34 612 34 56 7',
  '+5016221234',          // the r1 §4 probe — VALID Belize here (asserted below), filtered out of the reject loop
  '++50497950000', '+504+97950000', '504+97950000', '+ ', '+', 'call +504 9795-0000', '+504 9795-0000 ext 2', '+504#97950000',
  '+５０４９７９５００００', '+504 9795 0000', null, undefined, 50497950000, {}, [], '+5212345678901',
];
// '+5016221234' is a VALID Belize number (501 + 7 digits); the r1 probe's INVALID case is under a +504-default picker
// (client hydration, S-picker). Here it parses as BZ — assert that explicitly and drop it from the reject list.
assert.deepStrictEqual(I.parseSubmitted('+5016221234'), { cc: '501', national: '6221234', canonical: '+5016221234', identity: '5016221234' }, 'INTL-BZ-7');
for (const raw of R.filter((r) => r !== '+5016221234')) assert.strictEqual(I.parseSubmitted(raw), null, `INTL-REJECT ${JSON.stringify(raw)}`);
ok(`rejects with no fallback: '+'+8 digits, +44, every wrong length, double '+', inner '+', words, '#', non-ASCII digits / nbsp, non-strings (${R.length - 1}); +501+7 is Belize`);

// ── 5. equal last-8 across countries never collide ──
const a = I.parseSubmitted('+504 9795-0000'), b = I.parseSubmitted('+502 9795-0000'), c = I.parseSubmitted('+1 219 795 0000');
assert.ok(a.identity !== b.identity && a.identity.slice(-8) === b.identity.slice(-8), 'INTL-SAME-SUFFIX-DISTINCT');
assert.ok(new Set([a.canonical, b.canonical, c.canonical]).size === 3, 'INTL-CANONICAL-DISTINCT');
ok('equal last-8 suffixes in +504 / +502 stay distinct identities');

// ── 6. legacyRawForms: the raw strings older servers stored for the SAME number (the dual-read set, §3A) ──
assert.deepStrictEqual(I.legacyRawForms('+50497950000'), ['+50497950000', '50497950000', '97950000'], 'INTL-LEGACY-HN');
assert.deepStrictEqual(I.legacyRawForms('+12197950000'), ['+12197950000', '12197950000'], 'INTL-LEGACY-INTL-NO-BARE-8');
assert.deepStrictEqual(I.legacyRawForms('+50297950000'), ['+50297950000', '50297950000'], 'INTL-LEGACY-502-NEVER-BARE-8');
for (const bad of ['97950000', '+44791112345', '', null, '+504 9795-0000']) assert.deepStrictEqual(I.legacyRawForms(bad), [], `INTL-LEGACY-NON-CANONICAL ${JSON.stringify(bad)}`);
ok('legacyRawForms: canonical first, then the no-+ form, and the bare-8 ONLY for +504; anything not canonical → []');

console.log(`intl: OK (${n})`);
