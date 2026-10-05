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
//   • DISCOVERY (codex CP1 B1): the restaurant set is the registry ∪ EVERY restaurant key in RTDB ∪ EVERY key that already
//     holds a kitchen floor. A registry failure is reported, never turned into "no restaurants": set / raise REFUSE when
//     the registry could not be read (a restaurant could otherwise be skipped and silently stay OFF); the emergency
//     DELETE needs no Firestore at all — it covers every floor node found in RTDB plus every discovered restaurant;
//   • after an apply, a FULL RTDB re-scan (not only the plan's own rows) must show the intended state everywhere.
const KINDS = new Set(['kitchen', 'orders']);
const OPS = new Set(['set', 'raise', 'delete']);
const ORDERS_PATH = 'platform_config/client_floor/orders';
const kitchenPath = (rid) => `restaurants/${rid}/client_floor/kitchen`;
const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

// → { ok, error? , updates, rows: [{ path, from, to }] }
// rids: the discovered restaurants; floorKeys: every /restaurants key holding a kitchen floor (RTDB); registryOk: did the
// registry read succeed.
function planFloor({ kind, op, value, current, rids, floorKeys = [], registryOk = true, maxCompat, force = false }) {
  if (!KINDS.has(kind)) return { ok: false, error: `unknown floor kind ${kind}` };
  if (!OPS.has(op)) return { ok: false, error: `unknown op ${op}` };
  if (op !== 'delete') {
    if (!Number.isInteger(value) || value < 0 || value > 1000000) return { ok: false, error: 'a floor is a non-negative integer' };
    if (Number.isInteger(maxCompat) && value > maxCompat && !force) {
      return { ok: false, error: `floor ${value} is above ${kind}'s current compatibility generation ${maxCompat} — it would refuse EVERY page; pass --force only if a build at that generation is deployed` };
    }
  }
  let paths;
  if (kind === 'orders') paths = [ORDERS_PATH];
  else if (op === 'delete') {
    // the KILL SWITCH: every existing floor node (whatever its key) ∪ every discovered restaurant — no registry needed
    paths = [...new Set([...floorKeys, ...rids])].sort().map(kitchenPath);
    if (!paths.length) return { ok: false, error: 'no restaurants and no floor nodes found — nothing to delete' };
  } else {
    if (!registryOk) return { ok: false, error: 'restaurant registry discovery FAILED — refusing set/raise (a restaurant could be omitted and silently stay OFF); `kitchen delete` still works without the registry' };
    const all = [...new Set([...rids, ...floorKeys])].sort();
    if (!all.length) return { ok: false, error: 'no restaurants found — refusing to write a kitchen floor for nobody' };
    const bad = all.filter((r) => !RID_RE.test(r));
    if (bad.length) return { ok: false, error: `malformed restaurant ids: ${bad.join(', ')} — refusing set/raise (delete still covers them)` };
    paths = all.map(kitchenPath);
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

// RTDB side of discovery, independent of Firestore: every restaurant key, and every key holding a kitchen floor.
async function rtdbRestaurants(rtdb) {
  const snap = (await rtdb.ref('restaurants').once('value')).val() || {};
  const keys = Object.keys(snap);
  const floorKeys = keys.filter((k) => snap[k] && snap[k].client_floor && snap[k].client_floor.kitchen !== undefined && snap[k].client_floor.kitchen !== null);
  return { keys, floorKeys };
}

// Full discovery. readRegistry: () => Promise<string[]>; a failure or a timeout is REPORTED (registryOk false).
async function discoverRestaurants(rtdb, readRegistry, { timeoutMs = 10000 } = {}) {
  let registryIds = [], registryOk = true, registryError = null;
  let timer;
  try {
    registryIds = await Promise.race([Promise.resolve().then(readRegistry),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('registry_timeout')), timeoutMs); })]);
    if (!Array.isArray(registryIds)) throw new Error('registry returned a non-list');
  } catch (e) { registryOk = false; registryError = String((e && e.message) || e); registryIds = []; }
  finally { clearTimeout(timer); }
  const { keys, floorKeys } = await rtdbRestaurants(rtdb);
  const rids = [...new Set([...registryIds.filter((r) => typeof r === 'string'), ...keys])].sort();
  return { rids, floorKeys: floorKeys.sort(), registryOk, registryError };
}

async function readCurrent(rtdb, kind, rids, floorKeys = []) {
  const paths = kind === 'orders' ? [ORDERS_PATH] : [...new Set([...rids, ...floorKeys])].map(kitchenPath);
  const out = {};
  for (const p of paths) out[p] = (await rtdb.ref(p).once('value')).val();
  return out;
}

// ONE multi-path update, then a read-back of the plan's rows AND (kitchen) a FULL re-scan of every restaurant: after a
// delete NO floor node may remain anywhere; after a set/raise every restaurant key must carry the target value.
async function applyPlan(rtdb, plan, { kind = null, target = undefined } = {}) {
  await rtdb.ref().update(plan.updates);
  const mismatched = [];
  for (const r of plan.rows) {
    const v = (await rtdb.ref(r.path).once('value')).val();
    if (v !== r.to) mismatched.push(`${r.path}: ${JSON.stringify(v)} ≠ ${JSON.stringify(r.to)}`);
  }
  if (kind === 'kitchen') {
    const snap = (await rtdb.ref('restaurants').once('value')).val() || {};
    for (const k of Object.keys(snap)) {
      const v = snap[k] && snap[k].client_floor ? snap[k].client_floor.kitchen : undefined;
      const have = v === undefined ? null : v;
      if (have !== target) mismatched.push(`re-scan ${kitchenPath(k)}: ${JSON.stringify(have)} ≠ ${JSON.stringify(target)}`);
    }
  }
  return { ok: mismatched.length === 0, mismatched };
}

module.exports = { planFloor, discoverRestaurants, rtdbRestaurants, readCurrent, applyPlan, ORDERS_PATH, kitchenPath };
