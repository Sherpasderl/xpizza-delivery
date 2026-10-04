'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-a — THE FRESHNESS KEYS OF A RESOLVED CATALOG CONTEXT (plan rev 9 step 3, as amended
// by PLAN-D4a-ERRATA.md E1).
//
//   CK = (identityRevision, recordUpdateTime{seconds, nanoseconds})      — the CONTENT key
//   FK = (activationGeneration, CK)                                      — the ACTIVATION-ORDER key
//
// CK determines a fixed version's context content, so it keys every REQUEST-SIDE version cache
// (rid, versionId, CK) and drives discovery and eviction. FK adds the activation generation and is used
// ONLY where activation ORDER matters: the persisted HEAD, the writer's pre-check and the RTDB fence.
// 🔴 WHY THE SPLIT (E1). The request side never witnesses a generation for the version it serves — the
// pricing reader's pointer probe discards it — and inferring one would add the active-pointer
// dependency step 5d forbids. A version's content does not depend on which activation made it live.
// Both keys are built HERE and nowhere else.
//
// 🔴 WHY ONE DEFINITION. Rev 8 of the plan added recordUpdateTime to the fence and NOT to the HEAD or
// the cache key, so discovery could observe a newer updateTime while a cache keyed on the old tuple
// kept handing back the old payload (codex r8 B1). A component added to a key has to reach every place
// the key lives; the only way to make that structural rather than remembered is to have exactly one
// key and to build every site from it. Nothing in D4-a spells the triple out by hand.
//
// 🔴 recordUpdateTime IS LOSSLESS. Firestore commit times carry nanoseconds; an ISO string or a JS
// millisecond number truncates them, and two writes inside one millisecond would then compare EQUAL —
// which the fence reads as "same content or refuse". So it is kept as the integer pair Firestore hands
// back, and compared as a pair.
//
// 🔴 ABSENT/MALFORMED IS THE MINIMUM, never an error and never a guess. A pre-D4-a version record has
// no identity_revision (reads 0), a HEAD that was never written has no FK (reads MIN), and a corrupt
// HEAD is treated as never written — so any well-formed write replaces it, and nothing can block the
// path by writing garbage into it.
// ---------------------------------------------------------------------------

const ZERO_TIME = Object.freeze({ seconds: 0, nanoseconds: 0 });
const MIN_FK = Object.freeze({ generation: 0, revision: 0, updateTime: ZERO_TIME });

const nonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;

// A Firestore Timestamp (or anything carrying the same two integer fields) → {seconds, nanoseconds}.
// null when it cannot be represented exactly, so the caller decides; never a rounded value.
function encodeRecordTime(ts) {
  if (!ts || typeof ts !== 'object') return null;
  const seconds = ts.seconds !== undefined ? ts.seconds : ts._seconds;
  const nanoseconds = ts.nanoseconds !== undefined ? ts.nanoseconds : ts._nanoseconds;
  if (!nonNegInt(seconds) || !Number.isInteger(nanoseconds) || nanoseconds < 0 || nanoseconds > 999999999) return null;
  return { seconds, nanoseconds };
}

// An absent or malformed identity_revision reads as 0 (plan step 6). Present-and-valid is kept exactly.
function revisionOf(record) {
  const r = record && record.identity_revision;
  return nonNegInt(r) ? r : 0;
}

// Build an FK from its three sources. Returns null if the update time cannot be represented exactly —
// a key that silently lost precision is the defect this module exists to prevent.
function makeFK({ generation, record, updateTime }) {
  const t = encodeRecordTime(updateTime);
  if (!t) return null;
  return { generation: nonNegInt(generation) ? generation : 0, revision: revisionOf(record), updateTime: t };
}

// A stored FK (from a HEAD, or from RTDB) → a well-formed FK, or MIN_FK when absent/malformed.
function normalizeFK(fk) {
  if (!fk || typeof fk !== 'object') return MIN_FK;
  const t = encodeRecordTime(fk.updateTime);
  if (!nonNegInt(fk.generation) || !nonNegInt(fk.revision) || !t) return MIN_FK;
  return { generation: fk.generation, revision: fk.revision, updateTime: t };
}

const isValidFK = (fk) => !!fk && typeof fk === 'object' && nonNegInt(fk.generation) && nonNegInt(fk.revision)
  && encodeRecordTime(fk.updateTime) !== null;

// Lexicographic: generation, then revision, then the commit time (seconds, then nanoseconds).
function compareFK(a, b) {
  const x = normalizeFK(a), y = normalizeFK(b);
  const parts = [
    [x.generation, y.generation], [x.revision, y.revision],
    [x.updateTime.seconds, y.updateTime.seconds], [x.updateTime.nanoseconds, y.updateTime.nanoseconds],
  ];
  for (const [p, q] of parts) { if (p !== q) return p < q ? -1 : 1; }
  return 0;
}

// ── CK: the content key ──────────────────────────────────────────────────────────────────────────
// Built from the version record and its Firestore updateTime. null if the time cannot be kept exactly.
function makeCK({ record, updateTime }) {
  const t = encodeRecordTime(updateTime);
  if (!t) return null;
  return { revision: revisionOf(record), updateTime: t };
}
const ckOfFK = (fk) => { const f = normalizeFK(fk); return { revision: f.revision, updateTime: f.updateTime }; };

// Discovery's monotonic order (plan step 6): newer only if (identityRevision, recordUpdateTime) is
// strictly greater.
function compareCK(a, b) {
  const x = normalizeFK({ generation: 0, ...(a || {}) }), y = normalizeFK({ generation: 0, ...(b || {}) });
  return compareFK({ ...x, generation: 0 }, { ...y, generation: 0 });
}

// String forms used in keys and logs. Fixed-width nanoseconds so each string is injective.
const timeString = (t) => `${t.seconds}.${String(t.nanoseconds).padStart(9, '0')}`;
function ckString(ck) {
  const c = normalizeFK({ generation: 0, ...(ck || {}) });
  return `r${c.revision}.t${timeString(c.updateTime)}`;
}
function fkString(fk) {
  const f = normalizeFK(fk);
  return `g${f.generation}.r${f.revision}.t${timeString(f.updateTime)}`;
}

module.exports = {
  MIN_FK, ZERO_TIME, makeFK, normalizeFK, isValidFK, compareFK, fkString,
  makeCK, ckOfFK, compareCK, ckString,
  encodeRecordTime, revisionOf,
};
