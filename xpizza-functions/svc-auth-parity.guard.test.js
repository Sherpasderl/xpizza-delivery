'use strict';
// S1a AUTH-SHAPE PARITY guard (codex r1 P1-7 follow-up). With databaseAuthVariableOverride, the rules' `auth` is
// EXACTLY the override object — so the production override and the test harness that "proves" it must present the SAME
// auth shape, or the harness proves nothing about production. This guard pins:
//   1. the production override literal lib/svc-assigner.js SVC_AUTH = {uid:'svc-assigner', token:{svc_assigner:true}}
//      — uid top-level (rules key on auth.uid), token PRESENT (so the svc claim txn's /tasks read, which evaluates
//      auth.token.customer, resolves to null → !== true → allowed, never a missing-object deref);
//   2. the parity + eligibility harnesses construct the svc context with authenticatedContext(..., { svc_assigner: true })
//      — the SAME custom token claims as SVC_AUTH.token — so their rule evaluation matches production's override.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SVC_AUTH } = require('./lib/svc-assigner');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

// 1. the production override literal
assert.deepStrictEqual(SVC_AUTH, { uid: 'svc-assigner', token: { svc_assigner: true } }, '🔴 the svc-assigner override shape changed — update the harnesses + this guard together');
assert.strictEqual(SVC_AUTH.uid, 'svc-assigner', 'uid is top-level (rules evaluate auth.uid)');
assert.ok(SVC_AUTH.token && typeof SVC_AUTH.token === 'object', '🔴 token MUST be present so auth.token.customer resolves instead of dereferencing a missing object');
assert.strictEqual(SVC_AUTH.token.customer, undefined, 'auth.token.customer is absent → !== true → allowed, exactly as a non-customer');
ok('the production override literal is {uid:"svc-assigner", token:{svc_assigner:true}} — token present, uid top-level');

// 2. the harnesses present the SAME custom token claims as the override
const tokenClaims = JSON.stringify(SVC_AUTH.token);   // {"svc_assigner":true}
const claimsLiteral = `{ svc_assigner: true }`;        // the exact source literal the harnesses must pass
assert.strictEqual(JSON.stringify({ svc_assigner: true }), tokenClaims, 'the expected source claims literal matches SVC_AUTH.token');
for (const f of ['test/driver-eligibility-rules.emulator.test.js', 'test/driver-assignment-parity.emulator.test.js']) {
  const src = read(f);
  const m = src.match(/authenticatedContext\(\s*(?:SVC|'svc-assigner')\s*,\s*(\{[^}]*\})\s*\)/);
  assert.ok(m, `🔴 ${f}: the svc context must be built as authenticatedContext('svc-assigner', { svc_assigner: true }) so it carries the override's token claims`);
  assert.strictEqual(m[1].replace(/\s/g, ''), claimsLiteral.replace(/\s/g, ''), `🔴 ${f}: the svc context's token claims must EQUAL SVC_AUTH.token (${tokenClaims})`);
}
ok('both the eligibility + parity harnesses build the svc context with the SAME token claims as the override');

// 3. non-vacuity: a mismatched claims literal is detected
{
  const bad = `authenticatedContext('svc-assigner', { customer: true })`;
  const m = bad.match(/authenticatedContext\(\s*(?:SVC|'svc-assigner')\s*,\s*(\{[^}]*\})\s*\)/);
  assert.ok(m && m[1].replace(/\s/g, '') !== claimsLiteral.replace(/\s/g, ''), 'non-vacuity: a different claims literal does not match');
}
ok('non-vacuity: a mismatched token-claims literal is detected');

console.log(`\nsvc-auth-parity.guard: OK (${n})`);
