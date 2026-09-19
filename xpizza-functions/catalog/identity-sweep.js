'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4 — THE REGISTRY INTEGRITY SWEEP (the durable half of the self-heal).
//
// The writer guard in ensureIdentity closes the duplicate-id hazard for any object a write PASSES
// THROUGH. That is not the same as a guarantee, and the difference is the reason this exists:
//   · an orphan whose object is served id-less generates no lookup and no write, so nothing ever
//     visits it — traffic-driven repair simply never reaches it;
//   · an off-path detached write can be lost entirely to an instance freeze.
// So the writer guard repairs what happens to be touched, and this repairs the rest, on a schedule,
// idempotently, off the order path.
//
// 🔴 IT REPAIRS THE REVERSE ROW AND NOTHING ELSE. It never mints, never retires, never chooses between
// two live ids, and never touches a healthy row. An integrity job that can invent an identity is a
// worse problem than the corruption it was written for.
// ---------------------------------------------------------------------------
const crypto = require('crypto');   // eslint-disable-line no-unused-vars -- parity with the registry's imports

const STATUS_LIVE = 'live';
const encodeKey = (legacyKey) => Buffer.from(String(legacyKey), 'utf8').toString('base64url');
const idsColOf = (db, rid, kind) => db.collection('restaurants').doc(rid).collection('identity').doc(kind).collection('ids');
const keysColOf = (db, rid, kind) => db.collection('restaurants').doc(rid).collection('identity').doc(kind).collection('keys');

/* One brand, one kind. Returns what it found and what it repaired, so the caller can log a number
   rather than a shrug — a sweep that reports nothing is indistinguishable from a sweep that did not
   run, which is the same reporting lesson D3 taught. */
async function sweepIdentityIntegrity(fs, rid, kind, { limit = 500, now = () => new Date().toISOString() } = {}) {
  const report = { rid, kind, scanned: 0, orphans: 0, repaired: 0, conflicts: 0, errors: 0 };
  let snap;
  try {
    snap = await idsColOf(fs, rid, kind).where('status', '==', STATUS_LIVE).get();
  } catch (_e) {
    report.errors += 1;
    return report;
  }
  const docs = (snap && snap.docs ? snap.docs : []).slice(0, limit);
  report.scanned = docs.length;

  /* Group by legacy key first, so a key claimed by TWO live ids is recognised as a conflict rather
     than repaired twice — the second repair would silently overwrite the first and pick a winner,
     which is exactly the arbitration the writer guard refuses to do. */
  const byKey = new Map();
  for (const d of docs) {
    const data = d.data() || {};
    if (typeof data.legacy_key !== 'string' || !data.legacy_key) continue;
    if (!byKey.has(data.legacy_key)) byKey.set(data.legacy_key, []);
    byKey.get(data.legacy_key).push(d.id);
  }

  for (const [legacyKey, ids] of byKey) {
    if (ids.length > 1) {
      report.conflicts += 1;
      try {
        console.warn('identity_sweep_conflict', JSON.stringify({ rid, kind, legacy_key: legacyKey, ids: ids.slice().sort() }));
      } catch (_) {}
      continue;                                   // reported, never arbitrated
    }
    const canonicalId = ids[0];
    const keyRef = keysColOf(fs, rid, kind).doc(encodeKey(legacyKey));
    try {
      const repaired = await fs.runTransaction(async (tx) => {
        /* Re-read inside the transaction: the scan above is a snapshot, and by now an ordinary
           ensureIdentity may already have adopted this orphan. Repairing on the scan's word would
           overwrite a fresher row with a stale one. */
        const cur = await tx.get(keyRef);
        if (cur.exists && (cur.data() || {}).canonical_id) return false;   // healthy, or already healed
        tx.set(keyRef, { canonical_id: canonicalId, kind, created_at: now(), repaired_at: now() });
        return true;
      });
      if (repaired) {
        report.orphans += 1;
        report.repaired += 1;
        try {
          console.log('identity_sweep_repaired', JSON.stringify({ rid, kind, legacy_key: legacyKey, canonical_id: canonicalId }));
        } catch (_) {}
      }
    } catch (_e) {
      report.errors += 1;                          // retryable: the next run picks it up
    }
  }
  return report;
}

async function sweepAllIdentityIntegrity(fs, rids, opts = {}) {
  const reports = [];
  for (const rid of rids) {
    for (const kind of ['dish', 'extra']) {
      reports.push(await sweepIdentityIntegrity(fs, rid, kind, opts));
    }
  }
  try {
    const total = reports.reduce((a, r) => ({
      scanned: a.scanned + r.scanned, repaired: a.repaired + r.repaired,
      conflicts: a.conflicts + r.conflicts, errors: a.errors + r.errors,
    }), { scanned: 0, repaired: 0, conflicts: 0, errors: 0 });
    console.log('identity_sweep_done', JSON.stringify(total));
  } catch (_) {}
  return reports;
}

module.exports = { sweepIdentityIntegrity, sweepAllIdentityIntegrity };
