'use strict';
// DISH PHOTOS A2 step 13 (PLAN-dish-photos r2 §2.6 sweep; Codex r2 P2-2 resumable deletion claims) — the photo sweeper, per restaurant.
// Mode (config/photos_sweep): 'off' → nothing; 'dry_run' → report only (no Firestore write, no delete); 'live' → act.
//   4b RECOVERY first: every `deleting` pid whose claim.lease_until + 60 s has passed is TAKEN OVER (a new claim id fences the old owner
//      out) and its deletes are finished.
//   1  SCAN references = the draft map ∪ meta/photos of EVERY retained version. Any read failure → scan_incomplete: the rid is ABORTED,
//      nothing is claimed or deleted (fail closed).
//   2  CANDIDATES: unreferenced pids with last_ref_at < now − grace (draft 7 d; published 30 d).
//   3  CLAIM (transaction): the SAME last_ref_at seen at the scan and state draft|published → state 'deleting', claim {id, lease_until:
//      now + 5 min}. An attach / publish in between changed last_ref_at ⇒ skipped.
//   4  DELETE each recorded object with ifGenerationMatch (drafts in the default bucket, photos in the public bucket). A missing object or
//      one at another generation (re-created since) counts as DONE and is never deleted. An owner issues no delete once now > lease − 30 s
//      (it never acts on an expired lease; recovery finishes). Then a transaction REQUIRING its own claim.id sets 'deleted' — a fenced-out
//      owner's final write fails and is dropped.
//   5  REPAIR: a pid in the ACTIVE version's meta/photos still marked draft → published (a crash after activation).
//   +  UPLOADS: photo_uploads still 'issued' after 1 day → 'expired' (their objects go with the bucket lifecycle rule).
// deps: { fs, priv, pub (object stores: deleteIfGeneration(path, gen) → 'deleted'|'missing'|'other_generation'), now, newClaimId, log,
//         activeVersionId(rid) }
const LEASE_MS = 5 * 60 * 1000;
const TAKEOVER_GRACE_MS = 60 * 1000;
const STOP_BEFORE_LEASE_END_MS = 30 * 1000;
const GRACE = { draft: 7 * 86400e3, published: 30 * 86400e3 };
const UPLOAD_EXPIRY_MS = 86400e3;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const regCol = (fs, rid) => fs.collection('photo_registry').doc(rid).collection('pids');
const pidsOf = (entries) => Object.values(isObj(entries) ? entries : {}).filter((e) => isObj(e) && e.state === 'pid' && typeof e.pid === 'string').map((e) => e.pid);

async function scanReferences({ fs }, rid) {
  try {
    const refs = new Set();
    const src = await fs.collection('restaurants').doc(rid).collection('meta').doc('source').get();
    if (src.exists) for (const p of pidsOf((src.data() || {}).photos)) refs.add(p);
    const versions = await fs.collection('restaurants').doc(rid).collection('versions').get();
    for (const v of versions.docs) {
      const m = await fs.collection('restaurants').doc(rid).collection('versions').doc(v.id).collection('meta').doc('photos').get();
      if (!m.exists) continue;
      const d = m.data();
      if (!(isObj(d) && d.schema === 1 && isObj(d.entries))) throw new Error(`malformed meta/photos on ${v.id}`);
      for (const p of pidsOf(d.entries)) refs.add(p);
    }
    return refs;
  } catch (e) {
    throw Object.assign(new Error(`scan_incomplete: ${rid} — ${String((e && e.message) || e).slice(0, 160)}`), { code: 'scan_incomplete' });
  }
}

async function claim({ fs, now, newClaimId }, rid, cand) {
  const ref = regCol(fs, rid).doc(cand.pid);
  const id = newClaimId();
  return fs.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const d = s.exists ? s.data() : null;
    if (!d || !['draft', 'published'].includes(d.state) || d.last_ref_at !== cand.last_ref_at) return null;
    if (isObj(d.reserve) && d.reserve.until > now()) return null;   // codex r1 P1-2: a live processing reservation is respected
    const c = { id, lease_until: now() + LEASE_MS };
    tx.update(ref, { state: 'deleting', claim: c });
    return c;
  });
}

async function takeOver({ fs, now, newClaimId }, rid, pid, seenClaimId) {
  const ref = regCol(fs, rid).doc(pid);
  const id = newClaimId();
  return fs.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const d = s.exists ? s.data() : null;
    if (!d || d.state !== 'deleting' || !isObj(d.claim) || d.claim.id !== seenClaimId || now() <= d.claim.lease_until + TAKEOVER_GRACE_MS) return null;
    const c = { id, lease_until: now() + LEASE_MS };
    tx.update(ref, { claim: c });
    return c;
  });
}

// → true when every object is done; false when the owner stopped at its lease limit (recovery finishes)
async function deleteObjects({ priv, pub, now }, rid, doc, c) {
  const g = (doc && doc.generations) || {};
  const pid = doc.pid || doc._pid;
  const jobs = [[priv, `drafts/${rid}/${pid}-card.webp`, g.draft_card], [priv, `drafts/${rid}/${pid}-hero.webp`, g.draft_hero],
    [pub, `photos/${rid}/${pid}-card.webp`, g.pub_card], [pub, `photos/${rid}/${pid}-hero.webp`, g.pub_hero]];
  for (const [store, path, gen] of jobs) {
    if (gen === undefined || gen === null) continue;
    if (now() > c.lease_until - STOP_BEFORE_LEASE_END_MS) return false;
    await store.deleteIfGeneration(path, gen);   // 'deleted' | 'missing' | 'other_generation' — all count as done
  }
  return true;
}

async function markDeleted({ fs, now }, rid, pid, claimId) {
  const ref = regCol(fs, rid).doc(pid);
  return fs.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const d = s.exists ? s.data() : null;
    if (!d || d.state !== 'deleting' || !isObj(d.claim) || d.claim.id !== claimId) return false;   // fenced out
    tx.update(ref, { state: 'deleted', claim: null, deleted_at: now() });
    return true;
  });
}

async function finish(deps, rid, pid, c) {
  const s = await regCol(deps.fs, rid).doc(pid).get();
  if (!s.exists) return false;
  if (!(await deleteObjects(deps, rid, { ...s.data(), pid }, c))) return false;
  return markDeleted(deps, rid, pid, c.id);
}

async function sweepRid(deps, rid) {
  const { fs, now, mode, log } = deps;
  if (mode !== 'dry_run' && mode !== 'live') return { rid, mode: 'off' };
  const live = mode === 'live';
  const out = { rid, mode, recovered: [], deleted: [], would_delete: [], repaired: [], expired_uploads: 0 };

  // 4b recovery
  const deleting = await regCol(fs, rid).where('state', '==', 'deleting').get();
  for (const s of deleting.docs) {
    const d = s.data() || {};
    if (!isObj(d.claim) || now() <= d.claim.lease_until + TAKEOVER_GRACE_MS) continue;
    if (!live) { out.recovered.push(s.id); continue; }
    const c = await takeOver(deps, rid, s.id, d.claim.id);
    if (c && await finish(deps, rid, s.id, c)) out.recovered.push(s.id);
  }

  // 1 scan (fail closed) → 2 candidates → 3/4 claim + delete
  let refs;
  try { refs = await scanReferences(deps, rid); } catch (e) { log.warn(JSON.stringify({ evt: 'photo_sweep_aborted', rid, code: e.code || 'error' })); return { ...out, aborted: 'scan_incomplete' }; }
  const t = now();
  for (const st of ['draft', 'published']) {
    const snap = await regCol(fs, rid).where('state', '==', st).get();
    for (const s of snap.docs) {
      const d = s.data() || {};
      if (refs.has(s.id) || !Number.isFinite(d.last_ref_at) || d.last_ref_at >= t - GRACE[st]) continue;
      if (!live) { out.would_delete.push(s.id); continue; }
      const c = await claim(deps, rid, { pid: s.id, last_ref_at: d.last_ref_at });
      if (c && await finish(deps, rid, s.id, c)) out.deleted.push(s.id);
    }
  }

  // 5 repair
  const vid = await deps.activeVersionId(rid);
  if (vid) {
    const m = await fs.collection('restaurants').doc(rid).collection('versions').doc(vid).collection('meta').doc('photos').get();
    for (const pid of m.exists ? pidsOf((m.data() || {}).entries) : []) {
      if (!live) continue;
      const fixed = await fs.runTransaction(async (tx) => {
        const ref = regCol(fs, rid).doc(pid); const s = await tx.get(ref);
        if (s.exists && (s.data() || {}).state === 'draft') { tx.update(ref, { state: 'published' }); return true; }
        return false;
      });
      if (fixed) out.repaired.push(pid);
    }
  }

  // stale uploads
  const ups = await fs.collection('photo_uploads').where('rid', '==', rid).where('state', '==', 'issued').get();
  for (const s of ups.docs) {
    const d = s.data() || {};
    if (!Number.isFinite(d.created_at) || d.created_at >= t - UPLOAD_EXPIRY_MS) continue;
    if (live) await fs.runTransaction(async (tx) => { const ss = await tx.get(s.ref); if (ss.exists && (ss.data() || {}).state === 'issued') tx.update(s.ref, { state: 'expired' }); });
    out.expired_uploads++;
  }
  log.info(JSON.stringify({ evt: 'photo_sweep', rid, mode, recovered: out.recovered.length, deleted: out.deleted.length, would_delete: out.would_delete.length, repaired: out.repaired.length, expired_uploads: out.expired_uploads }));
  return out;
}

module.exports = { sweepRid, scanReferences, claim, takeOver, deleteObjects, markDeleted, LEASE_MS, GRACE, TAKEOVER_GRACE_MS, STOP_BEFORE_LEASE_END_MS };
