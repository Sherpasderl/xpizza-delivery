/**
 * Unit tests for the factura trigger predicates. Run: `node factura/eligibility.test.js`.
 */
const assert = require('assert');
const { facturaSaleEligible, facturaVoidEligible, usesPlatformFactura } = require('./eligibility');

const CUTOFF = 1000;
let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

function cashSale(over = {}) {
  return { status: 'new', payment_method: 'cash', factura_status: 'not_due', created_at: 2000, ...over };
}
function onlineSale(over = {}) {
  return { status: 'new', payment_method: 'online', payment_status: 'confirmed', factura_status: 'not_due', created_at: 2000, ...over };
}

(async () => {
  // --- facturaSaleEligible ---
  assert.equal(facturaSaleEligible(cashSale(), CUTOFF), true);                          ok('cash sale at creation is eligible');
  assert.equal(facturaSaleEligible(onlineSale(), CUTOFF), true);                        ok('online sale post-capture is eligible');
  assert.equal(facturaSaleEligible(onlineSale({ payment_status: 'pending' }), CUTOFF), false); ok('online not-yet-confirmed is NOT eligible');
  assert.equal(facturaSaleEligible(cashSale({ status: 'pending_payment' }), CUTOFF), false);    ok('non-new status is NOT eligible');
  assert.equal(facturaSaleEligible(cashSale({ factura_status: 'issued' }), CUTOFF), false);     ok('already issued is NOT eligible (no loop)');
  assert.equal(facturaSaleEligible(cashSale({ factura_status: 'failed' }), CUTOFF), false);     ok('failed left to reconciler, not re-fired');
  assert.equal(facturaSaleEligible(cashSale({ factura_status: undefined }), CUTOFF), false);    ok('legacy order w/o factura_status is NOT eligible');
  assert.equal(facturaSaleEligible(cashSale({ created_at: 500 }), CUTOFF), false);              ok('pre-launch-cutoff order is NOT eligible');
  assert.equal(facturaSaleEligible(null, CUTOFF), false);                                ok('null record is NOT eligible');

  // --- facturaVoidEligible ---
  assert.equal(facturaVoidEligible({ status: 'new' }, { status: 'cancelled' }), true);  ok('new->cancelled is void-eligible');
  assert.equal(facturaVoidEligible(null, { status: 'cancelled' }), true);               ok('created-cancelled (no before) is void-eligible');
  assert.equal(facturaVoidEligible({ status: 'cancelled' }, { status: 'cancelled' }), false); ok('already-cancelled does not re-fire');
  assert.equal(facturaVoidEligible({ status: 'new' }, { status: 'new' }), false);        ok('non-cancel write is not void-eligible');
  assert.equal(facturaVoidEligible({ status: 'new' }, null), false);                     ok('deleted record is not void-eligible');

  // --- usesPlatformFactura (F3 — La Musa external-POS opt-out) ---
  assert.equal(usesPlatformFactura('x_pizza'), true);   ok('x_pizza is on the platform factura pipeline');
  assert.equal(usesPlatformFactura('la_musa'), false);  ok('la_musa is NOT on the platform pipeline (Soft Restaurant POS)');
  assert.equal(usesPlatformFactura('unknown'), false);  ok('unknown restaurant defaults to off-platform');

  console.log(`\nAll ${pass} eligibility tests passed.`);
})().catch((e) => { console.error('TEST FAILED:', (e && e.stack) || e); process.exit(1); });
