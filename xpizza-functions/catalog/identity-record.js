'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-c1 — CONTENT-ADDRESSED IDENTITY RECORDS, the PURE core (PLAN-D4c1 rev 7 §2, §3a, §3b, §4).
//
// A version's identity context is a pure function of its own documents + identity_revision. Those inputs are
// NOT immutable under (versionId, identityRevision) — an old-executable certification changes stamps without a
// revision bump (D4-a ERRATA E1) — so a record is keyed by the DIGEST of its own normalized inputs: a changed
// input is a NEW record, never an overwrite.
//
// RTDB catalog_ctx/{rid}/{versionId} = { head: {digest, ck}, records: { {digest}: record }, seen: { {digest}: CK } }
//
// 🔴 ONE ENCODING. The record's `canonical` string is EXACTLY D4-a's persisted payload — persistedNode(...).payload
// (context-writer.js), i.e. the D4-a record-field allowlist (recordSubset) + canonical JSON in a STRING, which already
// survives RTDB's empty-container/null stripping. Decoding is D4-a's rawFromNode; building is D4-a's buildContext
// (the sole stamp→cid gateway). Nothing here re-implements any of them.
//
// 🔴 CK WIRE FORM = D4-a's own {revision, updateTime: {seconds, nanoseconds}} (context-fk.js makeCK), compared ONLY with
// compareCK — but only AFTER isValidCK: compareCK normalizes a malformed CK to the minimum, and here a malformed CK must be
// SEEN as malformed (plan §2), never silently ordered as the oldest.
//
// 🔴 PURE AND TOTAL. No I/O, no clock. Every function returns a value; nothing throws on bad input.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { canonicalJson } = require('./canonical-json');
const { buildContext } = require('./catalog-context');
const { makeCK, compareCK, revisionOf } = require('./context-fk');
const { persistedNode, rawFromNode } = require('./context-writer');
const { pricesExactlyEqual } = require('./context-source');

const IDENTITY_PATH = 'catalog_ctx';
const SCHEMA_V = 1;
const MAX_RECORDS = 8;
// §3b — the record bound: 4 × the larger of the two live restaurants' records, in UTF-8 bytes of the serialized RTDB
// value. Measured and pinned in identity-record.test.js (the measurement is reproduced there from the real writers).
const RECORD_BOUND_BYTES = 88064;   // = ceil(4 × 21787 / 1024) KiB: la_musa certified (the larger) — measured 2026-10-06
const NODE_OVERHEAD_BYTES = 4096;   // head + 8 seen entries + keys
const NODE_CAP_BYTES = MAX_RECORDS * RECORD_BOUND_BYTES + NODE_OVERHEAD_BYTES;

const RECORD_KEYS = ['canonical', 'certified', 'content_hash', 'digest', 'identityRevision', 'rid', 'seq', 'v', 'versionId'];
const HEAD_KEYS = ['ck', 'digest'];
const CK_KEYS = ['revision', 'updateTime'];
const TIME_KEYS = ['nanoseconds', 'seconds'];
const EPOCH_TIME = Object.freeze({ seconds: 0, nanoseconds: 0 });

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const sameKeys = (o, keys) => { const k = Object.keys(o).sort(); return k.length === keys.length && k.every((x, i) => x === keys[i]); };
const isDigest = (d) => typeof d === 'string' && /^[0-9a-f]{64}$/.test(d);
// An RTDB-legal path segment (no . # $ [ ] / and no control characters).
const isPathKey = (s) => typeof s === 'string' && s.length > 0 && s.length <= 128 && !/[.#$[\]/\u0000-\u001f\u007f]/.test(s);
const utf8Bytes = (value) => Buffer.byteLength(JSON.stringify(value === undefined ? null : value), 'utf8');

// ── CK ─────────────────────────────────────────────────────────────────────────────────────────────
function isValidCK(ck) {
  if (!isPlainObject(ck) || !sameKeys(ck, CK_KEYS) || !nonNegInt(ck.revision)) return false;
  const t = ck.updateTime;
  return isPlainObject(t) && sameKeys(t, TIME_KEYS) && nonNegInt(t.seconds)
    && Number.isInteger(t.nanoseconds) && t.nanoseconds >= 0 && t.nanoseconds <= 999999999;
}
const cloneCK = (ck) => ({ revision: ck.revision, updateTime: { seconds: ck.updateTime.seconds, nanoseconds: ck.updateTime.nanoseconds } });
const epochCK = (revision) => ({ revision, updateTime: { ...EPOCH_TIME } });
// The greater of two VALID CKs (b wins only if strictly greater).
const maxCK = (a, b) => (compareCK(b, a) > 0 ? cloneCK(b) : cloneCK(a));

// ── The record ─────────────────────────────────────────────────────────────────────────────────────
// The digest preimage is EXACTLY: v, rid, versionId, identityRevision, certified, content_hash, seq and the canonical
// string. Not the digest field itself, not seen, not head, no timestamp.
function digestOf(r) {
  const pre = canonicalJson({
    v: r.v, rid: r.rid, versionId: r.versionId, identityRevision: r.identityRevision,
    certified: r.certified, content_hash: r.content_hash, seq: r.seq, canonical: r.canonical,
  });
  return crypto.createHash('sha256').update(pre, 'utf8').digest('hex');
}

// certified: absent source field → false; a boolean → itself; anything else → malformed (refuse).
function certifiedOf(record) {
  const c = record ? record.identity_certified : undefined;
  if (c === undefined) return { ok: true, value: false };
  if (c === true || c === false) return { ok: true, value: c };
  return { ok: false };
}

// THE ONE SHARED CONSTRUCTOR (every writer uses it; trigger and reconciler are byte-equal by construction and test).
// src = { rid, versionId, record, updateTime, items, extras, structure } — ONE consistent Firestore read.
// → { ok: true, record, digest, ck, bytes, context } | { ok: false, reason, detail }
function buildIdentityRecord(src, { recordBound = RECORD_BOUND_BYTES } = {}) {
  try {
    if (!src || !isPathKey(src.rid) || !isPathKey(src.versionId)) return { ok: false, reason: 'source_malformed', detail: 'rid/versionId' };
    const { rid, versionId, record } = src;
    if (!isPlainObject(record)) return { ok: false, reason: 'source_malformed', detail: 'record' };
    const cert = certifiedOf(record);
    if (!cert.ok) return { ok: false, reason: 'certified_malformed' };
    if (!nonNegInt(record.seq)) return { ok: false, reason: 'seq_malformed' };
    if (typeof record.content_hash !== 'string' || !record.content_hash) return { ok: false, reason: 'no_content_hash' };
    const ck = makeCK({ record, updateTime: src.updateTime });
    if (!ck || !isValidCK(ck)) return { ok: false, reason: 'record_time_unrepresentable' };
    const canonical = persistedNode({ rid, versionId, record, items: src.items, extras: src.extras, structure: src.structure, fk: null }).payload;
    // Integrity over EXACTLY what will be persisted, decoded AS it will be read back (D4-a writer step 3).
    const context = buildContext(rawFromNode({ head: { rid, versionId }, payload: canonical }));
    if (!context.contentIntegrity || context.contentIntegrity.state !== 'intact') {
      return { ok: false, reason: 'content_integrity', detail: context.contentIntegrity && (context.contentIntegrity.reason || context.contentIntegrity.state) };
    }
    const rec = { v: SCHEMA_V, rid, versionId, seq: record.seq, identityRevision: revisionOf(record), certified: cert.value, content_hash: record.content_hash, canonical };
    rec.digest = digestOf(rec);
    if (ck.revision !== rec.identityRevision) return { ok: false, reason: 'ck_revision_mismatch' };   // unreachable: both are revisionOf
    const bytes = utf8Bytes(rec);
    if (bytes > recordBound) return { ok: false, reason: 'oversize', detail: `record ${bytes} > ${recordBound} bytes`, bytes };
    return { ok: true, record: rec, digest: rec.digest, ck, bytes, context };
  } catch (e) {
    return { ok: false, reason: 'source_malformed', detail: String((e && e.message) || e).slice(0, 160) };
  }
}

// THE ONE VALIDATION SEQUENCE (§4), up to "decoded-record agrees":
//   schema → outer key/metadata agreement → recompute digest → decode → decoded-record agrees with key + metadata.
// The reader continues with build → attach (identityFromVersionNode). Writers call exactly this to decide "valid".
function validateRecord(key, rec, where) {
  // 1. schema
  if (!isPlainObject(rec) || !sameKeys(rec, RECORD_KEYS)) return { ok: false, reason: 'schema' };
  if (rec.v !== SCHEMA_V) return { ok: false, reason: 'schema_version' };
  if (!isPathKey(rec.rid) || !isPathKey(rec.versionId) || !nonNegInt(rec.seq) || !nonNegInt(rec.identityRevision)
    || typeof rec.content_hash !== 'string' || !rec.content_hash || typeof rec.canonical !== 'string' || !isDigest(rec.digest)) {
    return { ok: false, reason: 'schema' };
  }
  if (rec.certified !== true && rec.certified !== false) return { ok: false, reason: 'certified_malformed' };
  // 2. outer key / metadata agreement
  if (rec.digest !== key) return { ok: false, reason: 'key_mismatch' };
  if (!where || rec.rid !== where.rid || rec.versionId !== where.versionId) return { ok: false, reason: 'metadata_mismatch' };
  // 3. recompute the digest (a stored digest is NEVER trusted)
  if (digestOf(rec) !== key) return { ok: false, reason: 'digest_mismatch' };
  // 4. decode (D4-a's own decoder)
  const raw = rawFromNode({ head: { rid: rec.rid, versionId: rec.versionId }, payload: rec.canonical });
  if (!raw || !isPlainObject(raw.record) || !Array.isArray(raw.items) || !Array.isArray(raw.extras)) return { ok: false, reason: 'decode' };
  // 5. the decoded record agrees with the key + metadata
  const d = raw.record;
  const cert = certifiedOf(d);
  if (!cert.ok) return { ok: false, reason: 'decoded_certified_malformed' };
  if (d.version !== rec.versionId || d.seq !== rec.seq || d.content_hash !== rec.content_hash
    || cert.value !== rec.certified || revisionOf(d) !== rec.identityRevision) {
    return { ok: false, reason: 'decoded_disagrees' };
  }
  return { ok: true, raw };
}

const isValidHeadShape = (h) => isPlainObject(h) && sameKeys(h, HEAD_KEYS) && isDigest(h.digest) && isValidCK(h.ck);

// ── §3a THE VERSION-NODE TRANSACTION CALLBACK — side-effect-free, recomputes everything from `current` ─────────────
// cand = { digest, record, ck } (from buildIdentityRecord, already self-validated); where = { rid, versionId }.
// → { write: false, outcomes, detail }   — nothing to commit (no-op), or `oversize` (refused)
//   { write: true, next, outcomes, detail } — the node to commit
// RTDB may call the callback repeatedly (first with null); this is a function of (current, cand) only.
function applyCandidate(current, cand, where, { maxRecords = MAX_RECORDS, nodeCap = NODE_CAP_BYTES } = {}) {
  const outcomes = new Set();
  const detail = { unrecoverable: [], evicted: [], seenRepaired: [], orphanSeen: [] };
  const cur = isPlainObject(current) ? current : null;
  if (current !== null && current !== undefined && !cur) outcomes.add('head_invalid');   // a non-object node: corrupt
  const recsIn = cur && isPlainObject(cur.records) ? cur.records : {};
  const seenIn = cur && isPlainObject(cur.seen) ? cur.seen : {};

  // (1) Classify stored records: only bytes whose recomputed digest equals their key are valid.
  const records = {};
  const valid = new Map();
  const corrupt = new Set();
  for (const [k, r] of Object.entries(recsIn)) {
    records[k] = r;
    if (validateRecord(k, r, where).ok) valid.set(k, r); else corrupt.add(k);
  }
  const preExisting = new Set(valid.keys());

  // (2) Record insertion — create-only by digest. Restore a corrupt entry ONLY from an exact matching source.
  if (valid.has(cand.digest)) outcomes.add('exists');
  else if (corrupt.has(cand.digest)) {
    records[cand.digest] = cand.record; valid.set(cand.digest, cand.record); corrupt.delete(cand.digest);
    outcomes.add('restored');
  } else { records[cand.digest] = cand.record; valid.set(cand.digest, cand.record); outcomes.add('inserted'); }
  for (const k of corrupt) { detail.unrecoverable.push(k); outcomes.add('unrecoverable_record'); }

  // (3) seen invariants (i)–(iii) over the VALID records, BEFORE the candidate's CK is applied.
  const seen = {};
  for (const [d, rec] of valid) {
    const s = seenIn[d];
    if (!preExisting.has(d)) {
      // A record that became valid IN THIS transaction (inserted, or restored over a corrupt entry) starts from the reset
      // baseline: a seen stored under its digest belonged to no valid record — an orphan (iii) or a corrupt entry's —
      // and is never ordering evidence (else it could sit above head without advancing it, breaking (iv)).
      seen[d] = epochCK(rec.identityRevision);
      if (s !== undefined) { if (outcomes.has('restored')) { detail.seenRepaired.push(d); outcomes.add('seen_repaired'); } else detail.orphanSeen.push(d); }
      continue;
    }
    if (isValidCK(s) && s.revision === rec.identityRevision) { seen[d] = cloneCK(s); continue; }   // (i)
    seen[d] = epochCK(rec.identityRevision);                                                        // (ii) reset
    detail.seenRepaired.push(d); outcomes.add('seen_repaired');
  }
  for (const d of Object.keys(seenIn)) if (!valid.has(d)) detail.orphanSeen.push(d);              // (iii) dropped below

  // (4) Head validity FIRST (iv): names a valid record AND a valid CK AND revisions agree.
  const hasHistory = !!cur && (Object.keys(recsIn).length > 0 || cur.head !== undefined);
  let head = null;
  const h = cur ? cur.head : undefined;
  const headValid = isValidHeadShape(h) && valid.has(h.digest) && h.ck.revision === valid.get(h.digest).identityRevision;
  if (headValid) {
    head = { digest: h.digest, ck: cloneCK(h.ck) };
    // head/seen consistency (valid head only): seen is raised to head.ck; a greater seen moves head.
    if (compareCK(head.ck, seen[head.digest]) > 0) { seen[head.digest] = cloneCK(head.ck); outcomes.add('head_repaired'); }
    // pre-existing records only: the candidate is ordered by its own CK in step (5), not by its reset baseline
    const g = greatestSeen(seen, [...valid.keys()].filter((d) => preExisting.has(d)));
    if (g && compareCK(g.ck, head.ck) > 0) { head = g; outcomes.add('head_repaired'); }
  } else if (hasHistory) {
    // An invalid (or absent-with-history) head: its CK is DISCARDED as ordering evidence; head is reconstructed from the
    // validated seen entries PLUS the candidate — never promoted into seen.
    outcomes.add('head_invalid');
    const pool = { ...seen, [cand.digest]: maxCK(seen[cand.digest], cand.ck) };
    head = greatestSeen(pool, Object.keys(pool));
  }

  // (5) The candidate: seen advancement, then head advancement (STRICTLY greater CK only).
  seen[cand.digest] = maxCK(seen[cand.digest], cand.ck);
  if (!head) { head = { digest: cand.digest, ck: cloneCK(cand.ck) }; outcomes.add('head_advanced'); }
  else {
    const c = compareCK(cand.ck, head.ck);
    if (c > 0) { head = { digest: cand.digest, ck: cloneCK(cand.ck) }; outcomes.add('head_advanced'); }
    else if (c === 0 && cand.digest !== head.digest) outcomes.add('ck_conflict');
    else outcomes.add('head_unchanged');
  }

  // (6) §3b eviction: head selected FIRST; then while > maxRecords, drop the non-head record with the OLDEST seen CK
  // (ties: lexicographically smallest digest), corrupt entries first (no valid seen), deleting its seen in the SAME result.
  for (;;) {
    const keys = Object.keys(records);
    if (keys.length <= maxRecords) break;
    const victims = keys.filter((k) => k !== head.digest).sort((a, b) => {
      const ca = corrupt.has(a), cb = corrupt.has(b);
      if (ca !== cb) return ca ? -1 : 1;
      if (!ca) { const c = compareCK(seen[a], seen[b]); if (c !== 0) return c; }
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const v = victims[0];
    delete records[v]; valid.delete(v); corrupt.delete(v);   // its seen is dropped by the (iii) pass below, in the SAME result
    detail.evicted.push(v); outcomes.add('evicted');
  }
  if (detail.unrecoverable.length) detail.unrecoverable = detail.unrecoverable.filter((k) => records[k] !== undefined);
  if (!detail.unrecoverable.length) outcomes.delete('unrecoverable_record');
  for (const d of Object.keys(seen)) if (!valid.has(d)) delete seen[d];                       // (iii) seen ⊆ valid records
  if (detail.orphanSeen.length) outcomes.add('orphan_seen_removed');

  const next = { head, records, seen };
  // (7) Byte limit, enforced INSIDE the transaction: above the cap nothing is written.
  const bytes = utf8Bytes(next);
  if (bytes > nodeCap) return { write: false, outcomes: [...new Set([...outcomes, 'oversize'])], detail: { ...detail, bytes, nodeCap } };
  // (8) A no-op writes nothing.
  if (cur && canonicalJson(next) === canonicalJson(cur)) return { write: false, outcomes: [...outcomes], detail: { ...detail, bytes } };
  return { write: true, next, outcomes: [...outcomes], detail: { ...detail, bytes } };
}

// The valid record with the greatest seen CK (ties: lexicographically GREATEST digest).
function greatestSeen(seen, digests) {
  let best = null;
  for (const d of digests) {
    const s = seen[d];
    if (!isValidCK(s)) continue;
    if (!best) { best = { digest: d, ck: cloneCK(s) }; continue; }
    const c = compareCK(s, best.ck);
    if (c > 0 || (c === 0 && d > best.digest)) best = { digest: d, ck: cloneCK(s) };
  }
  return best;
}

// The invariants (i)–(iv) of a node, checked independently of applyCandidate (used by tests and the verifier).
function nodeInvariantProblems(node, where) {
  const p = [];
  if (!isPlainObject(node)) return ['node_not_object'];
  const recs = isPlainObject(node.records) ? node.records : {};
  const seen = isPlainObject(node.seen) ? node.seen : {};
  const valid = new Map(Object.entries(recs).filter(([k, r]) => validateRecord(k, r, where).ok));
  for (const [d, r] of valid) {
    if (!isValidCK(seen[d])) p.push(`seen_missing:${d}`);
    else if (seen[d].revision !== r.identityRevision) p.push(`seen_revision:${d}`);                        // (i)
  }
  for (const d of Object.keys(seen)) if (!valid.has(d)) p.push(`seen_orphan:${d}`);                       // (iii)
  const h = node.head;
  if (!isValidHeadShape(h) || !valid.has(h.digest) || h.ck.revision !== valid.get(h.digest).identityRevision) p.push('head_invalid');   // (iv)
  else {
    if (compareCK(h.ck, seen[h.digest]) !== 0) p.push('head_seen_mismatch');
    for (const [d] of valid) if (isValidCK(seen[d]) && compareCK(seen[d], h.ck) > 0) p.push(`seen_above_head:${d}`);
  }
  if (Object.keys(recs).length > MAX_RECORDS) p.push('too_many_records');
  return p;
}

// ── §4 THE READER (pure): identityFromVersionNode(node, served, where) ─────────────────────────────────────────────
// served = { rid, versionId, seq, prices: { menu, extras } } — INDEPENDENTLY captured served prices (never the record's).
// Outcomes: missing node/head/record → `unavailable` (never certified:false); explicit certified:false → valid UNCERTIFIED;
// malformed certification / key-metadata-decoded disagreement / malformed head CK / bad digest → `invalid`.
// An invalid selected head NEVER falls back to an older record.
function identityFromVersionNode(node, served, where, { maxRecords = MAX_RECORDS, nodeCap = NODE_CAP_BYTES } = {}) {
  const res = (availability, extra) => ({ availability, attached: false, usableForWriting: false, ...extra });
  try {
    if (node === null || node === undefined) return res('unavailable', { reason: 'no_node' });
    if (!isPlainObject(node)) return res('invalid', { reason: 'node_malformed' });
    if (utf8Bytes(node) > nodeCap) return res('invalid', { reason: 'node_oversize' });
    const recs = isPlainObject(node.records) ? node.records : {};
    if (Object.keys(recs).length > maxRecords) return res('invalid', { reason: 'too_many_records' });
    if (node.head === undefined || node.head === null) return res('unavailable', { reason: 'no_head' });
    if (!isValidHeadShape(node.head)) return res('invalid', { reason: 'head_malformed' });
    const { digest, ck } = node.head;
    const rec = recs[digest];
    if (rec === undefined) return res('unavailable', { reason: 'no_record', digest });
    const v = validateRecord(digest, rec, where);
    if (!v.ok) return res('invalid', { reason: v.reason, digest });
    if (ck.revision !== rec.identityRevision) return res('invalid', { reason: 'head_revision_mismatch', digest });
    // build (D4-a's builder, the sole stamp→cid gateway)
    const ctx = buildContext({ ...v.raw, rid: rec.rid, versionId: rec.versionId });
    if (!ctx.built || !ctx.contentIntegrity || ctx.contentIntegrity.state !== 'intact') {
      return res('invalid', { reason: 'integrity', digest, integrity: ctx.contentIntegrity && ctx.contentIntegrity.state });
    }
    // attach — provenance + EXACT price equality against the independently served prices
    const attached = !!served && served.rid === rec.rid && served.versionId === rec.versionId && served.seq === rec.seq
      && pricesExactlyEqual(ctx.prices, served.prices);
    return {
      availability: 'available', digest, ck: cloneCK(ck), identityRevision: rec.identityRevision, seq: rec.seq,
      certified: rec.certified, intact: true, complete: ctx.complete === true, attached,
      usableForWriting: ctx.complete === true && attached,
      context: ctx,
    };
  } catch (e) {
    return res('invalid', { reason: 'reader_exception', detail: String((e && e.message) || e).slice(0, 160) });
  }
}

module.exports = {
  IDENTITY_PATH, SCHEMA_V, MAX_RECORDS, RECORD_BOUND_BYTES, NODE_OVERHEAD_BYTES, NODE_CAP_BYTES, EPOCH_TIME,
  isValidCK, digestOf, certifiedOf, buildIdentityRecord, validateRecord, applyCandidate, greatestSeen,
  nodeInvariantProblems, identityFromVersionNode, utf8Bytes, isPathKey,
};
