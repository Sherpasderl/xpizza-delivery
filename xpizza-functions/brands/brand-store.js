'use strict';
// PLATFORM F1 — the brand store: plan (pure) → apply (one path) → read back. Over an INJECTED RTDB handle, so the owner CLI adds
// only the project guard and argv. Admin SDK bypasses RTDB rules, so every record is re-validated here before a write.
const { isDeepStrictEqual } = require('util');
const { isRoutingValid } = require('../restaurant-config');
const { brandText } = require('../pickup-label');
const { validateBrand, isBrandId } = require('./brand-model');
const { buildPublicBrand } = require('./brand-projection');

const brandPath = (b) => `brands/${b}`;
const publicPath = (b) => `public/brands/${b}`;

async function readNode(rtdb, path) { return (await rtdb.ref(path).once('value')).val(); }

// ONE read of /restaurants (RTDB only — no Firestore registry): rid → identity, for every node that has one.
async function readIdentities(rtdb) {
  const all = (await readNode(rtdb, 'restaurants')) || {};
  const out = {};
  for (const [rid, node] of Object.entries(all)) if (node && node.identity) out[rid] = node.identity;
  return out;
}

// A legacy-singleton brand record for an EXISTING restaurant: brandId === rid, locations {rid: member}, state legacy.
function planSeedLegacy({ rid, identity, existing, nowMs }) {
  if (!isBrandId(rid)) return { ok: false, error: `not a brand id: ${JSON.stringify(rid)}` };
  if (!isRoutingValid(identity)) return { ok: false, error: `${rid}: identity missing or not routing-valid — refusing to seed a brand for it` };
  if (identity.brand_id !== undefined && identity.brand_id !== rid) return { ok: false, error: `${rid}: identity.brand_id is ${JSON.stringify(identity.brand_id)} — it already belongs to another brand` };
  const to = { name: brandText(identity.display_name) || identity.name, active: identity.active, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: nowMs } };
  const v = validateBrand(rid, to);   // the GENERATED record — Admin bypasses rules, so this is the only shape check before the write
  if (!v.ok) return { ok: false, error: `${rid}: the seeded record would be invalid — ${v.errors.join('; ')}` };
  if (existing !== null && existing !== undefined) {
    const same = validateBrand(rid, existing).ok && existing.activation.state === 'legacy' && existing.name === to.name && existing.active === to.active;
    return same ? { ok: true, noop: true } : { ok: false, error: `${rid}: /brands/${rid} already exists with a different record — not overwritten` };
  }
  return { ok: true, row: { path: brandPath(rid), to } };
}

async function applySeedLegacy(rtdb, plan) {
  const r = await rtdb.ref(plan.row.path).transaction((cur) => (cur === null ? plan.row.to : undefined));   // create-only
  if (!r.committed) return { ok: false, error: 'the node appeared after the plan — aborted, nothing written' };
  const back = await readNode(rtdb, plan.row.path);
  return isDeepStrictEqual(back, plan.row.to) ? { ok: true } : { ok: false, error: 'read-back mismatch', back };
}

function planPublish({ brandId, brand, identities, current }) {
  const b = buildPublicBrand(brandId, brand, identities);
  if (!b.ok) return { ok: false, errors: b.errors };
  const from = current === undefined ? null : current;
  return { ok: true, row: { path: publicPath(brandId), from, to: b.projection }, changed: !isDeepStrictEqual(from, b.projection) };
}

async function applyPublish(rtdb, plan) {
  await rtdb.ref(plan.row.path).set(plan.row.to);   // overwritable: the projection is derived
  const back = await readNode(rtdb, plan.row.path);
  return isDeepStrictEqual(back, plan.row.to) ? { ok: true } : { ok: false, back };
}

module.exports = { brandPath, publicPath, readNode, readIdentities, planSeedLegacy, applySeedLegacy, planPublish, applyPublish };
