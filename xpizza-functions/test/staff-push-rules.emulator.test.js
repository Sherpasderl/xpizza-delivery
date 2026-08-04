/**
 * Behavioral suite for the Phase-2 staff_push RTDB rules (Mobile Dispatch-lite web push).
 *
 * Run against the Firebase RTDB emulator:
 *   npm run test:staff-push-rules
 *     = firebase emulators:exec --only database --project demo-xpizza \
 *         "node test/staff-push-rules.emulator.test.js"
 *
 * Covers the staff_push/$uid contract (own-uid read + own-uid non-customer write):
 *   A — a staff user writes/reads ONLY its own staff_push/$uid.
 *   B — a staff user cannot write or read another uid's subscription.
 *   C — a customer-token user cannot write (auth.token.customer !== true clause).
 *   D — anon cannot read or write.
 * (staff_push_state / order push_alerted are admin-only — written by Cloud Functions which bypass
 *  rules — so there is intentionally no client rule to test for them.)
 *
 * Plain-node style (no jest) to match the repo's existing `node *.test.js` tests.
 */
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');

const STAFF = 'u_staff0000000000000000';
const OTHER = 'u_other0000000000000000';
const SUB = { subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'k1', auth: 'k2' } }, updated_at: 1700000000000 };

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-xpizza',
    database: { rules: RULES },
  });

  // Admin-seed OTHER's subscription (rules disabled) so the cross-user read test has a target.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref('staff_push/' + OTHER).set(SUB);
  });

  const staffDb = env.authenticatedContext(STAFF).database();                          // staff (no customer claim)
  const otherDb = env.authenticatedContext(OTHER).database();
  const custDb  = env.authenticatedContext('u_cust0000000000000000', { customer: true }).database();
  const anonDb  = env.unauthenticatedContext().database();

  let n = 0;
  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ok ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ok ${++n} ${label}`); };
  const set = (db, p, v) => db.ref(p).set(v);
  const get = (db, p) => db.ref(p).get();

  // ── A: own-uid read + write ──
  await ok('A staff writes its own staff_push/$uid', set(staffDb, 'staff_push/' + STAFF, SUB));
  await ok('A staff reads its own staff_push/$uid', get(staffDb, 'staff_push/' + STAFF));

  // ── B: cross-user denied ──
  await no('B staff cannot write another uid', set(staffDb, 'staff_push/' + OTHER, SUB));
  await no('B staff cannot read another uid', get(staffDb, 'staff_push/' + OTHER));

  // ── C: customer token cannot write (customer !== true clause) ──
  await no('C customer-token user cannot write its own staff_push', set(custDb, 'staff_push/u_cust0000000000000000', SUB));

  // ── D: anon denied ──
  await no('D anon cannot write', set(anonDb, 'staff_push/' + STAFF, SUB));
  await no('D anon cannot read', get(anonDb, 'staff_push/' + STAFF));

  await env.cleanup();
  console.log(`staff-push-rules: OK (${n} cases)`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
