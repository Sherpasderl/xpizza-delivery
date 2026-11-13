'use strict';
// INTL PHONE S-core step 3 — index.js wiring guard for the flagged wire contract (the photos/portalui-wiring pattern).
//   1. PROOF: tools/intl-inverse.js turns index.js back into 8a31e2a3:index.js BYTE-FOR-BYTE (each hunk exactly once); a byte inside /
//      outside a hunk, a duplicated and a missing hunk are each detected.
//   2. SAME-LINE: index.js has exactly the base's line count; exactly the hunk lines differ (createOrder, chargeOnlineOrder,
//      requestOtp, and S-match's 3-line STATUS_CHECK block).
//   3. EXACT TEXT: each hunk = the untouched `validateOrderPayload(body, restaurantId, pricingTables);` call (the seam pinned by
//      fail-closed-reject.test) + applyWireContract(ONE flag read, body, errors, fields) — BEFORE the line that checks `errors`.
//   4. sanitizePhone and validateOrderPayload are byte-identical to the base.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, BASE, unapplyIntlIndex } = require('./tools/intl-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// DRYRUN R-WIRE (2e): intl-core is merged NEWEST onto the assembly, so its 8a31e2a3 pin first folds out every other layer the tip
// carries (the checkout-wiring toBase pattern: lifecycle → checkout → the tip layers, and mem512's hunk 5 restored to 8a31e2a3's 256MiB).
const FS5 = require('./tools/mem512-inverse').HUNKS.find((h) => h.fn === 'formSignal');
const TIP_LAYERS = ['mem512', 'pausa', 's4hours', 'formbake', 'area', 's2app', 's2tip', 's5r', 's3c', 's3b', 's3a', 'driver-ledger'];
const foldOthers = (src) => {
  let out = require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(src));
  for (const t of TIP_LAYERS) {
    const m = require(`./tools/${t}-inverse`); out = m[Object.keys(m).find((k) => /^unapply\w*Index$/.test(k))](out);
    if (t === 'mem512') { const k = out.split(FS5.was).length - 1; if (k !== 1) throw new Error(`intl-wiring: the 8a31e2a3 formSignal line occurs ${k} times`); out = out.replace(FS5.was, () => FS5.now); }
  }
  return out;
};
const real = foldOthers(require('./tools/photos-inverse').unapplyPhotosIndex(require('./tools/_asm-next2-layers').stripNewer('index.js', require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', require('./tools/s1d-module-inverse').unapplyS1dModule('index.js', require('./tools/s2-module-inverse').unapplyS2Module('index.js', require('./tools/s1srv-module-inverse').unapplyS1srvModule('index.js', require('./tools/d3live-module-inverse').unapplyD3liveModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))))))))))   /* DRYRUN R-WIRE (2e): photos A1/A2 (newest) innermost */ );
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

// ── 1. the inverse ──
let undone; try { undone = unapplyIntlIndex(real); } catch (e) { throw new Error(`🔴 INTL-WIRING-PROOF: ${e.message}`); }   // a thrown inverse carries the marker too
assert.strictEqual(undone, baseIdx, `🔴 INTL-WIRING-PROOF: index.js minus the intl hunks is not ${BASE}:index.js`);
assert.notStrictEqual(real, baseIdx, 'non-vacuity: the slice is present');
assert.strictEqual(HUNKS.length, 5);
for (const h of HUNKS) {
  assert.ok(real.includes(h.now), 'non-vacuity: each hunk is present');
  assert.ok(h.now.includes("require('./phone/"), 'premise: every hunk calls into phone/');
  assert.throws(() => unapplyIntlIndex(real.replace(h.now, h.now.replace("require('./phone/", "require('./phonE/"))), /occurs 0 times/, 'a byte INSIDE a hunk');
  assert.throws(() => unapplyIntlIndex(real + h.now), /occurs 2 times/, 'a duplicated hunk');
  assert.throws(() => unapplyIntlIndex(real.replace(h.now, h.was)), /occurs 0 times/, 'a missing hunk');
}
assert.notStrictEqual(unapplyIntlIndex(real.replace('exports.verifyOtp', 'exports.verifyOtP')), baseIdx, 'a byte OUTSIDE every hunk survives and fails the base pin');
ok(`PROOF: unapplyIntlIndex(index.js) === ${BASE}:index.js byte-for-byte (${HUNKS.length} hunks, each once); inside / outside / duplicated / missing each detected`);

// ── 2. same-line ──
const rl = real.split('\n'), bl = baseIdx.split('\n');
assert.strictEqual(rl.length, bl.length, '🔴 INTL-WIRING-SAME-LINE: index.js gained or lost a line (R3 binds call sites by line)');
const diffLines = rl.map((l, i) => (l === bl[i] ? null : i)).filter((i) => i !== null);
const groups = []; for (const i of diffLines) { const g = groups[groups.length - 1]; if (g && g[g.length - 1] === i - 1) g.push(i); else groups.push([i]); }
const differing = groups.map((g) => g[0]);
const lineOf = (h) => real.slice(0, real.indexOf(h.now)).split('\n').length - 1;   // a hunk's first line (0-based)
assert.deepStrictEqual(groups.map((g) => g.map((i) => `${rl[i]}\n`).join('')), [...HUNKS].sort((a, b) => lineOf(a) - lineOf(b)).map((h) => h.now), 'INTL-WIRING-SAME-LINE: exactly the hunk lines differ');
ok(`SAME-LINE: index.js has the base's ${bl.length} lines; exactly lines ${groups.map((g) => g.map((i) => i + 1).join('-')).join(', ')} differ`);

// ── 3. the exact pinned text, before the errors check, in the right handler ──
const SEAM = '  const { errors, total, lat, lng, fields } = validateOrderPayload(body, restaurantId, pricingTables);';
const WIRE = " require('./phone/wire').applyWireContract(require('./phone/flag').phoneWireStrictNow(db), body, errors, fields);   // INTL S-core step 3 — the flagged wire contract (OFF = no-op) ";
for (const [i, name, tag] of [[0, 'createOrder', 'create'], [1, 'chargeOnlineOrder', 'charge']]) {
  assert.strictEqual(HUNKS[i].now, `${SEAM}${WIRE}[${tag}]\n`, `🔴 INTL-WIRING-EXACT ${name}`);
  assert.strictEqual(HUNKS[i].was, `${SEAM}\n`, `INTL-WIRING-WAS ${name}`);
  const at = lineOf(HUNKS[i]);
  assert.ok(/^\s*if \(errors\.length > 0\)/.test(rl[at + 1]), `INTL-WIRING-BEFORE-ERRORS-CHECK ${name}`);
}
assert.ok(lineOf(HUNKS[0]) < real.split('\n').findIndex((l) => l.startsWith('exports.createOrder = onRequest(')), 'the first hunk is in createOrderApp');
assert.ok(rl.slice(0, lineOf(HUNKS[1])).some((l) => l.includes("console.log(`chargeOnlineOrder: restaurant_id=")), 'the second hunk is in the chargeOnlineOrder handler');
assert.strictEqual(real.split('phoneWireStrictNow(db)').length - 1, 2, 'INTL-WIRING-ONE-READ-PER-HANDLER');
assert.ok(!/await\s+require\('\.\/phone\/flag'\)/.test(real) && !/phoneWireStrict\(/.test(real), '🔴 INTL-WIRING-NO-AWAITED-FLAG (codex r1 #2: hot paths read the flag synchronously, never awaited)');
// step 4 — requestOtp: the gate after the pHash check, BEFORE the IP / per-phone reservations and the send; the same uniform answer
const UNIFORM = 'return res.status(200).json({ ok: true, cooldown: 30 });';
assert.strictEqual(HUNKS[2].was, `      if (!pHash) ${UNIFORM}   // uniform — no enumeration\n`, 'INTL-WIRING-OTP-WAS');
assert.strictEqual(HUNKS[2].now, `      if (!pHash) ${UNIFORM} if (!(await require('./phone/login-gate').otpLoginAllowed({ db: getDatabase(), phone, restaurantId, strict: () => require('./phone/flag').phoneWireStrictNow(getDatabase()) }))) ${UNIFORM}   // uniform — no enumeration (INTL S-core step 4: the per-sender login gate refuses uniformly)\n`, '🔴 INTL-WIRING-OTP-EXACT');
const otpAt = lineOf(HUNKS[2]), reqAt = rl.findIndex((l) => l.startsWith('exports.requestOtp = onRequest('));
const verAt = rl.findIndex((l) => l.startsWith('exports.verifyOtp = onRequest('));
assert.ok(reqAt < otpAt && otpAt < verAt, 'INTL-WIRING-OTP-IN-REQUESTOTP (never verifyOtp: an issued code is honoured)');
const after = rl.slice(otpAt + 1, verAt).join('\n');
for (const later of ["db.ref('otp_ip/'", "db.ref('otp/' + pHash).transaction", 'whatsapp.sendMessage(phone, whatsapp.tplOtp']) assert.ok(after.includes(later), `INTL-WIRING-OTP-BEFORE ${later}`);
assert.ok(!rl.slice(verAt, verAt + 60).join('\n').includes('login-gate'), 'INTL-WIRING-VERIFY-UNGATED');
// S-match — STATUS_CHECK: the full-number compare, inside onIncomingWhatsApp's STATUS_CHECK branch, AFTER the restaurant scope
const smAt = lineOf(HUNKS[3]) + 1;   // the samePhone line (the hunk's 2nd)
assert.ok(HUNKS[3].now.includes("if (!require('./phone/match').samePhone(o.customer_phone, fromPhoneRaw)) {"), '🔴 INTL-WIRING-SMATCH-EXACT');
assert.ok(!HUNKS[3].now.includes('slice(-8)') && HUNKS[3].was.includes('slice(-8)'), 'INTL-WIRING-SMATCH-NO-SUFFIX');
assert.strictEqual(HUNKS[3].now.split('\n').length, HUNKS[3].was.split('\n').length, 'INTL-WIRING-SMATCH-SAME-LINE-COUNT');
const scopeAt = rl.slice(0, smAt).map((l, i) => (l.includes("if ((o.restaurant_id || 'x_pizza') !== restaurantId) return false;") ? i : -1)).filter((i) => i >= 0).pop();
assert.ok(scopeAt !== undefined && smAt - scopeAt <= 3, 'INTL-WIRING-SMATCH-AFTER-RESTAURANT-SCOPE (restaurant_id scope preserved)');
assert.ok(rl.slice(Math.max(0, smAt - 20), smAt).some((l) => l.includes("if (intent === 'STATUS_CHECK') {")), 'INTL-WIRING-SMATCH-IN-STATUS-CHECK');
assert.ok(!real.split('\n').some((l, i) => i > smAt - 30 && i < smAt + 30 && /\.slice\(-8\)/.test(l)), 'INTL-WIRING-SMATCH-NO-SUFFIX-LEFT');
// codex r1 #4 — the mute READ uses readMute (both leaves); the mute WRITE is still the identity key via inbound.muteKeyFor (unchanged line)
assert.strictEqual(HUNKS[4].was, "      const muteRec = (await mdb.ref(`whatsapp_mute/${restaurantId}/${inbound.muteKeyFor(fromPhoneRaw)}`).once('value')).val();\n", 'INTL-WIRING-MUTE-READ-WAS');
assert.ok(HUNKS[4].now.startsWith("      const muteRec = await require('./phone/match').readMute(mdb, restaurantId, fromPhoneRaw);"), '🔴 INTL-WIRING-MUTE-READ-BOTH-LEAVES');
assert.strictEqual(real.split("await mdb.ref(`whatsapp_mute/${restaurantId}/${k}`).set({ at: Date.now() });").length - 1, 1, 'INTL-WIRING-MUTE-WRITER-UNCHANGED (one identity-key write)');
ok('EXACT: intake hunks = the untouched seam + applyWireContract(one flag read), right before `if (errors.length > 0)`; requestOtp = the login gate after the pHash check, before the IP / phone reservations and the send, uniform refusal; verifyOtp ungated; STATUS_CHECK = samePhone after the restaurant scope, no suffix left');

// ── 4. sanitizePhone / validateOrderPayload untouched ──
const fnText = (src, sig) => { const a = src.indexOf(sig); return src.slice(a, src.indexOf('\n}\n', a) + 3); };
for (const sig of ['function sanitizePhone(v) {', 'function validateOrderPayload(body, restaurantId, tables = null) {']) {
  assert.ok(fnText(real, sig).length > 100, `premise ${sig}`);
  assert.strictEqual(fnText(real, sig), fnText(baseIdx, sig), `INTL-WIRING-UNTOUCHED ${sig}`);
}
ok('sanitizePhone and validateOrderPayload are byte-identical to the base');

console.log(`\nintl-wiring.guard: OK (${n})`);
