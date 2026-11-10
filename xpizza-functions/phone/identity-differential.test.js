'use strict';
// INTL PHONE S-core step 2 (PLAN-intl-phone r2.3 §3, §5 "parsing support is permanent"; build-order ruling 2026-10-27) — the
// STORED-DATA identity path is FROZEN: whatsapp.normalizePhone and otp-lib.phoneHash stay byte-identical to origin/main 8a31e2a3.
// The plan §2 bug ('+97950000' → +504) is fixed at the SUBMISSION boundary (phone/intl.js parseSubmitted, steps 3/4, flagged),
// never here — stored '+'+8 records (accepted by the old sanitizePhone) keep their HN meaning for claim / sends / denylist,
// exactly as stats does (ruling (c)).
//   1. GOLDEN: normalizePhone + phoneHash over the r1 §9 matrix, a FIXED synthetic salt, == the base's values (characterization,
//      generated at 8a31e2a3 — phone/identity-golden.json).
//   2. INVARIANT: every number parseSubmitted accepts hashes IDENTICALLY as raw and as canonical, and normalizePhone(canonical)
//      === its identity digits — so a canonical order phone keeps today's phoneHash (claim-order, signup tickets, welcome).
// Run: node phone/identity-differential.test.js
process.env.OTP_SALT = 'tb_fixed_salt_for_phone_differential_00000000';
const assert = require('assert');
const O = require('../otp-lib');
const W = require('../whatsapp');
const { parseSubmitted } = require('./intl');
const GOLDEN = require('./identity-golden.json');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

// ── 1. the frozen golden ──
const keys = Object.keys(GOLDEN);
assert.ok(keys.length >= 20, 'non-vacuity: the matrix is present');
for (const k of keys) {
  const raw = JSON.parse(k);
  assert.deepStrictEqual(quiet(() => ({ n: W.normalizePhone(raw), h: O.phoneHash(raw) })), GOLDEN[k], `IDENTITY-GOLDEN ${k}`);
}
assert.strictEqual(GOLDEN['"+97950000"'].n, '50497950000', 'premise: the stored +8 form keeps its HN meaning');
ok(`normalizePhone + phoneHash == the 8a31e2a3 golden over ${keys.length} inputs (fixed synthetic salt); stored '+97950000' stays HN`);

// ── 2. canonical keeps today's identity ──
const ACCEPTED = ['97950000', '+504 9795-0000', '+1 (219) 795-0000', '+52 55 1234 5678', '+502 5555-1234', '+503 7000-1234', '+505 8888-1234',
  '+506 8888-1234', '+507 6999-9999', '+501 622-1234', '+34 612 34 56 78'];
for (const raw of ACCEPTED) {
  const p = parseSubmitted(raw);
  assert.ok(p, `premise ${raw}`);
  assert.strictEqual(quiet(() => W.normalizePhone(p.canonical)), p.identity, `IDENTITY-CANONICAL-NORMALIZES ${raw}`);
  assert.strictEqual(quiet(() => O.phoneHash(p.canonical)), quiet(() => O.phoneHash(raw)), `IDENTITY-CANONICAL-SAME-HASH ${raw}`);
}
ok(`every accepted submission (${ACCEPTED.length}, all 10 countries): normalizePhone(canonical) === identity, phoneHash(canonical) === phoneHash(raw)`);

// ── 3. the realistic corpus (advisor step-2 condition): every live shape, seeded — forms (valid / partial / over-length), capp
//       E.164 + member-under-504, OTP overlay, stored profile / inbound / old-sanitizePhone forms, the stored '+'+8 ──
const { buildCorpus } = require('./identity-corpus');
const corpus = buildCorpus();
const CORPUS_DIGEST_8A31E2A3 = '2e78bfc5b2ce49316d4812cfdfe58b6c09320365df8d1f6ca4c829cac7291e0a';   // generated at origin/main 8a31e2a3
const h = require('crypto').createHash('sha256');
let valid = 0;
for (const x of corpus) {
  const r = quiet(() => [W.normalizePhone(x), O.phoneHash(x)]);
  h.update(JSON.stringify([x, r[0], r[1]]) + '\n');
  const p = parseSubmitted(x);
  if (p) { valid++; assert.strictEqual(r[0], p.identity, `IDENTITY-CORPUS-VALID-SHAPE-UNCHANGED ${x}`); }
}
assert.ok(corpus.length === 2160 && valid === 880, `non-vacuity: corpus ${corpus.length}, contract-valid ${valid}`);
assert.strictEqual(h.digest('hex'), CORPUS_DIGEST_8A31E2A3, 'IDENTITY-CORPUS-DIGEST: some live shape changed normalizePhone / phoneHash vs 8a31e2a3');
ok(`corpus of ${corpus.length} live shapes (${valid} contract-valid): normalizePhone + phoneHash digest == 8a31e2a3; every contract-valid shape normalizes to its parsed identity`);

console.log(`identity-differential: OK (${n})`);
