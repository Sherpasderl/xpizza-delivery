// PLAN-menu-ordering §3 — COPY INTEGRITY for the shared serialization-order model (in its own file, like the other copy tests,
// so a mutant of the canonical copy reaches the behavioural suites instead of dying here).
// Run: node --test xpizza-orders/form-serial-order.copy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

test('the la_musa copy is byte-identical; both forms load it after the cart model', () => {
  const canonical = readFileSync(new URL('./form-serial-order.js', import.meta.url), 'utf8');
  assert.strictEqual(readFileSync(new URL('../la-musa-orders/form-serial-order.js', import.meta.url), 'utf8'), canonical,
    'la-musa-orders/form-serial-order.js has drifted — copy xpizza-orders/form-serial-order.js over it');
  const code = canonical.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.ok(!/^\s*export[\s{]/m.test(code) && !/^\s*import[\s{]/m.test(code), 'no ESM — the same bytes load in Node and as a classic script');
  assert.ok(/module\.exports/.test(code) && /window\.createSerialOrder/.test(code), 'published to both worlds');
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const html = readFileSync(new URL(`../${dir}/index.html`, import.meta.url), 'utf8');
    const cart = html.indexOf('<script src="form-cart.js"></script>'), serial = html.indexOf('<script src="form-serial-order.js"></script>');
    assert.ok(cart !== -1 && serial > cart, `${dir}: form-serial-order.js is loaded, after form-cart.js`);
    // the ORDER serializes through serialLines(): redeemCartItems (items) and buildOrder's items_text — never cartLines()
    assert.ok(/function redeemCartItems\(\)\{[\s\S]{0,400}return serialLines\(\)\.map\(/.test(html), `${dir}: redeemCartItems serializes through serialLines()`);
    assert.ok(/const items=serialLines\(\)\.map\(l => l\.record\);[^\n]*\n\s*const total=calcTotal\(\);\n\s*const orderId = orderIdForThisCart\(\);/.test(html), `${dir}: buildOrder's items_text serializes through serialLines()`);
  }
});
