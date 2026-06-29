'use strict';

// Hash-guard (M, finding #1): the anchored expected-output truth (COMBOS) must not drift silently.
// Editing COMBOS changes this hash; updating EXPECTED_HASH is the conscious "I am changing the
// audited pre-Phase-0 truth" step — which a reviewer then re-audits.
const assert = require('assert');
const { combosHash } = require('./combo-validation');

const EXPECTED_HASH = '80da64d2abb124bf20416b4b968da0c75c9d01b1229de5e3b066ea83f58eef91';

assert.equal(
  combosHash(),
  EXPECTED_HASH,
  'combo-validation COMBOS changed — re-audit the expected outputs vs the pre-Phase-0 shape, then update EXPECTED_HASH'
);
console.log('combo-validation.guard: OK (anchored expected unchanged)');
