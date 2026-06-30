'use strict';

// Hash-guard (M, finding #1): the anchored expected-output truth (COMBOS) must not drift silently.
// Editing COMBOS changes this hash; updating EXPECTED_HASH is the conscious "I am changing the
// audited pre-Phase-0 truth" step — which a reviewer then re-audits.
const assert = require('assert');
const { combosHash } = require('./combo-validation');

// Rebumped for S1 E2: additive `restaurant_id: 'x_pizza'` on tasks/ORD1_pickup (the only driver
// pickup task in COMBOS — cash_pickup/ORD2 has no tasks). Re-audited: additive-only, no other field
// moved on any record; cash_delivery + cash_pickup goldens still pass byte-identical on prior fields.
const EXPECTED_HASH = 'e3e1fb8a1edb53c722563ff58b932403335db7bb499d49f9a98cd1ec907564a8';

assert.equal(
  combosHash(),
  EXPECTED_HASH,
  'combo-validation COMBOS changed — re-audit the expected outputs vs the pre-Phase-0 shape, then update EXPECTED_HASH'
);
console.log('combo-validation.guard: OK (anchored expected unchanged)');
