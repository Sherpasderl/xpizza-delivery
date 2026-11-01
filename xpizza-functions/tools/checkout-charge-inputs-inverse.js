'use strict';
// PLAN-guest-checkout-server §2.3 — the test-only INVERSE of the slice's ONE line in catalog/charge-inputs.js: the
// `checkout_ticket` NON_CHARGE_FIELDS entry. Narrowly scoped (the area-charge-inputs-inverse idiom): it removes EXACTLY that line
// and nothing else — the neighbouring `entry_mode` (S3b) and `address_area` (colonia) entries stay. The guest-checkout slice is
// the NEWEST layer on this file, so this runs FIRST (INNERMOST) wherever a guard byte-pins catalog/charge-inputs.js
// (area-wiring's line pin, s2tip-wiring's module pin); their base pins are the byte proof that nothing else moved.

const FILE = 'catalog/charge-inputs.js';
const LINE = "  checkout_ticket: 'PLAN-guest-checkout-server §2.3: the capp guest\\'s verified-phone evidence, checked read-only by the guest gate; never priced',\n";

function unapplyCheckoutChargeInputs(src) {
  const i = src.indexOf(LINE);
  if (i < 0 || src.indexOf(LINE, i + 1) !== -1) throw new Error('checkout-charge-inputs-inverse: the checkout_ticket entry not found exactly once');
  return src.slice(0, i) + src.slice(i + LINE.length);
}
// a module pin's form: only catalog/charge-inputs.js is touched; every other module passes through
const unapplyCheckoutChargeInputsModule = (file, src) => (file === FILE ? unapplyCheckoutChargeInputs(src) : src);

module.exports = { unapplyCheckoutChargeInputs, unapplyCheckoutChargeInputsModule, LINE, FILE };
