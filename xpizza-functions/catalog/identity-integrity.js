'use strict';
/* 1D D4-c2b — THE IDENTITY INTEGRITY CLASSIFIER (PLAN-D4c2b rev 14 §2, §3). PURE: no I/O, no clock.
   Judges ONE coherent observation of a restaurant against the c2a binding evidence and returns the findings it implies. The
   monitor (identity-integrity-monitor.js) does the reads; the reducer (identity-integrity-state.js) makes findings sticky.

   Everything c2a-defined is IMPORTED, never re-derived (§0 owner rule 1, c2a rev 14 §2E.8(4)):
     final_digest     only through c2a's exported finalDigestOfVersion (ENC2)
     size budget      only through c2a's exported finalTupleBytes / FINAL_FRAME_BYTES
     addressing       activationDocId / certificationDocId / G20 / H
     registry verdict catalog-verifier.js's judgePair (catalog-verifier.js:62)

   FINDING CLASSES (summary counts, §4/§6):
     violation  evidence_malformed, evidence_mismatch, decertified, coverage_broken, stamps_changed, registry_disagrees,
                active_version_missing, rollback_target_altered                                   → alerted
     gap        unattested{generation_gap | boundary_unknown}, history_unknown                       → informational
     degraded   degraded (a missing_key_row pair whose timer passed 2 h — opened by the reducer)  → alerted */
const { finalDigestOfVersion, finalTupleBytes, FINAL_FRAME_BYTES, activationDocId, certificationDocId } = require('./identity-evidence');
const { H } = require('./evidence-encoding');
const { judgePair } = require('./catalog-verifier');
const { validIdShape, encodeKey } = require('./identity-registry');   // what Firestore requires of a document id (the registry read)

const KINDS = Object.freeze(['dish', 'extra']);
const CLASS_OF = Object.freeze({
  evidence_malformed: 'violation', evidence_mismatch: 'violation', decertified: 'violation', coverage_broken: 'violation',
  stamps_changed: 'violation', registry_disagrees: 'violation', active_version_missing: 'violation', rollback_target_altered: 'violation',
  unattested: 'gap', history_unknown: 'gap',
  degraded: 'degraded',
});
const MAX_OBJECTS = 400;                          // §2: combined > 400 → unavailable{oversized} BEFORE any object read
const MAX_CERTIFICATIONS = 8;                     // §2: the range is read with limit(9); a 9th → unavailable{too_many_certifications}
const PAIR_RAW_BUDGET = 4 * 1024 * 1024;          // §5: raw pair bytes
const PAIR_ENCODED_BUDGET = 24 * 1024 * 1024;     // §5: the EXACT c2a encoded size (ENC2 preimage bytes)

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isDigest = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isGen = isCount;
const isCls = (v) => isCount(v) || (typeof v === 'string' && /^o:[a-z]{1,10}$/.test(v));   // c2a CLS(): an int or "o:<class>"
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/* ── §2.1 SCHEMAS (c2a rev 14 §2 / §2a / §3) — exact field sets; the `at` server timestamp is checked for presence only ── */
const ACTIVATION_FULL = Object.freeze(['v', 'certified', 'vid', 'generation', 'intent', 'ch', 'seq_c', 'rev_c', 'final_digest', 'final_count',
  'stampmap_digest', 'stampmap_counts', 'relocated_count', 'observed_digest', 'plan', 'at']);
const ACTIVATION_MINIMAL = Object.freeze(['v', 'certified', 'vid', 'generation', 'intent', 'ch', 'seq_c', 'rev_c', 'at']);
const CERTIFICATION = Object.freeze(['v', 'kind', 'certified', 'vid', 'observed_generation', 'rev_c', 'ch', 'final_digest', 'final_count',
  'checks_digest', 'checks_count', 'at']);
const sameKeys = (d, want) => { const k = Object.keys(d).sort(); const w = want.slice().sort(); return k.length === w.length && k.every((x, i) => x === w[i]); };
const PLAN_KEYS = ['deletions', 'mints', 'moves', 'plan_digest', 'restores', 'retires', 'verified'];
const planOk = (p) => p && typeof p === 'object' && ['dish', 'extra'].every((k) => {
  const s = p[k];
  return s && typeof s === 'object' && sameKeys(s, PLAN_KEYS) && isDigest(s.plan_digest) && typeof s.verified === 'boolean'
    && ['mints', 'moves', 'restores', 'retires', 'deletions'].every((c) => isCount(s[c]));
}) && Object.keys(p).length === 2;

// → { ok:true, certified } | { ok:false, why }. Structure only (association is checked separately, §2.1).
function activationSchema(docId, d) {
  if (!d || typeof d !== 'object') return { ok: false, why: 'not_an_object' };
  if (d.v !== 1) return { ok: false, why: 'version' };
  const certified = d.certified === true;
  if (d.certified !== true && d.certified !== false) return { ok: false, why: 'certified_flag' };
  if (!sameKeys(d, certified ? ACTIVATION_FULL : ACTIVATION_MINIMAL)) return { ok: false, why: 'fields' };
  if (!isDigest(d.vid) || !isDigest(d.ch) || !isGen(d.generation) || !isCls(d.seq_c) || !isCls(d.rev_c)) return { ok: false, why: 'header' };
  if (d.intent !== 'publish' && d.intent !== 'rollback') return { ok: false, why: 'intent' };
  if (docId !== undefined && docId !== activationDocId(d.generation)) return { ok: false, why: 'doc_id' };
  if (certified) {
    if (!isDigest(d.final_digest) || !isCount(d.final_count) || !isDigest(d.stampmap_digest) || !isDigest(d.observed_digest)
      || !isCount(d.relocated_count) || !d.stampmap_counts || typeof d.stampmap_counts !== 'object' || !planOk(d.plan)) return { ok: false, why: 'body' };
    if (!Object.values(d.stampmap_counts).every(isCount)) return { ok: false, why: 'body' };
  }
  if (!own(d, 'at')) return { ok: false, why: 'at' };
  return { ok: true, certified };
}
function certificationSchema(docId, d) {
  if (!d || typeof d !== 'object') return { ok: false, why: 'not_an_object' };
  if (d.v !== 1 || d.kind !== 'certify' || d.certified !== true) return { ok: false, why: 'header' };
  if (!sameKeys(d, CERTIFICATION)) return { ok: false, why: 'fields' };
  if (!isDigest(d.vid) || !isDigest(d.ch) || !isGen(d.observed_generation) || !isCount(d.rev_c)) return { ok: false, why: 'header' };
  if (!isDigest(d.final_digest) || !isCount(d.final_count) || !isDigest(d.checks_digest) || !isCount(d.checks_count)) return { ok: false, why: 'body' };
  if (docId !== undefined && docId !== certificationDocId(d.observed_generation, d.rev_c)) return { ok: false, why: 'doc_id' };
  return { ok: true };
}

// A finding as the classifier reports it: its CONDITION KEY (what it is about) is stable across runs; the reducer adds identity.
const finding = (kind, subject, detail = {}) => ({ kind, class: CLASS_OF[kind], cond: H(`${kind}|${subject}`), subject, detail });

/* ── §5 the retained-pair budgets, counted BEFORE the digest buffer is built ───────────────────────────────────────────
   INCREMENTAL (codex build r1 P1-1): the monitor admits each pair AS ITS PAGE IS REDUCED and stops reading the moment either
   budget is exceeded — the retained set never grows past the budget, and the result is unavailable{oversized_values}. */
function createPairBudget() {
  let raw = 0; let encoded = FINAL_FRAME_BYTES; let n = 0;
  return {
    admit(p) {   // → true while both budgets hold (including this pair)
      raw += Buffer.byteLength(String(p.kind)) + Buffer.byteLength(String(p.key)) + Buffer.byteLength(String(p.id)) + Buffer.byteLength(String(p.docId));
      encoded += finalTupleBytes({ k: p.kind, c: p.id, n: p.key, o: p.docId }) + (n ? 1 : 0);
      n += 1;
      return raw <= PAIR_RAW_BUDGET && encoded <= PAIR_ENCODED_BUDGET;
    },
    state: () => ({ raw, encoded, pairs: n }),
  };
}
function pairBudget(pairs) {
  const b = createPairBudget();
  for (const p of pairs) if (!b.admit(p)) return { ok: false, ...b.state() };
  return { ok: true, ...b.state() };
}
// c2a's recomputation over the retained pairs — ONLY through the export (as the version docs it reads would present them)
const asDoc = (p) => ({ id: p.docId, data: () => ({ key: p.key, display: { identity_id: p.id } }) });
function recomputeFinal(pairs) {
  return finalDigestOfVersion({ dishDocs: pairs.filter((p) => p.kind === 'dish').map(asDoc), extraDocs: pairs.filter((p) => p.kind === 'extra').map(asDoc) });
}

/* ── §2 CHECK A — the active binding ───────────────────────────────────────────────────────────────────────────────────
   obs = {
     rid:            the restaurant (registry paths)
     pointer:        { version, generation }                      (c2a's reader semantics: an absent generation reads 0)
     record:         { exists, certified }                        the version record (identity_certified === true)
     activation:     { id, data } | null                          g{G20(generation)}
     certifications: [{ id, data }]                               the name range for this generation (≤ 9 read)
     origin:         { kind: 'publish'|'certify'|'none' }         only read when no effective record (§2.3)
     objects:        { count, oversized, pairs:[{kind,key,id,docId}], unstamped:[{kind,docId}] }
     rows:           { [path]: row }                              registry rows for readSetOf(pairs)
   }
   boundary = { G0 } | null (unknown).  → { state, findings[], degradedPairs[], coverage }  (coverage = a completed check) */
function classifyActive(obs, boundary) {
  const findings = [];
  const gen = obs.pointer.generation;
  const vid = H(String(obs.pointer.version));
  const subj = `${gen}`;
  if (!obs.record.exists) {
    findings.push(finding('active_version_missing', subj, { generation: gen }));
    return { state: 'violation', findings, degradedPairs: [], coverage: true };
  }
  // §5: the monitor stopped reading when the retained pairs passed the budgets → the binding cannot be judged: unavailable,
  // NEVER a violation, not coverage (codex build r1 P1-1 — decided while reading, before the registry is read)
  if (obs.objects.oversized_values) return { state: 'unavailable', reason: 'oversized_values', findings: [], degradedPairs: [], coverage: false };
  // 1. schemas, separately; association to THIS pointer
  let activation = null; let stop = false;
  if (obs.activation) {
    const s = activationSchema(obs.activation.id, obs.activation.data);
    if (!s.ok) { findings.push(finding('evidence_malformed', `g${subj}`, { generation: gen, why: s.why })); stop = true; }
    else if (obs.activation.data.vid !== vid || obs.activation.data.generation !== gen) { findings.push(finding('evidence_mismatch', `g${subj}`, { generation: gen })); stop = true; }
    else activation = obs.activation.data;
  } else if (boundary && gen < boundary.G0) {
    // pre_boundary: a state, not a finding (§1, §10)
  } else {
    findings.push(finding('unattested', `g${subj}`, { generation: gen, reason: boundary ? 'generation_gap' : 'boundary_unknown' }));
  }
  const certs = [];
  for (const c of obs.certifications) {
    const s = certificationSchema(c.id, c.data);
    if (!s.ok) { findings.push(finding('evidence_malformed', `c:${c.id}`, { generation: gen, why: s.why })); stop = true; continue; }
    if (c.data.vid !== vid || c.data.observed_generation !== gen) { findings.push(finding('evidence_mismatch', `c:${c.id}`, { generation: gen })); stop = true; continue; }
    certs.push(c.data);
  }
  // 5. registry — independent of the binding judgement (it runs even when the evidence is unusable)
  // (the monitor judges the registry batch by batch and keeps only the verdicts — obs.registry; a direct caller passes rows)
  const reg = obs.registry ? registryFindings(gen, obs.registry) : judgeRegistry(obs);
  findings.push(...reg.findings);
  if (stop) return { state: 'violation', findings, degradedPairs: reg.degradedPairs, coverage: true };
  // 2. the EFFECTIVE binding record, selected before any count/digest check
  const cert = certs.reduce((best, c) => (best === null || c.rev_c > best.rev_c ? c : best), null);
  const effective = cert || (activation && activation.certified === true ? activation : null);
  let state;
  if (!effective) {
    // 3. prior certification → decertified
    if (obs.origin && obs.origin.kind !== 'none' && !obs.record.certified) {
      findings.push(finding('decertified', `v:${vid}`, { generation: gen }));
      state = 'violation';
    } else state = boundary && gen < boundary.G0 && !obs.activation ? 'pre_boundary' : 'uncertified';
  } else {
    // 4. the binding
    if (!obs.record.certified) findings.push(finding('decertified', `v:${vid}`, { generation: gen }));
    const cov = coverageOf(obs.objects, effective.final_count);
    if (!cov.ok) findings.push(finding('coverage_broken', `g${subj}`, { generation: gen, ...cov.detail }));
    // §2.4/§5: past the pair/encoding budgets the binding cannot be judged → unavailable, NEVER a violation, not coverage
    const budget = pairBudget(obs.objects.pairs);
    if (!budget.ok) return { state: 'unavailable', reason: 'oversized_values', findings: [], degradedPairs: [], coverage: false };
    if (recomputeFinal(obs.objects.pairs).final_digest !== effective.final_digest) findings.push(finding('stamps_changed', `g${subj}`, { generation: gen }));
    state = findings.some((f) => f.class === 'violation') ? 'violation' : 'ok';
  }
  if (state !== 'violation' && findings.some((f) => f.class === 'violation')) state = 'violation';
  return { state, findings, degradedPairs: reg.degradedPairs, coverage: true };
}

// coverage — every object stamped, ids unique per kind, the stamped count equals the effective record's final_count
function coverageOf(objects, finalCount) {
  const unstamped = objects.unstamped.length;
  const seen = new Set(); let dup = 0;
  for (const p of objects.pairs) { const k = `${p.kind}\u0000${p.id}`; if (seen.has(k)) dup += 1; else seen.add(k); }
  const count = objects.pairs.length + unstamped;
  const ok = unstamped === 0 && dup === 0 && count === finalCount;
  return { ok, detail: { unstamped, duplicate_ids: dup, objects: count, final_count: finalCount } };
}

// registry: judgePair per stamped pair; missing_key_row ONLY → degraded for that pair; any other rejection → registry_disagrees
const pairKey = (p) => H(`${p.kind}|${p.key}|${p.id}`);
// which stamped pairs CAN be looked up: a stamp that is not a valid document id ('bad/id', '..', '__x__', > 200 chars), or a legacy
// key whose encoded key-row id passes Firestore's 1,500-byte document-id limit (a key > 1,125 bytes), is never turned into a
// registry path (codex build r1 P2-6 — Firestore would reject the read, or address ANOTHER document): no such row can exist
const MAX_DOC_ID_BYTES = 1500;
const addressable = (p) => validIdShape(p.id) && typeof p.key === 'string' && p.key.length > 0 && Buffer.byteLength(encodeKey(p.key)) <= MAX_DOC_ID_BYTES;
// ONE batch of pairs against the rows read for exactly those pairs → verdicts only (the rows are then released by the caller)
function judgeRegistryChunk(rid, pairs, rows) {
  const degraded = []; const disagree = []; let invalid = 0;
  for (const p of pairs) {
    if (!addressable(p)) { disagree.push(pairKey(p)); invalid += 1; continue; }   // a malformed stamp cannot agree with any registry row
    const r = judgePair(rid, { kind: p.kind, legacyKey: p.key, canonicalId: p.id }, rows || {});
    if (!r) continue;
    if (r.reason === 'missing_key_row') degraded.push(pairKey(p));
    else disagree.push(pairKey(p));
  }
  return { degraded, disagree, invalid };
}
function registryFindings(gen, { degraded, disagree, invalid = 0 }) {
  const findings = [];
  if (disagree.length) findings.push(finding('registry_disagrees', `g${gen}|${disagree.slice().sort().join(',')}`, { generation: gen, pairs: disagree.length, ...(invalid ? { invalid_stamps: invalid } : {}) }));
  return { findings, degradedPairs: degraded.slice().sort() };
}
function judgeRegistry(obs) {
  return registryFindings(obs.pointer.generation, judgeRegistryChunk(obs.rid, obs.objects.pairs, obs.rows || {}));
}

/* ── §3 CHECK B — one generation of the dense audit ───────────────────────────────────────────────────────────────────
   entry = { g, doc: { id, data } | null, origin: { kind, data } | undefined }   boundary = { G0 } | null
   → { findings[], rollback: boolean }   (the origin is read by the monitor only for a certified rollback) */
function classifyAuditEntry(entry, boundary) {
  const { g } = entry;
  if (!entry.doc) {
    if (boundary && g < boundary.G0) return { findings: [], pre_boundary: true };
    return { findings: [finding('unattested', `g${g}`, { generation: g, reason: boundary ? 'generation_gap' : 'boundary_unknown' })] };
  }
  const s = activationSchema(entry.doc.id, entry.doc.data);
  if (!s.ok || entry.doc.data.generation !== g) return { findings: [finding('evidence_malformed', `g${g}`, { generation: g, why: s.ok ? 'generation' : s.why })] };
  const d = entry.doc.data;
  if (d.intent !== 'rollback' || d.certified !== true) return { findings: [] };
  return { findings: classifyRollbackOrigin(g, d, entry.origin), rollback: true };
}
// a certified rollback against its version's BINDING origin (c2a §2b); a rollback is never an origin
function classifyRollbackOrigin(g, d, origin) {
  if (!origin || origin.kind === 'none') return [finding('history_unknown', `v:${d.vid}`, { generation: g })];
  const o = origin.data;
  const ok = origin.kind === 'publish' ? activationSchema(origin.id, o).ok && o.intent === 'publish' && o.certified === true && o.vid === d.vid
    : certificationSchema(origin.id, o).ok && o.vid === d.vid;
  if (!ok) return [finding('evidence_malformed', `origin:${origin.id}`, { generation: g, why: 'origin' })];
  return o.final_digest === d.final_digest ? [] : [finding('rollback_target_altered', `g${g}`, { generation: g })];
}

module.exports = {
  KINDS, CLASS_OF, MAX_OBJECTS, MAX_CERTIFICATIONS, PAIR_RAW_BUDGET, PAIR_ENCODED_BUDGET,
  activationSchema, certificationSchema, classifyActive, classifyAuditEntry, classifyRollbackOrigin, coverageOf, judgeRegistry, judgeRegistryChunk,
  registryFindings, addressable, pairBudget, createPairBudget,
  recomputeFinal, pairKey, finding,
};
