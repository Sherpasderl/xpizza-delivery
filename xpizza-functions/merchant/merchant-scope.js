'use strict';
// H1a C-3/C-4 — who may act for a location.
//   authorizeHandheld: a server-created device account (claims {handheld, rid}) with an unrevoked registry row under the
//     location — restaurants/{rid}/handhelds/{uid} = {kind:'handheld', revoked:false, …}. Checked on EVERY call, so a revoked
//     device is refused immediately even while its ID token is still valid.
//   authorizeManager: a human who may pair / revoke devices — the device.pair capability (PLAN-portal-membership r3).
// The brand is resolved through an injected `resolveBrand(db, rid)` (F1's brandIdOf behind merchant-brand.js); 'unknown' is
// refused before any role or registry read. Every read failure is `unavailable` (fail closed), never a grant.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const { resolveAccess, can } = require('../access/membership');
const deny = (code) => ({ ok: false, code });
async function readVal(db, path) { return (await db.ref(path).once('value')).val(); }

async function brandOrDeny(db, rid, resolveBrand) {
  try {
    const b = await resolveBrand(db, rid);
    return typeof b === 'string' && b !== 'unknown' ? { brand: b } : { denied: deny('forbidden') };
  } catch (_) { return { denied: deny('unavailable') }; }
}

async function authorizeHandheld(db, auth, rid, { resolveBrand }) {
  if (!auth || !auth.uid) return deny('unauthenticated');
  const t = auth.token || {};
  if (t.customer === true) return deny('forbidden');
  if (t.handheld !== true || t.rid !== rid) return deny('forbidden');
  const b = await brandOrDeny(db, rid, resolveBrand);
  if (b.denied) return b.denied;
  let row;
  try { row = await readVal(db, `restaurants/${rid}/handhelds/${auth.uid}`); } catch (_) { return deny('unavailable'); }
  if (!isObj(row) || row.kind !== 'handheld' || row.revoked === true) return deny('forbidden');
  return { ok: true, uid: auth.uid, row };                // the registry row as read for THIS decision (H1c reads pair_gen from it)
}

// PLAN-portal-membership r3 §3/§8: through the ONE resolver. A human with the device.pair capability at this location (a brand
// owner or this location's manager, at a MEMBER location). H1's policy is kept: an unknown brand is refused, and a dispatcher
// alone gains nothing here. resolveBrand stays in the signature (authorizeHandheld still uses it); the resolver derives the
// brand with the same F1 rule plus the location's roster state.
async function authorizeManager(db, auth, rid, _opts) {
  if (!auth || !auth.uid) return deny('unauthenticated');
  const t = auth.token || {};
  if (t.customer === true || t.handheld === true) return deny('forbidden');
  const a = await resolveAccess({ db }, { uid: auth.uid, token: t }, rid);
  if (!a.ok) return deny(a.code === 'unavailable' ? 'unavailable' : 'forbidden');
  if (a.brandId === 'unknown') return deny('forbidden');
  if (!can(a, 'device.pair')) return deny('forbidden');
  return { ok: true, uid: auth.uid, tier: a.facts.owner ? 'owner' : 'manager' };
}

module.exports = { authorizeHandheld, authorizeManager };
