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
const QUIET_MS = 10 * 60 * 1000;
const OBJECT_PAGE = 25;
const REGISTRY_BATCH = 10;
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
  const window = [];   // [t, n] issued within the last second
  const log = [];      // (t, n) per paced read — the pacing assertion reads this
  return {
    reserve(n, stage) { if (used + n > cap) throw new BudgetDeferral(stage); used += n; },
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
    used: () => used,
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
      activation: act.exists ? { id: act.id, data: actData } : null, certifications: [], objects: { count: 0, pairs: [], unstamped: [] }, rows: {} };
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
    // objects in pages of 25 (mask key + display.identity_id) → pairs; each page released after reduction
    for (const [kind, sub] of [['dish', 'menu_items'], ['extra', 'extras']]) {
      let after = null;
      for (;;) {
        budget.reserve(OBJECT_PAGE, 'objects'); await budget.pace(OBJECT_PAGE);
        let q = vref.collection(sub).select('key', 'display.identity_id').orderBy(ID).limit(OBJECT_PAGE);
        if (after) q = q.startAfter(after);
        const page = await tx.get(q);
        for (const d of page.docs) {
          const data = d.data() || {}; const id = data.display && data.display.identity_id;
          if (typeof data.key === 'string' && data.key && typeof id === 'string' && id) obs.objects.pairs.push({ kind, key: data.key, id, docId: d.id });
          else obs.objects.unstamped.push({ kind, docId: d.id });
        }
        if (page.docs.length < OBJECT_PAGE) break;
        after = page.docs[page.docs.length - 1].id;
      }
    }
    // registry rows: readSetOf (3 paths per pair), getAll in batches of 10 with field masks
    const paths = readSetOf(rid, obs.objects.pairs.map((p) => ({ kind: p.kind, canonicalId: p.id, legacyKey: p.key })));
    for (let i = 0; i < paths.length; i += REGISTRY_BATCH) {
      const batch = paths.slice(i, i + REGISTRY_BATCH);
      budget.reserve(batch.length, 'registry'); await budget.pace(batch.length);
      const snaps = await tx.getAll(...batch.map((p) => gdb.doc(p)), { fieldMask: [...new Set([...ID_MASK, ...KEY_MASK])] });
      snaps.forEach((s, j) => { if (s.exists) obs.rows[batch[j]] = s.data(); });
    }
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
  // the compact children (coverage + summary) — two small gets, each bounded
  const viewOf = async (rid) => {
    const get = (k) => race(rtdb.ref(`${INTEGRITY_PATH}/${rid}/${k}`).get(), READ_OP_MS, 'integrity_view');
    const [cov, sum] = await Promise.all([get('coverage'), get('summary')]);
    return { rid, coverage: cov.val() || {}, summary: sum.val() || null };
  };

  // ONE RTDB transaction on the restaurant's node: the reducer steps in order, then the size record
  async function commit(rid, gate, steps) {
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
    const result = { rid };
    let pre;
    try { pre = await bounded(() => precheck(gdb, rid, budget, quietMs), 'precheck'); } catch (e) { return fail(rid, stop, e, 'precheck'); }
    if (pre.active) {
      await commit(rid, stop, [(n) => S.enumerated(n, { obs_t: pre.obs_t }), (n) => S.deferActive(n, { obs_t: pre.obs_t, runId: run })]);
      log('identity_integrity_check', { rid, outcome: 'deferred_merchant_active', why: pre.why });
      return { ...result, outcome: 'deferred_merchant_active' };
    }
    // the node's boundary / cursor (one small get each, budgeted)
    budget.reserve(2, 'node');
    const gr = gateIo(rtdb, work, 'integrity_node');
    const [bSnap, aSnap] = await Promise.all([nodeRef(gr, rid).child('boundary').get(), nodeRef(gr, rid).child('audited_through').get()]);
    const boundary = bSnap.val(); const through0 = aSnap.val();
    let active; let audit = null; let count = null; let onboarded = null;
    try {
      const obs = await bounded(() => observeActive(gdb, rid, budget), 'check_active');
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
        await commit(rid, stop, [(n) => S.enumerated(n, { obs_t: obs_t || S.fromMs(now()) }), (n) => S.deferFailure(n, { nowMs: now(), reason: `unavailable_${e.oversized}` })]);
        log('identity_integrity_check', { rid, outcome: 'unavailable', reason: e.oversized });
        return { ...result, outcome: 'unavailable', reason: e.oversized };
      }
      return fail(rid, stop, e, 'check');
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
    try { c = await commit(rid, stop, steps); } catch (e) { return fail(rid, stop, e, 'commit'); }
    const state = active.none ? 'no_active_version' : active.result.state;
    log('identity_integrity_check', { rid, outcome: c.committed ? 'checked' : 'commit_not_settled', state, generation: active.none ? 0 : active.obs.pointer.generation,
      findings: active.none ? 0 : active.result.findings.length, audit: audit ? { from: audit.start, to: audit.end, findings: audit.findings.length } : null,
      evidence_count: count, applied: c.out });
    return { ...result, outcome: 'checked', state, committed: c.committed, applied: c.out };
  }

  async function fail(rid, stop, e, stage) {
    const reason = e && e.budgetDeferral ? e.message : (e && e.workDeadline ? 'budget_exhausted' : `${stage}_failed`);
    try { await commit(rid, stop, [(n) => S.deferFailure(n, { nowMs: now(), reason })]); } catch (_) { /* the next run retries */ }
    log('identity_integrity_check', { rid, outcome: e && (e.budgetDeferral || e.workDeadline) ? 'deferred_budget' : 'failed', reason, error: String((e && e.message) || e).slice(0, 160) });
    return { rid, outcome: e && (e.budgetDeferral || e.workDeadline) ? 'deferred_budget' : 'failed', reason };
  }

  // the run: enumerate → read every node's compact children → oldest-first → per-restaurant checks → summaries + heartbeat
  async function run({ listIds, runBudgetMs = RUN_BUDGET_MS, restaurantMs = RESTAURANT_ALLOWANCE_MS, readCap = RUN_READ_CAP, perSecond = READS_PER_SECOND, quietMs = QUIET_MS } = {}) {
    const id = runId();
    const budget = createReadBudget({ cap: readCap, perSecond, now, sleep });
    let ids; let enumeratedOk = true;
    try {
      ids = sanitize(await boundedWork(makeDeadline(LIST_DEADLINE_MS, now), () => listIds(), LIST_DEADLINE_MS, 'integrity_list')).slice().sort();
    } catch (e) { log('identity_integrity_run', { ok: false, error: String((e && e.message) || e).slice(0, 160) }); return { ok: false, results: [] }; }
    const run = makeDeadline(runBudgetMs, now);
    const views = [];
    for (const rid of ids) {
      try { budget.reserve(2, 'views'); } catch (_) { enumeratedOk = false; break; }
      try { views.push(await viewOf(rid)); } catch (_) { views.push({ rid, coverage: {}, summary: null }); }
    }
    const results = [];
    for (const rid of S.scheduleOrder(views, now())) {
      if (run.stopped()) { results.push({ rid, outcome: 'not_reached' }); continue; }
      const ms = Math.min(restaurantMs, run.remaining());
      const stop = makeDeadline(ms, now);
      results.push(await race(checkRestaurant(rid, stop, budget, id, { quietMs }), ms + 1000, 'integrity_restaurant').catch((e) => ({ rid, outcome: 'failed', reason: String((e && e.message) || e).slice(0, 120) })));
    }
    // summaries for EVERY enumerated restaurant, processed or not (§6) — the compact children only
    let anyStale = false;
    const lines = [];
    for (const rid of ids) {
      let view;
      try { view = await viewOf(rid); } catch (_) { view = { coverage: {}, summary: null, unread: true }; }
      const line = S.summaryLine(rid, view, now());
      if (view.unread) { line.stale = 1; line.stale_reasons = ['state_unreadable']; }
      if (line.stale) anyStale = true;
      lines.push(line); log(line.event, line);
    }
    const covered = results.filter((r) => r.outcome === 'checked').length;
    if (enumeratedOk && !anyStale) log('identity_integrity_heartbeat', S.heartbeatLine({ enumerated: ids.length, covered }));
    log('identity_integrity_run', { ok: true, run: id, enumerated: ids.length, covered, reads: budget.used(), outcomes: results.map((r) => `${r.rid}:${r.outcome}`) });
    return { ok: true, run: id, ids, results, lines, reads: budget.used(), pacing: budget.log };
  }

  return { run, checkRestaurant, commit };
}

module.exports = {
  createIdentityIntegrityMonitor, createReadBudget, precheck, observeActive, observeAudit, evidenceCount, originOf, originOfVid,
  INTEGRITY_PATH, INTEGRITY_SCHEDULE, INTEGRITY_TIMEOUT_S, INTEGRITY_MEMORY, RUN_READ_CAP, READS_PER_SECOND, RESTAURANT_ALLOWANCE_MS,
  SUMMARY_RESERVE_MS, RUN_BUDGET_MS, QUIET_MS, OBJECT_PAGE, REGISTRY_BATCH, AUDIT_PAGE, CERT_READ_LIMIT, COUNT_LIMIT, GROWTH_LIMIT, READ_ONLY,
  BudgetDeferral, OversizedDeferral,
};
