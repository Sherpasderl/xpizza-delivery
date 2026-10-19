/**
 * Pure driver-order FEED controller for the query-rules consumer (F2). No DOM, no Firebase — the real
 * subscription primitives are injected via `env`, so the whole membership / value-authority / readiness /
 * reconnect / revocation / session-generation / handoff contract is unit-tested in node with fakes
 * (`node driver-feed.test.js`, repo idiom). Mirrors the companion's injected-controller discipline.
 *
 * WHY this exists: F2 replaces the whole-node `/orders` + `/tasks` reads with an own-assignment task query,
 * per-order point listeners keyed off that task feed, and TWO delivered-by history queries (the union). The
 * controller is the ONE disposer that owns every one of those subscriptions and publishes a single coherent
 * `allOrders` (+ own tasks, + readiness, + own driver record) to the UI.
 *
 * LIVE MONEY PATH — correctness over convenience (codex F2b r1 fixes):
 * ── Reconnect RE-ATTACHES every source (a fresh onValue attach always emits the current server value;
 *    Firebase does NOT re-emit an unchanged subscription on reconnect — so flag-reset-and-wait would hang).
 * ── BC1 handoff reconciles a last-membership-removed order via a SERVER-FRESH per-oid read (env.reconcileOrderOnce,
 *    which reads the order POINT path that has no active listener → a real network read, not the empty cache),
 *    and FAILS CLOSED on reject (the order stays published + pending, retried on reconnect / next task snapshot).
 * ── Authoritative membership (a task re-add, a live history emission, or a revocation) always SUPERSEDES a
 *    pending/late reconcile — a stale result can never resurrect a removed order.
 * ── Revocation (PERMISSION_DENIED) removes the oid from EVERYTHING published immediately (orders AND task legs).
 * ── Source errors FAIL CLOSED: readiness → loading and the failed source's contribution is dropped.
 *
 * `env` (all injected; the live wiring lives in xpizza-delivery.js):
 *   subscribeOwnTasks(cb, onError) -> unsub        cb(ownTasksMap); onError(err) on task-query cancellation
 *   subscribeOrder(oid, cb, onRevoked, onError) -> unsub
 *                                          cb(value|null); onRevoked() on PERMISSION_DENIED (revocation);
 *                                          onError(err) on any OTHER point error (fail closed, not revocation)
 *   subscribeHistory(which, cb, onError) -> unsub   which ∈ 'primary'|'legacy'
 *   reconcileOrderOnce(oid) -> Promise<{ value, keep }>   SERVER-fresh order read + attribution check (keep =
 *                                          delivered_by_driver_uid===uid || delivered_by_uid===uid)
 *   onReconnect(cb) -> unsub                fires on each false->true RTDB reconnect edge
 *   filterLiveOrders(ordersMap) -> ordersMap   status-only presence filter
 *   emit: { onOrders(allOrders), onTasks(ownTasks), onReadiness('loading'|'ready'), onDriver(record|null) }
 *   subscribeOwnDriver(cb, onError) -> unsub   cb(record|null); onError(err) on own-driver cancellation
 */

export const READY = 'ready';
export const LOADING = 'loading';

export function makeDriverFeed(env) {
  const emit = (env && env.emit) || {};
  const filterLive = (env && env.filterLiveOrders) || ((m) => m || {});

  let gen = 0;
  const isLive = (g) => g === gen;

  // ---- per-session mutable state ----
  let ownTasks = {};
  let tasksEmitted = false;
  let tasksErrored = false;
  let histEmitted = { primary: false, legacy: false };
  let histErrored = { primary: false, legacy: false };
  let hist = { primary: {}, legacy: {} };
  const orderSubs = new Map();     // oid -> { unsub, emitted, value, present, revoked, errored }
  const revokedOids = new Set();   // oids revoked (PERMISSION_DENIED) — suppressed from EVERYTHING published
  const handoff = new Set();       // oids awaiting their first BC1 reconcile
  const handoffRetry = new Set();  // oids whose reconcile REJECTED — retried on reconnect / next task snapshot
  const handoffValue = new Map();  // oid -> last-known value kept published (fail-closed) while a handoff is pending
  const handoffEpoch = new Map();  // oid -> per-ATTEMPT token (codex r2 #1): a reconcile applies only if the oid's epoch is unchanged since it started — a newer handoff / any supersession bumps it, invalidating an older reconcile
  const confirmed = new Map();     // oid -> value, server-reconciled as delivered + attributed to me (persists)
  let lastReadiness = null;
  let lastDriver = undefined;

  let unsubTasks = null, unsubHist = { primary: null, legacy: null }, unsubReconnect = null, unsubDriver = null;

  function _resetState() {
    ownTasks = {}; tasksEmitted = false; tasksErrored = false;
    histEmitted = { primary: false, legacy: false };
    histErrored = { primary: false, legacy: false };
    hist = { primary: {}, legacy: {} };
    for (const s of orderSubs.values()) { try { s.unsub && s.unsub(); } catch (_) {} }
    orderSubs.clear(); revokedOids.clear();
    handoff.clear(); handoffRetry.clear(); handoffValue.clear(); handoffEpoch.clear(); confirmed.clear();
    lastReadiness = null; lastDriver = undefined;
  }

  // ---- membership + value (pure over current state) ----
  function taskOids() {
    const s = new Set();
    for (const id in ownTasks) {
      const t = ownTasks[id];
      if (t && t.order_id != null && !revokedOids.has(String(t.order_id))) s.add(String(t.order_id));
    }
    return s;
  }
  // RAW task membership — EVERY oid referenced by own tasks, NOT filtered by revocation. A revocation clears only
  // when the raw tasks actually drop the oid (codex r2 #2), never on an unrelated task update.
  function rawTaskOids() {
    const s = new Set();
    for (const id in ownTasks) { const t = ownTasks[id]; if (t && t.order_id != null) s.add(String(t.order_id)); }
    return s;
  }
  function valueFor(oid) {
    const sub = orderSubs.get(oid);
    // BC2: point listener's latest wins — BUT an ERRORED point drops its value authority (codex r2 #3), so an
    // order with independent history membership publishes the history value, never the stale point value.
    if (sub && sub.present && !sub.errored && sub.value != null) return sub.value;
    if (hist.primary[oid] != null) return hist.primary[oid];
    if (hist.legacy[oid] != null) return hist.legacy[oid];
    if (confirmed.has(oid)) return confirmed.get(oid);               // server-reconciled attributed delivered order
    if (handoffValue.has(oid)) return handoffValue.get(oid);         // fail-closed value while a handoff is pending
    return null;
  }
  function membershipNonEmpty(oid, tOids) {
    if (revokedOids.has(oid)) return false;                          // revoked → never published (fix #5)
    if (tOids.has(oid)) return true;
    if (hist.primary[oid] != null || hist.legacy[oid] != null) return true;
    if (confirmed.has(oid)) return true;
    if (handoff.has(oid) || handoffRetry.has(oid)) return true;      // pending handoff keeps it published (no undercount)
    return false;
  }
  function buildAllOrders() {
    const tOids = taskOids();
    const candidates = new Set([...tOids, ...Object.keys(hist.primary), ...Object.keys(hist.legacy),
      ...confirmed.keys(), ...handoff, ...handoffRetry]);
    const raw = {};
    for (const oid of candidates) {
      if (!membershipNonEmpty(oid, tOids)) continue;
      const v = valueFor(oid);
      if (v == null) continue;
      raw[oid] = v;
    }
    return filterLive(raw);   // presence invariant: STATUS-ONLY live filter
  }
  // Published own-tasks EXCLUDE a revoked oid's legs immediately (fix #5: getDriverOrders accepts a null order,
  // so a retained task pair would still render a card for a revoked order).
  function publishedOwnTasks() {
    if (!revokedOids.size) return ownTasks;
    const out = {};
    for (const id in ownTasks) {
      const t = ownTasks[id];
      if (t && t.order_id != null && revokedOids.has(String(t.order_id))) continue;
      out[id] = t;
    }
    return out;
  }

  // ---- readiness: ready iff every needed source has a current post-connect emission (handoff is separate — it
  // blocks FINALIZE via hasPendingHandoff, not readiness) ----
  function computeReadiness() {
    if (!tasksEmitted || tasksErrored) return LOADING;
    if (!histEmitted.primary || !histEmitted.legacy) return LOADING;
    if (histErrored.primary || histErrored.legacy) return LOADING;
    for (const sub of orderSubs.values()) {
      if (sub.revoked) continue;
      if (!sub.emitted || sub.errored) return LOADING;   // fail closed on a referenced order not yet fresh / errored
    }
    return READY;
  }
  function publish() {
    if (emit.onTasks && tasksEmitted) emit.onTasks(publishedOwnTasks());   // fix #8: never the synthetic pre-emit {}
    if (emit.onOrders) emit.onOrders(buildAllOrders());
    const r = computeReadiness();
    if (r !== lastReadiness) { lastReadiness = r; if (emit.onReadiness) emit.onReadiness(r); }
  }

  // ---- per-order point listeners ----
  // Supersession (task re-add / live history / revocation / resolved reconcile) bumps the epoch so any still-pending
  // reconcile for a PRIOR attempt is invalidated (codex r2 #1).
  function clearHandoffState(oid) { handoff.delete(oid); handoffRetry.delete(oid); handoffValue.delete(oid); handoffEpoch.set(oid, (handoffEpoch.get(oid) || 0) + 1); }

  function attachOrder(oid) {
    if (orderSubs.has(oid) || revokedOids.has(oid)) return;
    const myGen = gen;
    const rec = { unsub: null, emitted: false, value: undefined, present: false, revoked: false, errored: false };
    orderSubs.set(oid, rec);
    rec.unsub = env.subscribeOrder(oid, (value) => {            // value snapshot
      if (!isLive(myGen)) return;
      const r = orderSubs.get(oid);
      if (!r || r !== rec || r.revoked) return;
      r.emitted = true; r.errored = false;
      r.present = value != null;
      r.value = value != null ? value : undefined;
      publish();
    }, () => {                                                  // onRevoked (PERMISSION_DENIED)
      if (!isLive(myGen)) return;
      const r = orderSubs.get(oid);
      if (!r || r !== rec) return;
      r.revoked = true;
      try { r.unsub && r.unsub(); } catch (_) {}
      orderSubs.delete(oid);
      revokedOids.add(oid);
      // fix #5: remove the oid from EVERY membership source so it leaves allOrders AND the card immediately.
      delete hist.primary[oid]; delete hist.legacy[oid]; confirmed.delete(oid); clearHandoffState(oid);
      publish();
    }, (/* err */) => {                                         // onError (non-permission point error): fail closed
      if (!isLive(myGen)) return;
      const r = orderSubs.get(oid);
      if (!r || r !== rec || r.revoked) return;
      r.errored = true;                                         // readiness → loading until it recovers (reconnect re-attach)
      publish();
    });
  }
  function detachOrder(oid) {
    const r = orderSubs.get(oid);
    if (!r) return;
    try { r.unsub && r.unsub(); } catch (_) {}
    orderSubs.delete(oid);
  }

  function reconcileOrderSubs() {
    const tOids = taskOids();
    // a task re-adding an oid supersedes any pending handoff / confirmed (membership resumes via the task)
    for (const oid of tOids) { if (handoff.has(oid) || handoffRetry.has(oid)) clearHandoffState(oid); confirmed.delete(oid); }
    const rOids = rawTaskOids();   // codex r2 #2: clear a revocation ONLY when the RAW tasks drop the oid (tOids already excludes revoked, so it can't gate this)
    for (const oid of [...revokedOids]) if (!rOids.has(oid)) revokedOids.delete(oid);
    for (const oid of tOids) attachOrder(oid);
    for (const oid of [...orderSubs.keys()]) {
      if (tOids.has(oid)) continue;
      if (hist.primary[oid] != null || hist.legacy[oid] != null) { detachOrder(oid); continue; }
      beginHandoff(oid);
    }
    // fix #3: retry rejected handoffs that still lack task + live-history membership
    for (const oid of [...handoffRetry]) {
      if (tOids.has(oid) || hist.primary[oid] != null || hist.legacy[oid] != null) { clearHandoffState(oid); continue; }
      handoffRetry.delete(oid); beginHandoff(oid);
    }
  }

  // BC1: on a last-membership task removal, keep the order published (fail closed) + block FINALIZE until a
  // SERVER-FRESH per-oid reconcile resolves (fix #2: the order POINT path has no active listener after detach →
  // a real network read, never the empty history cache).
  function beginHandoff(oid) {
    if (handoff.has(oid)) return;
    handoffRetry.delete(oid);
    const prev = orderSubs.get(oid);
    const keepVal = prev && prev.present ? prev.value : (confirmed.has(oid) ? confirmed.get(oid) : handoffValue.get(oid));
    detachOrder(oid);
    handoff.add(oid);
    if (keepVal != null) handoffValue.set(oid, keepVal);   // stay published while reconciling (no undercount)
    const myGen = gen;
    const myEpoch = (handoffEpoch.get(oid) || 0) + 1;      // codex r2 #1: this attempt's token
    handoffEpoch.set(oid, myEpoch);
    // Apply this reconcile ONLY if it is still the current attempt: live session, still pending, and the epoch
    // unchanged (a newer handoff or any supersession bumps the epoch → an older reconcile is ignored).
    const stillCurrent = () => isLive(myGen) && handoff.has(oid) && handoffEpoch.get(oid) === myEpoch;
    Promise.resolve()
      .then(() => env.reconcileOrderOnce(oid))
      .then((res) => {
        if (!stillCurrent()) return;                        // fix #1/#4: superseded by a newer attempt / task re-add / live hist / revocation
        handoff.delete(oid); handoffValue.delete(oid);
        if (res && res.keep && res.value != null) confirmed.set(oid, res.value);   // delivered + attributed to me
        else confirmed.delete(oid);                         // genuinely not mine → drop
        publish();
      })
      .catch(() => {
        if (!stillCurrent()) return;
        handoff.delete(oid);
        handoffRetry.add(oid);                              // fix #3: fail closed — stays published + pending; retried later
        publish();
      });
  }

  // ---- source callbacks ----
  function onTasksSnapshot(tasksMap) {
    ownTasks = tasksMap || {};
    tasksEmitted = true; tasksErrored = false;
    reconcileOrderSubs();
    publish();
  }
  function onTasksError() {
    // fix #6: fail closed — drop the task contribution (task-only orders vanish), hold readiness. Orders with
    // independent history / confirmed membership survive. A later successful task emission recovers.
    tasksErrored = true; ownTasks = {};
    publish();
  }
  function onHistorySnapshot(which, ordersMap) {
    const map = ordersMap || {};
    // never let a live history emission resurrect a revoked order
    for (const oid of revokedOids) if (map[oid] != null) delete map[oid];
    hist[which] = map;
    histEmitted[which] = true; histErrored[which] = false;
    // a live history emission is authoritative for the oids it carries → supersede any pending handoff / fail-closed
    // value / server-reconciled confirmation for those oids (fix #4).
    for (const oid in map) { clearHandoffState(oid); confirmed.delete(oid); }
    publish();
  }
  function onHistoryError(which) {
    // fix #6: drop the stale map AND hold readiness (previously it kept publishing the stale map).
    hist[which] = {};
    histErrored[which] = true; histEmitted[which] = false;
    publish();
  }

  // ---- (re)attach helpers ----
  function attachTaskAndHistory(myGen) {
    unsubTasks = env.subscribeOwnTasks(
      (m) => { if (isLive(myGen)) onTasksSnapshot(m); },
      () => { if (isLive(myGen)) onTasksError(); });
    unsubHist.primary = env.subscribeHistory('primary',
      (m) => { if (isLive(myGen)) onHistorySnapshot('primary', m); },
      () => { if (isLive(myGen)) onHistoryError('primary'); });
    unsubHist.legacy = env.subscribeHistory('legacy',
      (m) => { if (isLive(myGen)) onHistorySnapshot('legacy', m); },
      () => { if (isLive(myGen)) onHistoryError('legacy'); });
  }

  function onReconnectEdge() {
    // fix #1: Firebase does not re-emit an unchanged subscription on reconnect — DETACH + RE-ATTACH every source
    // so each one emits a fresh server value. State (ownTasks, hist, confirmed, handoff…) is preserved; only the
    // emission flags reset. Readiness → loading until the fresh emissions land.
    const reattachOids = [...orderSubs.keys()].filter((oid) => !revokedOids.has(oid));
    try { unsubTasks && unsubTasks(); } catch (_) {}
    try { unsubHist.primary && unsubHist.primary(); } catch (_) {}
    try { unsubHist.legacy && unsubHist.legacy(); } catch (_) {}
    try { unsubDriver && unsubDriver(); } catch (_) {}
    for (const s of orderSubs.values()) { try { s.unsub && s.unsub(); } catch (_) {} }
    orderSubs.clear();
    tasksEmitted = false; tasksErrored = false;
    histEmitted = { primary: false, legacy: false };
    histErrored = { primary: false, legacy: false };
    const myGen = gen;
    attachTaskAndHistory(myGen);
    for (const oid of reattachOids) attachOrder(oid);        // fresh per-order listeners → fresh emissions
    if (env.subscribeOwnDriver) unsubDriver = env.subscribeOwnDriver(
      (rec) => { if (isLive(myGen)) onDriverSnapshot(rec); },
      () => { if (isLive(myGen)) onDriverError(); });
    // fix #3: re-drive any rejected handoffs now that we're back online
    for (const oid of [...handoffRetry]) { handoffRetry.delete(oid); beginHandoff(oid); }
    publish();
  }

  function onDriverSnapshot(record) {
    lastDriver = record != null ? record : null;
    if (emit.onDriver) emit.onDriver(lastDriver);
  }
  function onDriverError() {
    // fix #6/#7: surface so the UI fails cash closed (index.html gates the cuadre on driverState != null).
    lastDriver = null;
    if (emit.onDriver) emit.onDriver(null);
  }

  // ---- public API ----
  function start() {
    gen += 1;
    _resetState();
    const myGen = gen;
    attachTaskAndHistory(myGen);
    if (env.onReconnect) unsubReconnect = env.onReconnect(() => { if (isLive(myGen)) onReconnectEdge(); });
    if (env.subscribeOwnDriver) unsubDriver = env.subscribeOwnDriver(
      (rec) => { if (isLive(myGen)) onDriverSnapshot(rec); },
      () => { if (isLive(myGen)) onDriverError(); });
    publish();   // initial LOADING (no synthetic onTasks — fix #8: tasksEmitted is false)
  }
  function dispose() {
    gen += 1;
    try { unsubTasks && unsubTasks(); } catch (_) {}
    try { unsubHist.primary && unsubHist.primary(); } catch (_) {}
    try { unsubHist.legacy && unsubHist.legacy(); } catch (_) {}
    try { unsubReconnect && unsubReconnect(); } catch (_) {}
    try { unsubDriver && unsubDriver(); } catch (_) {}
    unsubTasks = unsubReconnect = unsubDriver = null;
    unsubHist = { primary: null, legacy: null };
    _resetState();
  }

  return {
    start, dispose,
    isReady: () => computeReadiness() === READY,
    readiness: () => computeReadiness(),
    hasPendingHandoff: () => handoff.size > 0 || handoffRetry.size > 0,
    getOrders: () => buildAllOrders(),
    getOwnTasks: () => publishedOwnTasks(),
    getDriver: () => (lastDriver === undefined ? null : lastDriver),
    _state: () => ({
      gen, ownTasks, tasksEmitted, tasksErrored, histEmitted: { ...histEmitted }, histErrored: { ...histErrored },
      hist: { primary: { ...hist.primary }, legacy: { ...hist.legacy } },
      orderSubs: new Map([...orderSubs].map(([k, v]) => [k, { emitted: v.emitted, present: v.present, value: v.value, revoked: v.revoked, errored: v.errored }])),
      revokedOids: new Set(revokedOids), handoff: new Set(handoff), handoffRetry: new Set(handoffRetry),
      handoffValue: new Map(handoffValue), confirmed: new Map(confirmed),
    }),
  };
}
