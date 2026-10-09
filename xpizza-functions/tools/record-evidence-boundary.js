#!/usr/bin/env node
'use strict';
// 1D D4-c2b — record the evidence BOUNDARY G0 per restaurant from the c2a ROLLOUT RECORD (PLAN-D4c2b rev 14 §1, §10.2; advisor
// ruling N2, DECISIONS 2026-10-09 "c2b N2 BOUNDARY"). OWNER-RUN, DRY RUN unless --apply. WRITE-ONCE: an existing boundary is
// never overwritten.
//
//   node tools/record-evidence-boundary.js --project xpizza-delivery --from-rollout-record tools/identity-boundary-records/2026-10-09.json [--rid <rid>] [--apply]
//
// G0 is NEVER derived from today's pointer. The input is the RECORDED read-only observation (version + full-precision updateTime
// per restaurant, read after c2a went ready); tools/identity-boundary-core.js decides: unchanged pointer, or every generation since
// the record evidenced → G0 = Gpre + 1; a gap or an inconsistency → REFUSED. Reads are read-only Firestore transactions; the write
// is ONE RTDB transaction on catalog_integrity/{rid} through the monitor's own reducer (setBoundary: write-once, relabels any
// boundary_unknown finding below G0 as pre_boundary, initialises audited_through = G0 − 1). Run with the monitor job PAUSED (§10).
const fs = require('fs');
const core = require('./identity-boundary-core');
const S = require('../catalog/identity-integrity-state');
const { activationDocId, EVIDENCE_COL } = require('../catalog/identity-evidence');
const { readPointerSnap } = require('../catalog/catalog-firestore');
const { INTEGRITY_PATH } = require('../catalog/identity-integrity-monitor');

const MAX_SPAN = 200;   // a span this long since the record is not a fresh rollout: refuse rather than read without bound

async function observe(db, rid, Gpre) {
  return db.runTransaction(async (tx) => {
    const ptr = await tx.get(db.collection('restaurants').doc(rid).collection('meta').doc('active_version'));
    const evidence = new Map();
    if (ptr.exists) {
      const cur = readPointerSnap(ptr, rid);
      if (cur.generation > Gpre && cur.generation - Gpre <= MAX_SPAN) {
        const col = db.collection('restaurants').doc(rid).collection(EVIDENCE_COL);
        for (let g = Gpre + 1; g <= cur.generation; g += 1) {
          const s = await tx.get(col.doc(activationDocId(g)));
          evidence.set(g, s.exists ? { id: s.id, data: s.data() } : null);
        }
      } else if (cur.generation - Gpre > MAX_SPAN) return { tooFar: true, pointer: ptr };
    }
    return { pointer: ptr, evidence, readTime: ptr.readTime };
  }, { readOnly: true });
}

async function run({ db, rtdb, record, rid = null, apply = false, log = console.log }) {
  const bad = core.validateRecord(record);
  if (bad) return { ok: false, refused: `rollout record invalid: ${bad}` };
  const rids = rid ? [rid] : Object.keys(record.restaurants).sort();
  const out = [];
  for (const r of rids) {
    const rec = record.restaurants[r];
    if (!rec) { out.push({ rid: r, ok: false, reason: 'not_in_record' }); continue; }
    const Gpre = core.recordedPointer({ rid: r, pointer: rec.pointer }).generation;
    const now = await observe(db, r, Gpre);
    if (now.tooFar) { out.push({ rid: r, ok: false, reason: 'span_too_long' }); continue; }
    const d = core.decide(r, rec, { pointer: now.pointer, evidence: now.evidence });
    const readIso = now.readTime ? now.readTime.toDate().toISOString() : null;
    log(`${r}: Gpre ${d.Gpre} (recorded ${rec.version} @ ${rec.updateTime}) → ${d.ok ? `G0 ${d.G0} [${d.branch}]` : `REFUSED ${d.reason}${d.missing ? ` missing ${JSON.stringify(d.missing)}` : ''}${d.malformed && d.malformed.length ? ` malformed ${JSON.stringify(d.malformed)}` : ''}`}`);
    if (!d.ok) { out.push({ rid: r, ...d }); continue; }
    const doc = core.boundaryDoc(record, r, d, readIso);
    if (!apply) { out.push({ rid: r, ...d, wouldWrite: doc }); continue; }
    let written = false; let existing = null;
    const res = await rtdb.ref(`${INTEGRITY_PATH}/${r}`).transaction((cur) => {
      written = false; existing = cur && cur.boundary ? cur.boundary : null;
      if (existing) return undefined;   // WRITE-ONCE: abort, nothing changes
      const step = S.setBoundary(cur, doc); written = step.written;
      return S.withSize(step.node);
    }, undefined, false);
    out.push({ rid: r, ...d, written: !!(res && res.committed && written), existing });
    log(`${r}: ${existing ? `boundary EXISTS (G0 ${existing.G0}, ${existing.source}) — not overwritten` : (written ? `boundary written: G0 ${doc.G0}` : 'not written')}`);
  }
  return { ok: out.every((x) => x.ok), results: out };
}

module.exports = { run, observe, MAX_SPAN };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });   // FIRST: before any client is constructed
  const file = val('--from-rollout-record');
  if (!file) { console.error('record-evidence-boundary: REFUSED — --from-rollout-record <file> is required (G0 is never derived from today\'s pointer)'); process.exit(2); }
  const admin = require('firebase-admin');
  const { RTDB_URL } = require('../catalog/mirror-rtdb');
  admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
  const apply = argv.includes('--apply');
  console.log(`record-evidence-boundary ${apply ? 'APPLY' : 'DRY RUN'} — project ${PROJECT_ID}, record ${file}`);
  run({ db: admin.firestore(), rtdb: admin.database(), record: JSON.parse(fs.readFileSync(file, 'utf8')), rid: val('--rid'), apply })
    .then((r) => {
      if (r.refused) { console.error(`record-evidence-boundary: REFUSED — ${r.refused}`); process.exit(1); }
      if (!apply) console.log('(dry run — nothing written; add --apply)');
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => { console.error('record-evidence-boundary: FAILED —', e && e.message); process.exit(1); });
}
