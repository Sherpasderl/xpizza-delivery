'use strict';

/**
 * Golden test for the cash-intake builder, driven by the shared, hash-guarded anchored expected
 * (deploy/combo-validation.js — the SAME COMBOS the emulator e2e validates against, so what the
 * emulator proves is byte-for-byte what the goldens prove). Asserts each cash combo's output is
 * byte-identical on existing fields + additive-snapshot-only + tasks/tracking exact + no metadata
 * leak, against the audited pre-Phase-0 truth.
 */
const { buildCreateOrderUpdates } = require('./create-order-build');
const { COMBOS, assertComboOutput } = require('./deploy/combo-validation');

let n = 0;
const ok = (label) => console.log(`  ✓ ${++n} ${label}`);

for (const [key, combo] of Object.entries(COMBOS)) {
  const updates = buildCreateOrderUpdates({ ...combo.input, hubSnap: combo.snapshot });
  assertComboOutput(updates, combo);
  ok(`${key}: order+tasks+tracking byte-identical (existing) + additive-snapshot-only + no leak`);
}

console.log(`create-order-build: OK (${n} cases)`);
