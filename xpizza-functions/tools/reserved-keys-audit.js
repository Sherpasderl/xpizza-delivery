'use strict';
// CLI — S1c (PLAN-portal-item-edit r6 §2.2, §5 step 3; D4c-grill/item-s1/S1c-DESIGN.md D5). Rebuild one restaurant's RECOVERABLE
// reservations into restaurants/{rid}/meta/reserved_keys. Owner-run, one restaurant at a time.
//
// DRY RUN (reads only, writes NOTHING — start here):
//   node tools/reserved-keys-audit.js --rid=x_pizza --project xpizza-delivery
// APPLY (one transaction: reads the set, writes the union; it never removes a key):
//   node tools/reserved-keys-audit.js --rid=x_pizza --project xpizza-delivery --apply
//
// Prints COUNTS only, never a key. NOT a proof of complete history: a key that lived only in a pruned version and whose
// identity row was later moved away, and a never-registered key of an uncertified publish that was later removed and pruned,
// cannot be recovered (plan §6). Idempotent: a second apply adds nothing.
// The project guard runs first — before dotenv, firebase-admin or any credential (see backfill-identities.js).
const { requireProject } = require('./require-project');
const { checkRegistered } = require('./registered-roster');
const PROJECT_ID = requireProject({ requireFlag: true });

const ARGS = require('./cert-cli-args').parseCertArgs('reserved-keys-audit', process.argv.slice(2), { options: ['rid'], flags: ['apply'] });
if (ARGS.refused) { console.error(ARGS.refused); process.exit(1); }
if (!ARGS.rid) { console.error('reserved-keys-audit: REFUSED — --rid=<rid> is required (one restaurant at a time)'); process.exit(1); }
const RID = ARGS.rid;
const APPLY = ARGS.apply === true;

try { require('dotenv').config(); } catch (_) { /* dotenv is a devDependency; this needs only ADC */ }
const admin = require('firebase-admin');
const AUDIT = require('../catalog/reserved-keys-audit');
const RK = require('../catalog/reserved-keys');

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID });
const db = admin.firestore();

(async () => {
  const roster = await checkRegistered(db, RID);
  if (!roster.ok) { console.error(`reserved-keys-audit: REFUSED — ${RID} is not a registered restaurant (${roster.reason})`); process.exit(1); }
  const { plan, counts } = await AUDIT.collectRecoverable(db, RID);
  const current = await RK.reservedRefOf(db, RID).get();
  const would = AUDIT.wouldAdd(current.exists ? current.data() : undefined, plan);
  console.log(`reserved_keys: ${RID} project=${PROJECT_ID} sources id_rows=${counts.id_rows} key_rows=${counts.key_rows} versions=${counts.versions} frozen=${counts.frozen} distinct_keys=${counts.distinct_keys}`);
  console.log(`reserved_keys: would add ${would} (set has ${current.exists ? Object.keys((current.data() || {}).keys || {}).length : 0} keys now)`);
  console.log('reserved_keys: recoverable reservations only — keys lost to pruned versions after a move, and never-registered keys of removed uncertified publishes, are not recoverable (plan §6)');
  if (!APPLY) { console.log('reserved_keys: DRY RUN — nothing written (add --apply to write the union)'); return; }
  const r = await AUDIT.applyRecoverable(db, RID, plan);
  console.log(`reserved_keys: added ${r.added}; the set now holds ${r.total} keys`);
})().then(() => process.exit(0), (e) => { console.error(`reserved-keys-audit: FAILED — ${e && e.message}`); process.exit(1); });
