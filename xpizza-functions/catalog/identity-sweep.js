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
async function sweepIdentityIntegrity(fs, rid, kind, { pageSize = 500, limit = null, now = () => new Date().toISOString() } = {}) {
  const report = { rid, kind, scanned: 0, orphans: 0, repaired: 0, conflicts: 0, errors: 0 };
  const size = Math.max(1, Number(limit || pageSize) || 500);

  /* 🔴 EVERY PAGE, NOT THE FIRST ONE. This used to read the collection once and slice to 500. Two
     things were wrong with that and both are silent: an orphan past the cut was never repaired on ANY
     run — not "later", never, because every run cut at the same place — and, worse, the slice happened
     BEFORE conflict grouping, so a key whose two live claimants straddled the boundary looked like a
     single clean claimant and would have been "repaired" toward whichever side landed first. That is
     the arbitration this file exists to refuse, reached by way of a pagination bug. The full live set
     is gathered first; only then is anything grouped or decided. */
  const byKey = new Map();
  try {
    let last = null;
    for (;;) {
      let q = idsColOf(fs, rid, kind).where('status', '==', STATUS_LIVE).orderBy('__name__').limit(size);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      const docs = (snap && snap.docs) ? snap.docs : [];
      if (!docs.length) break;
      for (const d of docs) {
        const data = d.data() || {};
        if (typeof data.legacy_key !== 'string' || !data.legacy_key) continue;
        if (!byKey.has(data.legacy_key)) byKey.set(data.legacy_key, []);
        byKey.get(data.legacy_key).push(d.id);
      }
      report.scanned += docs.length;
      last = docs[docs.length - 1];
      if (docs.length < size) break;
    }
  } catch (_e) {
    report.errors += 1;
    return report;
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
    if (typeof canonicalId !== 'string' || !canonicalId) { report.errors += 1; continue; }
    const keyRef = keysColOf(fs, rid, kind).doc(encodeKey(legacyKey));
    const idRef = idsColOf(fs, rid, kind).doc(canonicalId);
    try {
      const verdict = await fs.runTransaction(async (tx) => {
        /* 🔴 RE-READ BOTH SIDES, NOT JUST THE ROW BEING WRITTEN. The scan is a snapshot and this
           transaction runs later; between them the claimant can be retired, re-keyed, or joined by a
           second live id. Checking only the reverse row meant the sweep would faithfully restore a
           pointer to an id that had since been RETIRED — and because the key row is the registry's
           fast path, the very next ensureIdentity would hand that reserved id back out as if it were
           current. An integrity job that can resurrect a retired identity is worse than no integrity
           job, so the claimant must still be exactly what the scan saw. */
        const liveQ = idsColOf(fs, rid, kind).where('legacy_key', '==', legacyKey).where('status', '==', STATUS_LIVE);
        const [curKey, curId, claimants] = await Promise.all([tx.get(keyRef), tx.get(idRef), tx.get(liveQ)]);

        /* MISSING ROW ONLY. The old guard skipped a row that already held a canonical_id, which reads
           as "don't clobber a healthy row" but leaves the complement: a row that EXISTS with a falsy
           or absent canonical_id was fair game to overwrite. Repairing is for a row that is not there;
           a row that is there and malformed is a different fault, and quietly rewriting it would
           destroy the evidence of it. */
        if (curKey.exists) return 'skip';

        const d = curId.exists ? (curId.data() || {}) : null;
        if (!d) return 'skip';                              // the claimant vanished after the scan
        if (d.status !== STATUS_LIVE) return 'skip';        // retired in between — never revive it
        if (d.legacy_key !== legacyKey) return 'skip';      // re-keyed in between — no longer this object's

        /* 🔴 AND THE CLAIMANT SET ITSELF, RE-READ IN THE TRANSACTION. Checking only the id we SELECTED
           answers "is my candidate still valid", which is a different question from "is it still the
           only one". A second live id appearing for this key between the scan and here made the sweep
           write a reverse row toward whichever the scan happened to pick and report a clean repair —
           arbitrating a conflict, which is the one thing this file refuses to do everywhere else. The
           grouping above cannot see it because it ran against an older snapshot, so the refusal has to
           be re-established transactionally, exactly as findOrphanedLiveId does on the writer side. */
        const liveIds = (claimants && claimants.docs ? claimants.docs : []).map((x) => x.id);
        if (liveIds.length !== 1 || liveIds[0] !== canonicalId) return 'conflict';

        tx.set(keyRef, { canonical_id: canonicalId, kind, created_at: now(), repaired_at: now() });
        return 'repaired';
      });
      if (verdict === 'conflict') {
        report.conflicts += 1;
        try {
          console.warn('identity_sweep_conflict', JSON.stringify({ rid, kind, legacy_key: legacyKey, ids: 'changed_under_sweep' }));
        } catch (_) {}
      } else if (verdict === 'repaired') {
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
