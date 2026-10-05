'use strict';
// P-SELFUPDATE §5/§6 — the owner's floor operations, as pure plans + one apply. Used by tools/client-floor.js.
//
// KITCHEN floor — ONE authoritative value PER RESTAURANT at restaurants/{rid}/client_floor/kitchen: the value the RTDB
// rules enforce AND the value the KDS reads. set / raise / delete act on ALL restaurants in ONE multi-path update, so no
// restaurant is ever left on a different floor by a partial run. delete-all is the KILL SWITCH (no deploy).
// ORDERS floor — platform_config/client_floor/orders (read by the functions only, cached per instance for one TTL).
//
// Safety:
//   • a floor is a non-negative integer;
//   • `raise` never lowers anything (refused if any current value is higher);
//   • a floor ABOVE the app's current compatibility generation (platform/compat.json) would refuse EVERY page, including
//     the newest build — refused unless `force`;
//   • the restaurant set is the union of the RTDB restaurants that carry an identity and the registry ids — a restaurant
//     missing from the update would silently stay OFF.
const KINDS = new Set(['kitchen', 'orders']);
const OPS = new Set(['set', 'raise', 'delete']);
const ORDERS_PATH = 'platform_config/client_floor/orders';
const kitchenPath = (rid) => `restaurants/${rid}/client_floor/kitchen`;
const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

// → { ok, error? , updates, rows: [{ path, from, to }] }
function planFloor({ kind, op, value, current, rids, maxCompat, force = false }) {
  if (!KINDS.has(kind)) return { ok: false, error: `unknown floor kind ${kind}` };
  if (!OPS.has(op)) return { ok: false, error: `unknown op ${op}` };
  if (op !== 'delete') {
    if (!Number.isInteger(value) || value < 0 || value > 1000000) return { ok: false, error: 'a floor is a non-negative integer' };
    if (Number.isInteger(maxCompat) && value > maxCompat && !force) {
      return { ok: false, error: `floor ${value} is above ${kind}'s current compatibility generation ${maxCompat} — it would refuse EVERY page; pass --force only if a build at that generation is deployed` };
    }
  }
  const paths = kind === 'orders' ? [ORDERS_PATH] : rids.map(kitchenPath);
  if (kind === 'kitchen') {
    if (!rids.length) return { ok: false, error: 'no restaurants found — refusing to write a kitchen floor for nobody' };
    const bad = rids.filter((r) => !RID_RE.test(r));
    if (bad.length) return { ok: false, error: `malformed restaurant ids: ${bad.join(', ')}` };
  }
  if (op === 'raise') {
    const higher = paths.filter((p) => Number.isInteger(current[p]) && current[p] > value);
    if (higher.length) return { ok: false, error: `raise refuses to LOWER: ${higher.map((p) => `${p}=${current[p]}`).join(', ')}` };
  }
  const to = op === 'delete' ? null : value;
  const updates = {}; const rows = [];
  for (const p of paths) { updates[p] = to; rows.push({ path: p, from: current[p] === undefined ? null : current[p], to }); }
  return { ok: true, updates, rows };
}

// The restaurants a kitchen floor must cover: RTDB restaurants with an identity ∪ the registry ids.
async function listRestaurants(rtdb, registryIds = []) {
  const snap = (await rtdb.ref('restaurants').once('value')).val() || {};
  const fromRtdb = Object.keys(snap).filter((rid) => snap[rid] && snap[rid].identity);
  return [...new Set([...fromRtdb, ...registryIds])].filter((r) => RID_RE.test(r)).sort();
}

async function readCurrent(rtdb, kind, rids) {
  const paths = kind === 'orders' ? [ORDERS_PATH] : rids.map(kitchenPath);
  const out = {};
  for (const p of paths) out[p] = (await rtdb.ref(p).once('value')).val();
  return out;
}

// ONE multi-path update, then a read-back that must equal the plan.
async function applyPlan(rtdb, plan) {
  await rtdb.ref().update(plan.updates);
  const mismatched = [];
  for (const r of plan.rows) {
    const v = (await rtdb.ref(r.path).once('value')).val();
    if (v !== r.to) mismatched.push(`${r.path}: ${JSON.stringify(v)} ≠ ${JSON.stringify(r.to)}`);
  }
  return { ok: mismatched.length === 0, mismatched };
}

module.exports = { planFloor, listRestaurants, readCurrent, applyPlan, ORDERS_PATH, kitchenPath };
