'use strict';

// Hash-guard (M, finding #1): the anchored expected-output truth (COMBOS) must not drift silently.
// Editing COMBOS changes this hash; updating EXPECTED_HASH is the conscious "I am changing the
// audited pre-Phase-0 truth" step — which a reviewer then re-audits.
const assert = require('assert');
const { combosHash } = require('./combo-validation');

const EXPECTED_HASH = 'e284f2d7167d082a04c7d0f66e906eb42939fa7e24b3b661382ef73f3e34d7c0';

assert.equal(
  combosHash(),
  EXPECTED_HASH,
  'combo-validation COMBOS changed — re-audit the expected outputs vs the pre-Phase-0 shape, then update EXPECTED_HASH'
);
console.log('combo-validation.guard: OK (anchored expected unchanged)');
