'use strict';
// Phase 1d Stage 1b — BACKFILL the coherent snapshot + RTDB mirror for the CURRENTLY ACTIVE versions.
//
// Both brands published their active versions before Stage 1b existed, so they have no active_snapshot
// and no mirror. This reads whatever version each pointer currently names and emits the snapshot + the
// mirror for exactly that version — it NEVER moves a pointer, so it cannot change what customers are
// charged. Idempotent: re-running rewrites the same coherent snapshot.
//
// Run (owner, post-gate):  GOOGLE_CLOUD_PROJECT=xpizza-delivery node tools/backfill-snapshot.js
// Then verify:             node tools/verify-catalog.js   (pricing must still be identical — inert)
try { require('dotenv').config(); } catch (_) { /* devDependency; this needs only ADC */ }
const admin = require('firebase-admin');
const { getActiveVersionId, readVersionDocs } = require('../catalog/catalog-firestore');
const { snapshotRefOf, snapshotOf, writeMirror, tablesFromVersionDocs } = require('../catalog/catalog-publish');
const { makeRtdbMirror, RTDB_URL } = require('../catalog/mirror-rtdb');

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: RTDB_URL,   // 1b REVISE: ADC + GOOGLE_CLOUD_PROJECT alone do NOT resolve RTDB — without
                           // this, admin.database() throws and the tool dies before writing anything.
});
const db = admin.firestore();
const mirror = makeRtdbMirror(admin.database());

(async () => {
  let failures = 0;
  for (const rid of ['x_pizza', 'la_musa']) {
    const versionId = await getActiveVersionId(db, rid);
    if (!versionId) { console.error(`${rid}: NO active version pointer — nothing to backfill (publish first)`); failures++; continue; }
    // readVersionDocs runs the same completeness + price-validity checks the money path uses, so a
    // version that could not be served cannot be snapshotted either.
    const docs = await readVersionDocs(db, rid, versionId);
    const { menuTable, extraTable } = tablesFromVersionDocs(docs);
    // 2b-pre: RE-RUNNING THIS IS MANDATORY, not incidental. The snapshots and mirrors written before
    // the ordinal existed carry no `seq`, and 2b's reader treats an absent seq as too-stale (never
    // distance-zero) — so until this re-run lands, the fallback is correctly but permanently refused.
    if (!Number.isInteger(docs.seq)) throw new Error(`backfill_missing_seq: ${rid}/${versionId} — the version record has no seq ordinal`);
    await snapshotRefOf(db, rid).set(snapshotOf(rid, versionId, docs.seq, menuTable, extraTable));
    const res = await writeMirror(mirror, null, rid, { version: versionId, seq: docs.seq, rid, menu: menuTable, extras: extraTable });
    if (!res.mirrored) failures++;
    console.log(`${rid}: snapshot + ${res.mirrored ? 'mirror' : 'MIRROR FAILED'} for active version ${versionId} (seq ${docs.seq}) ` +
      `(${Object.keys(menuTable).length} items + ${Object.keys(extraTable).length} extras) — pointer UNCHANGED`);
  }
  if (failures) { console.error(`backfill-snapshot: ${failures} failure(s)`); process.exit(1); }
  console.log('backfill-snapshot complete — snapshots coherent with the CURRENT pointers, nothing flipped');
  process.exit(0);
})().catch((e) => { console.error('backfill-snapshot failed:', e && e.message); process.exit(1); });
