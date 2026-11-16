'use strict';
// offer-audience BUILD T12 (PLAN-5f-offer-audience r4.1 §5 «account deletion», owner DECISIONS:5013) — deleting an account removes the
// frozen codes (orders/{id}/audience_ids) of EVERY order in its history, in the deletion's own atomic update (the history ids are read
// before that update removes the history); the per-brand markers are KEPT (owner: keep the coded fact — otherwise a delete + re-sign-up
// re-unlocks «new»). Another customer's order is untouched. Real chain: orders by test/_audience-seed.js; the REAL deleteAccountCore.
// Run: node marketing/audience-deletion.test.js
const assert = require('assert');
const S = require('../test/_audience-seed');
const { HOUR, T0, quiet, profile, aworld, placeOrder, status, codes, KEY, RID } = S;
const OTP = require('../otp-lib');
const SE = require('../signup-endpoints');
const ACCOUNT = require('../account-lib');
const AR = require('./audience-read');
const OW = require('./offer-wire');
const BO = require('./brand-of');

let n = 0; let FINISHED = false; const fails = [];
async function cell(label, fn) { OW._resetCaches(); BO._reset(); try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ audience-deletion: exited without completing\n'); process.exitCode = 1; } });

(async () => {
  await cell('AD-CODES: the deleted account\'s open orders lose their codes; another customer\'s keep theirs; the brand marker is KEPT', async (L) => {
    const w = await aworld(); profile(w, 'u1'); profile(w, 'u2', '+504 9999-1111');
    const done = await placeOrder(w, 'u1'); await status(w, done, 'delivered', T0 + HOUR);   // the marker exists (kept on deletion)
    const open1 = await placeOrder(w, 'u1'); const open2 = await placeOrder(w, 'u1', { at: T0 + 60000 }); const other = await placeOrder(w, 'u2');
    assert.ok(w.fake.get(`orders/${open1}/audience_ids`) && w.fake.get(`orders/${open2}/audience_ids`), 'premise: codes frozen');
    const ok = await SE.deleteAccountCore(w.db, ACCOUNT, { uid: 'u1', phoneHash: OTP.phoneHash(S.PHONE), now: T0 + 2 * HOUR, revoke: async () => {} });
    assert.strictEqual(ok, true, 'premise: deleted');
    assert.deepStrictEqual([w.fake.get(`orders/${open1}/audience_ids`), w.fake.get(`orders/${open2}/audience_ids`)], [null, null], `🔴 ${L}: the account's codes are gone`);
    assert.ok(w.fake.get(`orders/${other}/audience_ids`), `🔴 ${L}: another customer's codes stay`);
    assert.deepStrictEqual(w.fake.get(`customer_seen/tb/${codes().p}`), { m: '2026-11' }, `🔴 ${L}: the brand marker is kept (owner 5013)`);
    profile(w, 'u3');   // the same phone signs up again
    assert.strictEqual((await AR.resolveAudience(w.db, { uid: 'u3', rid: RID, key: KEY, nowMs: T0 + 3 * HOUR, log: quiet })).kind, 'returning', `🔴 ${L}: a delete + re-sign-up stays RETURNING`);
  });
  FINISHED = true;
  if (fails.length) { console.log(`audience-deletion: ${fails.length} FAILED`); process.exit(1); }
  console.log(`audience-deletion: OK (${n})`);
})();
