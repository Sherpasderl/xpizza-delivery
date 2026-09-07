'use strict';
/**
 * Portal 2b-2a Task 1 — the ownership index must not be client-writable.
 * Run: npm run test:owner-rules
 *   = firebase emulators:exec --only database "node test/owner-rules.emulator.test.js"
 *
 * The reverse index decides which catalogs a merchant can load, and the forward index decides who may
 * sign the fiscal acknowledgement for any brand on the platform factura. Both are worth attacking directly.
 *
 * THE DISPATCHER CASE IS THE ONE THAT MATTERS. `dispatchers/{uid}` and `restaurants/{rid}/kitchen_staff/{uid}`
 * are both DISPATCHER-WRITABLE in database.rules.json. Had the ownership index copied that pattern —
 * the obvious thing, since it sits right beside them — any dispatcher could have added themselves as an
 * owner and then produced their own fiscal acknowledgement, which is the exact bypass 2b-1 Task 7 exists
 * to close. It is deny-by-default instead, and this proves that rather than assuming it.
 *
 * Deny-by-default is easy to lose by accident: someone adding a rule to `restaurants/$rid` for an
 * unrelated feature could open a read or write that cascades onto `owners`. This test fails loudly if
 * that ever happens.
 *
 * Plain-node style (no jest), matching the repo's other rules suites.
 */
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');

const DISP = 'dispuid000001';     // a real dispatcher — the dangerous case
const STAFF = 'staffuid00001';    // kitchen staff at merch_a
const OWNER = 'owneruid00001';    // an actual owner of merch_a
const OTHER = 'otheruid00001';    // an owner of merch_b, i.e. a different tenant
const RANDO = 'randouid00001';    // authenticated, nothing else
const RID = 'merch_a';            // brand-agnostic ids throughout
const RID2 = 'merch_b';

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-owner-rules', database: { rules: RULES } });

  // Seed the memberships with rules disabled — this is what the admin tool does via the Admin SDK.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.database();
    await d.ref(`dispatchers/${DISP}`).set(true);
    await d.ref(`restaurants/${RID}/kitchen_staff/${STAFF}`).set(true);
    await d.ref(`restaurants/${RID}/owners/${OWNER}`).set(true);
    await d.ref(`owner_restaurants/${OWNER}/${RID}`).set(true);
    await d.ref(`restaurants/${RID2}/owners/${OTHER}`).set(true);
    await d.ref(`owner_restaurants/${OTHER}/${RID2}`).set(true);
  });

  const asUid = (uid, claims) => env.authenticatedContext(uid, claims).database();
  const dispDb = asUid(DISP);
  const staffDb = asUid(STAFF);
  const ownerDb = asUid(OWNER);
  const otherDb = asUid(OTHER);
  const randoDb = asUid(RANDO);
  const custDb = asUid('custuid000001', { customer: true });
  const anonDb = env.unauthenticatedContext().database();

  const set = (db, p, v) => db.ref(p).set(v);
  const upd = (db, p, v) => db.ref(p).update(v);
  const get = (db, p) => db.ref(p).get();

  let n = 0;
  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ✓ ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ✓ ${++n} ${label}`); };

  // ── A. NOBODY may write the FORWARD index (the authorization tier) ───────────────────────────
  const FWD = `restaurants/${RID}/owners/${RANDO}`;
  await no('A: a DISPATCHER cannot grant ownership — the bypass that would defeat the fiscal gate', set(dispDb, FWD, true));
  await no('A: a dispatcher cannot make THEMSELVES an owner', set(dispDb, `restaurants/${RID}/owners/${DISP}`, true));
  await no('A: kitchen staff cannot grant ownership', set(staffDb, FWD, true));
  await no('A: an existing OWNER cannot add another owner (no self-service co-ownership)', set(ownerDb, FWD, true));
  await no('A: an owner cannot grant themselves a SECOND restaurant', set(ownerDb, `restaurants/${RID2}/owners/${OWNER}`, true));
  await no('A: a customer-claim token cannot', set(custDb, FWD, true));
  await no('A: a random authenticated user cannot', set(randoDb, FWD, true));
  await no('A: an anonymous client cannot', set(anonDb, FWD, true));
  await no('A: nor via a multi-path update at the parent', upd(dispDb, `restaurants/${RID}`, { [`owners/${RANDO}`]: true }));
  await no('A: nor by replacing the whole owners node', set(dispDb, `restaurants/${RID}/owners`, { [RANDO]: true }));

  // ── B. NOBODY may write the REVERSE index (which catalogs the portal loads) ──────────────────
  const REV = `owner_restaurants/${RANDO}/${RID}`;
  await no('B: a dispatcher cannot write the reverse index', set(dispDb, REV, true));
  await no('B: an owner cannot add a restaurant to their OWN reverse index', set(ownerDb, `owner_restaurants/${OWNER}/${RID2}`, true));
  await no('B: a tenant cannot write ANOTHER tenant\'s reverse index', set(otherDb, `owner_restaurants/${OWNER}/${RID2}`, true));
  await no('B: a customer cannot', set(custDb, REV, true));
  await no('B: an anonymous client cannot', set(anonDb, REV, true));
  await no('B: nor by replacing the whole subtree', set(dispDb, `owner_restaurants/${RANDO}`, { [RID]: true }));
  await no('B: nor the entire root node', set(dispDb, 'owner_restaurants', { [RANDO]: { [RID]: true } }));

  // ── C. DELETION is a write too — revoking someone else's ownership is an attack ──────────────
  await no('C: a dispatcher cannot REVOKE an owner (forward)', set(dispDb, `restaurants/${RID}/owners/${OWNER}`, null));
  await no('C: a tenant cannot revoke another tenant (reverse)', set(otherDb, `owner_restaurants/${OWNER}/${RID}`, null));
  await no('C: an owner cannot delete their own forward grant', set(ownerDb, `restaurants/${RID}/owners/${OWNER}`, null));

  // ── D. READS are closed too — the index is not a public directory of who owns what ───────────
  await no('D: a random user cannot read the reverse index', get(randoDb, `owner_restaurants/${OWNER}`));
  await no('D: a tenant cannot enumerate another tenant\'s holdings', get(otherDb, `owner_restaurants/${OWNER}`));
  await no('D: an anonymous client cannot read the owners node', get(anonDb, `restaurants/${RID}/owners`));
  await no('D: nor can a customer', get(custDb, `owner_restaurants/${OWNER}`));

  // ── E. NON-VACUITY. The suite must be able to see a SUCCESS, or "everything is denied" would
  //       also pass against a totally broken environment where every operation fails.
  await ok('E: non-vacuity — an authenticated client CAN read something the rules do allow', get(dispDb, `restaurants/${RID}/identity/name`));
  await ok('E: non-vacuity — a dispatcher CAN write where the rules do allow it (kitchen_staff)', set(dispDb, `restaurants/${RID}/kitchen_staff/${RANDO}`, true));
  // ...which is exactly the pattern the ownership index deliberately does NOT follow.

  await env.cleanup();
  console.log(`owner-rules.emulator: OK (${n} assertions)`);
  process.exit(0);
})().catch((e) => { console.error('owner-rules.emulator: FAIL\n', e); process.exit(1); });
