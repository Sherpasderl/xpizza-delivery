'use strict';
// CLI — ROLL the active_version pointer BACK to a retained prior version. One atomic flip, plus a
// re-emitted snapshot + RTDB mirror describing the version rolled TO (never the one rolled away from).
//
// This exists because portal 2a's cutover runbook needs an executable rollback. rollbackVersion has
// been implemented and tested since 1c-b2, but nothing invoked it — so the documented recovery step
// would have meant writing code during an incident. This is a thin, deliberately boring wrapper.
//
// LIST (read-only, changes NOTHING — start here):
//   node tools/rollback-version.js --rid=x_pizza
// ROLL BACK (writes: one pointer flip + snapshot + mirror):
//   node tools/rollback-version.js --rid=x_pizza --to=<versionId>
// Then ALWAYS verify:
//   node tools/verify-catalog.js
//
// The target is EXPLICIT and never inferred. "The previous version" is ambiguous exactly when it
// matters most — mid-incident, after more than one publish — and a wrong guess re-publishes the prices
// you are trying to escape.
try { require('dotenv').config(); } catch (_) { /* dotenv is a devDependency; this needs only ADC */ }
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const { rollbackVersion } = require('../catalog/catalog-publish');
const { makeRtdbMirror, RTDB_URL } = require('../catalog/mirror-rtdb');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : null;
};
const RID = arg('rid');
const TO = arg('to');
const KNOWN = ['x_pizza', 'la_musa'];

// THE PROJECT GUARD, before anything resolves a credential or constructs a client: a refusal
// here cannot have read or written a byte. See tools/require-project.js.
const PROJECT_ID = requireProject();
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: PROJECT_ID,   // NEVER the ambient gcloud default — that is what nearly wrote a catalog into another project

  databaseURL: RTDB_URL,   // without this admin.database() throws and the tool dies before writing anything
});
const db = admin.firestore();

(async () => {
  if (!RID) {
    console.error('usage: node tools/rollback-version.js --rid=<restaurant> [--to=<versionId>]\n' +
                  '       omit --to to LIST the retained versions (read-only)');
    process.exit(2);
  }
  if (!KNOWN.includes(RID)) console.warn(`note: ${RID} is not one of the two founding brands (${KNOWN.join(', ')})`);

  const col = db.collection('restaurants').doc(RID).collection('versions');
  const [snap, pointer] = await Promise.all([col.get(), db.collection('restaurants').doc(RID).collection('meta').doc('active_version').get()]);
  const active = pointer.exists ? (pointer.data() || {}).version : null;
  const rows = snap.docs.map((d) => {
    const v = d.data() || {};
    const created = v.created_at && v.created_at.toMillis ? new Date(v.created_at.toMillis()).toISOString() : '(no timestamp)';
    return { id: d.id, seq: v.seq, created, items: v.item_count, extras: v.extra_count };
  }).sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0));

  if (!TO) {
    console.log(`${RID} — active: ${active || '(none)'}\nretained versions (newest first):`);
    for (const r of rows) console.log(`  ${r.id === active ? '*' : ' '} ${r.id}  seq=${r.seq}  ${r.created}  ${r.items} items + ${r.extras} extras`);
    console.log('\nnothing changed. re-run with --to=<versionId> to roll back.');
    process.exit(0);
  }
  if (!rows.some((r) => r.id === TO)) {
    console.error(`refusing: ${TO} is not a retained version of ${RID}. Run without --to to list them.`);
    process.exit(1);
  }
  if (TO === active) {
    console.error(`refusing: ${TO} is ALREADY active for ${RID} — nothing to roll back.`);
    process.exit(1);
  }
  console.log(`rolling ${RID} back: ${active || '(none)'} → ${TO}`);
  // The pointer this rollback was DECIDED against — read above, re-asserted inside the flip. A
  // rollback is chosen by a human reading the list a moment ago; if a publish lands in between, the
  // rollback would silently bury it, and the operator would have rolled back past something they
  // never saw. No draftRevision: a rollback is not derived from the draft, and claiming it was would
  // be a check that means nothing.
  const res = await rollbackVersion(db, RID, TO, { mirror: makeRtdbMirror(admin.database()), expected: { activeVersionId: active } });
  console.log(`  done — active_version=${res.versionId}, mirrored=${res.mirrored}`);
  console.log('now run: node tools/verify-catalog.js');
  process.exit(0);
})().catch((e) => { console.error('rollback failed (pointer NOT moved unless stated above):', e && e.message); process.exit(1); });
