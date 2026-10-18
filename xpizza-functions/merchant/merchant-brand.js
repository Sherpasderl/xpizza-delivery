'use strict';
// H1a — the ONE place the handheld derives a location's brand: F1's pure brandIdOf (brands/brand-model.js, PLAN-multi-location
// §1.2) over one identity read and one /brands/{rid} read, then F1's checkMembership on the resolved brand (codex r1 P2-5). No
// other derivation exists here, honouring F1's "only brandOf" rule.
//
// F1 is wired: an unresolvable location is 'unknown', which every merchant authorizer refuses — the handheld stays closed.

function makeResolveBrand(f1) {
  return async function resolveBrand(db, rid) {
    if (!f1 || typeof f1.brandIdOf !== 'function' || typeof f1.checkMembership !== 'function') return 'unknown';
    const identity = (await db.ref(`restaurants/${rid}/identity`).once('value')).val();
    const own = (await db.ref(`brands/${rid}`).once('value')).val();
    const b = f1.brandIdOf(rid, identity, own === null ? {} : { [rid]: own });
    if (b === 'unknown') return 'unknown';
    // codex r1 P2-5 (advisor: REQUIRE membership): the resolved brand must exist, be valid, and list this location (member or
    // retired), with the identity naming it (a legacy singleton accepts an absent brand_id). Activation is NOT consulted, so
    // 'off' keeps serving; membership never becomes an intake gate.
    const rec = b === rid ? own : (await db.ref(`brands/${b}`).once('value')).val();
    const findings = f1.checkMembership(rec === null ? {} : { [b]: rec }, { [rid]: identity || {} })
      .filter((f) => f.code === 'brand_invalid' || f.rid === rid);
    if (rec === null || findings.length) return 'unknown';
    return b;
  };
}

const resolveBrand = makeResolveBrand(require('../brands/brand-model'));

module.exports = { makeResolveBrand, resolveBrand };
