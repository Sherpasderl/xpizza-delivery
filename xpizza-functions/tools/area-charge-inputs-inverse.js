'use strict';
// Order colonia (PLAN-colonia-address-area r1) — the test-only INVERSE of the slice's ONE line in catalog/charge-inputs.js: the
// `address_area` NON_CHARGE_FIELDS entry. Narrowly scoped (Codex colonia r1 P2-2): it removes EXACTLY that line and nothing else —
// the neighbouring `entry_mode` entry (S3b) stays. Unlike tools/area-inverse.js (same-line hunks) this hunk is a whole inserted
// line, so it lives apart. Proof (area-wiring.guard): unapplyAreaChargeInputs(charge-inputs.js) === e051df4c:catalog/charge-inputs.js
// byte-for-byte, with sensitivity. Composed INNERMOST wherever a guard byte-pins catalog/charge-inputs.js (s2tip-wiring's module pin).

const BASE = 'e051df4c';
const FILE = 'catalog/charge-inputs.js';
const LINE = "  address_area: 'the pre-accept area label for the driver (display only); never priced, routed, deduped, receipted or bound',\n";

function unapplyAreaChargeInputs(src) {
  const i = src.indexOf(LINE);
  if (i < 0 || src.indexOf(LINE, i + 1) !== -1) throw new Error('area-charge-inputs-inverse: the address_area entry not found exactly once');
  return src.slice(0, i) + src.slice(i + LINE.length);
}
// a module pin's form: only catalog/charge-inputs.js is touched; every other module passes through
const unapplyAreaChargeInputsModule = (file, src) => (file === FILE ? unapplyAreaChargeInputs(src) : src);

module.exports = { unapplyAreaChargeInputs, unapplyAreaChargeInputsModule, LINE, FILE, BASE };
