'use strict';
// ---------------------------------------------------------------------------
// THE SHARED REAL-CART FIXTURES — one source, imported by every suite that claims parity.
//
// 🔴 WHY THIS FILE EXISTS. compute-server-net.test.js and quote-order.test.js each held their own
// copy of these carts. They were identical, so every parity assertion passed — and nothing stopped
// them drifting apart, or, worse, drifting TOGETHER away from production while still agreeing with
// each other. A parity test whose fixtures can rot is a parity test that can pass vacuously, which is
// precisely the failure class these suites exist to catch. Applying single-source to the tests that
// guard single-source.
//
// These are real carts from both brands: a single item, a multiple, an extras-bearing one (the case
// where the two brands' option models diverge — x_pizza name-keyed and counted once, la_musa id-keyed
// and qty-aware), a second-menu item, and a large quantity.
const CARTS = {
  x_pizza: [
    [{ name: 'Margherita', qty: 1 }],
    [{ name: 'Pepperoni', qty: 3 }],
    [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }, { name: 'Basil Pesto' }] }],
    [{ name: 'Carnivora NY', qty: 1 }],
    [{ name: 'Nutella', qty: 50 }],
  ],
  la_musa: [
    [{ id: 'dimsum_01', qty: 1 }],
    [{ id: 'noodle_02', qty: 4 }],
    [{ id: 'dimsum_01', qty: 2, extras: [{ id: 'rice_white', qty: 3 }] }],
  ],
};

module.exports = { CARTS };
