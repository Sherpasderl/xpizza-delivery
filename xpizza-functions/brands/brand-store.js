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

// Orchestration §6 — fenced publication. Every projected input is versioned: brands/{b}/projection_gen (bumped in every membership /
// activation brand transaction) and each member identity's `version`. The projection carries source = {gen, versions}; a publish
// commits only over an OLDER source, so a late publisher that read older inputs can never overwrite a newer projection.
const finiteOr = (v, d) => (Number.isFinite(v) ? v : d);
function projectionSource(brand, identities) {
  const versions = {};
  for (const [rid, st] of Object.entries((brand && brand.locations) || {})) if (st === 'member') versions[rid] = finiteOr(identities[rid] && identities[rid].version, 0);
  const gen = finiteOr(brand && brand.projection_gen, 0);
  return Object.keys(versions).length ? { gen, versions } : { gen };   // RTDB drops an empty object: write what reads back
}
// component-wise over gen + the member versions both sides share (a member added / removed moves gen, so gen covers it)
function compareSource(next, cur) {
  if (!cur || typeof cur !== 'object') return 'newer';   // a pre-v2 (unstamped) projection
  const a = { gen: finiteOr(next.gen, -1), v: next.versions || {} };
  const b = { gen: finiteOr(cur.gen, -1), v: cur.versions || {} };
  const ka = Object.keys(a.v).sort(); const kb = Object.keys(b.v).sort();
  if (a.gen === b.gen && !isDeepStrictEqual(ka, kb)) return 'incomparable';
  let ge = a.gen >= b.gen; let le = a.gen <= b.gen;
  for (const k of ka) if (k in b.v) { ge = ge && a.v[k] >= b.v[k]; le = le && a.v[k] <= b.v[k]; }
  if (ge && le) return 'equal';
  return ge ? 'newer' : (le ? 'older' : 'incomparable');
}

function planPublish({ brandId, brand, identities, current }) {
  const b = buildPublicBrand(brandId, brand, identities);
  if (!b.ok) return { ok: false, errors: b.errors };
  const to = { ...b.projection, source: projectionSource(brand, identities) };
  const from = current === undefined ? null : current;
  return { ok: true, row: { path: publicPath(brandId), from, to }, changed: !isDeepStrictEqual(from, to) };
}

async function applyPublish(rtdb, plan) {
  let verdict = null;
  await rtdb.ref(plan.row.path).transaction((cur) => {
    verdict = compareSource(plan.row.to.source, cur && cur.source);
    return verdict === 'newer' ? plan.row.to : undefined;
  });
  if (verdict === 'equal') return { ok: true, unchanged: true };
  if (verdict === 'older') return { ok: false, error: 'superseded' };
  if (verdict !== 'newer') return { ok: false, error: 'incomparable' };
  const back = await readNode(rtdb, plan.row.path);   // read-back compares source (a newer publisher may already have landed)
  if (back && isDeepStrictEqual(back.source, plan.row.to.source)) return isDeepStrictEqual(back, plan.row.to) ? { ok: true } : { ok: false, back };
  return { ok: true, superseded_after_write: true };
}

const PUBLISH_TRIES = 3;
async function publishBrandProjection(rtdb, brandId, { now }) {
  for (let i = 0; i < PUBLISH_TRIES; i += 1) {
    const brand = await readNode(rtdb, brandPath(brandId));
    if (brand === null || brand === undefined) return { ok: false, error: 'brand_not_found' };
    const plan = planPublish({ brandId, brand, identities: await readIdentities(rtdb), current: null });
    if (!plan.ok) return { ok: false, error: 'refused', errors: plan.errors };
    const r = await applyPublish(rtdb, plan);
    if (r.error === 'incomparable') continue;   // a mixed-timing read: re-read
    if (r.error === 'superseded') return { ok: true, superseded: true };
    return r.ok ? { ...r, source: plan.row.to.source } : r;
  }
  await rtdb.ref(`dispatcher_alerts/projection_unfenced_${brandId}`).transaction((cur) => (cur == null ? { type: 'projection_unfenced', brand_id: brandId, created_at: now } : undefined));
  return { ok: false, error: 'projection_unfenced' };
}

module.exports = { brandPath, publicPath, readNode, readIdentities, planSeedLegacy, applySeedLegacy, planPublish, applyPublish, projectionSource, compareSource, publishBrandProjection };
