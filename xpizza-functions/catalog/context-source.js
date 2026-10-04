'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-a — THE CONTEXT SOURCE: the second projection of a pricing resolution.
//
// The pricing resolver finalizes prices exactly as today, then asks this module — SYNCHRONOUSLY — for
// the context of the version it SERVED. This module answers only from what it already holds:
//   • a context already built for the served (rid, versionId, CK) attaches on that same request;
//   • a miss reports `unavailable` for that request and starts (never awaits) a bounded, single-flight
//     background build (PLAN-D4a-ERRATA E2).
// 🔴 NOTHING HERE CAN ALTER A PRICE, an acceptance, a fallback choice, a latency bound or an alarm:
// `resolve` does no I/O and never throws, and the resolver additionally wraps it.
//
// 🔴 CACHES ARE KEYED (rid, versionId, CK), CK = (identityRevision, recordUpdateTime) (ERRATA E1), and
// are NEW — the pricing caches in catalog.js are untouched and never hold context. DISCOVERY is explicit
// and independent of them (plan step 6): the pricing reader's version cache never learns of an in-place
// bootstrap re-stamp (catalog.js:56-63, identity-bootstrap.js:423-438), so this module re-reads the
// served version's RECORD on its own TTL, CONTEXT_RECORD_TTL_MS (= the pricing pointer TTL, asserted by
// test), single-flight per (rid, versionId), bounded, MONOTONIC on CK: a late or slower result not
// strictly newer than what is already observed is discarded. When CK advances, entries under the older
// CK are unreachable by key AND explicitly evicted.
//
// 🔴 ATTACHMENT IS PROVENANCE, NOT RECENCY (plan step 5d). A context attaches only if its rid, versionId
// and seq equal what the PRICE route independently witnessed AND the prices re-derived from its rebuilt
// objects EXACTLY equal the served prices. Historical context for historical prices (a warm cache of A,
// last_good A) attaches; this module never consults the active pointer.
//
// 🔴 LIVENESS, STATED EXACTLY (PLAN-D4a-ERRATA E4, owner-approved option A). The background reads here
// are detached from the response, and on Cloud Functions a detached task gets NO CPU after its invocation
// ends — it resumes during a later one. So these caches progress DURING invocations: under continuous
// traffic within one TTL; after idle, within the first invocations once traffic resumes. NO wall-clock
// liveness is claimed for them. (The RTDB context node is written by the trigger and the reconciler in
// their OWN awaited invocations and keeps its bound: one interval + bounded execution when healthy.)
// 🔴 SAFETY UNDER SUSPENSION — holds whenever CPU resumes: every freshness stamp is the read's INITIATION
// time (conservative), never its completion; a completion whose now() − initiatedAt exceeds its deadline
// is DISCARDED as a timeout by an EXPLICIT comparison, even if its timer has not fired (a suspended timer
// fires late, so the timer alone cannot be trusted); nothing stale is reported fresh.
//
// Routes: live → built context; flat → `unavailable`; last_good → the in-memory built context for its
// version; mirror / mirror_cold → the persisted node at catalog_snapshot_ctx/{rid}, REBUILT from its raw
// payload and re-checked in the background loader, memoized in memory per exact node (plan step 7: no
// derived object is ever PERSISTED; codex build r1 F4: no rebuild on the request path).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { buildContext, identityPairs, deepFreeze } = require('./catalog-context');
const { makeCK, compareCK, ckString, ckOfFK, fkString } = require('./context-fk');
const { rawFromNode, contextRefOf, contentOf } = require('./context-writer');

const CONTEXT_RECORD_TTL_MS = 45000;      // == the pricing pointer TTL (catalog.js createCatalogReader default)
const CONTEXT_READ_DEADLINE_MS = 3000;    // each background context read
const CONTEXT_MAX_VERSIONS = 32;          // bounded built-context LRU
const DIAG_MS = 60000;                    // shadow diagnostics: at most one per (kind, rid, version) per minute
const ATTACH_STATS_MS = 10 * 60 * 1000;   // context_attach_stats: at most one emission per instance per 10 min (E4)

const vkey = (rid, versionId) => `${rid}::${versionId}`;
const bkey = (rid, versionId, ck) => `${rid}::${versionId}::${ckString(ck)}`;

function tableExactlyEqual(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!Number.isInteger(a[k]) || a[k] !== b[k]) return false;
  }
  return true;
}
const pricesExactlyEqual = (a, b) => !!a && !!b && tableExactlyEqual(a.menu, b.menu) && tableExactlyEqual(a.extras, b.extras);

function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const unavailable = (reason, extra = {}) => deepFreeze({ availability: 'unavailable', reason, attached: false, usableAsIdentity: false, ...extra });

// 🔴 SINGLE-FLIGHT, REGISTERED BEFORE ANY SDK CALL (codex build r1 F3). The work used to start inside an
// async IIFE whose promise was put in the map only AFTER the IIFE returned — so an SDK call that threw
// SYNCHRONOUSLY ran the catch and the cleanup `finally` first, and the already-settled promise was then
// inserted and never removed: that key was poisoned for the life of the instance. Here the entry is set
// first and the body starts on a later microtask, and cleanup removes the entry only if the map still
// holds THIS promise, so a stale cleanup can never delete a newer flight.
function singleFlight(map, key, body) {
  if (map.has(key)) return map.get(key);
  const p = (async () => {
    await null;                                   // the body (and every SDK call in it) runs after map.set
    try { return await body(); }
    finally { if (map.get(key) === p) map.delete(key); }
  })();
  map.set(key, p);
  return p;
}

function createContextSource({
  db, rtdb, verifier, now = Date.now, recordTtlMs = CONTEXT_RECORD_TTL_MS, readDeadlineMs = CONTEXT_READ_DEADLINE_MS,
  maxVersions = CONTEXT_MAX_VERSIONS, peekGates = null, buildContext: buildCtx = buildContext,
  log = (k, d) => { try { console.log(k, JSON.stringify(d)); } catch (_) {} },
} = {}) {
  const discovered = new Map();    // vkey -> { ck, at }            — discovery state, monotonic on CK
  const discFlights = new Map();   // vkey -> Promise
  const built = new Map();         // bkey -> context               — LRU, bounded
  const buildFlights = new Map();  // bkey -> Promise
  const persisted = new Map();     // rid -> { node, at, key, ctx } — the RTDB node + its memoized rebuild (mirror routes)
  const persistFlights = new Map();
  const lastDiag = new Map();
  const stats = { discoveryReads: 0, discoveryDiscarded: 0, builds: 0, evictions: 0, persistedReads: 0, mirrorRebuilds: 0, lateDiscards: 0 };
  // E4 observability: counts by availability|reason|route since the last emission. Diagnostic only.
  let attachCounts = new Map();
  let attachSince = now();
  // A completion is admissible only if it landed within its deadline of its INITIATION (E4). Checked
  // explicitly: under suspension a completion can arrive long after the deadline with its timer unfired.
  const lateBy = (initiatedAt) => now() - initiatedAt > readDeadlineMs;

  // ── Discovery: the served version's record, on its own TTL ──────────────────────────────────────
  // `initiatedAt` is when the read that produced `ck` STARTED (E4): the freshness stamp never claims a
  // moment later than the one the data is known to be from.
  function applyDiscovery(rid, versionId, ck, initiatedAt) {
    const k = vkey(rid, versionId);
    const cur = discovered.get(k);
    if (cur && compareCK(ck, cur.ck) < 0) { stats.discoveryDiscarded += 1; return false; }   // older → discarded
    if (cur && compareCK(ck, cur.ck) === 0) { cur.at = Math.max(cur.at, initiatedAt); return false; }   // same → refresh, never backwards
    discovered.set(k, { ck, at: initiatedAt });
    if (cur) {                                                                                  // advanced → evict older CK entries
      const prefix = `${k}::`;
      for (const key of [...built.keys()]) {
        if (key.startsWith(prefix) && key !== bkey(rid, versionId, ck)) { built.delete(key); stats.evictions += 1; }
      }
    }
    return true;
  }

  function discover(rid, versionId) {
    const k = vkey(rid, versionId);
    if (discFlights.has(k)) return discFlights.get(k);
    stats.discoveryReads += 1;
    const initiatedAt = now();
    return singleFlight(discFlights, k, async () => {
      try {
        const read = db.collection('restaurants').doc(rid).collection('versions').doc(versionId).get();
        read.catch(() => {});
        const snap = await withDeadline(read, readDeadlineMs, 'context_record_read');
        if (lateBy(initiatedAt)) { stats.lateDiscards += 1; return null; }   // a late completion is a timeout (E4)
        if (!snap.exists) return null;
        const ck = makeCK({ record: snap.data() || {}, updateTime: snap.updateTime });
        if (ck) applyDiscovery(rid, versionId, ck, initiatedAt);
        return ck;
      } catch (e) {
        log('context_discovery_failed', { rid, versionId, error: String((e && e.message) || e).slice(0, 160) });
        return null;
      }
    });
  }

  // ── Build: one consistent read of the version (read-only transaction) → the pure builder ────────
  function build(rid, versionId) {
    const k = vkey(rid, versionId);
    if (buildFlights.has(k)) return buildFlights.get(k);
    stats.builds += 1;
    const observedAt = now();
    return singleFlight(buildFlights, k, async () => {
      try {
        const vref = db.collection('restaurants').doc(rid).collection('versions').doc(versionId);
        const read = db.runTransaction(async (tx) => {
          const recSnap = await tx.get(vref);
          if (!recSnap.exists) return null;
          const [items, extras, st] = await Promise.all([
            tx.get(vref.collection('menu_items')), tx.get(vref.collection('extras')), tx.get(vref.collection('meta').doc('menu_structure')),
          ]);
          const rows = (qs) => qs.docs.map((d) => ({ id: d.id, data: d.data() }));
          return { record: recSnap.data() || {}, updateTime: recSnap.updateTime, items: rows(items), extras: rows(extras), structure: st.exists ? (st.data() || null) : null };
        }, { readOnly: true });
        read.catch(() => {});
        const r = await withDeadline(read, readDeadlineMs, 'context_payload_read');
        if (lateBy(observedAt)) { stats.lateDiscards += 1; return null; }   // a late completion is a timeout (E4)
        if (!r) return null;
        const ck = makeCK({ record: r.record, updateTime: r.updateTime });
        if (!ck) return null;
        const ctx = buildCtx({ rid, versionId, record: r.record, items: r.items, extras: r.extras, structure: r.structure });
        const stored = deepFreeze({ ...ctx, ck, observedAt });      // deep-frozen BEFORE it is cached (F1)
        // The payload IS a record observation too: discovery advances (monotonically) from it.
        applyDiscovery(rid, versionId, ck, observedAt);
        const cur = discovered.get(k);
        if (cur && compareCK(cur.ck, ck) === 0) {
          built.set(bkey(rid, versionId, ck), stored);
          while (built.size > maxVersions) { built.delete(built.keys().next().value); stats.evictions += 1; }
        }
        return stored;
      } catch (e) {
        log('context_build_failed', { rid, versionId, error: String((e && e.message) || e).slice(0, 160) });
        return null;
      }
    });
  }

  // ── The persisted node, for the mirror routes ───────────────────────────────────────────────────
  // 🔴 REBUILT HERE, IN THE BACKGROUND, NEVER IN resolve() (codex build r1 F4). Rebuilding — JSON parse,
  // buildMenu, content_hash, policy — on every mirror-route request put unbounded synchronous work on the
  // pricing response. The rebuild is still FROM RAW and still re-checks the pinned hash (plan step 7: no
  // DERIVED object is ever PERSISTED); it is memoized IN MEMORY per exact persisted node (its FK plus a
  // digest of its full canonical content), so an unchanged node is rebuilt once and a node whose payload
  // changed under the same FK is rebuilt and re-judged. resolve() then does lookups + attachment only.
  function loadPersisted(rid) {
    if (persistFlights.has(rid)) return persistFlights.get(rid);
    stats.persistedReads += 1;
    const at = now();                                 // the INITIATION stamp (E4), never the completion
    return singleFlight(persistFlights, rid, async () => {
      try {
        const read = contextRefOf(rtdb, rid).get();
        read.catch(() => {});
        const snap = await withDeadline(read, readDeadlineMs, 'context_node_read');
        if (lateBy(at)) { stats.lateDiscards += 1; return null; }          // a late completion is a timeout (E4)
        const node = snap && typeof snap.val === 'function' ? snap.val() : null;
        let key = null, ctx = null;
        if (node && node.head) {
          key = `${fkString(node.head.fk)}#${crypto.createHash('sha256').update(contentOf(node)).digest('hex')}`;
          const prev = persisted.get(rid);
          if (prev && prev.key === key && prev.ctx) ctx = prev.ctx;
          else {
            stats.mirrorRebuilds += 1;
            ctx = deepFreeze({ ...buildCtx(rawFromNode(node)), ck: ckOfFK(node.head.fk), observedAt: at });
          }
        }
        persisted.set(rid, { node, at, key, ctx });
        return node;
      } catch (e) {
        log('context_node_read_failed', { rid, error: String((e && e.message) || e).slice(0, 160) });
        return null;
      }
    });
  }

  // ── Shadow diagnostics (plan step 10): bounded, rate-limited, nothing else ──────────────────────
  function diag(kind, rid, versionId, detail) {
    const key = `${kind}::${rid}::${versionId}`;
    const t = now();
    if (lastDiag.has(key) && t - lastDiag.get(key) < DIAG_MS) return;
    lastDiag.set(key, t);
    if (lastDiag.size > 256) lastDiag.delete(lastDiag.keys().next().value);
    log(kind, { rid, versionId, ...detail });
  }
  function shadow(rid, versionId, ctx, eligibility) {
    if (ctx.contentIntegrity && ctx.contentIntegrity.state === 'mismatch') {
      diag('context_integrity_mismatch', rid, versionId, { reason: ctx.contentIntegrity.reason || null, detail: ctx.contentIntegrity.detail || null });
    }
    if (eligibility.state === 'rejected') {
      diag('context_eligibility_rejected', rid, versionId, { rejections: eligibility.rejections.slice(0, 10) });
    }
    // Policy vs a gate-reader result ALREADY cached for the same (rid, versionId). Never triggers a read.
    if (typeof peekGates === 'function' && Array.isArray(ctx.objects)) {
      let gates = null;
      try { gates = peekGates(rid, versionId); } catch (_) { gates = null; }
      // PER RULE, never one shared early-out: a gate the store did not author is the static fallback and
      // says nothing about the catalog, but it must not silence the OTHER rules (menu-gates.js:112-116 —
      // la_musa authors no weekend gate, and a shared `fallback` check skipped its redeem rule entirely).
      if (gates) {
        const fromCtx = (rule) => {
          const s = new Set();
          for (const o of ctx.objects) if (o.policy[rule] === true) s.add(o.legacyKey);
          return s;
        };
        const diffs = [];
        const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
        if (!gates.fallback && gates.weekend instanceof Set && !same(fromCtx('weekend_only'), gates.weekend)) diffs.push('weekend_only');
        if (gates.pickup instanceof Set && !same(fromCtx('pickup_only'), gates.pickup)) diffs.push('pickup_only');
        if (gates.redeem && gates.redeem.allow instanceof Set && !same(fromCtx('redeem_eligible'), gates.redeem.allow)) diffs.push('redeem_eligible');
        if (diffs.length) diag('context_policy_diff', rid, versionId, { rules: diffs });
      }
    }
  }

  // ── Attachment + the frozen projection ──────────────────────────────────────────────────────────
  function project(ctx, served, route) {
    if (!ctx.built) {
      return unavailable('integrity_unbuildable', { route, rid: served.rid, versionId: served.versionId, contentIntegrity: ctx.contentIntegrity });
    }
    if (ctx.rid !== served.rid || ctx.versionId !== served.versionId || ctx.seq !== served.seq) {
      return unavailable('provenance_mismatch', { route, servedVersionId: served.versionId, servedSeq: served.seq, contextVersionId: ctx.versionId, contextSeq: ctx.seq });
    }
    if (!pricesExactlyEqual(ctx.prices, served.prices)) {
      return unavailable('price_mismatch', { route, versionId: served.versionId, seq: served.seq });
    }
    const eligibility = verifier ? verifier.eligibilityFor(served.rid, identityPairs(ctx)) : { state: 'unknown', reason: 'no_verifier' };
    try { shadow(served.rid, served.versionId, ctx, eligibility); } catch (_) {}
    const unexpired = eligibility.state === 'confirmed' && now() <= eligibility.expiresAt;
    const usableAsIdentity = ctx.contentIntegrity.state === 'intact' && unexpired && ctx.complete === true;
    return deepFreeze({                          // deep-frozen: nothing a caller holds can be mutated (F1)
      availability: 'available', attached: true, route,
      rid: ctx.rid, versionId: ctx.versionId, seq: ctx.seq, ck: ctx.ck || null,
      contentIntegrity: { ...ctx.contentIntegrity, observedAt: ctx.observedAt },
      registryEligibility: eligibility,
      certified: ctx.certified, complete: ctx.complete, coverage: ctx.coverage, rawStampCoverage: ctx.rawStampCoverage,
      labels: ctx.labels, ids: ctx.ids, policyRules: ctx.policyRules, objects: ctx.objects,
      usableAsIdentity,
    });
  }

  // E4 observability: count every projection; emit at most once per ATTACH_STATS_MS per instance. The
  // emission is a single synchronous log line — no I/O, nothing reads it.
  function countAttach(c) {
    try {
      const key = `${c.availability}|${c.reason || '-'}|${c.route || '-'}`;
      attachCounts.set(key, (attachCounts.get(key) || 0) + 1);
      const t = now();
      if (t - attachSince >= ATTACH_STATS_MS) {
        const counts = {};
        for (const [k, v] of attachCounts) counts[k] = v;
        log('context_attach_stats', { since: attachSince, until: t, counts });
        attachCounts = new Map(); attachSince = t;
      }
    } catch (_) { /* diagnostics must never break anything */ }
    return c;
  }

  // resolve(served) — SYNCHRONOUS, NEVER THROWS. served = { rid, versionId, seq, source, prices }.
  function resolve(served) { return countAttach(resolveInner(served)); }
  function resolveInner(served) {
    try {
      const { rid, versionId, source } = served || {};
      if (!rid) return unavailable('no_restaurant');
      if (source === 'mirror' || source === 'mirror_cold') {
        const p = persisted.get(rid);
        if (!p || now() - p.at >= recordTtlMs) void loadPersisted(rid);
        if (!p || !p.ctx) return unavailable('context_not_persisted', { route: source });
        return project(p.ctx, served, source);   // the memoized raw rebuild (F4): no parse/hash/build here
      }
      if (versionId == null) return unavailable('flat', { route: source || 'live' });
      const k = vkey(rid, versionId);
      const d = discovered.get(k);
      if (!d || now() - d.at >= recordTtlMs) void discover(rid, versionId);
      if (!d) { void build(rid, versionId); return unavailable('not_discovered', { route: source || 'live' }); }
      const ctx = built.get(bkey(rid, versionId, d.ck));
      if (!ctx) { void build(rid, versionId); return unavailable('not_built', { route: source || 'live' }); }
      built.delete(bkey(rid, versionId, d.ck)); built.set(bkey(rid, versionId, d.ck), ctx);   // LRU touch
      return project(ctx, served, source || 'live');
    } catch (e) {
      return unavailable('context_exception', { error: String((e && e.message) || e).slice(0, 160) });
    }
  }

  return {
    resolve, discover, build, loadPersisted, stats,
    _state: { discovered, built, persisted, discFlights, buildFlights },
  };
}

module.exports = { createContextSource, pricesExactlyEqual, CONTEXT_RECORD_TTL_MS, CONTEXT_READ_DEADLINE_MS, CONTEXT_MAX_VERSIONS };
