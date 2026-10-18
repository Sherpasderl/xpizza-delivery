/**
 * Pure driver-order FEED controller for the query-rules consumer (F2). No DOM, no Firebase — the real
 * subscription primitives are injected via `env`, so the whole membership / value-authority / readiness /
 * reconnect / revocation / session-generation / handoff contract is unit-tested in node with fakes
 * (`node driver-feed.test.js`, repo idiom). Mirrors the companion's injected-controller discipline
 * (onboarding-helpers.js `makeCompanionController`).
 *
 * WHY this exists: F2 replaces the whole-node `/orders` + `/tasks` reads with an own-assignment task query,
 * per-order point listeners keyed off that task feed, and TWO delivered-by history queries (the union). The
 * controller is the ONE disposer that owns every one of those subscriptions and publishes a single coherent
 * `allOrders` (+ own tasks, + readiness, + own driver record) to the UI.
 *
 * ── Membership (which sources reference an oid) is kept SEPARATE from value (what the order node holds):
 *    membership(oid) = { taskLeg, histPrimary, histLegacy }; an oid is a publication candidate iff membership
 *    is non-empty. A task-referenced oid also gets a per-order point listener.
 * ── Value authority (BC2): the SDK cache coalesces `orders/{oid}` to its newest synced value, so we take the
 *    point listener's latest snapshot when present, else the (same, coherent) history-query child. No arrival
 *    marker — there is no independent stale snapshot to guard.
 * ── Presence invariant: published iff membership non-empty AND the value passes the STATUS-ONLY live filter.
 *
 * `env` (all injected; the live wiring lives in xpizza-delivery.js):
 *   subscribeOwnTasks(cb) -> unsub         cb(ownTasksMap) on each own-assignment task-query snapshot
 *   subscribeOrder(oid, cb, onRevoked) -> unsub
 *                                          cb(value|null) on each point snapshot; onRevoked() on a
 *                                          PERMISSION_DENIED cancel (revocation — order no longer granted)
 *   subscribeHistory(which, cb, onError) -> unsub   which ∈ 'primary' | 'legacy'; cb(ordersMap); onError(err)
 *   getHistoryOnce() -> Promise<{ primary: map, legacy: map }>   BC1 fresh reconcile (BOTH queries)
 *   onReconnect(cb) -> unsub                fires cb() on each false->true RTDB reconnect edge
 *   filterLiveOrders(ordersMap) -> ordersMap   status-only presence filter (NON_LIVE_ORDER_STATUSES)
 *   emit: { onOrders(allOrders), onTasks(ownTasks), onReadiness('loading'|'ready'), onDriver(record|null) }
 *   subscribeOwnDriver(cb, onError?) -> unsub   (optional; §8) cb(record|null) for drivers/{uid}
 *
 * The controller NEVER constructs a Firebase ref or query; it only orchestrates the injected primitives.
 */

export const READY = 'ready';
export const LOADING = 'loading';

export function makeDriverFeed(env) {
  const emit = (env && env.emit) || {};
  const filterLive = (env && env.filterLiveOrders) || ((m) => m || {});

  // ---- session generation: every subscription callback captures the gen live at attach; a callback from a
  // disposed / superseded session is rejected before it touches any state (§7). dispose() bumps the gen.
  let gen = 0;

  // ---- per-session mutable state (reset by _resetState) ----
  let ownTasks = {};                 // taskId -> task (latest own-assignment query snapshot)
  let tasksEmitted = false;          // the task query has emitted once since the last (re)connect
  let histEmitted = { primary: false, legacy: false };
  let histErrored = { primary: false, legacy: false };
  let hist = { primary: {}, legacy: {} };   // oid -> order value, per history query
  const orderSubs = new Map();       // oid -> { unsub, emitted, value, present }  (per-order point listeners)
  const revokedOids = new Set();     // oids revoked (PERMISSION_DENIED) — not re-attached until the task feed drops them (NO retry loop)
  const handoff = new Set();         // oids whose LAST-membership removal is awaiting a BC1 reconcile get()
  const histOverride = new Map();    // oid -> value kept alive by a resolved BC1 reconcile until a live hist emit
  let lastReadiness = null;
  let lastDriver = undefined;

  // top-level disposers (task query, both history queries, reconnect edge, own-driver)
  let unsubTasks = null, unsubHist = { primary: null, legacy: null }, unsubReconnect = null, unsubDriver = null;

  const isLive = (g) => g === gen;   // reject stale-session callbacks

  function _resetState() {
    ownTasks = {};
    tasksEmitted = false;
    histEmitted = { primary: false, legacy: false };
    histErrored = { primary: false, legacy: false };
    hist = { primary: {}, legacy: {} };
    for (const s of orderSubs.values()) { try { s.unsub && s.unsub(); } catch (_) {} }
    orderSubs.clear();
    revokedOids.clear();
    handoff.clear();
    histOverride.clear();
    lastReadiness = null;
    lastDriver = undefined;
  }

  // ---- membership + value (pure over current state) ----
  function taskOids() {
    const s = new Set();
    for (const id in ownTasks) {
      const t = ownTasks[id];
      if (t && t.order_id != null) s.add(String(t.order_id));
    }
    return s;
  }

  function valueFor(oid) {
    // BC2: point listener's latest wins; else the coherent history child; else a resolved BC1 override.
    const sub = orderSubs.get(oid);
    if (sub && sub.present && sub.value != null) return sub.value;
    if (hist.primary[oid] != null) return hist.primary[oid];
    if (hist.legacy[oid] != null) return hist.legacy[oid];
    if (histOverride.has(oid)) return histOverride.get(oid);
    return null;
  }

  function membershipNonEmpty(oid, tOids) {
    if (tOids.has(oid)) return true;                       // a current own task references it
    if (hist.primary[oid] != null || hist.legacy[oid] != null) return true;
    if (histOverride.has(oid)) return true;                // kept alive by a resolved reconcile (BC1)
    return false;
  }

  function buildAllOrders() {
    const tOids = taskOids();
    const candidates = new Set([...tOids, ...Object.keys(hist.primary), ...Object.keys(hist.legacy), ...histOverride.keys()]);
    const raw = {};
    for (const oid of candidates) {
      if (!membershipNonEmpty(oid, tOids)) continue;
      const v = valueFor(oid);
      if (v == null) continue;                             // membership without a value yet → not published
      raw[oid] = v;
    }
    // Presence invariant: STATUS-ONLY live filter (never a restaurant filter).
    return filterLive(raw);
  }

  // ---- readiness (ongoing): ready iff every needed source has a current post-connect emission ----
  function computeReadiness() {
    if (!tasksEmitted) return LOADING;
    if (!histEmitted.primary || !histEmitted.legacy) return LOADING;
    if (histErrored.primary || histErrored.legacy) return LOADING;   // a source-level error holds loading (§10 iii)
    for (const sub of orderSubs.values()) {                          // a referenced order whose listener hasn't emitted → loading
      if (!sub.revoked && !sub.emitted) return LOADING;
    }
    return READY;
  }

  function publish() {
    if (emit.onTasks) emit.onTasks(ownTasks);
    if (emit.onOrders) emit.onOrders(buildAllOrders());
    const r = computeReadiness();
    if (r !== lastReadiness) { lastReadiness = r; if (emit.onReadiness) emit.onReadiness(r); }
  }

  // ---- per-order point listeners: attach/detach to match the task-referenced oid set ----
  function attachOrder(oid) {
    if (orderSubs.has(oid)) return;
    if (revokedOids.has(oid)) return;                      // revoked + still briefly task-referenced → do NOT re-attach (no retry loop)
    const myGen = gen;
    const rec = { unsub: null, emitted: false, value: undefined, present: false, revoked: false };
    orderSubs.set(oid, rec);   // register BEFORE subscribing so a synchronous (cached) callback finds rec
    rec.unsub = env.subscribeOrder(oid, (value) => {
      if (!isLive(myGen)) return;
      const r = orderSubs.get(oid);
      if (!r || r !== rec || r.revoked) return;            // detached / superseded / revoked → reject late callback
      r.emitted = true;
      r.present = value != null;
      r.value = value != null ? value : undefined;
      publish();
    }, () => {
      // REVOCATION (BC3, measured): PERMISSION_DENIED cancel = this order is no longer granted to me by ANY
      // path. Remove it, tear down, NO retry, readiness NOT held on its account.
      if (!isLive(myGen)) return;
      const r = orderSubs.get(oid);
      if (!r || r !== rec) return;
      r.revoked = true;
      try { r.unsub && r.unsub(); } catch (_) {}
      orderSubs.delete(oid);
      revokedOids.add(oid);                                // guard against immediate re-attach from a stale task snapshot
      histOverride.delete(oid);
      handoff.delete(oid);
      publish();
    });
  }

  function detachOrder(oid) {
    const r = orderSubs.get(oid);
    if (!r) return;
    try { r.unsub && r.unsub(); } catch (_) {}
    orderSubs.delete(oid);
  }

  // Reconcile per-order listeners against the current task-referenced oid set. Newly-referenced → attach;
  // no-longer-referenced → BC1 handoff if removing it would empty the oid's membership, else detach now.
  function reconcileOrderSubs() {
    const tOids = taskOids();
    for (const oid of [...revokedOids]) if (!tOids.has(oid)) revokedOids.delete(oid);   // task feed dropped it → a future re-assignment may re-attach
    for (const oid of tOids) attachOrder(oid);
    for (const oid of [...orderSubs.keys()]) {
      if (tOids.has(oid)) continue;                        // still referenced by a task → keep
      // The task leg is gone. If a LIVE history source still references it, drop the point listener now
      // (history supplies value+membership). Otherwise this removal would empty membership → BC1 handoff.
      if (hist.primary[oid] != null || hist.legacy[oid] != null) { detachOrder(oid); continue; }
      beginHandoff(oid);
    }
  }

  // BC1: do NOT remove on last-membership loss until ONE fresh get() of BOTH history queries resolves. The
  // assignment card is already gone (task removed from ownTasks); only cash FINALIZATION is blocked via the
  // pending-handoff state until this resolves — so confirmation can never undercount a just-delivered order.
  function beginHandoff(oid) {
    if (handoff.has(oid)) return;
    handoff.add(oid);
    detachOrder(oid);                                      // the point listener's grant is gone with the task
    const myGen = gen;
    Promise.resolve()
      .then(() => env.getHistoryOnce())
      .then((res) => {
        if (!isLive(myGen)) return;
        if (!handoff.has(oid)) return;                     // superseded (re-added, revoked, disposed)
        handoff.delete(oid);
        const fromHist = (res && res.primary && res.primary[oid] != null) ? res.primary[oid]
                       : (res && res.legacy && res.legacy[oid] != null) ? res.legacy[oid]
                       : null;
        if (fromHist != null) histOverride.set(oid, fromHist);   // keep it via history (delivered, attributed)
        // else: neither query returned it → genuinely gone; nothing kept.
        publish();
      })
      .catch(() => {
        if (!isLive(myGen)) return;
        // Reconcile failed: do NOT silently drop a possibly-delivered order. Keep the oid pending so finalize
        // stays blocked; a reconnect / next task snapshot re-drives reconciliation.
        publish();
      });
  }

  // ---- source callbacks ----
  function onTasksSnapshot(tasksMap) {
    ownTasks = tasksMap || {};
    tasksEmitted = true;
    reconcileOrderSubs();
    publish();
  }

  function onHistorySnapshot(which, ordersMap) {
    hist[which] = ordersMap || {};
    histEmitted[which] = true;
    histErrored[which] = false;
    // A live history emit supersedes any BC1 override for the oids it now carries.
    for (const oid in hist[which]) if (histOverride.has(oid)) histOverride.delete(oid);
    publish();
  }

  function onHistoryError(which) {
    // Source-level cancel/error on a source that SHOULD still be in scope → drop that source + hold readiness
    // 'loading' (§10 iii). Distinct from a per-order revocation.
    histErrored[which] = true;
    histEmitted[which] = false;
    publish();
  }

  function onReconnectEdge() {
    // BC3: readiness returns to 'loading' and stays there until EVERY active listener AND BOTH history queries
    // have emitted once AFTER the reconnect. No duplicate listeners; cached/local events are not fresh proof.
    tasksEmitted = false;
    histEmitted = { primary: false, legacy: false };
    histErrored = { primary: false, legacy: false };
    for (const sub of orderSubs.values()) sub.emitted = false;
    publish();   // → LOADING; sources re-emit post-reconnect and flip it back to READY
  }

  function onDriverSnapshot(record) {
    lastDriver = record != null ? record : null;
    if (emit.onDriver) emit.onDriver(lastDriver);
  }

  // ---- public API ----
  function start() {
    gen += 1;
    _resetState();
    const myGen = gen;
    unsubTasks = env.subscribeOwnTasks((m) => { if (isLive(myGen)) onTasksSnapshot(m); });
    unsubHist.primary = env.subscribeHistory('primary', (m) => { if (isLive(myGen)) onHistorySnapshot('primary', m); }, () => { if (isLive(myGen)) onHistoryError('primary'); });
    unsubHist.legacy = env.subscribeHistory('legacy', (m) => { if (isLive(myGen)) onHistorySnapshot('legacy', m); }, () => { if (isLive(myGen)) onHistoryError('legacy'); });
    if (env.onReconnect) unsubReconnect = env.onReconnect(() => { if (isLive(myGen)) onReconnectEdge(); });
    if (env.subscribeOwnDriver) unsubDriver = env.subscribeOwnDriver((rec) => { if (isLive(myGen)) onDriverSnapshot(rec); }, () => {});
    publish();   // emit the initial LOADING
  }

  function dispose() {
    gen += 1;                                              // invalidate every in-flight callback first
    try { unsubTasks && unsubTasks(); } catch (_) {}
    try { unsubHist.primary && unsubHist.primary(); } catch (_) {}
    try { unsubHist.legacy && unsubHist.legacy(); } catch (_) {}
    try { unsubReconnect && unsubReconnect(); } catch (_) {}
    try { unsubDriver && unsubDriver(); } catch (_) {}
    unsubTasks = unsubReconnect = unsubDriver = null;
    unsubHist = { primary: null, legacy: null };
    _resetState();
    lastReadiness = null;
  }

  return {
    start,
    dispose,
    // reads (for the UI + cuadre gate)
    isReady: () => computeReadiness() === READY,
    readiness: () => computeReadiness(),
    hasPendingHandoff: () => handoff.size > 0,
    getOrders: () => buildAllOrders(),
    getOwnTasks: () => ownTasks,
    getDriver: () => (lastDriver === undefined ? null : lastDriver),
    // test-only introspection
    _state: () => ({
      gen, ownTasks, tasksEmitted, histEmitted: { ...histEmitted }, histErrored: { ...histErrored },
      hist: { primary: { ...hist.primary }, legacy: { ...hist.legacy } },
      orderSubs: new Map([...orderSubs].map(([k, v]) => [k, { emitted: v.emitted, present: v.present, value: v.value, revoked: v.revoked }])),
      handoff: new Set(handoff), histOverride: new Map(histOverride),
    }),
  };
}
