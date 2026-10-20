'use strict';
// PORTAL-UI 1a (PLAN-portal-ui-slice1 r5 §6) — the branch's display name, with EXACTLY getMyRestaurants' fallback. A COPY of
// catalog/portal-reads.js's displayName (that module loads factura/eligibility, which the ops group must not). The guard
// (portal/ops-helpers.guard.test.js) compares this function's source with the live portal-reads.js text on every run, and
// runs both on the same fixtures.
async function displayName(db, rid) {
  const snap = await db.ref(`restaurants/${rid}/identity/name`).get();
  const name = snap && snap.val();
  // A restaurant with no name yet is still THEIRS. Label it by its id rather than dropping it or
  // showing a blank row — hiding a restaurant from the person who owns it is the worse failure.
  return (typeof name === 'string' && name.trim()) ? name : rid;
}

module.exports = { displayName };
