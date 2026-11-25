'use strict';
// S3 r1 (PLAN-5f-inicio-s3-pending-rebase-r0; owner 11-23: Inicio shows NO number — «Tenés cambios sin publicar» / «Todo en orden»;
// advisor 11-24: per CATALOG id) — has_pending per branch WITHOUT the editable catalog.
//   has_pending = «Revisar y publicar» would draw lines for the SAVED draft vs live: the shared review line model's hasPending
//   (catalog/review-lines.js, the portal's bytes — one rule, never a second count). It is written beside the draft by the writers that
//   already hold the canonical diff (the save; the owner publish, the published draft vs what it published), at
//   restaurants/{catalogId}/meta/pending_summary = { v: 2, has_pending, source_update_time, base_active_version }.
//   A summary is served ONLY while it is FRESH: its source_update_time is the draft's current updateTime (read with an EMPTY field mask —
//   the draft's body is never downloaded) AND its base_active_version is the current active pointer. Anything else — a writer that does
//   not record, a lost follow-up write, a race between two saves, a new live version — is `null`: unknown, never a stale answer.
//   Recording is best-effort for the same reason: a failed record only makes the answer null.
// The ANSWER (the review model) is catalog/pending-answer.js, required by the writers only. SELF-CONTAINED for the read (no review-lines,
// no source-store / catalog-firestore): getMyBranches' static closure stays light. The paths and the
// updateTime encoding are the store's own — pinned against source-store / catalog-firestore by PS-PARITY.
const metaRefOf = (fs, rid, id) => fs.collection('restaurants').doc(rid).collection('meta').doc(id);
const sourceRefOf = (fs, rid) => metaRefOf(fs, rid, 'source');
const activePointerRef = (fs, rid) => metaRefOf(fs, rid, 'active_version');
const summaryRefOf = (fs, rid) => metaRefOf(fs, rid, 'pending_summary');
const encodeUpdateTime = (ts) => (ts && typeof ts.seconds === 'number' ? `${ts.seconds}.${String(ts.nanoseconds || 0).padStart(9, '0')}` : String(ts));
const codeOf = (e) => (e && e.code != null ? String(e.code).slice(0, 40) : 'unknown');

/* record(fs, rid, { pending, sourceUpdateTime, baseActiveVersion }) — best-effort; never throws (a failed record ⇒ the read's null) */
async function record(fs, rid, { pending, sourceUpdateTime, baseActiveVersion }, log = console) {
  try {
    if (typeof pending !== 'boolean' || typeof sourceUpdateTime !== 'string' || !sourceUpdateTime || typeof baseActiveVersion !== 'string' || !baseActiveVersion) {
      await summaryRefOf(fs, rid).delete();   // an unknown answer must not leave an older, wrong one behind
      return false;
    }
    await summaryRefOf(fs, rid).set({ v: 2, has_pending: pending, source_update_time: sourceUpdateTime, base_active_version: baseActiveVersion });
    return true;
  } catch (e) {
    log.warn('pending_summary_record_failed', JSON.stringify({ rid, code: codeOf(e) }));   // the CODE only: a message can carry paths and doc data
    return false;
  }
}

/* readHasPending(fs, catalogId) → true | false | null. Three point reads, in parallel: the summary and the active pointer (one getAll),
   and the draft with an EMPTY field mask (its updateTime only). Any read failure ⇒ null, logged with its error CODE and this id only. */
async function readHasPending(fs, catalogId, log = console) {
  try {
    const [[sum, ptr], [src]] = await Promise.all([fs.getAll(summaryRefOf(fs, catalogId), activePointerRef(fs, catalogId)), fs.getAll(sourceRefOf(fs, catalogId), { fieldMask: [] })]);
    if (!sum.exists || !src.exists) return null;
    const s = sum.data() || {};
    const version = ptr.exists ? (ptr.data() || {}).version : null;
    if (s.v !== 2 || typeof s.has_pending !== 'boolean') return null;
    if (typeof version !== 'string' || s.base_active_version !== version) return null;
    if (s.source_update_time !== encodeUpdateTime(src.updateTime)) return null;
    return s.has_pending;
  } catch (e) {
    log.warn('getMyBranches: pending_summary read failed', JSON.stringify({ rid: catalogId, code: codeOf(e) }));
    return null;
  }
}

module.exports = { record, readHasPending, summaryRefOf, sourceRefOf, activePointerRef, encodeUpdateTime };
