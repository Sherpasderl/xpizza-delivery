'use strict';
// BRAND-AGNOSTIC SERVER (PLAN-brand-agnostic-server r3 §B) — the core of the OWNER's return-base backfill
// (tools/driver-return-backfill.js): give every driver a drivers/{uid}/return_restaurant_id BEFORE the X1 readers ship
// (stage B), so a returning driver geofences at the restaurant they last served. Pure over an injected RTDB handle.
//
// Evidence, in order:
//   1. the driver's live non-null current_restaurant_id;
//   2. otherwise their latest DELIVERED order over the FULL indexed history, under BOTH attributions — delivered_by_driver_uid
//      and the legacy delivered_by_uid (orders/.indexOn carries both; the driver history subscription reads both) — by
//      delivered_at, else created_at.
// The restaurant is used only when its identity EXISTS (corroborated). Anything else is UNRESOLVED — there is NO x_pizza
// default (a legacy order without restaurant_id is not assumed to be X. Pizza); the owner resolves each with set-return.
// Writes are per-driver set-if-absent transactions (a value a stage-A writer already wrote is never overwritten); a second run
// plans 0. The read-back fails while any driver lacks the field or names a restaurant without an identity.
const UID = /^[A-Za-z0-9_-]{1,128}$/;
const RID = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD = 'return_restaurant_id';

function identityChecker(db) {
  const memo = new Map();
  return async (rid) => {
    if (typeof rid !== 'string' || !RID.test(rid)) return false;
    if (!memo.has(rid)) memo.set(rid, (await db.ref(`restaurants/${rid}/identity`).once('value')).exists());
    return memo.get(rid);
  };
}

// the latest delivered order for uid over both attributions → { id, order } | null
async function latestDelivered(db, uid) {
  const hits = {};
  for (const f of ['delivered_by_driver_uid', 'delivered_by_uid']) Object.assign(hits, (await db.ref('orders').orderByChild(f).equalTo(uid).once('value')).val() || {});
  let best = null;
  for (const [id, o] of Object.entries(hits)) {
    if (!o || o.status !== 'delivered') continue;
    const at = typeof o.delivered_at === 'number' ? o.delivered_at : (typeof o.created_at === 'number' ? o.created_at : -Infinity);
    if (!best || at > best.at || (at === best.at && id > best.id)) best = { id, order: o, at };
  }
  return best;
}

// → { rows: [{ uid, name, rid, source }], present: [uid], unresolved: [{ uid, name, reason }] }
async function planBackfill(db) {
  const drivers = (await db.ref('drivers').once('value')).val() || {};
  const hasIdentity = identityChecker(db);
  const rows = []; const present = []; const unresolved = [];
  for (const uid of Object.keys(drivers).sort()) {
    const d = drivers[uid] || {};
    const name = d.name || null;
    if (typeof d[FIELD] === 'string') { present.push(uid); continue; }
    if (d.current_restaurant_id != null) {
      if (await hasIdentity(d.current_restaurant_id)) { rows.push({ uid, name, rid: d.current_restaurant_id, source: 'live current_restaurant_id' }); continue; }
      unresolved.push({ uid, name, reason: `live current_restaurant_id ${d.current_restaurant_id} has no identity` }); continue;
    }
    const last = await latestDelivered(db, uid);
    if (!last) { unresolved.push({ uid, name, reason: 'no live restaurant and no delivered order' }); continue; }
    const rid = last.order.restaurant_id;
    if (rid == null) { unresolved.push({ uid, name, reason: `latest delivered order ${last.id} has no restaurant_id` }); continue; }
    if (!(await hasIdentity(rid))) { unresolved.push({ uid, name, reason: `latest delivered order ${last.id} names ${rid}, which has no identity` }); continue; }
    rows.push({ uid, name, rid, source: `latest delivered order ${last.id}` });
  }
  return { rows, present, unresolved };
}

// set-if-absent per driver → { written: [uid], kept: [uid] }
async function applyBackfill(db, rows) {
  const written = []; const kept = [];
  for (const r of rows) {
    const res = await db.ref(`drivers/${r.uid}/${FIELD}`).transaction((cur) => (cur == null ? r.rid : undefined));
    (res.committed ? written : kept).push(r.uid);
  }
  return { written: written.sort(), kept: kept.sort() };
}

// → [problem strings]; empty = EVERY driver carries a persisted string return_restaurant_id naming an existing identity.
// codex build r1 P1: judged on the PERSISTED value only — a driver whose evidence could fill it but who has not been filled yet
// is a problem too (the stage-B gate must never open before the apply).
async function readBack(db) {
  const drivers = (await db.ref('drivers').once('value')).val() || {};
  const hasIdentity = identityChecker(db);
  const unresolved = new Map((await planBackfill(db)).unresolved.map((u) => [u.uid, u]));
  const problems = [];
  for (const uid of Object.keys(drivers).sort()) {
    const d = drivers[uid] || {};
    const v = d[FIELD];
    if (typeof v === 'string') { if (!(await hasIdentity(v))) problems.push(`${uid}: ${FIELD} ${JSON.stringify(v)} has no identity`); continue; }
    const u = unresolved.get(uid);
    if (u) { problems.push(`${uid}: UNRESOLVED (${u.name || 'no name'}) — ${u.reason}; resolve with set-return ${uid} <rid>`); continue; }
    problems.push(v == null
      ? `${uid}: no return_restaurant_id persisted (fillable from evidence — run the backfill --apply)`
      : `${uid}: ${FIELD} ${JSON.stringify(v)} is not a string`);
  }
  return problems.sort();
}

// the owner's manual resolution: set-if-absent, identity required, read-back
async function setReturn(db, uid, rid, { dryRun = false } = {}) {
  if (typeof uid !== 'string' || !UID.test(uid)) return { ok: false, error: `not a driver uid: ${JSON.stringify(uid)}` };
  if (!(await identityChecker(db)(rid))) return { ok: false, error: `${rid} has no identity — refusing` };
  const d = (await db.ref(`drivers/${uid}`).once('value')).val();
  if (!d) return { ok: false, error: `no driver ${uid}` };
  if (typeof d[FIELD] === 'string') {
    if (d[FIELD] === rid) return { ok: true, noop: true, back: rid };
    return { ok: false, error: `${uid} already has ${FIELD} ${JSON.stringify(d[FIELD])} — PRESERVED (set-if-absent)` };
  }
  if (dryRun) return { ok: true, dryRun: true };
  const res = await db.ref(`drivers/${uid}/${FIELD}`).transaction((cur) => (cur == null ? rid : undefined));
  const back = (await db.ref(`drivers/${uid}/${FIELD}`).once('value')).val();
  if (!res.committed) return { ok: false, error: `${uid} gained ${FIELD} ${JSON.stringify(back)} meanwhile — PRESERVED` };
  return back === rid ? { ok: true, back } : { ok: false, error: `read-back mismatch: ${JSON.stringify(back)}` };
}

module.exports = { planBackfill, applyBackfill, readBack, setReturn, latestDelivered, FIELD };
