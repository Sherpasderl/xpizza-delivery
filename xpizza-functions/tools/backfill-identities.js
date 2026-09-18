'use strict';
// CLI — Portal 1D · D1. Give every LIVE dish and extra a registry identity, one brand at a time.
//
// DRY RUN (reads only, writes NOTHING — start here):
//   node tools/backfill-identities.js --rid=x_pizza --project xpizza-delivery
// APPLY (writes registry rows; nothing else in the catalog is touched):
//   node tools/backfill-identities.js --rid=x_pizza --project xpizza-delivery --apply
//
// 🔴 THE KEYS COME FROM WHAT IS LIVE, NEVER FROM CODE — the same rule migrate-catalog-display states
// for prices, for the same reason. backfillIdentities takes a menu snapshot, and there are two things
// in this repo that look like one: catalogSnapshot(rid), which BUILDS from the code tables in
// menu-pricing/form-menu-source, and getRestaurantMenu(db, rid), which READS the published version out
// of Firestore. They agree today only because the live version was published from those same tables.
// The moment a merchant edits through the portal they diverge, and a backfill keyed from code would
// register identities for objects that are not live and miss the ones that are — minting ids for
// dishes nobody sells while the real ones serve id-less. So this reads the live version, through the
// same reader the serving path uses.
//
// IDEMPOTENT. A re-run mints nothing: every key already registered is preserved. Running it twice is
// not a mistake, and running it after a publish is how a newly added dish gets its id if the publish's
// own preserve-on-write missed the 5s registry deadline.
//
// WHAT IT WRITES: only restaurants/{rid}/identity/**. No version, no pointer, no price table, no
// mirror. Nothing reads these ids in D1 — they are shadow until D4 — so an apply cannot change a
// price, an availability answer, a reward or a factura.
/* 🔴 THE GUARD RUNS FIRST — BEFORE dotenv, BEFORE firebase-admin, BEFORE ANY CREDENTIAL.
   dotenv.config() can SET GOOGLE_CLOUD_PROJECT from a .env file that nobody reading the command line
   would see, so a guard that ran after it could be satisfied by a value the operator never stated.
   Ordering is the whole protection here: a refusal below has not loaded a config file, resolved a
   credential, constructed a client or read a byte.
   requireFlag: --project must be given as a FLAG. The runbook for this tool says it is mandatory, and
   a contract that the code does not enforce is a sentence, not a guarantee — an inherited or stale
   GOOGLE_CLOUD_PROJECT would otherwise satisfy it without the operator ever looking at which database
   they were about to write identities into. */
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });

try { require('dotenv').config(); } catch (_) { /* dotenv is a devDependency; this needs only ADC */ }
const admin = require('firebase-admin');
const { getRestaurantMenu } = require('../catalog/catalog-menu');
const { backfillIdentities, liveKeys } = require('../catalog/identity-backfill');
const { lookupByLegacyKeys } = require('../catalog/identity-registry');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : null;
};
const RID = arg('rid');
const APPLY = process.argv.includes('--apply');
const KNOWN = ['x_pizza', 'la_musa'];

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: PROJECT_ID,   // NEVER the ambient gcloud default
});
const db = admin.firestore();

(async () => {
  if (!RID || !KNOWN.includes(RID)) {
    console.error('usage: node tools/backfill-identities.js --rid=<x_pizza|la_musa> --project <id> [--apply]\n'
                + '       omit --apply for a DRY RUN (reads only)\n'
                + '       one brand per run, deliberately — see the 1D runbook');
    process.exit(2);
  }

  // THE LIVE CATALOG, through the serving reader. It fails closed on an absent pointer, an incomplete
  // read, a torn version or a content-hash mismatch — all of which must stop a backfill rather than
  // let it register a partial view of the menu.
  let menu;
  try {
    menu = await getRestaurantMenu(db, RID);
  } catch (e) {
    console.error(`\nREFUSED — cannot read ${RID}'s live catalog: ${(e && e.message) || e}`);
    console.error('Nothing was written. Fix the catalog read first; a backfill over a partial menu is worse than none.\n');
    process.exit(1);
  }
  console.log(`${RID}: live version ${menu.identity.version_id} (seq ${menu.identity.seq}) — ${menu.items.length} dishes, ${menu.extras.length} extras`);

  /* Enumerate first. liveKeys THROWS identity_backfill_unkeyable if any single record yields no
     legacy key, which is the loud failure that matters here: it means the reader is emitting a shape
     this cannot key, and the correct response is to stop, not to register the part it understood. */
  let keys;
  try {
    keys = liveKeys(RID, menu);
  } catch (e) {
    console.error(`\nREFUSED — ${(e && e.message) || e}`);
    console.error('\nThis means the live catalog contains a record the backfill cannot derive a pricing key from.');
    console.error('Nothing was written. Do NOT work around it: a partial registration leaves objects');
    console.error('permanently id-less with no signal. Report the named record and its fields.\n');
    process.exit(1);
  }

  const already = {
    dish: (await lookupByLegacyKeys(db, { rid: RID, kind: 'dish', legacyKeys: keys.dish })).size,
    extra: (await lookupByLegacyKeys(db, { rid: RID, kind: 'extra', legacyKeys: keys.extra })).size,
  };
  console.log(`  dishes: ${keys.dish.length} live, ${already.dish} already registered, ${keys.dish.length - already.dish} to mint`);
  console.log(`  extras: ${keys.extra.length} live, ${already.extra} already registered, ${keys.extra.length - already.extra} to mint`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to register the identities above.');
    process.exit(0);
  }

  const report = await backfillIdentities(db, RID, menu);
  console.log(`\napplied to ${RID}:`);
  for (const kind of ['dish', 'extra']) {
    console.log(`  ${kind}: ${report[kind].total} total — ${report[kind].created} created, ${report[kind].preserved} preserved`);
  }

  /* VERIFY WHAT LANDED, rather than trusting the report. The report says what this process believes it
     did; the lookup says what the database now holds, which is the thing the overlay will read. */
  const after = {
    dish: (await lookupByLegacyKeys(db, { rid: RID, kind: 'dish', legacyKeys: keys.dish })).size,
    extra: (await lookupByLegacyKeys(db, { rid: RID, kind: 'extra', legacyKeys: keys.extra })).size,
  };
  const complete = after.dish === keys.dish.length && after.extra === keys.extra.length;
  console.log(`  verified: ${after.dish}/${keys.dish.length} dishes and ${after.extra}/${keys.extra.length} extras resolve in the registry`);
  if (!complete) {
    console.error('\n🔴 INCOMPLETE — some live objects still have no identity. Re-run this command;');
    console.error('it is idempotent and will mint only what is missing. If it stays incomplete, stop and report.\n');
    process.exit(1);
  }
  console.log(`\ndone — ${RID} is fully registered. Re-running now would report ${report.dish.total + report.extra.total} preserved, 0 created.`);
  console.log('Nothing that decides a price, an 86, a reward or a factura reads these ids in D1.');
  process.exit(0);
})().catch((e) => {
  console.error('\nbackfill failed:', (e && e.message) || e);
  console.error('Registry rows already written are CORRECT and must not be deleted — re-run to finish.\n');
  process.exit(1);
});
