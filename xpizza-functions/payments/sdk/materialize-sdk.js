'use strict';
// The FINAL write of an SDK order's go-live (Codex r2 P1-A). The shared materialization builds the live-order update; for an SDK
// order it is applied in two steps that a stale or overlapping worker can never use to reopen a settled order:
//   1. ONE orders/{id} transaction applies the order fields only while the order is still admitted, pending_payment, confirmed
//      and not materialized — and records the remaining VALUES (pickup / delivery task, tracking, history) as one JSON string,
//      keyed by KIND, in the same write (a rules-immutable, server-only scalar — Codex r3 A);
//   2. each kind is written to the destination the replay DERIVES from the order itself (this order's two task ids, its
//      tracking token, its customer's history entry) — never a stored path — filling only the MISSING leaves (never
//      overwriting a leaf a driver or a trigger already wrote — Codex r3 C); then the list is cleared.
// A crash between the steps leaves the list on the order; the sweeper replays it. A cancel waits while it is present. A list
// that does not parse to exactly these kinds is never executed: it is alerted and dropped.
const F = require('./flow');

const PENDING = 'sdk_live_pending';

function setIn(obj, segs, v) {
  let o = obj;
  for (let i = 0; i < segs.length - 1; i++) { if (!o[segs[i]] || typeof o[segs[i]] !== 'object') o[segs[i]] = {}; o = o[segs[i]]; }
  if (v === null) delete o[segs[segs.length - 1]]; else o[segs[segs.length - 1]] = v;
}

// The fixed destinations of each kind, derived from the order (null when the order cannot name it).
const KINDS = Object.freeze(['pickup', 'delivery', 'tracking', 'history']);
function destinationOf(kind, orderId, order) {
  if (kind === 'pickup') return order.pickup_task_id === `${orderId}_pickup` ? `tasks/${orderId}_pickup` : null;
  if (kind === 'delivery') return order.delivery_task_id === `${orderId}_delivery` ? `tasks/${orderId}_delivery` : null;
  if (kind === 'tracking') return typeof order.tracking_token === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(order.tracking_token) ? `order_tracking/${order.tracking_token}` : null;
  if (kind === 'history') return typeof order.customer_uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(order.customer_uid) ? `user_orders/${order.customer_uid}/${orderId}` : null;
  return null;
}
// The kind a materialization path belongs to (null = a path this module does not know: refused).
function kindOf(path, orderId, order) {
  for (const k of KINDS) if (destinationOf(k, orderId, order) === path) return k;
  return null;
}
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// The parsed pending list, or null when it is not exactly { kind: object } over the known kinds.
function parsePending(raw) {
  if (typeof raw !== 'string') return null;
  let v; try { v = JSON.parse(raw); } catch (_) { return null; }
  if (!isPlainObject(v) || !Object.keys(v).length || !Object.keys(v).every((k) => KINDS.includes(k) && isPlainObject(v[k]))) return null;
  return v;
}
// Fill only the leaves `cur` lacks (deep); never overwrite. Returns { next, changed }.
function fillMissing(cur, val) {
  if (cur == null) return { next: val, changed: true };
  if (!isPlainObject(cur) || !isPlainObject(val)) return { next: cur, changed: false };
  const next = { ...cur }; let changed = false;
  for (const [k, v] of Object.entries(val)) { const r = fillMissing(cur[k], v); if (r.changed) { next[k] = r.next; changed = true; } }
  return { next, changed };
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
    const kinds = {};
    for (const [p, v] of rest) {
      const k = kindOf(p, orderId, next);
      if (!k) throw new Error(`sdk go-live: an unknown materialization path (${p.split('/')[0]})`);   // fail closed — nothing written
      kinds[k] = v;
    }
    if (Object.keys(kinds).length) next[PENDING] = JSON.stringify(kinds);
    won = true;
    return next;
  });
  if (!(res && res.committed && won)) return { written: false };
  await completeSdkLive(db, orderId);
  return { written: true };
}

// Write every pending kind to its DERIVED destination (missing leaves only), then clear the list (only the value this pass
// read). Skipped for a cancelled order. A malformed list is reported through onMalformed and dropped, never executed.
async function completeSdkLive(db, orderId, { onMalformed } = {}) {
  const order = (await db.ref(`orders/${orderId}`).once('value')).val();
  const raw = order && order[PENDING];
  if (raw === undefined || raw === null) return { replayed: 0 };
  const seen = JSON.stringify(raw);
  const clear = () => db.ref(`orders/${orderId}/${PENDING}`).transaction((cur) => (cur == null ? null : JSON.stringify(cur) === seen ? null : undefined));
  const kinds = parsePending(raw);
  if (!kinds) { if (onMalformed) await onMalformed({ field: PENDING }); await clear(); return { replayed: 0, malformed: true }; }
  let n = 0;
  if (!order.payment_cancel && order.status !== 'cancelled') {
    for (const [k, value] of Object.entries(kinds)) {
      const dest = destinationOf(k, orderId, order);
      if (!dest) continue;                              // the order cannot name it (e.g. a pickup order has no tasks)
      await db.ref(dest).transaction((cur) => { const r = fillMissing(cur, value); return r.changed ? r.next : undefined; });
      n += 1;
    }
  }
  await clear();
  return { replayed: n };
}

module.exports = { writeSdkLive, completeSdkLive, PENDING, KINDS, destinationOf, parsePending, fillMissing };
