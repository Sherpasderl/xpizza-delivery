'use strict';
// BUILD-stacked-seq-server r5 T5 — the writer-side helpers. autoAssignOnOrderCreate and sweepPendingOrders call these from small
// index.js hunks; monitorAssignmentTimeout NEVER does (D12: it is byte-identical with the flag ON or OFF).
//
//   readSeqFlag(db)          config/stack_sequencing_enabled, read ONCE per invocation; only === true is ON (fail OFF)
//   filterEligible(...)      pickEligibleDriver's {stackFilter}: a 1-order driver stays a candidate iff the pair is CROSS-HUB
//                            (D7 phase 1: today's rule exactly) or same-hub AND the cheap gate passes (prep + coords)
//   planForWriter(...)       { mode:'today' } (cross-hub / not one other order) | { mode:'single', reason } | { mode:'stack', … }
//   postClaimSeq(...)        the post-claim checks under a SEPARATE 3 s budget; a stall throws `deadline`
const { stackGate } = require('./gate');
const { planStack } = require('./plan-stack');
const { candidateState, confirmIncumbent } = require('./post-claim');
const { bounded } = require('./bounded');
const { hubForFresh } = require('../assign-hub');

const PLAN_DEADLINE_MS = 5000;   // one decision: reads + budget + Routes
const MIN_LEFT_MS = 20000;       // plan only with ≥ 20 s left of the invocation
const POST_CLAIM_MS = 3000;      // the post-claim reads, a separate budget
const TODAY = new Set(['cross_hub', 'not_one']);

async function readSeqFlag(db) {
  try { return (await db.ref('config/stack_sequencing_enabled').once('value')).val() === true; }
  catch (e) { console.warn(`stackseq: flag read failed (${(e && e.message) || e}) — OFF`); return false; }
}

// eligible: pickEligibleDriver's ranked entries; activeByDriver: { uid → Set(orderId) }. Returns the kept entries, in order.
async function filterEligible(db, tasks, eligible, activeByDriver, newOid) {
  const hubCache = new Map();
  const hub = (rid) => { if (!hubCache.has(rid)) hubCache.set(rid, hubForFresh(db, rid)); return hubCache.get(rid); };
  let newOrder;
  const kept = [];
  for (const e of eligible) {
    if (e.orderCount !== 1) { kept.push(e); continue; }
    try {
      const incOid = [...(activeByDriver[e.driverId] || [])][0];
      if (newOrder === undefined) newOrder = (await db.ref(`orders/${newOid}`).once('value')).val();
      const incOrder = (await db.ref(`orders/${incOid}`).once('value')).val();
      const incPickup = tasks[`${incOid}_pickup`] || null; const newPickup = tasks[`${newOid}_pickup`] || null;
      const rids = [...new Set([incPickup, newPickup].map((p) => p && p.restaurant_id).filter((r) => typeof r === 'string'))];
      const hubs = Object.fromEntries(await Promise.all(rids.map(async (rid) => [rid, await hub(rid)])));
      const g = stackGate({ incumbent: { oid: incOid, order: incOrder, pickup: incPickup }, candidate: { oid: newOid, order: newOrder, pickup: newPickup }, otherCount: 1, hubs });
      if (g.ok || g.reason === 'cross_hub') kept.push(e);
    } catch (err) {
      console.warn(`stackseq filter: dropped ${e.driverId} for ${newOid} (${(err && err.message) || err})`);
    }
  }
  return kept;
}

async function planForWriter({ db, uid, newOid, invocationDeadline, key, transport = globalThis.fetch, now = Date.now, mayPlan = true }) {
  const t = Date.now();
  const deadlineAt = Math.min(t + PLAN_DEADLINE_MS, invocationDeadline);
  const gateOnly = !mayPlan || invocationDeadline - t < MIN_LEFT_MS;
  const r = await planStack({ db, uid, newOid, deadlineAt, transport, key, now, gateOnly });
  if (r.stack) return { mode: 'stack', decision: r.decision, deadlineAt };
  if (TODAY.has(r.reason)) return { mode: 'today', reason: r.reason };
  return { mode: 'single', reason: r.reason };
}

async function postClaimSeq({ db, uid, newOid, decision, reassert, parked = false, sweep = false, isAssignable, isHeld, budgetMs = POST_CLAIM_MS }) {
  const end = Date.now() + budgetMs;
  const b = (p) => bounded(p, end - Date.now());
  const [pickup, delivery, order] = (await b(Promise.all([`tasks/${newOid}_pickup`, `tasks/${newOid}_delivery`, `orders/${newOid}`].map((p) => db.ref(p).once('value'))))).map((s) => s.val());
  const st = candidateState({ pickup, delivery, order }, { uid, parked: parked || (sweep && !!(order && order.dispatch_parked)), isAssignable, isHeld });
  if (!st.stillOffered) return { changed: st.changed };
  const re = await b(reassert(db, uid, newOid));
  if (!re || !re.ok) return { ok: false };
  const [tasksSnap, incSnap] = await b(Promise.all([db.ref('tasks').once('value'), db.ref(`orders/${decision.incumbentOid}`).once('value')]));
  return confirmIncumbent({ tasks: tasksSnap.val() || {}, uid, newOid, decision, incOrder: incSnap.val(), isAssignable, isHeld }) ? { ok: true } : { ok: false };
}

module.exports = { readSeqFlag, filterEligible, planForWriter, postClaimSeq, PLAN_DEADLINE_MS, MIN_LEFT_MS, POST_CLAIM_MS };
