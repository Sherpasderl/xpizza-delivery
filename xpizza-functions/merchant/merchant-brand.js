'use strict';
// H1a — the ONE place the handheld derives a location's brand: F1's pure brandIdOf (brands/brand-model.js, PLAN-multi-location
// §1.2) over one identity read and one /brands/{rid} read. No other derivation exists here, honouring F1's "only brandOf" rule.
// F1 is not yet on every base this branch rebases over: when brands/brand-model.js is absent the resolver returns 'unknown',
// which every merchant authorizer refuses — the handheld stays closed rather than guessing a brand.

function loadF1() {
  try { return require('../brands/brand-model'); } catch (e) { if (e && e.code === 'MODULE_NOT_FOUND') return null; throw e; }
}

function makeResolveBrand(f1) {
  return async function resolveBrand(db, rid) {
    if (!f1 || typeof f1.brandIdOf !== 'function') return 'unknown';
    const identity = (await db.ref(`restaurants/${rid}/identity`).once('value')).val();
    const brand = (await db.ref(`brands/${rid}`).once('value')).val();
    return f1.brandIdOf(rid, identity, brand === null ? {} : { [rid]: brand });
  };
}

const resolveBrand = makeResolveBrand(loadF1());

module.exports = { makeResolveBrand, resolveBrand };
