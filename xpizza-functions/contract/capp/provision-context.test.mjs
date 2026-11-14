// S-B dish_qty for capp's dish-stats fixture (advisor 2026-11-14) — provisionContext(rid) hands capp createOrder's OWN dish-identity
// input. For both brands: an order whose lines are the published catalog's own dishes, keyed the way the charge keys them
// (menu-pricing availIdentityField of the tables' key mode), maps through dishQtyOf to non-null canonical keys — and a line that is
// not on the menu still yields null (the identity is never partial or guessed). Run: node contract/capp/provision-context.test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert';
import { provisionContext } from './capture.mjs';

const require = createRequire(import.meta.url);
const { dishQtyOf } = require('../../ratings/dish-qty');
const { availIdentityField } = require('../../menu-pricing');
let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ provision-context: exited without completing (a hang)\n'); process.exitCode = 1; } });

try {
  for (const rid of ['x_pizza', 'la_musa']) {
    const { tables, context, keyMode } = await provisionContext(rid);
    assert.strictEqual(context.usableAsIdentity, true, `premise ${rid}: the resolver attached a usable context`);
    const keys = Object.keys(tables.menu).slice(0, 2);
    assert.strictEqual(keys.length, 2, `premise ${rid}: the published menu has dishes`);
    const field = availIdentityField(rid, keyMode);
    const items = [{ [field]: keys[0], qty: 2 }, { [field]: keys[1], qty: 1 }, { [field]: keys[0], qty: 1 }];
    const dq = dishQtyOf(items, rid, context, keyMode);
    assert.ok(dq && typeof dq === 'object', `${rid}: dishQtyOf yields a dish_qty (got ${JSON.stringify(dq)})`);
    assert.strictEqual(Object.keys(dq).length, 2, `${rid}: two distinct dishes ⇒ two canonical keys`);
    assert.ok(Object.keys(dq).every((k) => typeof k === 'string' && k.length > 0), `${rid}: non-null canonical keys`);
    assert.deepStrictEqual(Object.values(dq).sort(), [1, 3], `${rid}: repeated lines sum (2 + 1, 1)`);
    assert.strictEqual(dishQtyOf([...items, { [field]: 'NOT ON MENU', qty: 1 }], rid, context, keyMode), null, `${rid}: a line not on the menu ⇒ null (never partial)`);
    ok(`${rid}: the real resolver's context maps a seeded order to non-null dish keys (key mode ${keyMode})`);
  }
  FINISHED = true;
  console.log(`provision-context: ${n}/${n} ok`);
} catch (e) {
  console.error(`  ✗ ${e.message}`);
  process.exitCode = 1;
}
