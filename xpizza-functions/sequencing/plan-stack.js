'use strict';
// BUILD-stacked-seq-server r5 T4 — planStack: the stack decision, made BEFORE a writer's claim (no claim is ever held across the
// slow Routes call), and the ONE Admin commit transaction on stacks/{stack_id}.
//
//   1. fresh reads: the driver's tasks (the new order excluded from "exactly one other order"), both orders, both hubs
//      → stackGate (a refusal here is not cached: it is cheap and the facts move);
//   2. stacks/{id}: `committed` → REUSE its ranks + promise (no call), whichever member is now the incumbent;
//      `refused`, unexpired, with the SAME ready_at pair → refuse again (no call);
//   3. the key (no_key → refuse, not cached); 4. the budget transaction (over a cap → `budget`, not cached);
//   5. Routes → decide; 6. the commit transaction: null | refused → committed | refused; committed → abort and ADOPT it.
// That transaction is the single commit arbiter: concurrent planners on one pair finalize with the same ranks.
//
// 🔴 Every await races the decision deadline (bounded). On `deadline` the writer goes single with no claim. Anything still in
// flight completes LATE and harmlessly: a budget reservation only wastes elements; a late commit leaves a `committed` record for
// a pair the writer did NOT stack — a later pairing of the same pair on the same driver reuses it (never reorder), and the
// provenance rule (validity.js) keeps task copies inert.
const { ServerValue } = require('firebase-admin/database');
const { stackIdFor } = require('./id');
const { stackGate } = require('./gate');
const { decide } = require('./decide');
const { reserve, budgetKeys } = require('./budget');
const { bounded, isDeadline } = require('./bounded');
const { computeMatrix } = require('./routes-client');
const { hubForFresh } = require('../assign-hub');

const MIN = 60 * 1000;
const REFUSAL_TTL_MS = { over_6min: 30 * MIN, invalid_legs: 30 * MIN, traffic_unverified: 5 * MIN, deadline: 5 * MIN };
const ROUTES_DEADLINE_MS = 3000;
const TERMINAL_TASK = new Set(['completed', 'cancelled']);

// the driver's OTHER non-terminal orders (distinct order ids), the new order excluded
function otherOrders(tasks, uid, newOid) {
  const out = new Set();
  for (const t of Object.values(tasks || {})) {
    if (!t || t.assigned_driver_id !== uid || !t.order_id || t.order_id === newOid || TERMINAL_TASK.has(t.status)) continue;
    out.add(t.order_id);
  }
  return [...out];
}
const sameReady = (a, b) => !!a && !!b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
const decisionOf = (rec, stack_id, pair, incumbentOid) => ({ stack_id, pair, ranks: { ...rec.ranks }, plus_min: rec.plus_min, incumbentOid });
const validCommitted = (rec, pair) => !!rec && rec.state === 'committed' && !!rec.ranks
  && [1, 2].every((r) => pair.filter((o) => rec.ranks[o] === r).length === 1);

async function planStack({ db, uid, newOid, deadlineAt, transport, key, now = Date.now, gateOnly = false }) {
  const left = () => deadlineAt - Date.now();
  const b = (p) => bounded(p, left());
  let attempt = null;   // set once a Routes call is under way: { stack_id, pair, ready_at, at }
  try {
    // 1. fresh reads + the gate
    const tasks = (await b(db.ref('tasks').once('value'))).val() || {};
    const others = otherOrders(tasks, uid, newOid);
    if (others.length !== 1) return { stack: false, reason: 'not_one' };
    const incOid = others[0];
    const [incOrder, newOrder] = (await b(Promise.all([db.ref(`orders/${incOid}`).once('value'), db.ref(`orders/${newOid}`).once('value')]))).map((s) => s.val());
    const incPickup = tasks[`${incOid}_pickup`] || null;
    const newPickup = tasks[`${newOid}_pickup`] || null;
    const rids = [...new Set([incPickup, newPickup].map((p) => p && p.restaurant_id).filter((r) => typeof r === 'string'))];
    const hubs = Object.fromEntries(await b(Promise.all(rids.map(async (rid) => [rid, await hubForFresh(db, rid)]))));
    const g = stackGate({ incumbent: { oid: incOid, order: incOrder, pickup: incPickup }, candidate: { oid: newOid, order: newOrder, pickup: newPickup }, otherCount: 1, hubs });
    if (!g.ok) return { stack: false, reason: g.reason };
    if (gateOnly) return { stack: false, reason: 'no_time' };   // the caller may not plan (time / per-tick budget): the gate only

    // 2. the record: reuse a committed decision; honour an unexpired refusal for the same ready_at pair
    const { stack_id, pair } = stackIdFor(uid, incOid, newOid);
    const ready_at = { [incOid]: incOrder.prep.ready_at, [newOid]: newOrder.prep.ready_at };
    const t0 = now();
    const cur = (await b(db.ref(`stacks/${stack_id}`).once('value'))).val();
    if (cur && cur.state === 'committed') {
      return validCommitted(cur, pair) ? { stack: true, decision: decisionOf(cur, stack_id, pair, incOid) } : { stack: false, reason: 'invalid_record' };
    }
    if (cur && cur.state === 'refused' && Number.isFinite(cur.expires_at) && cur.expires_at > t0 && sameReady(cur.ready_at, ready_at)) {
      return { stack: false, reason: cur.reason };
    }

    // 3. key, 4. budget (neither refusal is cached)
    if (typeof key !== 'string' || key === '') return { stack: false, reason: 'no_key' };
    const { month, day } = budgetKeys(t0);
    let reserved;
    try { reserved = await b(db.ref(`counters/routes_elements/${month}`).transaction((c) => reserve(c, day))); }
    catch (e) { if (isDeadline(e)) throw e; return { stack: false, reason: 'budget' }; }
    if (!reserved || !reserved.committed) return { stack: false, reason: 'budget' };

    // 5. Routes → decide
    attempt = { stack_id, pair, ready_at, at: t0 };
    const T = Math.max(t0, ready_at[incOid], ready_at[newOid]);
    const m = await b(computeMatrix({ fetchImpl: transport, key, hub: g.hub, I: { lat: incOrder.lat, lng: incOrder.lng }, N: { lat: newOrder.lat, lng: newOrder.lng },
      departAt: T, nowMs: t0, deadlineMs: Math.min(ROUTES_DEADLINE_MS, Math.max(0, left())) }));
    let next;
    if (!m.ok) {
      if (m.reason === 'deadline') throw Object.assign(new Error('deadline'), { routesDeadline: true });
      next = { state: 'refused', driver_uid: uid, pair, reason: m.reason, ready_at, at: t0, expires_at: t0 + (REFUSAL_TTL_MS[m.reason] || 5 * MIN) };
    } else {
      const d = decide({ legs: m.legs });
      if (!d.stack) {
        next = { state: 'refused', driver_uid: uid, pair, reason: d.reason, ready_at, at: t0, expires_at: t0 + REFUSAL_TTL_MS[d.reason] };
      } else {
        const first = d.first === 'I' ? incOid : newOid;
        const second = first === incOid ? newOid : incOid;
        next = { state: 'committed', driver_uid: uid, pair, ranks: { [first]: 1, [second]: 2 }, plus_min: d.plus_min, plus_s: d.plus_s, hub_rid: g.hub_rid,
          depart_at: T, ready_at, legs_s: m.legs, decided_at: t0 };
      }
    }

    // 6. the commit transaction — the single arbiter
    let adopted = null;
    const res = await b(db.ref(`stacks/${stack_id}`).transaction((c) => {
      if (c && c.state === 'committed') { adopted = c; return undefined; }
      return next;
    }));
    const rec = res && res.committed ? next : (adopted || (res && res.snapshot && res.snapshot.val()));
    if (rec && rec.state === 'committed') {
      return validCommitted(rec, pair) ? { stack: true, decision: decisionOf(rec, stack_id, pair, incOid) } : { stack: false, reason: 'invalid_record' };
    }
    return { stack: false, reason: next.reason };
  } catch (e) {
    if (isDeadline(e) || (e && e.routesDeadline)) {
      // a deadline after a Routes call was attempted: cache the transient refusal (5 min) best-effort and NEVER awaited — the
      // budget is spent. The same transaction never touches a committed record (a late commit wins).
      if (attempt) {
        const rec = { state: 'refused', driver_uid: uid, pair: attempt.pair, reason: 'deadline', ready_at: attempt.ready_at, at: attempt.at, expires_at: attempt.at + REFUSAL_TTL_MS.deadline };
        Promise.resolve().then(() => db.ref(`stacks/${attempt.stack_id}`).transaction((c) => (c && c.state === 'committed' ? undefined : rec))).catch(() => {});
      }
      return { stack: false, reason: 'deadline' };
    }
    console.error(`stackseq planStack: failed for ${newOid} on ${uid} (${(e && (e.code || e.message)) || e})`);
    return { stack: false, reason: 'error' };
  }
}

// The finalize fragment: the five task-copy leaves for BOTH members (rank 1: stack_plus_min null). stack_at is the SAME
// ServerValue.TIMESTAMP the finalize writes as the new order's assigned_at, so provenance (assigned_at <= stack_at) holds.
function stackCopies(decision, uid) {
  const out = {};
  for (const oid of decision.pair) {
    const rank = decision.ranks[oid];
    const p = `tasks/${oid}_delivery`;
    out[`${p}/stack_id`] = decision.stack_id;
    out[`${p}/stop_seq`] = rank;
    out[`${p}/stack_uid`] = uid;
    out[`${p}/stack_at`] = ServerValue.TIMESTAMP;
    out[`${p}/stack_plus_min`] = rank === 2 ? decision.plus_min : null;
  }
  return out;
}

module.exports = { planStack, stackCopies, otherOrders, REFUSAL_TTL_MS };
