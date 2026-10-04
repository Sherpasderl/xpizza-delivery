'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-a — THE CONTEXT WRITER, decoupled from publish (plan rev 9 step 8, owner option B).
//
// Writes the resolved catalog context's AUTHENTICATED RAW PAYLOAD for a restaurant's CURRENT activation
// to RTDB `catalog_snapshot_ctx/{rid}` — and nothing else, anywhere.
//
// 🔴 NOT IN THE PUBLISH PATH. catalog-publish.js is not modified by D4-a (a byte-compare test pins
// it): publishVersion / rollbackVersion / flipPointer / writeMirror / the lease / the D1 pass / every
// return field and deadline are today's BY CONSTRUCTION. Two invokers call this instead:
//   • an RTDB trigger on `/catalog_snapshot/{rid}` — a WAKE-UP only; it never trusts the event's
//     payload, because this function reads the authoritative pointer itself;
//   • a scheduled reconciler — repairs a missed trigger, a failed legacy mirror write, an in-place
//     bootstrap re-stamp, and an old-executable certification, with no operator step.
//
// 🔴 ONE CONSISTENT SNAPSHOT. The pointer, the version record and the payload are read inside ONE
// read-only Firestore transaction — the pointer read is never outside it — so what is written is one
// activation's state, never a pointer from one moment and a payload from another.
//
// 🔴 THE FENCE (FK, context-fk.js): (activationGeneration, identityRevision, recordUpdateTime).
//   strictly greater → replace · equal + identical content (excl. `at`) → idempotent ·
//   equal + different content → refused · smaller → superseded · absent/malformed stored → minimum.
// Guarantee, stated exactly: the path's FK never regresses relative to COMMITTED context writes. A
// write is `superseded` only once a higher FK has actually COMMITTED here; an activation that exists in
// Firestore but whose context has not committed supersedes nothing — an older write may still commit,
// and that is harmless because attachment is by provenance match to the SERVED prices, never recency.
// No cross-store supersession is claimed.
//
// 🔴 BOUNDED, BOTH WAYS (the D1 precedent, catalog-publish.js:1577-1581): the RETURNED promise is
// settled by a timer race even if an operation never settles, AND `shouldStop` is checked before every
// further read/write. On timeout the single-flight entry and the reconciler slot are released and the
// outcome is `timeout`. An RTDB transaction already issued may still land later: harmless, because it
// is fenced and can only commit a context that was correct at its own read snapshot.
//
// Outcomes: committed | idempotent | superseded | refused | failed | timeout — logged as the bounded
// structured diagnostic `context_write`, never surfaced in any publish/rollback result, never alarmed.
// ---------------------------------------------------------------------------
const { activePointerRef, readPointerSnap } = require('./catalog-firestore');
const { canonicalJson } = require('./canonical-json');
const { buildContext } = require('./catalog-context');
const { makeFK, normalizeFK, compareFK, fkString } = require('./context-fk');
const { sanitize } = require('./restaurant-registry');

const CONTEXT_PATH = 'catalog_snapshot_ctx';
const CONTEXT_WRITER_DEADLINE_MS = 20000;
const CONTEXT_RECONCILE_CONCURRENCY = 4;
const CONTEXT_RECONCILE_INTERVAL = 'every 5 minutes';
const CONTEXT_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const CONTEXT_RECONCILE_TIMEOUT_S = 240;          // function timeout, BELOW the interval
const CONTEXT_LIST_DEADLINE_MS = 10000;
const OUTCOMES = Object.freeze(['committed', 'idempotent', 'superseded', 'refused', 'failed', 'timeout']);

const contextRefOf = (rtdb, rid) => rtdb.ref(`${CONTEXT_PATH}/${rid}`);
const versionRefOf = (db, rid, versionId) => db.collection('restaurants').doc(rid).collection('versions').doc(versionId);

class Abandoned extends Error { constructor() { super('context_write_abandoned'); this.abandoned = true; } }

// The record fields the context needs, and ONLY those: persisting the whole record would persist fields
// (activation timestamps) that are not part of the context and are not JSON-exact.
const RECORD_FIELDS = ['version', 'seq', 'schema_version', 'content_hash', 'identity_certified', 'identity_revision'];
function recordSubset(record) {
  const out = {};
  for (const f of RECORD_FIELDS) if (record && record[f] !== undefined) out[f] = record[f];
  return out;
}
const rowsOf = (qs) => (qs && qs.docs ? qs.docs : []).map((d) => ({ id: d.id, data: d.data() }))
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// The ONE persisted representation (plan step 7): raw payload + pinned hash + a small HEAD. The payload
// is canonical JSON in a STRING so RTDB cannot reshape it — RTDB drops nulls and empty containers and
// rejects some key characters, and a reshaped payload would fail its own hash check on every serve.
function persistedNode({ rid, versionId, record, items, extras, structure, fk }) {
  const payload = canonicalJson({ record: recordSubset(record), items, extras, structure: structure === undefined ? null : structure });
  return {
    head: { rid, versionId, seq: Number.isInteger(record.seq) ? record.seq : null, certified: record.identity_certified === true, fk },
    content_hash: record.content_hash,
    payload,
  };
}
// Canonical content for the equal-FK comparison: everything except the volatile `at`.
const contentOf = (node) => canonicalJson({ head: node && node.head, content_hash: node && node.content_hash, payload: node && node.payload });

// The raw payload back out of a persisted node, for the builder. null if the node is unusable.
function rawFromNode(node) {
  if (!node || typeof node !== 'object' || !node.head || typeof node.payload !== 'string') return null;
  let p;
  try { p = JSON.parse(node.payload); } catch (_) { return null; }
  if (!p || typeof p !== 'object' || !p.record) return null;
  return { rid: node.head.rid, versionId: node.head.versionId, record: p.record, items: p.items, extras: p.extras, structure: p.structure };
}

function createContextWriter({
  db, rtdb, now = Date.now, deadlineMs = CONTEXT_WRITER_DEADLINE_MS,
  log = (k, d) => { try { console.log(k, JSON.stringify(d)); } catch (_) {} },
} = {}) {
  const flights = new Map();   // rid -> Promise<result>   (per-restaurant single-flight, this instance)
  const stats = { precheckSkips: 0, fullReads: 0, rtdbTransactions: 0 };

  const report = (rid, outcome, extra = {}) => {
    const r = { rid, outcome, ...extra };
    log('context_write', r);
    return r;
  };

  // ── The pre-check: head-sized, non-transactional. Equal FK + same version → nothing to do. ──────
  async function precheck(rid, stop) {
    const ptr = readPointerSnap(await activePointerRef(db, rid).get(), rid);
    stop();
    if (ptr.version === null) return { skip: false };
    const recSnap = await versionRefOf(db, rid, ptr.version).get();
    stop();
    if (!recSnap.exists) return { skip: false };
    const fk = makeFK({ generation: ptr.generation, record: recSnap.data() || {}, updateTime: recSnap.updateTime });
    const headSnap = await contextRefOf(rtdb, rid).child('head').get();
    stop();
    const head = headSnap && typeof headSnap.val === 'function' ? headSnap.val() : null;
    if (fk && head && head.versionId === ptr.version && compareFK(head.fk, fk) === 0) {
      return { skip: true, fk, versionId: ptr.version };
    }
    return { skip: false };
  }

  // ── The full write: one read-only Firestore transaction, then the fenced RTDB transaction. ─────
  async function fullWrite(rid, stop) {
    stats.fullReads += 1;
    const snap = await db.runTransaction(async (tx) => {
      const ptr = readPointerSnap(await tx.get(activePointerRef(db, rid)), rid);   // INSIDE the transaction
      stop();
      if (ptr.version === null) return { ptr };
      const vref = versionRefOf(db, rid, ptr.version);
      const recSnap = await tx.get(vref);
      stop();
      if (!recSnap.exists) return { ptr, missing: true };
      const [items, extras, structureSnap] = await Promise.all([
        tx.get(vref.collection('menu_items')), tx.get(vref.collection('extras')), tx.get(vref.collection('meta').doc('menu_structure')),
      ]);
      stop();
      return {
        ptr, record: recSnap.data() || {}, updateTime: recSnap.updateTime,
        items: rowsOf(items), extras: rowsOf(extras), structure: structureSnap.exists ? (structureSnap.data() || null) : null,
      };
    }, { readOnly: true });

    if (snap.ptr.version === null) return report(rid, 'refused', { reason: 'no_active_version' });
    if (snap.missing) return report(rid, 'refused', { reason: 'active_version_missing', versionId: snap.ptr.version });
    const versionId = snap.ptr.version;
    const fk = makeFK({ generation: snap.ptr.generation, record: snap.record, updateTime: snap.updateTime });
    if (!fk) return report(rid, 'failed', { reason: 'record_time_unrepresentable', versionId });

    // (3) Recompute content_hash over exactly what will be persisted, AS it will be read back.
    const node = persistedNode({ rid, versionId, record: snap.record, items: snap.items, extras: snap.extras, structure: snap.structure, fk });
    const ctx = buildContext(rawFromNode(node));
    if (!ctx.contentIntegrity || ctx.contentIntegrity.state !== 'intact') {
      return report(rid, 'refused', { reason: 'content_integrity', integrity: ctx.contentIntegrity && ctx.contentIntegrity.state, detail: ctx.contentIntegrity && (ctx.contentIntegrity.reason || null), versionId, fk: fkString(fk) });
    }

    // (4) The fenced RTDB transaction — the ONLY write, and only to the context path.
    stop();
    let decision = null;
    const wanted = contentOf(node);
    stats.rtdbTransactions += 1;
    const res = await contextRefOf(rtdb, rid).transaction((current) => {
      if (stop.stopped()) { decision = 'timeout'; return undefined; }            // abort: commit nothing
      const curFK = normalizeFK(current && current.head && current.head.fk);
      const cmp = compareFK(fk, curFK);
      if (cmp > 0) { decision = 'committed'; return { ...node, at: now() }; }       // absent/malformed head = MIN
      if (cmp < 0) { decision = 'superseded'; return undefined; }
      decision = contentOf(current) === wanted ? 'idempotent' : 'refused';
      return undefined;
    }, undefined, false);
    if (decision === 'committed' && !(res && res.committed)) decision = 'failed';
    const extra = { versionId, seq: node.head.seq, fk: fkString(fk) };
    if (decision === 'refused') extra.reason = 'equal_fk_different_content';
    return report(rid, decision || 'failed', extra);
  }

  // writeActiveContext(rid) → { rid, outcome, ... }. Never rejects; bounded by deadlineMs.
  function writeActiveContext(rid) {
    if (flights.has(rid)) return flights.get(rid);
    let expired = false;
    const stop = () => { if (expired) throw new Abandoned(); };
    stop.stopped = () => expired;
    // Started on a later microtask so the single-flight entry below is registered before any SDK call
    // (codex build r1 F3 — the same register-first discipline as the context source and the verifier).
    const work = (async () => {
      await null;
      try {
        const pre = await precheck(rid, stop);
        if (pre.skip) { stats.precheckSkips += 1; return report(rid, 'idempotent', { precheck: true, versionId: pre.versionId, fk: fkString(pre.fk) }); }
        return await fullWrite(rid, stop);
      } catch (e) {
        if (e && e.abandoned) return { rid, outcome: 'timeout', late: true };
        return report(rid, 'failed', { error: String((e && e.message) || e).slice(0, 200) });
      }
    })();
    let timer = null;
    const bounded = Promise.race([
      work,
      new Promise((resolve) => { timer = setTimeout(() => { expired = true; resolve(report(rid, 'timeout', { deadlineMs })); }, deadlineMs); }),
    ]).finally(() => { if (timer) clearTimeout(timer); if (flights.get(rid) === bounded) flights.delete(rid); });
    flights.set(rid, bounded);
    return bounded;
  }

  // ── The reconciler: brand-agnostic enumeration, bounded parallelism, failure isolation. ──────────
  // Overlap with another invocation is PERMITTED (scheduled functions can overlap; maxInstances is not
  // mutual exclusion). Correctness under overlap is the fence + idempotence, not exclusion.
  async function reconcile({ listIds, concurrency = CONTEXT_RECONCILE_CONCURRENCY, listDeadlineMs = CONTEXT_LIST_DEADLINE_MS } = {}) {
    let ids;
    let timer = null;
    try {
      const p = Promise.resolve(listIds());
      p.catch(() => {});
      ids = sanitize(await Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('context_reconcile_list_timeout')), listDeadlineMs); })]));
    } catch (e) {
      log('context_reconcile', { ok: false, error: String((e && e.message) || e).slice(0, 160) });
      return { ok: false, results: [] };
    } finally { if (timer) clearTimeout(timer); }
    const results = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const rid = ids[cursor++];
        results.push(await writeActiveContext(rid));   // never rejects; bounded → the slot is released at the deadline
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
    const counts = {};
    for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
    log('context_reconcile', { ok: true, restaurants: ids.length, counts });
    return { ok: true, results };
  }

  return { writeActiveContext, reconcile, stats, _flights: flights };
}

module.exports = {
  createContextWriter, persistedNode, rawFromNode, contentOf, recordSubset, contextRefOf,
  CONTEXT_PATH, CONTEXT_WRITER_DEADLINE_MS, CONTEXT_RECONCILE_CONCURRENCY, CONTEXT_RECONCILE_INTERVAL,
  CONTEXT_RECONCILE_INTERVAL_MS, CONTEXT_RECONCILE_TIMEOUT_S, OUTCOMES,
};
