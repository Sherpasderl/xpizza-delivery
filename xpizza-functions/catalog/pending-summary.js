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
// S3 r2 (Codex #393): the summary is OPTIONAL, so no caller ever waits on it past this bound. A request that outlives it is
// abandoned, never cancelled: its late result is dropped, and a late rejection is handled by the race, never unhandled. A late WRITE
// that does land carries its own source_update_time / base_active_version, so it is served only while it is still exactly fresh.
const SUMMARY_WAIT_MS = 1500;
const TIMEOUT = Object.freeze({ code: 'timeout' });
function within(p, ms = SUMMARY_WAIT_MS) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(TIMEOUT), ms); })]).finally(() => clearTimeout(t));
}

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

/* recordAfter(fs, rid, answer) — the handlers' WHOLE summary hook in one best-effort boundary (Codex #393 P1-1/P1-2): `answer()`
   (the review-model computation) runs INSIDE it, and the computation + write together are bounded. Never throws; → true only when
   the summary was written within the bound. A throwing computation or a timeout logs {rid, code} only. */
async function recordAfter(fs, rid, answer, log = console) {
  try {
    return await within(Promise.resolve().then(() => record(fs, rid, answer(), log)));
  } catch (e) {
    log.warn('pending_summary_record_failed', JSON.stringify({ rid, code: codeOf(e) }));
    return false;
  }
}

/* readHasPending(fs, catalogId) → true | false | null. TWO parallel RPCs reading three documents: the summary and the active pointer
   (one getAll), and the draft with an EMPTY field mask (its updateTime only; the body is never downloaded). Bounded (SUMMARY_WAIT_MS):
   expiry ⇒ null. Any read failure ⇒ null, logged with its error CODE ('timeout' at the bound) and this id only. */
async function readHasPending(fs, catalogId, log = console) {
  try {
    const [[sum, ptr], [src]] = await within(Promise.resolve().then(() => Promise.all([fs.getAll(summaryRefOf(fs, catalogId), activePointerRef(fs, catalogId)), fs.getAll(sourceRefOf(fs, catalogId), { fieldMask: [] })])));
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

module.exports = { SUMMARY_WAIT_MS, record, recordAfter, readHasPending, summaryRefOf, sourceRefOf, activePointerRef, encodeUpdateTime };
