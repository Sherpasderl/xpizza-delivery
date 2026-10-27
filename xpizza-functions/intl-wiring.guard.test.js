'use strict';
// INTL PHONE S-core step 3 — index.js wiring guard for the flagged wire contract (the photos/portalui-wiring pattern).
//   1. PROOF: tools/intl-inverse.js turns index.js back into 8a31e2a3:index.js BYTE-FOR-BYTE (each hunk exactly once); a byte inside /
//      outside a hunk, a duplicated and a missing hunk are each detected.
//   2. SAME-LINE: index.js has exactly the base's line count; exactly the three hunk lines differ (createOrder, chargeOnlineOrder,
//      requestOtp).
//   3. EXACT TEXT: each hunk = the untouched `validateOrderPayload(body, restaurantId, pricingTables);` call (the seam pinned by
//      fail-closed-reject.test) + applyWireContract(ONE flag read, body, errors, fields) — BEFORE the line that checks `errors`.
//   4. sanitizePhone and validateOrderPayload are byte-identical to the base.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, BASE, unapplyIntlIndex } = require('./tools/intl-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

// ── 1. the inverse ──
let undone; try { undone = unapplyIntlIndex(real); } catch (e) { throw new Error(`🔴 INTL-WIRING-PROOF: ${e.message}`); }   // a thrown inverse carries the marker too
assert.strictEqual(undone, baseIdx, `🔴 INTL-WIRING-PROOF: index.js minus the intl hunks is not ${BASE}:index.js`);
assert.notStrictEqual(real, baseIdx, 'non-vacuity: the slice is present');
assert.strictEqual(HUNKS.length, 3);
for (const h of HUNKS) {
  assert.ok(real.includes(h.now), 'non-vacuity: each hunk is present');
  assert.throws(() => unapplyIntlIndex(real.replace(h.now, h.now.replace('phoneWireStrict', 'phoneWireStrikt'))), /occurs 0 times/, 'a byte INSIDE a hunk');
  assert.ok(h.now.includes('phoneWireStrict'), 'premise: every hunk reads the flag');
  assert.throws(() => unapplyIntlIndex(real + h.now), /occurs 2 times/, 'a duplicated hunk');
  assert.throws(() => unapplyIntlIndex(real.replace(h.now, h.was)), /occurs 0 times/, 'a missing hunk');
}
assert.notStrictEqual(unapplyIntlIndex(real.replace('exports.verifyOtp', 'exports.verifyOtP')), baseIdx, 'a byte OUTSIDE every hunk survives and fails the base pin');
ok(`PROOF: unapplyIntlIndex(index.js) === ${BASE}:index.js byte-for-byte (${HUNKS.length} hunks, each once); inside / outside / duplicated / missing each detected`);

// ── 2. same-line ──
const rl = real.split('\n'), bl = baseIdx.split('\n');
assert.strictEqual(rl.length, bl.length, '🔴 INTL-WIRING-SAME-LINE: index.js gained or lost a line (R3 binds call sites by line)');
const differing = rl.map((l, i) => (l === bl[i] ? null : i)).filter((i) => i !== null);
assert.deepStrictEqual(differing.map((i) => `${rl[i]}\n`), HUNKS.map((h) => h.now), 'INTL-WIRING-SAME-LINE: exactly the three hunk lines differ, in order');
ok(`SAME-LINE: index.js has the base's ${bl.length} lines; exactly lines ${differing.map((i) => i + 1).join(' and ')} differ`);

// ── 3. the exact pinned text, before the errors check, in the right handler ──
const SEAM = '  const { errors, total, lat, lng, fields } = validateOrderPayload(body, restaurantId, pricingTables);';
const WIRE = " require('./phone/wire').applyWireContract(await require('./phone/flag').phoneWireStrict(db), body, errors, fields);   // INTL S-core step 3 — the flagged wire contract (OFF = no-op) ";
for (const [i, name, tag] of [[0, 'createOrder', 'create'], [1, 'chargeOnlineOrder', 'charge']]) {
  assert.strictEqual(HUNKS[i].now, `${SEAM}${WIRE}[${tag}]\n`, `🔴 INTL-WIRING-EXACT ${name}`);
  assert.strictEqual(HUNKS[i].was, `${SEAM}\n`, `INTL-WIRING-WAS ${name}`);
  const at = differing[i];
  assert.ok(/^\s*if \(errors\.length > 0\)/.test(rl[at + 1]), `INTL-WIRING-BEFORE-ERRORS-CHECK ${name}`);
}
assert.ok(differing[0] < real.split('\n').findIndex((l) => l.startsWith('exports.createOrder = onRequest(')), 'the first hunk is in createOrderApp');
assert.ok(rl.slice(0, differing[1]).some((l) => l.includes("console.log(`chargeOnlineOrder: restaurant_id=")), 'the second hunk is in the chargeOnlineOrder handler');
assert.strictEqual(real.split('phoneWireStrict(db)').length - 1, 2, 'INTL-WIRING-ONE-READ-PER-HANDLER');
// step 4 — requestOtp: the gate after the pHash check, BEFORE the IP / per-phone reservations and the send; the same uniform answer
const UNIFORM = 'return res.status(200).json({ ok: true, cooldown: 30 });';
assert.strictEqual(HUNKS[2].was, `      if (!pHash) ${UNIFORM}   // uniform — no enumeration\n`, 'INTL-WIRING-OTP-WAS');
assert.strictEqual(HUNKS[2].now, `      if (!pHash) ${UNIFORM} if (!(await require('./phone/login-gate').otpLoginAllowed({ db: getDatabase(), phone, restaurantId, strict: await require('./phone/flag').phoneWireStrict(getDatabase()) }))) ${UNIFORM}   // uniform — no enumeration (INTL S-core step 4: the per-sender login gate refuses uniformly)\n`, '🔴 INTL-WIRING-OTP-EXACT');
const otpAt = differing[2], reqAt = rl.findIndex((l) => l.startsWith('exports.requestOtp = onRequest('));
const verAt = rl.findIndex((l) => l.startsWith('exports.verifyOtp = onRequest('));
assert.ok(reqAt < otpAt && otpAt < verAt, 'INTL-WIRING-OTP-IN-REQUESTOTP (never verifyOtp: an issued code is honoured)');
const after = rl.slice(otpAt + 1, verAt).join('\n');
for (const later of ["db.ref('otp_ip/'", "db.ref('otp/' + pHash).transaction", 'whatsapp.sendMessage(phone, whatsapp.tplOtp']) assert.ok(after.includes(later), `INTL-WIRING-OTP-BEFORE ${later}`);
assert.ok(!rl.slice(verAt, verAt + 60).join('\n').includes('login-gate'), 'INTL-WIRING-VERIFY-UNGATED');
ok('EXACT: intake hunks = the untouched seam + applyWireContract(one flag read), right before `if (errors.length > 0)`; requestOtp = the login gate after the pHash check, before the IP / phone reservations and the send, uniform refusal; verifyOtp ungated');

// ── 4. sanitizePhone / validateOrderPayload untouched ──
const fnText = (src, sig) => { const a = src.indexOf(sig); return src.slice(a, src.indexOf('\n}\n', a) + 3); };
for (const sig of ['function sanitizePhone(v) {', 'function validateOrderPayload(body, restaurantId, tables = null) {']) {
  assert.ok(fnText(real, sig).length > 100, `premise ${sig}`);
  assert.strictEqual(fnText(real, sig), fnText(baseIdx, sig), `INTL-WIRING-UNTOUCHED ${sig}`);
}
ok('sanitizePhone and validateOrderPayload are byte-identical to the base');

console.log(`\nintl-wiring.guard: OK (${n})`);
