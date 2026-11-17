'use strict';
// LEDGER S5 (PLAN-5f-ledger-shadow-s1-r3 §2; build note D4c-grill/ledger-s5/LEDGER.md, advisor OK 11-16) — the NIGHTLY REBUILD. I/O is
// injected ({ db, clock }); ledger/functions.js schedules it at 03:00 HN ('run') and 03:30 HN ('safety').
//   touched set  orders by created_at / delivered_at / cancelled_at / refunded_at / fulfilled_offline_at ≥ now − 21 d, payment_attempts by
//                paid_at / refunded_at / voided_at / failed_at / uncertain_at / flagged_at ≥ now − 21 d (⇒ order_id), the OPEN set
//                ledger/open, and orders extra_payment_review == true — every query on a declared .indexOn (S4); a numeric startAt also
//                returns string / object values (RTDB value order), so each hit is re-checked as a safe-integer time
//   per order    its sources (readSources) ⇒ S3 projectOrder at the S4 rate in effect at orders.created_at ⇒ REPLACE ledger/orders/{id}
//                whole + set / clear ledger/open/{id} in ONE multi-path update — skipped when inputs_hash is unchanged
//   run record   ledger/run/{HN date} = { started_at, finished_at, attempt, stopped, counts } — counts and codes only
//   cap          400 s of wall time, checked before each order ⇒ stopped: 'time_cap'; the 03:30 slot restarts FROM SCRATCH (the
//                per-order replace makes a full re-run harmless) or, after a finished run, does nothing
//   stale hold   a hold unchanged > 60 days leaves ledger/open, marked stale_hold and listed in ledger/stale (the S6 report's list)
//   alarm        ONE create-once dispatcher_alerts/ledger_run_{date} (type contabilidad_sombra; Central renders it in «Otros / Revisar»)
//                when the safety slot ends unfinished, or when unresolved went up vs yesterday's finished run
// Writes ONLY ledger/orders, ledger/open, ledger/run and that alert (all server-only); never a source node.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PJ = require('./projector');
const CR = require('./commission-rate');

const WINDOW_MS = 21 * 86400000;
const CAP_MS = 400000;
const STALE_MS = 60 * 86400000;   // a hold unchanged this long leaves the open set (stale_hold)
const HN_OFFSET_MS = 6 * 3600000;   // Honduras: UTC−6, no daylight saving
const ORDER_TIMES = ['created_at', 'delivered_at', 'cancelled_at', 'refunded_at', 'fulfilled_offline_at'];
const ATTEMPT_TIMES = ['paid_at', 'refunded_at', 'voided_at', 'failed_at', 'uncertain_at', 'flagged_at'];
const KEY = /^[A-Za-z0-9_-]{1,128}$/;
const ALERT_TYPE = 'contabilidad_sombra';

const time = (x) => Number.isSafeInteger(x) && x > 0;
const hnDate = (t) => new Date(t - HN_OFFSET_MS).toISOString().slice(0, 10);
const obj = (v) => (v && typeof v === 'object' ? v : {});
// the projection code is an input: a change to it re-projects every touched order without a hand-bumped version
const CODE_HASH = crypto.createHash('sha256')
  .update(['projector.js', path.join('..', 'payments', 'sdk', 'record.js')].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\u0000'))
  .digest('hex');
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v === undefined ? null : v));

async function touchedSet(db, now) {
  const from = now - WINDOW_MS; const ids = new Set();
  const add = (id) => { if (typeof id === 'string' && KEY.test(id)) ids.add(id); };
  for (const c of ORDER_TIMES) {
    for (const [k, o] of Object.entries(obj((await db.ref('orders').orderByChild(c).startAt(from).once('value')).val()))) if (time(o && o[c]) && o[c] >= from) add(k);
  }
  for (const c of ATTEMPT_TIMES) {
    for (const a of Object.values(obj((await db.ref('payment_attempts').orderByChild(c).startAt(from).once('value')).val()))) if (a && time(a[c]) && a[c] >= from) add(a.order_id);
  }
  for (const k of Object.keys(obj((await db.ref('ledger/open').once('value')).val()))) add(k);
  for (const k of Object.keys(obj((await db.ref('orders').orderByChild('extra_payment_review').equalTo(true).once('value')).val()))) add(k);
  return ids;
}

// the money snapshot (S1): ledger_alloc (cash) ⇒ the SDK record's ⇒ the ACTIVE attempt's ⇒ the one distinct attempt snapshot; anything
// else (none, or two different ones and no active attempt) ⇒ null, which the projector quarantines (no_snapshot) — never a guess
function snapshotOf(alloc, sdk, order, attempts) {
  if (alloc) return alloc;
  if (sdk && sdk.ledger) return sdk.ledger;
  const act = order && attempts[order.active_attempt_id];
  if (act && act.ledger) return act.ledger;
  const all = [...new Map(Object.values(attempts).filter((a) => a && a.ledger).map((a) => [canon(a.ledger), a.ledger])).values()];
  return all.length === 1 ? all[0] : null;
}

async function readSources(db, orderId) {
  const v = async (p) => (await db.ref(p).once('value')).val();
  const order = await v(`orders/${orderId}`);
  const attempts = obj(await db.ref('payment_attempts').orderByChild('order_id').equalTo(orderId).once('value').then((s) => s.val()));
  const refunds = {};
  for (const aid of Object.keys(attempts).sort()) Object.assign(refunds, obj((await db.ref('refund_attempts').orderByKey().startAt(`${aid}-`).endAt(`${aid}-`).once('value')).val()));
  const sdk = order && order.payment_flow === 'sdk_auth_v1' ? await v(`payment_sdk/${orderId}`) : null;
  const alloc = snapshotOf(await v(`ledger_alloc/${orderId}`), sdk, order, attempts);
  const rewardState = order && order.redemption && typeof order.customer_uid === 'string' && typeof order.restaurant_id === 'string'
    ? await v(`user_rewards/${order.customer_uid}/${order.restaurant_id}/reservations/${orderId}/state`) : null;
  return { orderId, order, alloc, attempts: Object.keys(attempts).length ? attempts : null, sdk, refunds: Object.keys(refunds).length ? refunds : null, rewardState };
}

// one order ⇒ 'written' | 'unchanged', and its status
async function rebuildOrder(db, orderId, { settings, now }) {
  const src = await readSources(db, orderId);
  const rate = src.order ? CR.rateAt(settings, src.order.restaurant_id, src.order.created_at) : null;
  const rateBp = rate ? rate.bp : null;
  const hash = crypto.createHash('sha256').update(canon({ code: CODE_HASH, src, rateBp })).digest('hex');
  const r = PJ.projectOrder(src, { rateBp });
  const leaf = async (k) => (await db.ref(`ledger/orders/${orderId}/${k}`).once('value')).val();
  const [prevHash, since, stale] = [await leaf('inputs_hash'), await leaf('hash_since'), await leaf('stale_hold')];
  let patch;
  if (prevHash === hash) {
    // Codex #116 r2 (b): a hold (quarantined / unresolved) unchanged for MORE than 60 days leaves the open set, marked stale_hold — the S6
    // report lists it for a person; a window event still re-projects it (a new hash replaces the projection and it rejoins)
    const held = r.status === 'quarantined' || r.status === 'unresolved';
    if (!(held && stale !== true && time(since) && now - since > STALE_MS)) return { result: 'unchanged', status: r.status };
    patch = { [`ledger/open/${orderId}`]: null, [`ledger/orders/${orderId}/stale_hold`]: true, [`ledger/stale/${orderId}`]: true };   // ledger/stale: the S6 report's list
  } else {
    const keep = r.status !== 'final';   // plan §2: every non-final order stays in discovery — a quarantined SDK order can still change with no windowed field (Codex #116 #1)
    patch = {
      [`ledger/orders/${orderId}`]: { v: 1, computed_at: now, hash_since: now, inputs_hash: hash, rate_bp: rateBp, status: r.status, reasons: r.reasons, journals: r.journals },
      [`ledger/open/${orderId}`]: keep ? true : null,
      [`ledger/stale/${orderId}`]: null,
    };
  }
  await db.ref().update(patch);   // ONE multi-path update: open-set membership always rides the projection write
  return { result: patch[`ledger/orders/${orderId}`] ? 'written' : 'unchanged', status: r.status };
}

const errCode = (e) => (e && typeof e.code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(e.code) ? e.code : 'error');

async function alarmOnce(db, date, now, reasons, counts) {
  const payload = { type: ALERT_TYPE, created_at: now, date, reasons, ...(counts ? { counts } : {}) };
  await db.ref(`dispatcher_alerts/ledger_run_${date}`).transaction((cur) => (cur === null ? payload : undefined));
}

// slot: 'run' (03:00 HN) | 'safety' (03:30 HN) ⇒ { outcome: 'finished' | 'time_cap' | 'error' | 'noop', counts }. NEVER throws (Codex #116
// #3): the whole lifecycle is inside one protected block. The alert is decided and delivered BEFORE the completion marker (Codex #116 #2):
// a failed read of yesterday's run or a failed alert transaction leaves the run unfinished, so the 03:30 slot re-runs and delivers it.
// When the safety slot ends without a recorded completion, the create-once «unfinished» alarm is attempted on its own, whatever became of
// the run record.
async function runNightly({ db, clock }, { slot }) {
  const start = clock(); const date = hnDate(start);
  const runRef = db.ref(`ledger/run/${date}`);
  const counts = { touched: 0, written: 0, unchanged: 0, final: 0, open: 0, quarantined: 0, unresolved: 0 };
  let attempt = null; let outcome = 'finished';
  try {
    const prior = (await runRef.once('value')).val();
    if (prior && time(prior.finished_at)) return { outcome: 'noop' };
    attempt = (prior && Number.isSafeInteger(prior.attempt) ? prior.attempt : 0) + 1;
    await runRef.set({ started_at: start, attempt });
    const settings = (await db.ref(CR.NODE).once('value')).val();
    const ids = [...(await touchedSet(db, start))].sort();
    counts.touched = ids.length;
    for (const id of ids) {
      if (clock() - start >= CAP_MS) { outcome = 'time_cap'; break; }
      const { result, status } = await rebuildOrder(db, id, { settings, now: start });
      counts[result] += 1; counts[status] += 1;
    }
    if (outcome === 'finished') {   // the alert BEFORE the marker
      const y = (await db.ref(`ledger/run/${hnDate(start - 86400000)}`).once('value')).val();
      if (y && time(y.finished_at) && y.counts && Number.isSafeInteger(y.counts.unresolved) && counts.unresolved > y.counts.unresolved) await alarmOnce(db, date, start, ['unresolved_up'], counts);
    }
  } catch (e) { outcome = errCode(e); }
  let recorded = false;
  try {
    await runRef.set({ started_at: start, attempt, counts, ...(outcome === 'finished' ? { finished_at: clock() } : { stopped: outcome }) });
    recorded = outcome === 'finished';
  } catch (_) { /* the safety slot alarms below; the 03:00 slot is retried at 03:30 */ }
  if (!recorded && slot === 'safety') { try { await alarmOnce(db, date, start, ['unfinished'], counts); } catch (_) { /* nothing left to try: the log line */ } }
  return { outcome: recorded ? 'finished' : outcome === 'time_cap' ? 'time_cap' : 'error', counts };
}

module.exports = { STALE_MS, runNightly, rebuildOrder, readSources, touchedSet, snapshotOf, hnDate, errCode, WINDOW_MS, CAP_MS, ALERT_TYPE, ORDER_TIMES, ATTEMPT_TIMES };
