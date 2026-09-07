'use strict';
// CLI — GRANT a merchant owner. Writes BOTH directions of the ownership index in one atomic update:
//   restaurants/{rid}/owners/{uid}   the authorization tier (2b-1's fiscal gate reads this)
//   owner_restaurants/{uid}/{rid}    the portal's "which restaurants do I own?" lookup
//
// LIST what a uid owns (read-only, changes NOTHING — start here):
//   node tools/seed-owner.js --uid=<uid>
// GRANT:
//   node tools/seed-owner.js --rid=<restaurant> --uid=<uid>
// REVOKE (removes BOTH paths, same atomicity):
//   node tools/seed-owner.js --rid=<restaurant> --uid=<uid> --revoke
//
// WHY THIS IS THE ONLY WRITER: both paths are deny-by-default in database.rules.json — no stanza grants
// a client write to `restaurants/{rid}/owners` or to `owner_restaurants`. That is deliberate and must
// stay so. `dispatchers/{uid}` and `kitchen_staff/{uid}` ARE dispatcher-writable, so copying their
// pattern here would let any dispatcher make themselves an owner and sign their own fiscal
// acknowledgement. The Admin SDK bypasses rules, which is why the grant lives in a tool an operator
// runs rather than in an endpoint. catalog/owner-rules.emulator.test.js proves the denial.
//
// BACKFILL: owners that predate this index must be granted once per (rid, uid) — until then the portal
// shows that owner no restaurants, and (since 2b-1) a platform-factura brand's publishes fail closed
// with not_owner. Which brands those are is a config lookup (factura/eligibility.js), not a name here.
try { require('dotenv').config(); } catch (_) { /* dotenv is a devDependency; this needs only ADC */ }
const admin = require('firebase-admin');
const { ownerGrantPaths, readOwnerRestaurants, RID_RE, UID_RE } = require('../catalog/owner-index');
const { RTDB_URL } = require('../catalog/mirror-rtdb');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : null;
};
const RID = arg('rid');
const UID = arg('uid');
const REVOKE = process.argv.includes('--revoke');

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: RTDB_URL,   // without this admin.database() throws before writing anything
});
const db = admin.database();

(async () => {
  if (!UID) {
    console.error('usage: node tools/seed-owner.js --uid=<uid> [--rid=<restaurant>] [--revoke]\n' +
                  '       --uid alone LISTS what that uid owns (read-only)');
    process.exit(2);
  }
  if (!UID_RE.test(UID)) {
    console.error(`refusing: ${JSON.stringify(UID)} is not a valid uid (alphanumeric, 6-128 chars) — it would build an RTDB path`);
    process.exit(1);
  }

  if (!RID) {
    const owned = await readOwnerRestaurants(db, UID);
    console.log(`${UID} owns: ${owned.length ? owned.join(', ') : '(nothing)'}`);
    console.log('\nnothing changed. re-run with --rid=<restaurant> to grant.');
    process.exit(0);
  }
  if (!RID_RE.test(RID)) {
    console.error(`refusing: ${JSON.stringify(RID)} is not a valid restaurant id — it would build an RTDB path`);
    process.exit(1);
  }

  // ownerGrantPaths is the single definition of WHICH paths a grant touches, so a revoke can never
  // clear a different set than a grant writes.
  const paths = ownerGrantPaths(RID, UID);
  const update = {};
  for (const p of Object.keys(paths)) update[p] = REVOKE ? null : true;

  const already = await readOwnerRestaurants(db, UID);
  const has = already.includes(RID);
  if (!REVOKE && has) console.log(`${UID} already owns ${RID} — re-applying is idempotent`);
  if (REVOKE && !has) console.log(`${UID} does not currently own ${RID} — clearing anyway (both paths)`);

  // ONE update: RTDB applies a multi-path update atomically, so the two directions cannot half-apply.
  // The dangerous half would be the reverse index naming a restaurant the forward index does not —
  // a merchant listed as owning something they do not own.
  await db.ref().update(update);
  console.log(`${REVOKE ? 'REVOKED' : 'GRANTED'} ${UID} ${REVOKE ? 'from' : 'on'} ${RID}:`);
  for (const p of Object.keys(paths)) console.log(`  ${REVOKE ? '- ' : '+ '}${p}`);

  const after = await readOwnerRestaurants(db, UID);
  console.log(`\n${UID} now owns: ${after.length ? after.join(', ') : '(nothing)'}`);
  process.exit(0);
})().catch((e) => { console.error('seed-owner failed:', e && e.message); process.exit(1); });
