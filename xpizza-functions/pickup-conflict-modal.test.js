'use strict';
// Pickup-only conflict modal — X. PIZZA ONLY. Source-structural (f2-client style). Runtime = manual smoke.
// Run: node pickup-conflict-modal.test.js
//
// SCOPE: La Musa has NO pickup-only machinery (no NY / pickup-only items; grep 0 vs 31 in x_pizza) — the
// modal is x_pizza-scoped, exactly like weekend_only. Mirroring the guards would call an UNDEFINED
// cartHasPickupOnly()/removePickupOnlyFromCart() at runtime and break la-musa's LIVE delivery checkout on
// every "Continuar" (form-load tests can't catch it — the guard lives inside goToLocation). So this test
// asserts the modal on x_pizza AND that la-musa is NOT given the (undefined-ref) guards/modal.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const xs = fs.readFileSync(path.join(__dirname, '..', 'xpizza-orders', 'index.html'), 'utf8');
const ls = fs.readFileSync(path.join(__dirname, '..', 'la-musa-orders', 'index.html'), 'utf8');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// --- X. Pizza: the modal feature is present + wired at BOTH chokes, config-driven, reusing the resolutions ---
const TOKENS = [
  'function showPickupConflictModal(',
  'function closePickupConflictModal(',
  'function pickupOnlyLabel(',
  'Por ahora ',
  'es solo para recoger en tienda',
  'Cambiar a recoger en tienda',
  'Quitarla y seguir con delivery',
  '.pk-modal-scrim{',
];
for (const t of TOKENS) assert.ok(xs.includes(t), `[x-pizza] missing token: ${t}`);
// early choke: goToLocation guards delivery+pickup-only → modal
assert.ok(/function goToLocation\(\)\{[\s\S]*?orderType==='delivery' && cartHasPickupOnly\(\)\)\{ showPickupConflictModal\(\); return; \}/.test(xs),
  '[x-pizza] goToLocation early guard → showPickupConflictModal');
// backstop choke: processPayment branch calls the modal
assert.ok(/if\(orderType==='delivery' && cartHasPickupOnly\(\)\)\{\s*showPickupConflictModal\(\);\s*return;\s*\}/.test(xs),
  '[x-pizza] processPayment backstop → showPickupConflictModal');
// config-driven: no hardcoded category literal in the modal fns (auto-retires when pickup_only_cats empties)
const modalBlock = xs.slice(xs.indexOf('function showPickupConflictModal('), xs.indexOf('function closePickupConflictModal(') + 200);
assert.ok(!/['"]ny['"]/.test(modalBlock), '[x-pizza] modal must not hardcode a category (config-driven only)');
// reuses the two existing resolutions
assert.ok(xs.includes("setOrderType('pickup')") && xs.includes('removePickupOnlyFromCart()'), '[x-pizza] reuses setOrderType + removePickupOnlyFromCart');
ok('x-pizza: modal fns + both chokes + config-driven + reuse');

// --- La Musa: x_pizza-scoped — the modal + its undefined-ref guards must NOT be present (no runtime break) ---
assert.ok(!ls.includes('showPickupConflictModal'), '[la-musa] must NOT contain the pickup modal (x_pizza-scoped)');
assert.ok(!ls.includes('cartHasPickupOnly'), '[la-musa] must NOT reference cartHasPickupOnly (undefined there → runtime break)');
assert.ok(!ls.includes('.pk-modal-scrim{'), '[la-musa] must NOT contain the modal CSS');
ok('la-musa: pickup-only modal correctly absent (no undefined-ref guards)');

console.log(`\npickup-conflict-modal.test.js: ${pass} passed`);
