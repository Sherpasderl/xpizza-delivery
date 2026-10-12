'use strict';
/* 1D D4-c2b — the boundary G0 decision for tools/record-evidence-boundary.js (PLAN-D4c2b rev 14 §1, §10.1, as clarified by the
   advisor's ruling N2, 2026-10-09: DECISIONS "c2b N2 BOUNDARY"). PURE.

   INPUT is the RECORDED read-only observation made AFTER c2a's publishEdited went ready and BEFORE any activation could have
   written evidence: per restaurant, the active pointer's `version`, its `updateTime` (full precision) and its data (here:
   NO generation field). G0 is NEVER derived from the pointer at import time.
     Gpre = the recorded pointer's generation AS c2a's READER INTERPRETS IT — readPointerSnap (catalog-firestore.js:124), whose
            absent-generation rule (catalog-firestore.js:112) reads a pointer without a generation as 0.
     G0   = Gpre + 1 = the generation of the first evidenced activation.
   The import is accepted ONLY if one of these holds for the pointer read NOW:
     (a) unchanged — same version AND same updateTime as recorded: nothing activated since, so the next activation (Gpre + 1)
         is the first evidenced one;
     (b) evidenced — it moved, and EVERY generation Gpre + 1 … current has a schema-valid activation evidence document
         g{G20(g)} (an activation by a pre-merged CLI writes none: that is a GAP and the import is REFUSED).
   Anything else is refused with its reason; nothing is written. */
const { readPointerSnap } = require('../catalog/catalog-firestore');
const { activationSchema } = require('../catalog/identity-integrity');
const { activationDocId } = require('../catalog/identity-evidence');

// full-precision time: an RFC 3339 UTC string or a Firestore Timestamp → "SSSSSSSSSSSS.NNNNNNNNN" (exact compare, no float)
function preciseOf(t) {
  if (t && typeof t === 'object' && Number.isSafeInteger(Number(t.seconds)) && Number.isSafeInteger(Number(t.nanoseconds))) {
    return `${String(Number(t.seconds)).padStart(12, '0')}.${String(Number(t.nanoseconds)).padStart(9, '0')}`;
  }
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(String(t));
  if (!m) throw new Error(`not a full-precision UTC time: ${JSON.stringify(t)}`);
  const sec = Date.parse(`${m[1]}Z`) / 1000;
  return `${String(sec).padStart(12, '0')}.${(m[2] || '').padEnd(9, '0')}`;
}
// a recorded pointer, as c2a's reader would read the document → { version, generation }
const recordedPointer = (r) => readPointerSnap({ exists: true, data: () => ({ ...r.pointer }) }, r.rid);

function validateRecord(rec) {
  if (!rec || typeof rec !== 'object' || !rec.restaurants || typeof rec.restaurants !== 'object') return 'the record has no restaurants';
  if (typeof rec.recorded_at !== 'string' || typeof rec.after_ready !== 'string' || !(rec.recorded_at > rec.after_ready)) return 'the record must be read AFTER the c2a deploy went ready (recorded_at > after_ready)';
  for (const [rid, r] of Object.entries(rec.restaurants)) {
    if (!r || typeof r.version !== 'string' || !r.version) return `${rid}: no recorded version`;
    if (typeof r.updateTime !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/.test(r.updateTime)) return `${rid}: recorded updateTime must be a full-precision RFC 3339 UTC string`;
    if (!r.pointer || r.pointer.version !== r.version) return `${rid}: the recorded pointer data must name the recorded version`;
  }
  return null;
}

/* now = { pointer: { exists, data(), updateTime } (the snapshot read NOW; updateTime a Timestamp), evidence: Map g → { id, data } | null } — the caller
   reads exactly g = Gpre + 1 … current.  → { ok, G0, Gpre, branch, current } | { ok: false, reason, … } */
function decide(rid, r, now) {
  const pre = recordedPointer({ rid, pointer: r.pointer });
  const Gpre = pre.generation;
  if (!now.pointer || !now.pointer.exists) return { ok: false, reason: 'pointer_missing_now', Gpre };
  const cur = readPointerSnap(now.pointer, rid);
  if (cur.version === r.version && preciseOf(now.pointer.updateTime) === preciseOf(r.updateTime)) {
    return { ok: true, G0: Gpre + 1, Gpre, branch: 'pointer_unchanged', current: cur.generation };
  }
  if (!(cur.generation > Gpre)) return { ok: false, reason: 'pointer_changed_without_a_new_generation', Gpre, current: cur.generation };
  const missing = []; const malformed = [];
  for (let g = Gpre + 1; g <= cur.generation; g += 1) {
    const doc = now.evidence.get(g);
    if (!doc) { missing.push(g); continue; }
    const s = activationSchema(doc.id, doc.data);
    if (!s.ok || doc.id !== activationDocId(g) || doc.data.generation !== g) malformed.push(g);
  }
  if (missing.length || malformed.length) return { ok: false, reason: 'evidence_gap', Gpre, current: cur.generation, missing, malformed };
  return { ok: true, G0: Gpre + 1, Gpre, branch: 'evidenced', current: cur.generation };
}

// the boundary document written (WRITE-ONCE) into catalog_integrity/{rid}/boundary
const boundaryDoc = (rec, rid, d, readTimeIso) => ({ G0: d.G0, source: 'rollout_record', Gpre: d.Gpre, branch: d.branch,
  recorded_at: rec.recorded_at, recorded_version: rec.restaurants[rid].version, recorded_update_time: rec.restaurants[rid].updateTime,
  verified_at_read_time: readTimeIso, ...(rec.decision ? { decision: String(rec.decision).slice(0, 200) } : {}) });

module.exports = { preciseOf, recordedPointer, validateRecord, decide, boundaryDoc };
