'use strict';
/* 1D D4-c2b — THE IDENTITY INTEGRITY MONITOR (PLAN-D4c2b rev 14 §2–§6, §9). Alert-only, OFF every request path.
   Every 15 min (scheduled function verifyIdentityIntegrity, index.js), for every restaurant the brand-agnostic registry
   enumerates, OLDEST coverage first and ONE restaurant at a time:
     precheck   ONE read-only getAll of the lease / draft / pointer → skip a restaurant with OBSERVED recent merchant activity
     check A    ONE read-only transaction: pointer, version record, activation + certification evidence, counts, objects,
                registry rows (→ identity-integrity.js classifyActive)
     check B    ONE read-only transaction: the next ≤ 20 activation generations (→ classifyAuditEntry)
     growth     identity_evidence.limit(20001).count()
     commit     ONE RTDB transaction on catalog_integrity/{rid} (→ identity-integrity-state.js)
   then one summary line for EVERY enumerated restaurant (from its compact coverage + summary children) and the heartbeat.

   🔴 READ-ONLY ON CATALOG DATA, LOCK-FREE: every Firestore read except the gated restaurant enumeration
   (makeFirestoreRegistryReader's listDocuments, restaurant-registry.js:96) runs in a READ-ONLY transaction ({readOnly: true}
   at EVERY call site — guard test): no document locks, no contention retries. The only writes are this monitor's own RTDB node.
   🔴 PACED + BUDGETED: ≤ 100 document reads per second (token bucket), every read RESERVED against the 15,000-read run cap
   before it is issued; a restaurant whose next stage does not fit is deferred at a stage boundary (never partially applied).
   🔴 BOUNDED: c1's gate primitives — every I/O through a gated handle (gateIo), started only before the work deadline
   (boundedWork); the RTDB commit spends the checkpoint reserve; 25 s per restaurant; 30 s reserved for the summaries. */
const { FieldPath } = require('firebase-admin/firestore');
const { gateIo, boundedWork, workDeadline, makeDeadline, race } = require('./identity-record-writer');
const { sanitize } = require('./restaurant-registry');
const { readSetOf } = require('./catalog-verifier');
const { readPointerSnap } = require('./catalog-firestore');
const { sourceRefOf } = require('./source-store');
const { EVIDENCE_COL, activationDocId, G20 } = require('./identity-evidence');
const { H } = require('./evidence-encoding');
const C = require('./identity-integrity');
const S = require('./identity-integrity-state');

const INTEGRITY_PATH = 'catalog_integrity';
const INTEGRITY_SCHEDULE = 'every 15 minutes';
const INTEGRITY_TIMEOUT_S = 300;
const INTEGRITY_MEMORY = '512MiB';
const RUN_READ_CAP = 15000;
const READS_PER_SECOND = 100;
const RESTAURANT_ALLOWANCE_MS = 25000;
const SUMMARY_RESERVE_MS = 30000;
const RUN_BUDGET_MS = (INTEGRITY_TIMEOUT_S * 1000) - SUMMARY_RESERVE_MS - 20000;   // restaurant work; the summaries keep their 30 s
const COMMIT_RESERVE_MS = 5000;
const READ_OP_MS = 10000;
const LIST_DEADLINE_MS = 10000;
// the enumeration is BOUNDED AT THE FETCH (codex build r3 P1-C ruling): ONE limited query of at most ENUMERATION_MAX + 1 restaurant
// documents (the +1 detects overflow), whose cost is reserved EXACTLY before it is issued — never an unrestricted listDocuments()
const ENUMERATION_MAX = 200;
// the monitor's OWN registry reader: a limited, field-less query (`select()` → ids only). It sees the restaurant DOCUMENTS; a
// restaurant must therefore have its `restaurants/{rid}` document (every onboarded brand does — the profile with pricing_key_mode)
function makeBoundedRegistryReader(db) {
  return async ({ limit }) => (await db.collection('restaurants').select().limit(limit).get()).docs.map((d) => d.id);
}
const QUIET_MS = 10 * 60 * 1000;
const OBJECT_PAGE = 25;
const REGISTRY_BATCH = 10;
const PAIRS_PER_BATCH = Math.floor(REGISTRY_BATCH / 3);   // readSetOf: ≤ 3 paths per pair → ≤ 9 per getAll
const AUDIT_PAGE = 20;
const CERT_READ_LIMIT = C.MAX_CERTIFICATIONS + 1;
const COUNT_LIMIT = C.MAX_OBJECTS + 1;
const GROWTH_LIMIT = 20001;
const READ_ONLY = Object.freeze({ readOnly: true });
const ID = FieldPath.documentId();
const ID_MASK = ['legacy_key', 'status', 'kind'];
const KEY_MASK = ['canonical_id', 'kind'];

class BudgetDeferral extends Error { constructor(stage) { super(`budget_deferred_${stage}`); this.budgetDeferral = true; } }
class OversizedDeferral extends Error { constructor(reason) { super(reason); this.oversized = reason; } }

/* ── the run's read budget + pacing ───────────────────────────────────────────────────────────────────────────────────
   reserve(n) BEFORE a read is issued (throws BudgetDeferral if the run cap would be passed); pace(n) then waits until issuing n
   more reads keeps EVERY 1-second window at ≤ perSecond (a sliding window — a token bucket that starts full would allow ~2×
   in its first second). Count queries are reserved at their billed upper bound (limit(401) ≤ 1, limit(20001) ≤ 21). */
function createReadBudget({ cap = RUN_READ_CAP, perSecond = READS_PER_SECOND, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let used = 0;
  const byStage = {};  // reserved reads per stage — observability, and the per-stage proof that every issued operation was reserved
  const window = [];   // [t, n] issued within the last second
  const log = [];      // (t, n) per paced read — the pacing assertion reads this
  return {
    reserve(n, stage) { if (used + n > cap) throw new BudgetDeferral(stage); used += n; byStage[stage] = (byStage[stage] || 0) + n; },
    async pace(n) {
      if (n > perSecond) throw new RangeError(`pace: one operation of ${n} reads exceeds the ${perSecond}/s limit`);
      for (;;) {
        const t = now();
        while (window.length && window[0][0] <= t - 1000) window.shift();
        const inWindow = window.reduce((sum, [, k]) => sum + k, 0);
        if (inWindow + n <= perSecond) { window.push([t, n]); log.push([t, n]); return; }
        await sleep(Math.max(1, window[0][0] + 1000 - t));
      }
    },
    // an UNUSED part of an up-front reservation (the enumeration's maximum) is returned once the actual cost is known
    release(n) { used = Math.max(0, used - Math.max(0, n)); },
    used: () => used,
    byStage: () => ({ ...byStage }),
    log,
  };
}

const evidenceCol = (db, rid) => db.collection('restaurants').doc(rid).collection(EVIDENCE_COL);
const versionRef = (db, rid, v) => db.collection('restaurants').doc(rid).collection('versions').doc(v);
const metaRef = (db, rid, d) => db.collection('restaurants').doc(rid).collection('meta').doc(d);
const tsMs = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : (t instanceof Date ? t.getTime() : null));

/* ── READS (each a function of the gated handles; every Firestore read in a READ-ONLY transaction) ──────────────────── */
// precheck — ONE getAll of the lease, the draft and the pointer; server time = the snapshot's readTime (never serverNow,
// which writes a probe). ACTIVE if the lease is live OR the draft changed < 10 min ago OR the pointer moved < 10 min ago.
async function precheck(gdb, rid, budget, quietMs = QUIET_MS) {
  budget.reserve(3, 'precheck'); await budget.pace(3);
  return gdb.runTransaction(async (tx) => {
    const [lock, src, ptr] = await tx.getAll(metaRef(gdb, rid, 'publish_lock'), sourceRefOf(gdb, rid), metaRef(gdb, rid, 'active_version'));
    const readMs = tsMs(ptr.readTime);
    const l = lock.exists ? (lock.data() || {}) : {};
    const lease = !!(l.owner_token && l.expires_at && tsMs(l.expires_at) > readMs);
    const draft = !!(src.exists && tsMs(src.updateTime) > readMs - quietMs);
    const pd = ptr.exists ? (ptr.data() || {}) : {};
    const moved = !!(ptr.exists && ((tsMs(pd.at) || 0) > readMs - quietMs || tsMs(ptr.updateTime) > readMs - quietMs));
    return { obs_t: S.obsT(ptr.readTime), active: lease || draft || moved, why: { lease, draft, pointer: moved } };
  }, READ_ONLY);
}

// origin of a version (c2a §2b): earliest g-evidence for vid → binding iff a certified publish; else earliest certification
async function originOf(tx, gdb, rid, versionId, budget) {
  const col = evidenceCol(gdb, rid); const vid = H(String(versionId));
  budget.reserve(1, 'origin'); await budget.pace(1);
  const first = await tx.get(col.where('vid', '==', vid).where(ID, '>=', 'g').where(ID, '<', 'g').orderBy(ID).limit(1));
  if (first.docs.length) {
    const d = first.docs[0].data();
    if (d.intent === 'publish' && d.certified === true) return { kind: 'publish', id: first.docs[0].id, data: d };
  }
  budget.reserve(1, 'origin'); await budget.pace(1);
  const cert = await tx.get(col.where('vid', '==', vid).where(ID, '>=', 'c').where(ID, '<', 'c').orderBy(ID).limit(1));
  if (cert.docs.length) return { kind: 'certify', id: cert.docs[0].id, data: cert.docs[0].data() };
  return { kind: 'none' };
}

// CHECK A — one read-only transaction → the classifier's observation (or { none } when the restaurant has no pointer)
async function observeActive(gdb, rid, budget) {
  return gdb.runTransaction(async (tx) => {
    budget.reserve(1, 'pointer'); await budget.pace(1);
    const ptrSnap = await tx.get(metaRef(gdb, rid, 'active_version'));
    const obs_t = S.obsT(ptrSnap.readTime);
    if (!ptrSnap.exists) return { none: true, obs_t };
    const { version, generation } = readPointerSnap(ptrSnap, rid);   // c2a's reader: an ABSENT generation reads 0 (catalog-firestore.js:112)
    if (!version) return { none: true, obs_t };
    const vref = versionRef(gdb, rid, version); const col = evidenceCol(gdb, rid);
    budget.reserve(2, 'evidence'); await budget.pace(2);
    const [rec] = await tx.getAll(vref, { fieldMask: ['identity_certified'] });          // the version record, masked
    const act = await tx.get(col.doc(activationDocId(generation)));                      // the activation evidence (bounded by c2a §2)
    const recData = rec.exists ? (rec.data() || {}) : null;
    const actData = act.exists ? (act.data() || {}) : null;
    const obs = { rid, obs_t, pointer: { version, generation }, record: { exists: rec.exists, certified: !!recData && recData.identity_certified === true },
      activation: act.exists ? { id: act.id, data: actData } : null, certifications: [], objects: { count: 0, pairs: [], unstamped: [] } };
    if (!rec.exists) return obs;
    budget.reserve(CERT_READ_LIMIT, 'certifications'); await budget.pace(CERT_READ_LIMIT);
    const pre = `c${G20(generation)}_`;
    const certs = await tx.get(col.where(ID, '>=', pre).where(ID, '<', `${pre}`).orderBy(ID).limit(CERT_READ_LIMIT));
    if (certs.docs.length > C.MAX_CERTIFICATIONS) throw new OversizedDeferral('too_many_certifications');
    obs.certifications = certs.docs.map((d) => ({ id: d.id, data: d.data() }));
    // counts FIRST: combined > 400 → unavailable{oversized} before any object is read
    budget.reserve(2, 'counts'); await budget.pace(2);
    const counts = {};
    for (const [kind, sub] of [['dish', 'menu_items'], ['extra', 'extras']]) counts[kind] = (await tx.get(vref.collection(sub).limit(COUNT_LIMIT).count())).data().count;
    obs.objects.count = counts.dish + counts.extra;
    if (obs.objects.count > C.MAX_OBJECTS) throw new OversizedDeferral('oversized');
    // objects in pages of 25 (mask key + display.identity_id) → pairs; each page released after reduction. Every pair is admitted
    // to the §5 budgets AS IT IS RETAINED: the moment either is exceeded, reading stops and the check is unavailable{oversized_values}
    // (codex build r1 P1-1 — nothing past the budget is ever held, and the registry is not read)
    const pb = C.createPairBudget();
    let oversized = false;
    for (const [kind, sub] of [['dish', 'menu_items'], ['extra', 'extras']]) {
      if (oversized) break;
      let after = null;
      for (;;) {
        budget.reserve(OBJECT_PAGE, 'objects'); await budget.pace(OBJECT_PAGE);
        let q = vref.collection(sub).select('key', 'display.identity_id').orderBy(ID).limit(OBJECT_PAGE);
        if (after) q = q.startAfter(after);
        const page = await tx.get(q);
        for (const d of page.docs) {
          const data = d.data() || {}; const id = data.display && data.display.identity_id;
          if (typeof data.key === 'string' && data.key && typeof id === 'string' && id) {
            const pair = { kind, key: data.key, id, docId: d.id };
            if (!pb.admit(pair)) { oversized = true; break; }
            obs.objects.pairs.push(pair);
          } else obs.objects.unstamped.push({ kind, docId: d.id });
        }
        if (oversized || page.docs.length < OBJECT_PAGE) break;
        after = page.docs[page.docs.length - 1].id;
      }
    }
    if (oversized) { obs.objects = { count: obs.objects.count, oversized_values: true, pairs: [], unstamped: [] }; return obs; }
    // registry: PAIRS_PER_BATCH pairs at a time → their readSetOf paths (3 per pair, ≤ 10) in ONE masked getAll → judged → the
    // rows RELEASED; only the verdicts (pair hashes) are kept (codex build r1 P1-1). A pair that cannot be addressed (a stamp that
    // is not a valid document id, a legacy key too long for a key-row id) never becomes a path (P2-6): judged registry_disagrees.
    const reg = { degraded: [], disagree: [], invalid: 0 };
    for (let i = 0; i < obs.objects.pairs.length; i += PAIRS_PER_BATCH) {
      const chunk = obs.objects.pairs.slice(i, i + PAIRS_PER_BATCH);
      const paths = readSetOf(rid, chunk.filter(C.addressable).map((p) => ({ kind: p.kind, canonicalId: p.id, legacyKey: p.key })));
      const rows = {};
      if (paths.length) {
        budget.reserve(paths.length, 'registry'); await budget.pace(paths.length);
        const snaps = await tx.getAll(...paths.map((p) => gdb.doc(p)), { fieldMask: [...new Set([...ID_MASK, ...KEY_MASK])] });
        snaps.forEach((sn, j) => { if (sn.exists) rows[paths[j]] = sn.data(); });
      }
      const v = C.judgeRegistryChunk(rid, chunk, rows);
      reg.degraded.push(...v.degraded); reg.disagree.push(...v.disagree); reg.invalid += v.invalid;
    }
    obs.registry = reg;
    // origin: only when no effective binding record exists at this generation (§2.3)
    const vid = H(String(version));
    const validCert = obs.certifications.some((c) => C.certificationSchema(c.id, c.data).ok && c.data.vid === vid && c.data.observed_generation === generation);
    const actOk = obs.activation && C.activationSchema(obs.activation.id, obs.activation.data).ok && actData.vid === vid && actData.generation === generation;
    if (!validCert && !(actOk && actData.certified === true)) obs.origin = await originOf(tx, gdb, rid, version, budget);
    return obs;
  }, READ_ONLY);
}

// CHECK B — the next ≤ 20 generations by direct get; a certified rollback's origin (c2a §2b)
async function observeAudit(gdb, rid, from, to, budget) {
  return gdb.runTransaction(async (tx) => {
    const col = evidenceCol(gdb, rid); const entries = [];
    let obs_t = null;
    for (let g = from; g <= to; g += 1) {
      budget.reserve(1, 'audit'); await budget.pace(1);
      const s = await tx.get(col.doc(activationDocId(g)));
      if (!obs_t) obs_t = S.obsT(s.readTime);
      const e = { g, doc: s.exists ? { id: s.id, data: s.data() } : null };
      const d = e.doc && e.doc.data;
      if (d && d.intent === 'rollback' && d.certified === true && C.activationSchema(e.doc.id, d).ok) e.origin = await originOfVid(tx, gdb, rid, d.vid, budget);
      entries.push(e);
    }
    // the backlog head's own time, when it exists (the first generation NOT in this page)
    let head = null;
    budget.reserve(1, 'audit_head'); await budget.pace(1);
    const hs = await tx.get(col.doc(activationDocId(to + 1)));
    if (!obs_t) obs_t = S.obsT(hs.readTime);
    if (hs.exists) head = { g: to + 1, at_ms: tsMs((hs.data() || {}).at) };
    return { entries, obs_t, head };
  }, READ_ONLY);
}
// the same §2b origin, addressed by vid (the audit has the evidence's vid, not the raw version id)
async function originOfVid(tx, gdb, rid, vid, budget) {
  const col = evidenceCol(gdb, rid);
  budget.reserve(1, 'origin'); await budget.pace(1);
  const first = await tx.get(col.where('vid', '==', vid).where(ID, '>=', 'g').where(ID, '<', 'g').orderBy(ID).limit(1));
  if (first.docs.length) {
    const d = first.docs[0].data();
    if (d.intent === 'publish' && d.certified === true) return { kind: 'publish', id: first.docs[0].id, data: d };
  }
  budget.reserve(1, 'origin'); await budget.pace(1);
  const cert = await tx.get(col.where('vid', '==', vid).where(ID, '>=', 'c').where(ID, '<', 'c').orderBy(ID).limit(1));
  if (cert.docs.length) return { kind: 'certify', id: cert.docs[0].id, data: cert.docs[0].data() };
  return { kind: 'none' };
}

// growth (§9): identity_evidence.limit(20001).count() — exact up to 20,000
async function evidenceCount(gdb, rid, budget) {
  budget.reserve(21, 'growth'); await budget.pace(21);
  return gdb.runTransaction(async (tx) => (await tx.get(evidenceCol(gdb, rid).limit(GROWTH_LIMIT).count())).data().count, READ_ONLY);
}

/* ── the monitor ──────────────────────────────────────────────────────────────────────────────────────────────────── */
function createIdentityIntegrityMonitor({ db, rtdb, now = Date.now, sleep, log = (k, d) => { try { console.log(JSON.stringify({ ...d, event: d.event || k })); } catch (_) {} },
  runId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` } = {}) {
  const nodeRef = (h, rid) => h.ref(`${INTEGRITY_PATH}/${rid}`);
  // the compact children (coverage + summary) — two small gets, gated + bounded by the PHASE deadline `dl` (codex build r1 P1-2)
  const viewOf = async (rid, dl, readOpMs = READ_OP_MS) => {
    if (dl.stopped()) throw new Error('integrity_view_deadline');
    const g = gateIo(rtdb, dl, 'integrity_view');
    const get = (k) => race(g.ref(`${INTEGRITY_PATH}/${rid}/${k}`).get(), Math.min(readOpMs, dl.remaining()), 'integrity_view');
    const [cov, sum] = await Promise.all([get('coverage'), get('summary')]);
    return { rid, coverage: cov.val() || {}, summary: sum.val() || null };
  };

  // ONE RTDB transaction on the restaurant's node: the reducer steps in order, then the size record
  async function commit(rid, gate, steps, reserve = null) {
    if (reserve) reserve();   // the transaction's read is reserved BEFORE it is issued (codex build r2 P1-C) — a BudgetDeferral throws here
    const g = gateIo(rtdb, gate, 'integrity_commit');
    let out = {};
    const res = await nodeRef(g, rid).transaction((cur) => {
      let n = cur; out = {};
      for (const step of steps) { const r = step(n, out); n = r && r.node !== undefined && Object.prototype.hasOwnProperty.call(r, 'node') ? r.node : r; }
      return S.withSize(n);
    }, undefined, false);
    return { committed: !!(res && res.committed), out };
  }

  async function checkRestaurant(rid, stop, budget, run, { quietMs = QUIET_MS } = {}) {
    const work = workDeadline(stop, COMMIT_RESERVE_MS);
    const gdb = gateIo(db, work, 'integrity_read');
    const bounded = (thunk, label) => boundedWork(work, thunk, READ_OP_MS, label);
    // check A is ONE transaction of up to ~1,700 PACED reads (≤ 100/s ≈ 17 s at the 400-object cap): it is bounded by the
    // restaurant's whole remaining work allowance (25 s, §5), never by the single-read limit
    const boundedStage = (thunk, label) => boundedWork(work, thunk, work.remaining(), label);
    const result = { rid };
    // the commit this check ends with is an RTDB transaction: ONE is reserved FIRST (codex build r1 P1-2); any FURTHER attempt — the
    // failure record after a failed commit — reserves its own read before it is issued (codex build r2 P1-C)
    let commitTokens = 0;
    try { budget.reserve(1, 'commit'); commitTokens = 1; } catch (e) { return { rid, outcome: 'deferred_budget', reason: e.message }; }
    const reserveCommit = () => { if (commitTokens > 0) { commitTokens -= 1; return; } budget.reserve(1, 'commit'); };
    let pre;
    try { pre = await bounded(() => precheck(gdb, rid, budget, quietMs), 'precheck'); } catch (e) { return fail(rid, stop, e, 'precheck', reserveCommit); }
    if (pre.active) {
      await commit(rid, stop, [(n) => S.enumerated(n, { obs_t: pre.obs_t }), (n) => S.deferActive(n, { obs_t: pre.obs_t, runId: run })], reserveCommit);
      log('identity_integrity_check', { rid, outcome: 'deferred_merchant_active', why: pre.why });
      return { ...result, outcome: 'deferred_merchant_active' };
    }
    // the node's boundary / cursor (one small get each, budgeted, gated, bounded) — a budget deferral here is a stage boundary too
    let boundary; let through0;
    try {
      budget.reserve(2, 'node');
      const gr = gateIo(rtdb, work, 'integrity_node');
      const [bSnap, aSnap] = await bounded(() => Promise.all([nodeRef(gr, rid).child('boundary').get(), nodeRef(gr, rid).child('audited_through').get()]), 'node_read');
      boundary = bSnap.val(); through0 = aSnap.val();
    } catch (e) { return fail(rid, stop, e, 'node', reserveCommit); }
    let active; let audit = null; let count = null; let onboarded = null;
    try {
      const obs = await boundedStage(() => observeActive(gdb, rid, budget), 'check_active');
      const obsT = obs.obs_t;
      if (obs.none) active = { none: true, obs_t: obs.obs_t };
      else active = { obs, result: C.classifyActive(obs, boundary ? { G0: boundary.G0 } : null) };
      const current = obs.none ? 0 : obs.pointer.generation;
      const through = Number.isSafeInteger(through0) ? through0 : (boundary ? boundary.G0 - 1 : 0);
      if (current > through) {
        const to = Math.min(current, through + AUDIT_PAGE);
        const page = await bounded(() => observeAudit(gdb, rid, through + 1, to, budget), 'check_audit');
        let b = boundary ? { G0: boundary.G0 } : null;
        // §1 onboarded: no boundary record and generation 1's evidence exists and validates → G0 = 1
        if (!b && through + 1 === 1 && page.entries[0] && page.entries[0].doc && C.activationSchema(page.entries[0].doc.id, page.entries[0].doc.data).ok) { b = { G0: 1 }; onboarded = { G0: 1, source: 'onboarded', recorded_obs_t: page.obs_t }; }
        const findings = []; for (const e of page.entries) findings.push(...C.classifyAuditEntry(e, b).findings);
        audit = { start: through + 1, end: to, findings, obs_t: page.obs_t, current, head: page.head };
      } else audit = { start: through + 1, end: through, findings: [], obs_t: obsT, current };
      count = await bounded(() => evidenceCount(gdb, rid, budget), 'growth');
    } catch (e) {
      if (e && e.oversized) {
        const obs_t = active && active.obs_t;
        await commit(rid, stop, [(n) => S.enumerated(n, { obs_t: obs_t || S.fromMs(now()) }), (n) => S.deferFailure(n, { nowMs: now(), reason: `unavailable_${e.oversized}` })], reserveCommit);
        log('identity_integrity_check', { rid, outcome: 'unavailable', reason: e.oversized });
        return { ...result, outcome: 'unavailable', reason: e.oversized };
      }
      return fail(rid, stop, e, 'check', reserveCommit);
    }
    const steps = [(n) => S.enumerated(n, { obs_t: active.obs_t || active.obs.obs_t })];
    if (onboarded) steps.push((n) => S.setBoundary(n, onboarded));
    if (!Number.isSafeInteger(through0) && !boundary && !onboarded) steps.push((n) => { const x = JSON.parse(JSON.stringify(n || {})); if (!Number.isSafeInteger(x.audited_through)) x.audited_through = 0; return x; });
    if (active.none) steps.push((n) => S.applyActive(n, { state: 'no_active_version', findings: [], degradedPairs: [], coverage: true }, { obs_t: active.obs_t, generation: 0 }));
    else {
      steps.push((n, out) => { const r = S.applyActive(n, active.result, { obs_t: active.obs.obs_t, generation: active.obs.pointer.generation }); out.activeApplied = r.applied; return r; });
      if (!active.result.coverage) steps.push((n) => S.deferFailure(n, { nowMs: now(), reason: `unavailable_${active.result.reason}` }));
    }
    if (audit) steps.push((n, out) => { const r = S.applyAuditPage(n, audit); out.auditApplied = r.applied; return r; });
    steps.push((n) => { const x = JSON.parse(JSON.stringify(n || {})); x.coverage = x.coverage || {}; x.coverage.evidence_count = count; return x; });
    let c;
    try { c = await commit(rid, stop, steps, reserveCommit); } catch (e) { return fail(rid, stop, e, 'commit', reserveCommit); }
    const state = active.none ? 'no_active_version' : active.result.state;
    log('identity_integrity_check', { rid, outcome: c.committed ? 'checked' : 'commit_not_settled', state, generation: active.none ? 0 : active.obs.pointer.generation,
      findings: active.none ? 0 : active.result.findings.length, audit: audit ? { from: audit.start, to: audit.end, findings: audit.findings.length } : null,
      evidence_count: count, applied: c.out });
    return { ...result, outcome: 'checked', state, committed: c.committed, applied: c.out };
  }

  async function fail(rid, stop, e, stage, reserve = null) {
    const reason = e && e.budgetDeferral ? e.message : (e && e.workDeadline ? 'budget_exhausted' : `${stage}_failed`);
    // (first_enumerated_at is recorded by run() for EVERY enumerated restaurant, so one that always fails still goes stale)
    try { await commit(rid, stop, [(n) => S.deferFailure(n, { nowMs: now(), reason })], reserve); } catch (_) { /* no budget for it, or it failed: the next run retries */ }
    log('identity_integrity_check', { rid, outcome: e && (e.budgetDeferral || e.workDeadline) ? 'deferred_budget' : 'failed', reason, error: String((e && e.message) || e).slice(0, 160) });
    return { rid, outcome: e && (e.budgetDeferral || e.workDeadline) ? 'deferred_budget' : 'failed', reason };
  }

  /* the run: enumerate → read every node's compact children → oldest-first → per-restaurant checks → summaries + heartbeat.
     ONE run deadline (codex build r1 P1-2): every phase is gated + raced against it — restaurant WORK (enumeration, views, the
     first-enumeration records, the checks) ends at runBudgetMs; the summaries keep summaryReserveMs after it, never less. EVERY
     read is reserved before it is issued: the enumeration (1 up front, then one per enumerated restaurant), the summaries'
     2 per restaurant RESERVED UP FRONT (restaurant work can never consume them), the views, the first-enumeration records and
     each check's commit. A stalled operation is abandoned at its phase deadline (the run moves on; the next run redoes it). */
  async function run({ listIds, runBudgetMs = RUN_BUDGET_MS, restaurantMs = RESTAURANT_ALLOWANCE_MS, readCap = RUN_READ_CAP, perSecond = READS_PER_SECOND,
    quietMs = QUIET_MS, summaryReserveMs = SUMMARY_RESERVE_MS, readOpMs = READ_OP_MS, enumerationMax = ENUMERATION_MAX } = {}) {
    const id = runId();
    const budget = createReadBudget({ cap: readCap, perSecond, now, sleep });
    const work = makeDeadline(runBudgetMs, now);
    let ids; let enumeratedOk = true; let listed = 0;
    try {
      const limit = enumerationMax + 1;   // +1 detects overflow
      budget.reserve(limit, 'enumerate');   // EXACTLY the limited query's maximum cost, before it is issued
      const raw = await boundedWork(work, () => listIds({ limit }), Math.min(LIST_DEADLINE_MS, readOpMs), 'integrity_list');
      if (!Array.isArray(raw) || raw.length > limit) throw new Error(`integrity_list: the reader returned ${Array.isArray(raw) ? raw.length : typeof raw} ids for a limit of ${limit} — unbounded`);
      listed = raw.length;
      ids = sanitize(raw).slice().sort();
      if (listed > enumerationMax) { enumeratedOk = false; ids = ids.slice(0, enumerationMax); log('identity_integrity_enumeration_truncated', { listed: `> ${enumerationMax}`, max: enumerationMax }); }
      // ZERO restaurants is a FAILED enumeration (advisor ruling, rail (i)): the bounded reader sees restaurant DOCUMENTS only, so a
      // registry whose restaurants lack their restaurants/{rid} document reads as empty — never a clean, heartbeat-emitting run
      if (!ids.length) { enumeratedOk = false; log('identity_integrity_enumeration_empty', { error: 'no restaurant documents enumerated — the heartbeat is suppressed (every restaurant needs its restaurants/{rid} document)' }); }
      budget.release(limit - Math.max(1, listed));   // the actual cost: one per returned document (≥ 1)
    } catch (e) {
      log('identity_integrity_run', { ok: false, error: String((e && e.message) || e).slice(0, 160), reads: budget.used() });
      return { ok: false, results: [], reads: budget.used(), reservedByStage: budget.byStage(), pacing: budget.log };
    }
    let summaryReserved = true;
    try { budget.reserve(2 * ids.length, 'summaries'); } catch (_) { summaryReserved = false; enumeratedOk = false; }
    const views = [];
    if (summaryReserved) {
      for (const rid of ids) {
        if (work.stopped()) { enumeratedOk = false; break; }
        try { budget.reserve(2, 'views'); } catch (_) { enumeratedOk = false; break; }
        try { views.push(await viewOf(rid, work, readOpMs)); } catch (_) { views.push({ rid, coverage: {}, summary: null }); }
      }
    }
    // every enumerated restaurant gets its first_enumerated_at recorded, even one this run never reaches (§6 missing coverage)
    for (const v of views) {
      if (v.coverage && v.coverage.first_enumerated_at) continue;
      if (work.stopped()) break;
      try { budget.reserve(1, 'enumerated'); } catch (_) { break; }
      try {
        const record = gateIo(rtdb, work, 'integrity_enumerated').ref(`${INTEGRITY_PATH}/${v.rid}`).transaction((cur) => S.withSize(S.enumerated(cur, { obs_t: S.fromMs(now()) })), undefined, false);
        await race(record, Math.min(readOpMs, work.remaining()), 'integrity_enumerated');
      } catch (_) { /* recorded next run */ }
    }
    const results = [];
    for (const rid of S.scheduleOrder(views, now())) {
      if (work.stopped()) { results.push({ rid, outcome: 'not_reached' }); continue; }
      const ms = Math.min(restaurantMs, work.remaining());
      const stop = makeDeadline(ms, now);
      results.push(await race(checkRestaurant(rid, stop, budget, id, { quietMs }), ms + 1000, 'integrity_restaurant').catch((e) => ({ rid, outcome: 'failed', reason: String((e && e.message) || e).slice(0, 120) })));
    }
    // summaries for EVERY enumerated restaurant, processed or not (§6) — the compact children only, within the summary reserve
    const sum = makeDeadline(summaryReserveMs, now);
    let anyStale = false;
    const lines = [];
    for (const rid of ids) {
      let view;
      if (!summaryReserved || sum.stopped()) view = { coverage: {}, summary: null, unread: true };
      else { try { view = await viewOf(rid, sum, readOpMs); } catch (_) { view = { coverage: {}, summary: null, unread: true }; } }
      const line = S.summaryLine(rid, view, now());
      if (view.unread) { line.stale = 1; line.stale_reasons = ['state_unreadable']; }
      if (line.stale) anyStale = true;
      lines.push(line); log(line.event, line);
    }
    const covered = results.filter((r) => r.outcome === 'checked').length;
    if (enumeratedOk && !anyStale) log('identity_integrity_heartbeat', S.heartbeatLine({ enumerated: ids.length, covered }));
    log('identity_integrity_run', { ok: true, run: id, enumerated: ids.length, covered, reads: budget.used(), outcomes: results.map((r) => `${r.rid}:${r.outcome}`) });
    return { ok: true, run: id, ids, results, lines, reads: budget.used(), reservedByStage: budget.byStage(), pacing: budget.log };
  }

  return { run, checkRestaurant, commit };
}

module.exports = {
  createIdentityIntegrityMonitor, createReadBudget, makeBoundedRegistryReader, precheck, observeActive, observeAudit, evidenceCount, originOf, originOfVid,
  INTEGRITY_PATH, INTEGRITY_SCHEDULE, INTEGRITY_TIMEOUT_S, INTEGRITY_MEMORY, RUN_READ_CAP, READS_PER_SECOND, RESTAURANT_ALLOWANCE_MS,
  SUMMARY_RESERVE_MS, RUN_BUDGET_MS, QUIET_MS, OBJECT_PAGE, REGISTRY_BATCH, PAIRS_PER_BATCH, AUDIT_PAGE, CERT_READ_LIMIT, COUNT_LIMIT, GROWTH_LIMIT, READ_ONLY,
  BudgetDeferral, OversizedDeferral, ENUMERATION_MAX,
};
