'use strict';
/* CUTOVER PRE-FLIGHT — every restaurant's active_version pointer is readable.
 *
 * 🔴 WHY THIS IS A TOOL AND NOT A MEMORY. Since E-1a a pointer document that EXISTS but names no
 * version is a FAULT on every read path, including the customer menu. That is the right call — only
 * the flip writes it and it always writes a version, so a versionless one is a partial write, and
 * reading it as "nothing published yet" would let a first publish's CAS overwrite whatever is really
 * live. But it is NOT self-healing: such a pointer refuses on READ and on PUBLISH alike, because the
 * draft partition reads it through the same shared reader before anything else runs. The repair is to
 * DELETE the document. An operator told to "publish again" would be stuck.
 * So this is a step the owner runs before the bootstrap pass, rather than a check somebody remembers.
 *
 * Reads only. Writes nothing. Pins the project like every other CLI here.
 */
const { requireProject } = require('./require-project');
const admin = require('firebase-admin');
const { readPointerSnap } = require('../catalog/catalog-firestore');

const PROJECT_ID = requireProject();
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID });
const db = admin.firestore();

(async () => {
  const shops = await db.collection('restaurants').get();
  const rows = [];
  for (const doc of (shops.docs || [])) {
    const rid = doc.id;
    const snap = await db.collection('restaurants').doc(rid).collection('meta').doc('active_version').get();
    try {
      const p = readPointerSnap(snap, rid);
      rows.push({ rid, ok: true,
        state: p.exists ? `version ${p.version} @ generation ${p.generation}` : 'ABSENT (never published — fine)' });
    } catch (e) {
      rows.push({ rid, ok: false, state: (e && e.message) || String(e) });
    }
  }
  const bad = rows.filter((r) => !r.ok);
  for (const r of rows) console.log(`${r.ok ? '  ok ' : '  🔴 '}${r.rid.padEnd(24)} ${r.state}`);
  if (bad.length) {
    console.error(`\n🔴 ${bad.length} restaurant(s) have an UNUSABLE pointer. Bootstrap must not run.`);
    console.error('   A pointer that exists but names no version is a partial write. It refuses on READ and on');
    console.error('   PUBLISH, so re-publishing will NOT clear it — DELETE the meta/active_version document,');
    console.error('   which is the genuine "nothing published" state, then publish.\n');
    process.exit(1);
  }
  console.log(`\nall ${rows.length} restaurant(s) have a readable pointer — bootstrap may proceed.\n`);
  process.exit(0);
})().catch((e) => { console.error('preflight-pointers FAILED:', (e && e.message) || e); process.exit(1); });
