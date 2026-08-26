'use strict';
// Guarded pricing resolver — pure/DI'd tests. Run: node catalog/pricing-tables.test.js
const assert = require('assert');
const { createPricingResolver, tablesEqual } = require('./pricing-tables');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// A never-settling await inside the async IIFE drains the event loop and Node exits 0 having run only
// part of the file — a HANG would read as a PASS. This turns "exited before the end" into a failure.
let finished = false;
process.on('exit', (code) => {
  if (code === 0 && !finished) { console.error('FATAL: pricing-tables.test.js exited early (a hang?) without completing'); process.exitCode = 1; }
});

const CODE = { x_pizza: { menu: { Margherita: 299, Pepperoni: 307 }, extras: { Mozzarella: 50 } },
               la_musa: { menu: { dimsum_01: 223 }, extras: { rice_white: 50 } } };
const codeFor = (rid) => ({ menu: CODE[rid].menu, extras: CODE[rid].extras });
const clone = (rid) => JSON.parse(JSON.stringify(CODE[rid]));
const mk = (getTables) => { const seen = []; return { resolver: createPricingResolver({ reader: { getTables }, codeFor, alarm: async (k, d) => { seen.push([k, d]); } }), seen }; };

(async () => {
  // ── PIN A: tablesEqual is STRICT — key sets + exact integer values ──
  assert.strictEqual(tablesEqual(clone('x_pizza'), CODE.x_pizza), true); ok('tablesEqual: identical → true');
  const price = clone('x_pizza'); price.menu.Margherita = 300;
  assert.strictEqual(tablesEqual(price, CODE.x_pizza), false); ok('PIN A: a single differing price → NOT equal');
  const missing = clone('x_pizza'); delete missing.menu.Pepperoni;
  assert.strictEqual(tablesEqual(missing, CODE.x_pizza), false); ok('PIN A: a missing key → NOT equal');
  const extra = clone('x_pizza'); extra.menu.Ghost = 1;
  assert.strictEqual(tablesEqual(extra, CODE.x_pizza), false); ok('PIN A: an extra key → NOT equal');
  const exMiss = clone('x_pizza'); delete exMiss.extras.Mozzarella;
  assert.strictEqual(tablesEqual(exMiss, CODE.x_pizza), false); ok('PIN A: EXTRAS are compared too (missing extra → NOT equal)');
  const strPrice = clone('x_pizza'); strPrice.menu.Margherita = '299';
  assert.strictEqual(tablesEqual(strPrice, CODE.x_pizza), false); ok("PIN A: '299' !== 299 — exact integer equality, no coercion");

  // ── parity holds → the CATALOG is the source (this is the cutover) ──
  for (const rid of ['x_pizza', 'la_musa']) {
    const { resolver, seen } = mk(async (r) => clone(r));
    const t = await resolver.getPricingTables(rid);
    assert.deepStrictEqual(t, { restaurantId: rid, menu: CODE[rid].menu, extras: CODE[rid].extras });
    assert.strictEqual(seen.length, 0, 'no alarm when parity holds');
    ok(`parity holds ${rid} → returns catalog tables, restaurant-TAGGED, no alarm`);
  }

  // ── mismatch → CODE + alarm (fail-safe), for each mismatch shape ──
  for (const [label, mutate] of [
    ['differing price', (c) => { c.menu.Margherita = 1; }],
    ['missing key', (c) => { delete c.menu.Pepperoni; }],
    ['extra key', (c) => { c.menu.Ghost = 1; }],
  ]) {
    const { resolver, seen } = mk(async (r) => { const c = clone(r); mutate(c); return c; });
    const t = await resolver.getPricingTables('x_pizza');
    assert.deepStrictEqual(t, { restaurantId: 'x_pizza', menu: CODE.x_pizza.menu, extras: CODE.x_pizza.extras });
    assert.strictEqual(seen[0][0], 'catalog_parity_mismatch');
    assert.strictEqual(seen[0][1].restaurantId, 'x_pizza', 'alarm detail names the restaurant');
    ok(`mismatch (${label}) → CODE tables + catalog_parity_mismatch alarm`);
  }

  // ── reader throws → CODE + alarm (fail-safe; the 1a contract propagates the throw to here) ──
  for (const err of ['firestore down', 'restaurant_not_found: x', 'catalog_empty: x']) {
    const { resolver, seen } = mk(async () => { throw new Error(err); });
    const t = await resolver.getPricingTables('x_pizza');
    assert.deepStrictEqual(t, { restaurantId: 'x_pizza', menu: CODE.x_pizza.menu, extras: CODE.x_pizza.extras });
    assert.strictEqual(seen[0][0], 'catalog_read_failed');
    ok(`reader throws (${err.split(':')[0]}) → CODE tables + catalog_read_failed alarm`);
  }

  // ── PIN D: the resolver NEVER throws — even if the alarm sink itself throws ──
  const boomResolver = createPricingResolver({ reader: { getTables: async () => { throw new Error('down'); } }, codeFor, alarm: () => { throw new Error('alarm sink exploded'); } });
  const t = await boomResolver.getPricingTables('x_pizza');
  assert.deepStrictEqual(t, { restaurantId: 'x_pizza', menu: CODE.x_pizza.menu, extras: CODE.x_pizza.extras });
  ok('PIN D: a throwing alarm sink still yields CODE tables (resolver never throws out)');

  // ── a malformed catalog shape must not crash the compare — it is simply not equal ──
  for (const junk of [null, undefined, {}, { menu: null, extras: null }, { menu: 'nope' }]) {
    const { resolver, seen } = mk(async () => junk);
    const r = await resolver.getPricingTables('x_pizza');
    assert.deepStrictEqual(r.menu, CODE.x_pizza.menu, 'malformed catalog → code tables');
    assert.ok(seen.length === 1, 'malformed catalog alarms');
  }
  ok('malformed catalog shapes → CODE tables + alarm (compare never throws)');
  // ── BOUNDED DEADLINE (codex money-grill): a HANG must land on code, fast. The fail-safe catches a
  //    REJECT; it does not catch a read that never settles. Unbounded, the handler's `await` would block
  //    until the 30s function timeout and DROP the order — an intake outage caused by the pricing cutover.
  {
    const alarms = [];
    const hung = createPricingResolver({
      reader: { getTables: () => new Promise(() => {}) },        // never resolves, never rejects
      codeFor, alarm: (k, d) => { alarms.push([k, d]); }, deadlineMs: 20,
    });
    const t0 = Date.now();
    const t = await hung.getPricingTables('x_pizza');
    const elapsed = Date.now() - t0;
    assert.deepStrictEqual(t, { restaurantId: 'x_pizza', menu: CODE.x_pizza.menu, extras: CODE.x_pizza.extras }, 'a hang falls back to CODE tables');
    assert.ok(elapsed < 500, `must return within the deadline, not block (took ${elapsed}ms)`);
    assert.strictEqual(alarms.length, 1);
    assert.strictEqual(alarms[0][0], 'catalog_read_timeout', 'a HANG alarms catalog_read_timeout, NOT catalog_read_failed');
    ok(`bounded deadline: a never-resolving catalog read → CODE tables in ${elapsed}ms + catalog_read_timeout`);
  }
  {
    // Regression: a REJECT still reports catalog_read_failed (the two failure modes stay distinguishable
    // so the prod-prove window can tell a hang from an error).
    const { resolver, seen } = mk(async () => { throw new Error('boom'); });
    await resolver.getPricingTables('x_pizza');
    assert.strictEqual(seen[0][0], 'catalog_read_failed', 'a reject is still catalog_read_failed, not timeout');
    ok('regression: reject → catalog_read_failed (distinct from the timeout kind)');
  }
  {
    // Regression: a fast reader still wins the race and the CATALOG serves (the deadline must not
    // accidentally beat a healthy read).
    const { resolver, seen } = mk(async (r) => clone(r));
    const t = await resolver.getPricingTables('x_pizza');
    assert.deepStrictEqual(t.menu, CODE.x_pizza.menu);
    assert.deepStrictEqual(seen, [], 'a healthy read raises no alarm');
    ok('regression: a fast reader still returns CATALOG tables (deadline does not misfire)');
  }
  {
    // A late rejection after the deadline must not surface as an unhandled rejection.
    let rejectLate; const late = new Promise((_, rej) => { rejectLate = rej; });
    const r2 = createPricingResolver({ reader: { getTables: () => late }, codeFor, alarm: () => {}, deadlineMs: 10 });
    const t = await r2.getPricingTables('x_pizza');
    assert.deepStrictEqual(t.menu, CODE.x_pizza.menu);
    rejectLate(new Error('arrived after the deadline'));
    await new Promise((res) => setTimeout(res, 30));
    ok('a rejection arriving AFTER the deadline is swallowed (no unhandled rejection)');
  }

  finished = true;
  console.log(`pricing-tables: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
