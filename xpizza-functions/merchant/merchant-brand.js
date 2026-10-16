'use strict';
// H1a — the ONE place the handheld derives a location's brand: F1's pure brandIdOf (brands/brand-model.js, PLAN-multi-location
// §1.2) over one identity read and one /brands/{rid} read. No other derivation exists here, honouring F1's "only brandOf" rule.
//
// REBASE STEP: F1 (brands/brand-model.js) is not on this branch's base. The repo's dependency walkers refuse an import they
// cannot resolve (catalog/source-store, identity-public-contract) and any non-literal one, so this base wires NO F1 module:
// resolveBrand returns 'unknown', which every merchant authorizer refuses — the handheld stays closed. On the rebase onto a
// main that contains F1, the single line below becomes:  makeResolveBrand(require('../brands/brand-model'))

function makeResolveBrand(f1) {
  return async function resolveBrand(db, rid) {
    if (!f1 || typeof f1.brandIdOf !== 'function') return 'unknown';
    const identity = (await db.ref(`restaurants/${rid}/identity`).once('value')).val();
    const brand = (await db.ref(`brands/${rid}`).once('value')).val();
    return f1.brandIdOf(rid, identity, brand === null ? {} : { [rid]: brand });
  };
}

const resolveBrand = makeResolveBrand(null);

module.exports = { makeResolveBrand, resolveBrand };
