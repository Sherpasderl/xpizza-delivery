'use strict';
// H1a — the ONE place the handheld derives a location's brand: F1's pure brandIdOf (brands/brand-model.js, PLAN-multi-location
// §1.2) over one identity read and one /brands/{rid} read. No other derivation exists here, honouring F1's "only brandOf" rule.
//
// F1 is wired: an unresolvable location is 'unknown', which every merchant authorizer refuses — the handheld stays closed.

function makeResolveBrand(f1) {
  return async function resolveBrand(db, rid) {
    if (!f1 || typeof f1.brandIdOf !== 'function') return 'unknown';
    const identity = (await db.ref(`restaurants/${rid}/identity`).once('value')).val();
    const brand = (await db.ref(`brands/${rid}`).once('value')).val();
    return f1.brandIdOf(rid, identity, brand === null ? {} : { [rid]: brand });
  };
}

const resolveBrand = makeResolveBrand(require('../brands/brand-model'));

module.exports = { makeResolveBrand, resolveBrand };
