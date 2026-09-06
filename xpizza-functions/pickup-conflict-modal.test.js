'use strict';
// Pickup-only conflict modal — source-structural + byte-parity (f2-client style). Runtime = manual smoke.
// Run: node pickup-conflict-modal.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const FORMS = {
  'x-pizza': path.join(__dirname, '..', 'xpizza-orders', 'index.html'),
  'la-musa': path.join(__dirname, '..', 'la-musa-orders', 'index.html'),
};
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// The exact tokens the modal feature must contain in EACH form (byte-parallel).
const TOKENS = [
  'function showPickupConflictModal(',
  'function closePickupConflictModal(',
  'function pickupOnlyLabel(',
  'Por ahora ',
  'es solo para recoger en tienda',
  'Cambiar a recoger en tienda',
  'Quitarla y seguir con delivery',
  ".pk-modal-scrim{",
];

for (const [brand, file] of Object.entries(FORMS)) {
  const src = fs.readFileSync(file, 'utf8');
  for (const t of TOKENS) assert.ok(src.includes(t), `[${brand}] missing token: ${t}`);
  // early choke: goToLocation guards delivery+pickup-only → modal
  assert.ok(/function goToLocation\(\)\{[\s\S]*?orderType==='delivery' && cartHasPickupOnly\(\)\)\{ showPickupConflictModal\(\); return; \}/.test(src),
    `[${brand}] goToLocation early guard → showPickupConflictModal`);
  // backstop choke: processPayment branch calls the modal
  assert.ok(/if\(orderType==='delivery' && cartHasPickupOnly\(\)\)\{\s*showPickupConflictModal\(\);\s*return;\s*\}/.test(src),
    `[${brand}] processPayment backstop → showPickupConflictModal`);
  // config-driven: the modal logic uses cartHasPickupOnly, never a hardcoded category literal in the modal fns
  const modalBlock = src.slice(src.indexOf('function showPickupConflictModal('), src.indexOf('function closePickupConflictModal(') + 200);
  assert.ok(!/['"]ny['"]/.test(modalBlock), `[${brand}] modal must not hardcode a category (config-driven only)`);
  // reuses existing resolutions
  assert.ok(src.includes("setOrderType('pickup')") && src.includes('removePickupOnlyFromCart()'), `[${brand}] reuses setOrderType + removePickupOnlyFromCart`);
  ok(`${brand}: modal fns + both chokes + config-driven + reuse`);
}

// byte-parallel: the modal function + CSS block appears identically in both forms
const xs = fs.readFileSync(FORMS['x-pizza'], 'utf8');
const ls = fs.readFileSync(FORMS['la-musa'], 'utf8');
const grab = (s, start, end) => s.slice(s.indexOf(start), s.indexOf(end));
assert.strictEqual(
  grab(xs, 'function showPickupConflictModal(', 'function pickupOnlyLabel('),
  grab(ls, 'function showPickupConflictModal(', 'function pickupOnlyLabel('),
  'showPickupConflictModal is byte-identical across forms');
ok('both forms byte-parallel on the modal function');

console.log(`\npickup-conflict-modal.test.js: ${pass} passed`);
