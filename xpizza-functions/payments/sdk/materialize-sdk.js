'use strict';
// The FINAL write of an SDK order's go-live (Codex r2 P1-A). The shared materialization builds the live-order update; for an SDK
// order it is applied in two steps that a stale or overlapping worker can never use to reopen a settled order:
//   1. ONE orders/{id} transaction applies the order fields only while the order is still admitted, pending_payment, confirmed
//      and not materialized — and records the remaining paths (tasks, tracking, history) as a pending list in the same write;
//   2. each pending path is written CREATE-ONLY (never over an existing task or tracking record), then the list is cleared.
// A crash between the steps leaves the list on the order; the sweeper replays it. A cancel waits while it is present.
const F = require('./flow');

const PENDING = 'sdk_live_pending';

function setIn(obj, segs, v) {
  let o = obj;
  for (let i = 0; i < segs.length - 1; i++) { if (!o[segs[i]] || typeof o[segs[i]] !== 'object') o[segs[i]] = {}; o = o[segs[i]]; }
  if (v === null) delete o[segs[segs.length - 1]]; else o[segs[segs.length - 1]] = v;
}

// Resolves { written } — false when the order is no longer one this go-live may make live (nothing written).
async function writeSdkLive(db, orderId, updates) {
  const prefix = `orders/${orderId}/`;
  const patch = []; const rest = [];
  for (const [p, v] of Object.entries(updates)) (p.startsWith(prefix) ? patch : rest).push([p, v]);
  let won = false;
  const res = await db.ref(`orders/${orderId}`).transaction((cur) => {
    won = false;
    if (cur == null) return null;
    if (!F.sdkGoLiveAdmits(cur) || cur.status !== 'pending_payment' || cur.payment_status !== 'confirmed' || cur.materialized_at || cur[PENDING]) return undefined;
    const next = JSON.parse(JSON.stringify(cur));
    for (const [p, v] of patch) setIn(next, p.slice(prefix.length).split('/'), v);
    if (rest.length) next[PENDING] = rest.map(([path, value]) => ({ path, value }));
    won = true;
    return next;
  });
  if (!(res && res.committed && won)) return { written: false };
  await completeSdkLive(db, orderId);
  return { written: true };
}

// Write every pending path create-only, then clear the list (only the list this pass read). Skipped for a cancelled order.
async function completeSdkLive(db, orderId) {
  const order = (await db.ref(`orders/${orderId}`).once('value')).val();
  const list = order && order[PENDING];
  if (!Array.isArray(list) || !list.length) return { replayed: 0 };
  let n = 0;
  if (!order.payment_cancel && order.status !== 'cancelled') {
    for (const { path, value } of list) {
      await db.ref(path).transaction((cur) => (cur == null ? value : undefined));
      n += 1;
    }
  }
  const seen = JSON.stringify(list);
  await db.ref(`orders/${orderId}/${PENDING}`).transaction((cur) => (cur == null ? null : JSON.stringify(cur) === seen ? null : undefined));
  return { replayed: n };
}

module.exports = { writeSdkLive, completeSdkLive, PENDING };
