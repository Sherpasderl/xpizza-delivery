'use strict';
// ORCHESTRATION O1b T8 (PLAN-orch-o1b r3 §2 E1+) — the ADDITIVE read model getMyBranches gains for slice 1b. Every 1a field stays
// byte-identical (portal/e1-extend.test.js pins it against acf32fc8's ops-core); this only ADDS:
//   rows (a member / staged branch the caller already sees): lifecycle staged|inactive|active, profile {location_name, phone, hours,
//     prep_default_min}, location read-only {address_line, address_reference, hub, zone_radius_km}, legacy:true on a legacy branch,
//     version (the CAS token — the identity's integer version), readiness {unmet, identity_gaps?} for OWNER rows of staged / inactive
//     non-legacy branches (the SAME facts and planner E8 uses; a failed fact read omits readiness for that row, never guesses);
//   brands: + the brands the caller OWNS with no visible row (a draft-only brand), and per brand caps (brand.locations for its owner),
//     activation, drafts (owner only: lifecycle 'draft', profile, location:null, pending_location:true, version = the draft token).
// The profile / location fields ride only where 1a already returns operational fields (an operational capability).
const { myOwnerBrands } = require('../access/membership');
const P = require('../branches/branch-ops');
const S = require('../branches/branch-store');
const { draftsOfBrand } = require('../branches/drafts');
const { portalReaders } = require('../branches/readiness-readers');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const val = async (db, p) => (await db.ref(p).once('value')).val();
const profileOf = (x) => ({
  location_name: isObj(x) && typeof x.location_name === 'string' ? x.location_name : null,
  phone: isObj(x) && typeof x.phone === 'string' ? x.phone : null,
  hours: isObj(x) && isObj(x.hours) ? x.hours : null,
  prep_default_min: isObj(x) && Number.isInteger(x.prep_default_min) ? x.prep_default_min : null,
});
const locationOf = (id) => ({
  address_line: typeof id.address_line === 'string' ? id.address_line : null,
  address_reference: typeof id.address_reference === 'string' ? id.address_reference : null,
  hub: Number.isFinite(id.hub_lat) && Number.isFinite(id.hub_lng) ? { lat: id.hub_lat, lng: id.hub_lng } : null,
  zone_radius_km: Number.isFinite(id.delivery_radius_km) ? id.delivery_radius_km : null,
});

async function readinessOfRow(db, rid, brandId, brand, identity) {
  try {
    const facts = await S.readinessFacts(db, rid, brandId, brand, S.unrevoked(await val(db, `restaurants/${rid}/handhelds`)), portalReaders(db, brandId));
    const plan = P.planSetActive({ identity, active: true, facts: { ...facts, brandId }, now: 0, expectedVersion: identity.version });
    if (plan.ok) return { unmet: [] };
    if (plan.error !== 'not_ready') return null;
    return plan.identity_gaps ? { unmet: plan.unmet, identity_gaps: plan.identity_gaps } : { unmet: plan.unmet };
  } catch (_) { return null; }   // a failed fact read: no readiness for this row (the UI shows it as unknown), never a guess
}

async function extendE1(db, ctx, { brands, branches }) {
  const brandRecs = new Map();
  const brandRec = async (b) => { if (!brandRecs.has(b)) brandRecs.set(b, await val(db, `brands/${b}`)); return brandRecs.get(b); };
  for (const row of branches) {
    if (row.degraded || (row.state !== 'member' && row.state !== 'staged') || !('identity_version' in row)) continue;   // operational rows only
    const identity = await val(db, `restaurants/${row.rid}/identity`);
    if (!isObj(identity)) continue;
    const brand = await brandRec(row.brand_id);
    const legacy = isObj(brand) && isObj(brand.activation) && brand.activation.state === 'legacy' && row.state === 'member';
    row.lifecycle = row.state === 'staged' ? 'staged' : (identity.active === true ? 'active' : 'inactive');
    row.profile = profileOf(identity);
    row.location = locationOf(identity);
    if (legacy) row.legacy = true;
    row.version = row.identity_version;
    if (row.role === 'owner' && !legacy && row.lifecycle !== 'active') {
      const r = await readinessOfRow(db, row.rid, row.brand_id, brand, identity);
      if (r) row.readiness = r;
    }
  }
  const owned = await myOwnerBrands({ db }, ctx);
  const byId = new Map(brands.map((b) => [b.brand_id, b]));
  for (const o of owned) {
    if (!byId.has(o.brand_id)) { const n = await val(db, `brands/${o.brand_id}/name`); byId.set(o.brand_id, { brand_id: o.brand_id, name: typeof n === 'string' && n.trim() ? n : o.brand_id }); }
  }
  const ownedSet = new Set(owned.map((o) => o.brand_id));
  const out = [];
  for (const b of [...byId.keys()].sort()) {
    const row = byId.get(b);
    const rec = await brandRec(b);
    row.caps = ownedSet.has(b) ? ['brand.locations'] : [];
    row.activation = isObj(rec) && isObj(rec.activation) && typeof rec.activation.state === 'string' ? rec.activation.state : null;
    if (ownedSet.has(b)) {
      row.drafts = (await draftsOfBrand(db, b)).map(({ rid, draft }) => ({ rid, brand_id: b, lifecycle: 'draft', profile: profileOf(draft), location: null, pending_location: true, version: P.draftToken(draft) }));
    }
    out.push(row);
  }
  return { brands: out, branches };
}

module.exports = { extendE1 };
