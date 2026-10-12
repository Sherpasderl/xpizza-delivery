'use strict';

// Hash-guard (M, finding #1): the anchored expected-output truth (COMBOS) must not drift silently.
// Editing COMBOS changes this hash; updating EXPECTED_HASH is the conscious "I am changing the
// audited pre-Phase-0 truth" step — which a reviewer then re-audits.
const assert = require('assert');
const { combosHash } = require('./combo-validation');

// Rebumped for S1 E2: additive `restaurant_id: 'x_pizza'` on tasks/ORD1_pickup (the only driver
// pickup task in COMBOS — cash_pickup/ORD2 has no tasks). Re-audited: additive-only, no other field
// moved on any record; cash_delivery + cash_pickup goldens still pass byte-identical on prior fields.
// Rebumped for R3-FIX D12: the hub snapshot (HUB) gains the OPTIONAL `restaurant_display_name: 'X. Pizza'` — x_pizza's
// identity.display_name, which the owner seeds before the D12 deploy. Re-audited: no pre3b record changed on any combo; in
// particular order_tracking/TOK2's audited pickup line stays exactly 'Recoger en X. Pizza', now DERIVED from config.
// Rebumped for D12b: both order_tracking records gain the additive `restaurant_display_name: 'X. Pizza'` (the public
// brand the tracker shows, from the identity snapshot). Re-audited: the ONLY change on any record; every prior field,
// address_short included ('Recoger en X. Pizza'), is byte-identical.
const EXPECTED_HASH = '796e241cbef491e4b5d645c8ce9e2945066c56c58e46bbcc8fbdeaad314001c1';

assert.equal(
  combosHash(),
  EXPECTED_HASH,
  'combo-validation COMBOS changed — re-audit the expected outputs vs the pre-Phase-0 shape, then update EXPECTED_HASH'
);
console.log('combo-validation.guard: OK (anchored expected unchanged)');
