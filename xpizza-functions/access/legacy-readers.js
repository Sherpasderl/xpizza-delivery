'use strict';
// PLAN-portal-membership r3 §7.3 — TODAY's (pre-cutover) readers, preserved ONLY so `membership-admin compare` can run the
// ACTUAL old decisions and lists next to the new ones against the same prod snapshot. Faithful copies of the logic replaced by
// the reader flip (catalog-edit-auth.js, portal-reads.js getMyRestaurants, merchant-scope.js authorizeManager,
// merchant-devices.js myLocations at e8e77e24). Nothing deployed reads this module. Delete with the legacy nodes (§7.4).
const { readOwnerRestaurants } = require('../catalog/owner-index');
const { resolveBrand } = require('../merchant/merchant-brand');
const V = require('../merchant/merchant-validate');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const val = async (db, p) => (await db.ref(p).once('value')).val();
const exists = async (db, p) => (await val(db, p)) !== null;

// catalog-edit-auth: owner (restaurants/{rid}/owners) → dispatcher → staff; null = not authorized
async function catalogRole(db, uid, rid) {
  if (await exists(db, `restaurants/${rid}/owners/${uid}`)) return 'owner';
  if (await exists(db, `dispatchers/${uid}`)) return 'dispatcher';
  if (await exists(db, `restaurants/${rid}/kitchen_staff/${uid}`)) return 'staff';
  return null;
}

// portal-reads getMyRestaurants: owner_restaurants (sorted) + identity/name fallback
async function myRestaurants(db, uid) {
  const rids = (await readOwnerRestaurants({ ref: (p) => ({ get: () => db.ref(p).once('value') }) }, uid)).sort();
  const out = [];
  for (const rid of rids) {
    const name = await val(db, `restaurants/${rid}/identity/name`);
    out.push({ rid, name: (typeof name === 'string' && name.trim()) ? name : rid });
  }
  return { restaurants: out };
}

// merchant-scope authorizeManager: brand owner (restaurants/{brand}/owners) | location manager; unknown brand refused
async function authorizeManager(db, uid, rid) {
  const b = await resolveBrand(db, rid);
  if (typeof b !== 'string' || b === 'unknown') return false;
  if ((await val(db, `restaurants/${b}/owners/${uid}`)) != null) return true;
  return (await val(db, `restaurants/${rid}/managers/${uid}`)) != null;
}

// merchant-devices myLocations: /brands scan; owner of the brand or manager of the location; members only
async function myLocations(db, uid) {
  const brands = (await val(db, 'brands')) || {};
  const out = [];
  for (const b of Object.keys(brands).sort()) {
    const locs = isObj(brands[b]) && isObj(brands[b].locations) ? brands[b].locations : {};
    const members = Object.keys(locs).filter((rid) => locs[rid] === 'member' && V.vRid(rid)).sort();
    if (!members.length) continue;
    const owner = (await val(db, `restaurants/${b}/owners/${uid}`)) != null;
    for (const rid of members) {
      if (!owner && (await val(db, `restaurants/${rid}/managers/${uid}`)) == null) continue;
      const name = await val(db, `restaurants/${rid}/identity/location_name`);
      const base = V.vPrepBase(await val(db, `restaurants/${rid}/identity/prep_default_min`));
      out.push({ rid, brand_id: b, location_name: typeof name === 'string' ? name : null, prep_default_min: base });
    }
  }
  return out;
}

module.exports = { catalogRole, myRestaurants, authorizeManager, myLocations };
