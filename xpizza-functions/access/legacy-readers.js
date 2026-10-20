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

// catalog-edit-auth.js authorizeCatalogEdit at e8e77e24, VERBATIM (bar the name) — the OLD front door the compare runs every core
// through (codex build r1 P2-6). RID_RE / deny are copied with it.
const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const deny = (status, error) => ({ ok: false, status, error });
async function authorizeCatalogEditLegacy({ db, verifyIdToken }, req, restaurantId) {
  if (typeof restaurantId !== 'string' || !RID_RE.test(restaurantId)) {
    return deny(400, 'bad_restaurant_id');            // a bad request, not a permissions decision
  }

  const header = (req && typeof req.get === 'function' && req.get('authorization')) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return deny(401, 'missing_bearer_token');

  let decoded;
  try {
    decoded = await verifyIdToken(token);
  } catch (_) {
    return deny(401, 'invalid_credentials');          // fail-closed: an unverifiable token is never a caller
  }
  if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid) return deny(401, 'invalid_credentials');

  // BEFORE any membership read, and the order matters. A customer token must not be able to probe
  // whether some uid is staff, and if this ran after the lookup it would GRANT for any uid that happens
  // to sit in both namespaces. Customers are minted through the OTP path with this claim; they have no
  // business on a path that moves prices.
  if (decoded.customer === true) return deny(403, 'not_authorized');

  // A read that THROWS must never fall through to "not a member". That is the shape where an outage
  // reads as a clean denial — or, one small edit later, as a grant. Denied explicitly, and as 503 rather
  // than 403 so an outage is not misdiagnosed as a permissions problem.
  const exists = async (path) => {
    const snap = await db.ref(path).once('value');
    return !!(snap && snap.exists());
  };
  try {
    // HIGHEST TIER FIRST, so a uid that is both an owner and a dispatcher resolves to owner — the fiscal
    // gate must see the higher tier, not whichever was checked first by accident.
    if (await exists(`restaurants/${restaurantId}/owners/${decoded.uid}`)) {
      return { ok: true, uid: decoded.uid, role: 'owner', actor: decoded.email || decoded.uid };
    }
    if (await exists(`dispatchers/${decoded.uid}`)) {
      return { ok: true, uid: decoded.uid, role: 'dispatcher', actor: decoded.email || decoded.uid };
    }
    if (await exists(`restaurants/${restaurantId}/kitchen_staff/${decoded.uid}`)) {
      return { ok: true, uid: decoded.uid, role: 'staff', actor: decoded.email || decoded.uid };
    }
  } catch (e) {
    console.warn('catalog_edit_auth_unavailable', JSON.stringify({ restaurantId, error: String((e && e.message) || e).slice(0, 160) }));
    return deny(503, 'authorization_unavailable');
  }
  return deny(403, 'not_authorized');
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

module.exports = { myRestaurants, authorizeManager, myLocations, authorizeCatalogEditLegacy };
