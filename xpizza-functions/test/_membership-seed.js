'use strict';
// PLAN-portal-membership r3 — the multi-path update that makes `uid` the owner of a LEGACY-SINGLETON brand `rid` in the
// membership model (a valid /brands record listing the location, the forward grant, the discovery index). Test fixtures use
// this instead of the retired restaurants/{rid}/owners + owner_restaurants paths. One ref().update() applies it atomically.
const legacyBrand = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
function ownerSeed(rid, uid) {
  return {
    [`brands/${rid}`]: legacyBrand(rid),
    [`brand_members/${rid}/owners/${uid}`]: { granted_at: 1, granted_by: 'cli:test' },
    [`member_of/${uid}/brands/${rid}`]: 'owner',
  };
}
module.exports = { ownerSeed, legacyBrand };
