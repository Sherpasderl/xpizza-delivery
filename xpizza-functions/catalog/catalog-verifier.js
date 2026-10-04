'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-a — THE CATALOG REGISTRY VERIFIER (plan rev 9 step 5b + "Verifier").
//
// Answers ONE question per request: do this version's stamped identities agree with the identity
// registry, in BOTH directions, right now (as of an unexpired observation)? → registryEligibility
// ∈ { confirmed, rejected (naming each object), unknown }.
//
// 🔴 EVIDENCE IS CACHED, VERDICTS ARE NOT. The cache holds only REGISTRY OBSERVATIONS — the raw
// `ids/*` and `keys/*` rows of one coherent read, with that read's observedAt — keyed by the exact
// sorted READ SET (the doc paths). Every request recomputes its verdict by comparing ITS OWN rebuilt
// (kind, canonicalId, legacyKey) pairs against those rows. So no `confirmed` can be reused by a
// different identity map: a stamp SWAP inside the same read set changes the pairs, not the rows, and
// fails the per-object comparison. content_hash excludes stamps (content-hash.js:32-35), so this
// comparison — not the hash — is what binds stamps. (Codex r5 F1: a verdict keyed on version metadata
// was reusable across a swap; that is the bug this shape makes unrepresentable.)
//
// 🔴 COHERENT. All rows for one read set come from ONE read-only Firestore transaction (getAll), so a
// retirement racing the read lands entirely before or entirely after it, never half-way.
//
// 🔴 `live` EXACTLY. Not "not retired" (cf. the forward resolver, identity-registry.js:366-369, which
// accepts any non-retired row because it serves grace, not proof).
//
// 🔴 STALENESS IS BOUNDED BY THE OBSERVATION TTL, MEASURED FROM THE READ'S START (the
// identity-registry.js:284-294 rule). A registry change after an observation is seen only once that
// observation expires and is re-read; caching never restarts the clock. That bound is the owner's
// stated model; how enforcement treats it is D4-f's decision.
//
// 🔴 OFF THE PRICE PATH. `eligibilityFor` is synchronous and reads only the cache; a miss returns
// `unknown` and starts (never awaits) a bounded, single-flight read.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { encodeKey, validIdShape, KINDS, STATUS_LIVE, STATUS_RETIRED } = require('./identity-registry');

const OBSERVATION_TTL_MS = 60000;        // bounded staleness of a confirmation (the forward resolver's TTL)
const VERIFIER_TIMEOUT_MS = 3000;        // one coherent catalog-sized read; late completions are discarded
const VERIFIER_MAX_INFLIGHT = 4;         // global cap on concurrent coherent reads per instance
const VERIFIER_MAX_CACHE = 32;           // bounded observation cache (LRU)
const VERIFIER_MAX_PAIRS = 400;          // a catalog-sized batch (58 objects today); beyond this → unknown

const otherKind = (k) => (k === 'dish' ? 'extra' : 'dish');
const idPath = (rid, kind, id) => `restaurants/${rid}/identity/${kind}/ids/${id}`;
const keyPath = (rid, kind, legacyKey) => `restaurants/${rid}/identity/${kind}/keys/${encodeKey(legacyKey)}`;

// The exact set of documents a set of pairs needs: the id row in its own kind, the id row in the OTHER
// kind (so a foreign-kind id is NAMED rather than reported as merely missing), and the key row.
function readSetOf(rid, pairs) {
  const paths = new Set();
  for (const p of pairs) {
    paths.add(idPath(rid, p.kind, p.canonicalId));
    paths.add(idPath(rid, otherKind(p.kind), p.canonicalId));
    paths.add(keyPath(rid, p.kind, p.legacyKey));
  }
  return [...paths].sort();
}
const readSetKey = (paths) => crypto.createHash('sha256').update(JSON.stringify(paths)).digest('hex');

// ── The per-request comparison (PURE) ───────────────────────────────────────────────────────────
// Every pair must be: id row present in its own kind, status === 'live', same kind, id→legacy_key ==
// the object's legacy key, and key row present with key→canonical_id == the object's id.
function judgePair(rid, p, rows) {
  const name = { kind: p.kind, legacyKey: p.legacyKey, canonicalId: p.canonicalId };
  const idRow = rows[idPath(rid, p.kind, p.canonicalId)];
  if (!idRow) {
    if (rows[idPath(rid, otherKind(p.kind), p.canonicalId)]) return { ...name, reason: 'foreign_kind' };
    return { ...name, reason: 'missing_id_row' };
  }
  if (idRow.kind !== undefined && idRow.kind !== p.kind) return { ...name, reason: 'foreign_kind' };
  if (idRow.status === STATUS_RETIRED) return { ...name, reason: 'retired' };
  if (idRow.status !== STATUS_LIVE) return { ...name, reason: 'not_live', status: idRow.status === undefined ? null : idRow.status };
  if (idRow.legacy_key !== p.legacyKey) return { ...name, reason: 'id_names_other_key', registry: idRow.legacy_key === undefined ? null : idRow.legacy_key };
  const keyRow = rows[keyPath(rid, p.kind, p.legacyKey)];
  if (!keyRow) return { ...name, reason: 'missing_key_row' };
  if (keyRow.kind !== undefined && keyRow.kind !== p.kind) return { ...name, reason: 'foreign_kind' };
  if (keyRow.canonical_id !== p.canonicalId) return { ...name, reason: 'key_names_other_id', registry: keyRow.canonical_id === undefined ? null : keyRow.canonical_id };
  return null;
}

function evaluate(rid, pairs, observation, ttlMs = OBSERVATION_TTL_MS) {
  const rejections = [];
  for (const p of pairs) { const r = judgePair(rid, p, observation.rows); if (r) rejections.push(r); }
  const base = { observedAt: observation.observedAt, expiresAt: observation.observedAt + ttlMs };
  return rejections.length ? { state: 'rejected', ...base, rejections } : { state: 'confirmed', ...base };
}

function createCatalogVerifier({
  db, now = Date.now, ttlMs = OBSERVATION_TTL_MS, timeoutMs = VERIFIER_TIMEOUT_MS,
  maxInflight = VERIFIER_MAX_INFLIGHT, maxCache = VERIFIER_MAX_CACHE, maxPairs = VERIFIER_MAX_PAIRS,
  log = (k, d) => { try { console.log(k, JSON.stringify(d)); } catch (_) {} },
} = {}) {
  const cache = new Map();      // readSetKey -> { rows, observedAt }
  const inflight = new Map();   // readSetKey -> Promise
  const stats = { reads: 0, discardedLate: 0, timeouts: 0, failures: 0, capped: 0 };

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (now() - hit.observedAt > ttlMs) { cache.delete(key); return null; }   // expired → dropped, never served
    cache.delete(key); cache.set(key, hit);                                     // LRU touch
    return hit;
  }
  function cacheSet(key, obs) {
    cache.set(key, obs);
    while (cache.size > maxCache) cache.delete(cache.keys().next().value);
  }

  // ONE coherent read of every document in the read set. Never rejects: resolves to the observation, or
  // null (timeout / failure / capacity). A completion after the deadline is DISCARDED — not cached.
  function observe(rid, paths) {
    const key = readSetKey(paths);
    if (inflight.has(key)) return inflight.get(key);                 // single-flight BY READ SET
    if (inflight.size >= maxInflight) { stats.capped += 1; return Promise.resolve(null); }
    const startedAt = now();                                         // observedAt = the read's START
    let settled = false;
    let timer = null;
    // 🔴 REGISTERED BEFORE ANY SDK CALL (codex build r1 F3): the body starts on a later microtask, after
    // inflight.set below, so a synchronous SDK throw can no longer settle-and-clean-up BEFORE the entry is
    // inserted — which left a dead promise in the map for good, and four of them exhausted maxInflight.
    const p = (async () => {
      await null;
      try {
        const refs = paths.map((path) => db.doc(path));
        stats.reads += 1;
        const read = db.runTransaction(async (tx) => tx.getAll(...refs), { readOnly: true });
        read.catch(() => {});
        const snaps = await Promise.race([
          read,
          new Promise((resolve) => { timer = setTimeout(() => resolve('__timeout__'), timeoutMs); }),
        ]);
        if (snaps === '__timeout__') {
          settled = true; stats.timeouts += 1;
          read.then(() => { stats.discardedLate += 1; }, () => {});
          return null;
        }
        /* 🔴 THE EXPLICIT LATENESS CHECK (PLAN-D4a-ERRATA E4). On Cloud Functions a detached read gets no
           CPU after its invocation ends; it can complete in a LATER invocation with its timer not yet run.
           Such a completion is a timeout whatever the timer says, so it is discarded — never cached, never
           the basis of a `confirmed`. observedAt stays the read's START either way. */
        if (now() - startedAt > timeoutMs) {
          settled = true; stats.timeouts += 1; stats.discardedLate += 1;
          return null;
        }
        const rows = {};
        snaps.forEach((s, i) => { rows[paths[i]] = s && s.exists ? (s.data() || {}) : null; });
        const obs = { rows, observedAt: startedAt };
        if (!settled) cacheSet(key, obs);
        return obs;
      } catch (e) {
        stats.failures += 1;
        log('context_verifier_read_failed', { rid, error: String((e && e.message) || e).slice(0, 160) });
        return null;
      } finally {
        settled = true;
        if (timer) clearTimeout(timer);
        if (inflight.get(key) === p) inflight.delete(key);   // only OUR entry
      }
    })();
    inflight.set(key, p);
    return p;
  }

  function pairsUsable(pairs) {
    if (!Array.isArray(pairs) || pairs.length === 0) return 'no_identity_pairs';
    if (pairs.length > maxPairs) return 'batch_too_large';
    for (const p of pairs) {
      if (!p || !KINDS.includes(p.kind) || !validIdShape(p.canonicalId)
        || typeof p.legacyKey !== 'string' || !p.legacyKey) return 'malformed_pair';
    }
    return null;
  }

  // SYNCHRONOUS: the verdict for THESE pairs from a cached, unexpired observation; otherwise `unknown`
  // and (unless told not to) a background read is started. Never awaited by the price path.
  function eligibilityFor(rid, pairs, { startRead = true } = {}) {
    const bad = pairsUsable(pairs);
    if (bad) return { state: 'unknown', reason: bad };
    const paths = readSetOf(rid, pairs);
    const obs = cacheGet(readSetKey(paths));
    if (obs) return evaluate(rid, pairs, obs, ttlMs);
    if (startRead) void observe(rid, paths);
    return { state: 'unknown', reason: 'not_observed' };
  }

  // AWAITABLE form (background tasks, tools, tests): ensure an observation, then evaluate.
  async function verify(rid, pairs) {
    const bad = pairsUsable(pairs);
    if (bad) return { state: 'unknown', reason: bad };
    const paths = readSetOf(rid, pairs);
    const obs = cacheGet(readSetKey(paths)) || await observe(rid, paths);
    if (!obs) return { state: 'unknown', reason: 'unreachable' };
    if (now() - obs.observedAt > ttlMs) return { state: 'unknown', reason: 'expired' };
    return evaluate(rid, pairs, obs, ttlMs);
  }

  return { eligibilityFor, verify, _cache: cache, _inflight: inflight, stats };
}

module.exports = {
  createCatalogVerifier, evaluate, judgePair, readSetOf, readSetKey,
  OBSERVATION_TTL_MS, VERIFIER_TIMEOUT_MS, VERIFIER_MAX_INFLIGHT, VERIFIER_MAX_CACHE, VERIFIER_MAX_PAIRS,
  idPath, keyPath,
};
