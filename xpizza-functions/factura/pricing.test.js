/**
 * Unit tests for pricedLineItems — per-line gross cents for the factura, mirroring
 * computeServerTotal's validation. Run: `node factura/pricing.test.js`.
 */
const assert = require('assert');
const { pricedLineItems } = require('./pricing');

// small fake tables (whole lempiras, like MENU_PRICES/EXTRA_PRICES)
const MENU = { 'Pizza Pepperoni': 200, 'Coca-Cola': 30 };
const EXTRA = { 'Salsa Roja': 39 };

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  // 1. single item -> gross cents = price*qty*100
  {
    const r = pricedLineItems([{ name: 'Pizza Pepperoni', qty: 2 }], MENU, EXTRA);
    assert.equal(r.error, null);
    assert.deepEqual(r.items, [{ qty: 2, description: 'Pizza Pepperoni', line_gross_cents: 40000 }]);
    ok('single item -> line_gross_cents');
  }

  // 2. extras fold into the parent line gross and append to description
  {
    const r = pricedLineItems([{ name: 'Pizza Pepperoni', qty: 1, extras: [{ name: 'Salsa Roja' }] }], MENU, EXTRA);
    assert.equal(r.error, null);
    assert.equal(r.items[0].line_gross_cents, 200 * 100 + 39 * 100);
    assert.match(r.items[0].description, /Salsa Roja/);
    ok('extras fold into line gross + description');
  }

  // 3. multi-line: sum of line_gross_cents === server total * 100
  {
    const items = [{ name: 'Pizza Pepperoni', qty: 2 }, { name: 'Coca-Cola', qty: 1 }];
    const r = pricedLineItems(items, MENU, EXTRA);
    const sum = r.items.reduce((a, i) => a + i.line_gross_cents, 0);
    assert.equal(sum, (200 * 2 + 30) * 100); // 43000
    ok('sum of line gross === total*100');
  }

  // 4. unknown item -> error, no items
  {
    const r = pricedLineItems([{ name: 'Hamburguesa', qty: 1 }], MENU, EXTRA);
    assert.ok(r.error);
    assert.equal(r.items, null);
    ok('unknown item -> error');
  }

  // 5. unknown extra -> error
  {
    const r = pricedLineItems([{ name: 'Pizza Pepperoni', qty: 1, extras: [{ name: 'Oro' }] }], MENU, EXTRA);
    assert.ok(r.error);
    ok('unknown extra -> error');
  }

  // 6. invalid qty -> error
  {
    const r = pricedLineItems([{ name: 'Pizza Pepperoni', qty: 0 }], MENU, EXTRA);
    assert.ok(r.error);
    ok('invalid qty -> error');
  }

  console.log(`\nAll ${pass} pricing tests passed.`);
})().catch((e) => { console.error('TEST FAILED:', (e && e.stack) || e); process.exit(1); });
