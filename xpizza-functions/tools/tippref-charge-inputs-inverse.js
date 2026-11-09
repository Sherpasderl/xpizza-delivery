'use strict';
// PLAN-capp-tip-step r7 §1 — the test-only INVERSE of the tip slice's ONE line in catalog/charge-inputs.js: the `tip_choice`
// NON_CHARGE_FIELDS entry (the capp's explicit-choice marker; never priced). Narrowly scoped (the checkout-charge-inputs-inverse
// idiom): it removes EXACTLY that line and nothing else. The tip slice is the NEWEST layer on this file, so this runs FIRST
// (INNERMOST) wherever a guard byte-pins catalog/charge-inputs.js (area-wiring's line pin, s2tip-wiring's module pin).

const FILE = 'catalog/charge-inputs.js';
const LINE = "  tip_choice: 'PLAN-capp-tip-step §1: the capp tip step\\'s explicit-choice marker, read only by tip-pref (a member UX hint, after acceptance); never priced (tip_cents is)',\n";

function unapplyTipprefChargeInputs(src) {
  const i = src.indexOf(LINE);
  if (i < 0 || src.indexOf(LINE, i + 1) !== -1) throw new Error('tippref-charge-inputs-inverse: the tip_choice entry not found exactly once');
  return src.slice(0, i) + src.slice(i + LINE.length);
}
// a module pin's form: only catalog/charge-inputs.js is touched; every other module passes through
const unapplyTipprefChargeInputsModule = (file, src) => (file === FILE ? unapplyTipprefChargeInputs(src) : src);

module.exports = { unapplyTipprefChargeInputs, unapplyTipprefChargeInputsModule, LINE, FILE };
