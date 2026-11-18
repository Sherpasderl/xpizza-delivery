// PLAN-capp-marketing-offers Slice A (advisor 11-14) — THE CART the offer quotes are priced for: the capp's REAL quote-body items
// (CappMenu → CappCart → CappSerialize over the S0 rig's served x_pizza envelope), 2× the first plain dish, and the price table the
// server prices them by ({ name: lempiras }). gen-offer-quote.mjs (run on 5f's tree) quotes exactly these items, so the fixture's
// total_cents IS this cart's subtotal. capp-offers.test.mjs re-derives this file and asserts it unchanged (no drift).
//   node customer-app/fixtures/offer-quote/cart-of.mjs            → writes cart.json
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)), CAPP = join(HERE, '..', '..'), ROOT = join(CAPP, '..');
const require = createRequire(import.meta.url);
export async function cartOf() {
  const { provisionBrand } = await import(join(ROOT, 'xpizza-functions/contract/capp/capture.mjs'));
  const w = console.warn, l = console.log; console.warn = console.log = () => {};
  let env; try { env = (await provisionBrand('x_pizza')).envelope; } finally { console.warn = w; console.log = l; }
  const menu = require(join(CAPP, 'capp-menu.js')).adaptMenu(env);
  const plain = menu.dishes.find((x) => !x.launcher && !x.variantOf && !menu.pickupOnlyCats.has(String(x.cat)));   // capp-ui.test's bootCo `plain`
  const cart = require(join(CAPP, 'capp-cart.js')).createCart(menu);
  cart.inc(plain.key); cart.inc(plain.key);
  const { items } = require(join(CAPP, 'capp-serialize.js')).serialize(cart, menu);
  const price = items[0].price;
  return { key: plain.key, items, menu: { [items[0].name]: price } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(HERE, 'cart.json'), JSON.stringify(await cartOf(), null, 1) + '\n');
  console.log('wrote cart.json');
}
