'use strict';
/* 1D D4-c2a — BINDING EVIDENCE, RECORDED AT ACTIVATION AND AT CERTIFICATION (PLAN-D4c2a rev 9 §2–§4).
   DORMANT: nothing in this slice reads it. c2b (monitor + alerts + runbook) consumes it.

   One create-only document per CERTIFIED activation (publish or rollback) and per bootstrap certification,
   written INSIDE that transaction, after every read and every existing write, from values the transaction
   already holds — ZERO new reads. Its payload is a FIXED-SIZE DIGEST RECORD: 43-char digests and small
   integer counts, no arrays, no raw identifiers, so its size is a constant regardless of catalog, registry,
   key or header-value size (plan §2 "Size"). Only the document NAME varies with the rid (the path).

   What each digest commits to (plan §2, codex r3 #4):
     final_digest     RECOMPUTABLE — c2b re-derives it from the immutable certified version docs
                      (finalEntriesFromDocs below) → equality = stamps untouched since activation.
     observed_digest / stampmap_digest / plan_digest / checks_digest
                      COMMITMENTS to activation-time registry state; generally NOT replayable after legitimate
                      registry changes. c2b trusts the recorded verdict COUNTS and uses these only for
                      equality between evidence records.
   rev 14 §2E: every RECORD digest above is ENC2 (evidence-encoding.js) — typed, domain-tagged tuples; `ch` and the CLS
   header values stay on the generic ENC. v stays 1 (no evidence was ever persisted under the older construction).

   🔴 TOTAL. Every builder here is pure and cannot throw on any input the writers hand it: the encoder is
   total (evidence-encoding.js), every container access is guarded, and an unexpected shape is RECORDED as
   its class rather than refused. That is owner rule 1: no activation that succeeds today may fail because
   of c2a, except by a genuine Firestore/commit error on the evidence create itself (§4). */
const { FieldValue } = require('firebase-admin/firestore');
const { D, H, CLS, DS2, planDigest, read, finalTupleBytes, finalPayloadBytes, FINAL_FRAME_BYTES } = require('./evidence-encoding');
const { encodeKey } = require('./identity-registry');

const EVIDENCE_COL = 'identity_evidence';
const EVIDENCE_V = 1;   // 🔴 BUMP on ANY future change to ANY digest construction (§2E.8 (5)), even with unchanged field names
const KINDS = ['dish', 'extra'];
const OTHER = { dish: 'extra', extra: 'dish' };
/* The per-stamp verdict codes judgeStampMap can issue (identity-stampmap.js stampVerdict). The counts map
   is keyed by these; anything else is bucketed as `unrecognised`, so the map has at most 9 keys (≤ 12, §2). */
const STAMP_CODES = Object.freeze(['verified', 'stamp_input_malformed', 'stamp_not_in_candidate', 'stamp_unregistered',
  'stamp_registry_disagrees', 'stamp_id_row_missing', 'stamp_id_retired', 'stamp_id_claims_other_name']);

const isStr = (v) => typeof v === 'string' && v.length > 0;
/* rev 14 §2E.8 (2): EVERY read of a writer-supplied value is guarded (read() → a sentinel, never a throw). A list is copied slot by
   slot through read(), so a hostile array/proxy cannot throw mid-iteration; a non-array is the empty list, as before. */
const arr = (v) => {
  try {
    if (!Array.isArray(v)) return [];
    const out = new Array(v.length);
    for (let i = 0; i < out.length; i += 1) out[i] = read(v, i);
    return out;
  } catch (_) { return []; }
};
// `o && o[k]`, guarded — the exact short-circuit the builder has always used (a falsy holder is passed through as itself)
const and = (o, k) => (o ? read(o, k) : o);
const len = (v) => { try { return Array.isArray(v) ? v.length : 0; } catch (_) { return 0; } };
const docsOf = (snap) => arr(read(snap, 'docs'));
const dataOf = (d) => { try { return (d && typeof d.data === 'function' ? d.data() : null) || {}; } catch (_) { return {}; } };
const getIn = (m, k) => { try { return m instanceof Map ? m.get(k) : undefined; } catch (_) { return undefined; } };
const hasIn = (m, k) => { try { return m instanceof Map && m.has(k); } catch (_) { return false; } };
const safeEncodeKey = (k) => { try { return isStr(k) ? encodeKey(k) : null; } catch (_) { return null; } };
// A doc's own identity stamp, read exactly as the flip reads it (catalog-publish.js `persisted`).
const stampOf = (data) => { const id = read(read(data, 'display') || {}, 'identity_id'); return isStr(id) ? id : undefined; };

/* ── DOCUMENT IDS (rev 11/12 §2, §3 — GENERATION-addressable) ────────────────────────────────────────────────────
   G20(n) = n as a decimal zero-padded to 20 digits, so lexicographic id order = numeric order (c2b reads by direct get and
   by bounded document-name ranges; §2b). The version is NOT in the id — it is the payload field `vid` = H(versionId).
     activation     g{G20(priorGeneration + 1)}                                   (21 chars; one per activation, publish or rollback)
     certification  c{G20(observed_generation)}_{G20(revisionOf(rec) + 1)}       (42 chars; bootstrap does not move the pointer)
   Generations and revisions are safe non-negative integers on every path that reaches here (readPointerSnap / revisionOf);
   anything else is rendered as its decimal string rather than refused (totality). */
const G20 = (n) => (Number.isSafeInteger(n) && n >= 0 ? String(n).padStart(20, '0') : String(n));
const activationDocId = (generation) => `g${G20(generation)}`;
const certificationDocId = (observedGeneration, revision) => `c${G20(observedGeneration)}_${G20(revision)}`;
const evidenceRefOf = (db, rid, docId) => db.collection('restaurants').doc(rid).collection(EVIDENCE_COL).doc(docId);

/* ── Projections (plan §2 "ENC — over a DECLARED PROJECTION") ────────────────────────────────────────────────
   Only the fields the binding judgement uses (catalog-verifier.js, identity-stampmap.js). Timestamps and other
   metadata are deliberately NOT digested. A missing field stays missing (["u"]) — `kind` may legitimately be
   absent (catalog-verifier.js:68). */
const projIdRow = (row) => ({ legacy_key: read(row, 'legacy_key'), status: read(row, 'status'), kind: read(row, 'kind') });
const projKeyRow = (row) => ({ canonical_id: read(row, 'canonical_id'), kind: read(row, 'kind') });
function rowAt(map, addr, proj) {
  if (!isStr(addr)) return { addr: { none: true }, absent: true };
  if (!hasIn(map, addr)) return { addr, absent: true };
  const row = getIn(map, addr);
  if (!row || typeof row !== 'object') return { addr, data: row };     // recorded as its class, never refused
  return { addr, data: proj(row) };
}

/* ── final: every stamped object of the COMMITTED version ────────────────────────────────────────────────────
   `minted` (key → id) and `mintDocIdByKey` (key → the ONE doc the flip writes the mint back to,
   catalog-publish.js mint write-back) reproduce the committed stamps exactly: a doc carries the minted id iff it
   is the write-back doc for that key, else its own stamp. Called with no mints, this IS the recomputation c2b
   performs from the committed version docs. */
function finalEntriesFromDocs(kind, docs, minted = null, mintDocIdByKey = null) {
  const out = [];
  for (const d of arr(docs)) {
    const data = dataOf(d);
    const key = read(data, 'key');
    if (!isStr(key)) continue;
    const docId = read(d, 'id');
    let id = stampOf(data);
    const m = getIn(minted, key);
    if (isStr(m) && getIn(mintDocIdByKey, key) === docId) id = m;
    if (!isStr(id)) continue;
    out.push({ k: kind, c: id, n: key, o: docId });
  }
  return out;
}
/* c2b's recomputation, exported so the tests (and c2b) use the SAME definition: version docs → final_digest (ENC2, §2E).
   Its size budget computes the `final` preimage bytes through finalTupleBytes / finalPayloadBytes (§2E.8 (4)), re-exported here. */
function finalDigestOfVersion({ dishDocs, extraDocs } = {}) {
  const entries = [...finalEntriesFromDocs('dish', dishDocs), ...finalEntriesFromDocs('extra', extraDocs)];
  return { final_digest: DS2('final', entries), final_count: entries.length };
}

/* ── plan section per kind ──────────────────────────────────────────────────────────────────────────────────
   `rec` is one of (captured by the flip, see catalog-publish.js c2a blocks):
     { source: 'reconcile', rec }             a rollback kind's reconciliation result (before the :837 continue)
     { source: 'derived', plan }              a publish kind's EMPTY derived plan (before the :865 continue) — the
                                              verifier did NOT run, so verified:false and all counts 0
     { source: 'verify', plan, verified }     a publish kind whose verifyPlan result permitted it (:888-892)
   planDigestInputs names, per source, the typed sub-lists in the FIXED §2E.2 order; plan_digest = planDigest(source, each DS2).
   Exported so the source-shape guard (§2E.8 (3b)) asserts on exactly the records that are encoded. */
const PLAN_ORDER = Object.freeze({
  reconcile: [['restore', 'restores', 'rec'], ['retire', 'retires', 'rec'], ['deletion', 'deletions', 'rec']],
  verify: [['move', 'moves', 'plan'], ['mint', 'mints', 'plan'], ['retire', 'retires', 'plan'],
    ['land', 'lands', 'verified'], ['release', 'releases', 'verified'], ['deletion', 'deletions', 'verified']],
  derived: [['move', 'moves', 'plan'], ['mint', 'mints', 'plan'], ['retire', 'retires', 'plan']],
});
function planDigestInputs(rec) {
  const source = read(rec, 'source');
  const has = (k) => !!read(rec, k);   // truthy, exactly the old capture test
  const ok = (source === 'reconcile' && has('rec')) || (source === 'verify' && has('plan') && has('verified')) || (source === 'derived' && has('plan'));
  if (!ok) return { source: 'none', lists: [] };
  return { source, lists: PLAN_ORDER[source].map(([type, field, holder]) => ({ type, list: arr(read(read(rec, holder), field)) })) };
}
function planSection(rec) {
  const { source, lists } = planDigestInputs(rec);
  const plan_digest = planDigest(source, lists.map(({ type, list }) => DS2(type, list)));
  const n = (holder, field) => len(read(read(rec, holder), field));
  if (source === 'reconcile') {
    return { mints: 0, moves: 0, restores: n('rec', 'restores'), retires: n('rec', 'retires'), deletions: n('rec', 'deletions'), verified: true, plan_digest };
  }
  if (source === 'verify') {
    return { mints: n('plan', 'mints'), moves: n('plan', 'moves'), restores: 0, retires: n('plan', 'retires'), deletions: n('verified', 'deletions'), verified: true, plan_digest };
  }
  // 'derived' (verifier did not run) and 'none' (no capture for this kind — impossible on today's paths; recorded, never refused)
  return { mints: 0, moves: 0, restores: 0, retires: 0, deletions: 0, verified: false, plan_digest };
}

/* ── ACTIVATION EVIDENCE (plan §2) ──────────────────────────────────────────────────────────────────────────
   Inputs are exactly the values the certified block of flipPointer already holds (no reads):
     record      the candidate version record as read in-tx (content_hash / seq / identity_revision)
     docs        { dish: itemsSnap, extra: extrasSnap }   the candidate's object docs as read in-tx
     docIdByKey  key → doc id (the mint write-back target)
     minted      { dish: Map, extra: Map }   key → id minted in this flip
     registry    { kind: Map key → {keyRowId, idRow} }   the stamp-map input
     fullIds / fullKeys   { kind: Map }   the whole registry per kind, as read BEFORE any write
     judged      judgeStampMap's result;  relocated  the Set of rollback-relocated refusal codes
     plans       { dish, extra }   per-kind captures (planSection) */
/* The activation's DIGEST INPUTS — the exact records each ENC2 digest encodes (exported for the §2E.8 (3b) source-shape guard). */
function activationDigestInputs(input) {
  const [docs, docIdByKey, minted, registry, fullIds, fullKeys, judged, relocated] =
    ['docs', 'docIdByKey', 'minted', 'registry', 'fullIds', 'fullKeys', 'judged', 'relocated'].map((k) => and(input, k));
  const docsBy = { dish: docsOf(and(docs, 'dish')), extra: docsOf(and(docs, 'extra')) };
  const per = and;

  const final = [];
  for (const kind of KINDS) final.push(...finalEntriesFromDocs(kind, docsBy[kind], per(minted, kind), per(docIdByKey, kind)));

  const stampmap = [];
  const counts = {};
  let relocatedCount = 0;
  for (const e of arr(and(judged, 'stamps'))) {
    const kind = and(e, 'kind');
    const key = and(e, 'key');
    const verdict = and(e, 'verdict') || {};
    const rawCode = read(verdict, 'code');
    const code = typeof rawCode === 'string' ? rawCode : undefined;
    let isRelocated = false;
    try { isRelocated = read(verdict, 'ok') !== true && !!code && relocated instanceof Set && relocated.has(code); } catch (_) { isRelocated = false; }
    if (isRelocated) relocatedCount += 1;
    const bucket = STAMP_CODES.includes(code) ? code : 'unrecognised';
    counts[bucket] = (counts[bucket] || 0) + 1;
    const keyRowId = read(getIn(per(registry, kind), key) || {}, 'keyRowId');
    stampmap.push({ k: kind, o: getIn(per(docIdByKey, kind), key), addr: isStr(keyRowId) ? keyRowId : { none: true }, code, relocated: isRelocated });
  }

  const observed = [];
  for (const kind of KINDS) {
    for (const d of docsBy[kind]) {
      const data = dataOf(d);
      const key = read(data, 'key');
      if (!isStr(key)) continue;
      const docId = read(d, 'id');
      const m = getIn(per(minted, kind), key);
      const finalId = (isStr(m) && getIn(per(docIdByKey, kind), key) === docId) ? m : stampOf(data);
      const keyRowId = read(getIn(per(registry, kind), key) || {}, 'keyRowId');
      observed.push({
        k: kind, o: docId,
        id_row: rowAt(per(fullIds, kind), finalId, projIdRow),                    // THIS object's id (a mint: absent, pre-write)
        key_row: rowAt(per(fullKeys, kind), safeEncodeKey(key), projKeyRow),
        other_kind_id_row: rowAt(per(fullIds, OTHER[kind]), finalId, projIdRow),
        sm_id_row: rowAt(per(fullIds, kind), keyRowId, projIdRow),               // the stamp-map input row: at the KEY ROW's id
      });
    }
  }
  return { final, stampmap, observed, counts, relocatedCount };
}

function buildActivationEvidence(input) {
  const versionId = read(input, 'versionId'); const generation = read(input, 'generation'); const intent = read(input, 'intent');
  const record = read(input, 'record'); const plans = read(input, 'plans');
  const rec = record && typeof record === 'object' ? record : {};
  const { final, stampmap, observed, counts, relocatedCount } = activationDigestInputs(input);
  const data = {
    v: EVIDENCE_V,
    certified: true,
    vid: H(String(versionId)),
    generation: CLS(generation),
    intent: intent === 'rollback' ? 'rollback' : 'publish',
    ch: D(read(rec, 'content_hash')),
    seq_c: CLS(read(rec, 'seq')),
    rev_c: CLS(read(rec, 'identity_revision')),
    final_digest: DS2('final', final),
    final_count: final.length,
    stampmap_digest: DS2('stampmap', stampmap),
    stampmap_counts: counts,
    relocated_count: relocatedCount,
    observed_digest: DS2('observed', observed),
    plan: { dish: planSection(read(plans, 'dish')), extra: planSection(read(plans, 'extra')) },
  };
  return { docId: activationDocId(generation), data };
}

/* ── CERTIFICATION EVIDENCE (plan §3) ───────────────────────────────────────────────────────────────────────
   From bootstrap's in-transaction values: the objects it stamps ({id, key, canonical_id} per kind, written at
   identity-bootstrap.js:424), the live claimants by key (liveClaimantsByKey, read in-tx) and the key rows. */
function certificationDigestInputs(input) {
  const [objects, liveByKey, keyRowIdOf] = ['objects', 'liveByKey', 'keyRowIdOf'].map((k) => and(input, k));
  const final = [];
  const checks = [];
  for (const kind of KINDS) {
    for (const o of arr(and(objects, kind))) {
      const key = and(o, 'key');
      if (!o || !isStr(key)) continue;
      const canonicalId = read(o, 'canonical_id');
      if (isStr(canonicalId)) final.push({ k: kind, c: canonicalId, n: key, o: read(o, 'id') });
      let claimants = arr(getIn(and(liveByKey, kind), key));
      try { claimants = claimants.sort(); } catch (_) { /* an unsortable member (a symbol): kept in read order */ }
      const kr = getIn(keyRowIdOf, `${kind}/${key}`);
      checks.push({ k: kind, n: key, claimants, key_row_canonical_id: kr === undefined ? { absent: true } : kr });
    }
  }
  return { final, checks };
}
function buildCertificationEvidence(input) {
  const versionId = read(input, 'versionId'); const observedGeneration = read(input, 'observedGeneration');
  const revisionAfter = read(input, 'revisionAfter'); const record = read(input, 'record');
  const rec = record && typeof record === 'object' ? record : {};
  const { final, checks } = certificationDigestInputs(input);
  const data = {
    v: EVIDENCE_V,
    kind: 'certify',
    certified: true,
    vid: H(String(versionId)),
    observed_generation: CLS(observedGeneration),
    rev_c: CLS(revisionAfter),
    ch: D(read(rec, 'content_hash')),
    final_digest: DS2('final', final),
    final_count: final.length,
    checks_digest: DS2('check', checks),
    checks_count: checks.length,
  };
  return { docId: certificationDocId(observedGeneration, revisionAfter), data };
}

/* ── WHICH evidence document an activation writes (the one call site in flipPointer; rev 12 §2, §2a) ────────────
   EVERY activation writes exactly one, so the per-restaurant generation sequence is DENSE (§2b):
     certified   → the full digest record built inside the certified block (§2), certified:true
     uncertified → the §2a MINIMAL record {v, certified:false, vid, generation, intent, ch, seq_c, rev_c, at} — no binding
                   sections, no registry data; built from the candidate record the flip already read (ZERO new reads). */
function activationEvidenceDoc(built, { certified, versionId, generation, intent, record } = {}) {
  if (certified && built) return built;
  const rec = record && typeof record === 'object' ? record : {};
  return { docId: activationDocId(generation), data: {
    v: EVIDENCE_V, certified: false, vid: H(String(versionId)), generation: CLS(generation),
    intent: intent === 'rollback' ? 'rollback' : 'publish', ch: D(read(rec, 'content_hash')), seq_c: CLS(read(rec, 'seq')), rev_c: CLS(read(rec, 'identity_revision')),
  } };
}

// The document as written: the payload plus the server timestamp (the REQUEST_TIME transform).
const withAt = (data) => ({ ...data, at: FieldValue.serverTimestamp() });

/* ── §4: COLLISION TRANSLATION AT THE TRANSACTION BOUNDARY ─────────────────────────────────────────────────
   A tx.create collision surfaces at COMMIT. Exactly Firestore ALREADY_EXISTS on an identity_evidence path is
   translated into the typed refusal; EVERY other error is re-thrown unchanged (same object). The SDK's own
   retry behaviour is untouched — this runs after runTransaction has settled. */
function isEvidenceCollision(err) {
  try {
    if (!err) return false;
    const already = err.code === 6 || err.code === 'already-exists' || err.code === 'ALREADY_EXISTS';
    const where = `${err.details || ''} ${err.message || ''}`;
    return already && where.includes(`/${EVIDENCE_COL}/`);
  } catch (_) { return false; }
}
function translateEvidenceCollision(code, rid, versionId) {
  return (err) => {
    if (!isEvidenceCollision(err)) throw err;
    const e = new Error(`${code}: ${rid}/${versionId} — an identity evidence record already exists at this id; nothing was committed`);
    e.cause = err;
    throw e;
  };
}

/* ── INDEX CONTRACT (rev 12 §2b, §5 "Index fan-out") ────────────────────────────────────────────────────────────
   THIS LIST IS THE SOURCE for firestore.indexes.json's identity_evidence fieldOverrides. Every top-level field the builders
   emit is EXEMPT (map fields exempt their subfields) EXCEPT `vid`, which keeps exactly ONE single-field index — ASCENDING,
   collection scope — serving c2b's origin lookup `where('vid','==',H(v))` + document-name range + orderBy(__name__) +
   limit(1). So each evidence create adds exactly one index entry. Tests assert EVIDENCE_FIELDS ∪ {vid} = exactly the
   builders' fields, and these overrides = the file's identity_evidence overrides. */
const EVIDENCE_FIELDS = Object.freeze(['v', 'certified', 'generation', 'intent', 'ch', 'seq_c', 'rev_c', 'at', 'final_digest', 'final_count',
  'stampmap_digest', 'stampmap_counts', 'relocated_count', 'observed_digest', 'plan', 'kind', 'observed_generation', 'checks_digest',
  'checks_count']);
const INDEXED_FIELD = 'vid';
const evidenceFieldOverrides = () => [
  ...EVIDENCE_FIELDS.map((f) => ({ collectionGroup: EVIDENCE_COL, fieldPath: f, indexes: [] })),
  { collectionGroup: EVIDENCE_COL, fieldPath: INDEXED_FIELD, indexes: [{ order: 'ASCENDING', queryScope: 'COLLECTION' }] },
];

module.exports = {
  EVIDENCE_COL, EVIDENCE_V, STAMP_CODES, EVIDENCE_FIELDS, INDEXED_FIELD, evidenceFieldOverrides, G20,
  activationDocId, certificationDocId, evidenceRefOf, withAt,
  buildActivationEvidence, activationEvidenceDoc, buildCertificationEvidence, finalEntriesFromDocs, finalDigestOfVersion, planSection,
  activationDigestInputs, certificationDigestInputs, planDigestInputs, PLAN_ORDER,
  finalTupleBytes, finalPayloadBytes, FINAL_FRAME_BYTES,
  isEvidenceCollision, translateEvidenceCollision,
};
