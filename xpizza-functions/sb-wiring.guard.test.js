'use strict';
// S-B step 3 (ruling F1) — the dish_qty intake WIRING (tools/sb-inverse.js, composed INNERMOST — inside unapplySdIndex — in every chain):
//   1. EXACT: index.js minus the three sb hunks === BASE byte-for-byte (outside the checkout endpoints block, pinned whole elsewhere);
//   2. PLACEMENT: each hunk sits right AFTER its record is complete — the held cash record (after its attribution), the immediate cash
//      record (after its attribution), the online pending record (after the S-D snapshot hunk) — i.e. after every pricing / placement
//      computation, so none of them can read it;
//   3. BEHAVIOUR (each hunk lifted and RUN): it ADDS dish_qty to its record and changes NOTHING else (every other key, every other
//      update byte-equal); an unusable context ⇒ no field; it reads only body.items / restaurantId / pricingTables;
//   4. sensitivity: a missing / duplicated / shared-line marker throws; a byte outside every hunk fails the pin.
// Run: node sb-wiring.guard.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { unapplySbIndex, HUNKS } = require('./tools/sb-inverse');
const { unapplyCheckoutIndex } = require('./tools/checkout-inverse');
const { MENU_BY_RESTAURANT } = require('./menu-pricing');

const BASE = 'a61adad5';   // DRYRUN (2e, TRAIN-NEXT2 A4): the pre-3a ASSEMBLY commit (was c887daeb, S-B step 3's parent on feat/security-lifecycle)
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const live = require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')))));
const base = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });
const fold = (s) => unapplyCheckoutIndex(s);

// 1. exact
assert.notStrictEqual(unapplySbIndex(live), live, 'non-vacuity');
assert.strictEqual(fold(require('./tools/sd-inverse').unapplySdIndex(unapplySbIndex(live))), fold(base),   /* DRYRUN: base = pre-3a, so S-D (an earlier 3a slice) is stripped too */ `🔴 index.js minus the sb hunks is not ${BASE}:index.js (outside the checkout endpoints block)`);
assert.strictEqual(live.split('\n').length - unapplySbIndex(live).split('\n').length, HUNKS.length * 4, 'exactly the hunks\' whole lines (4 each) removed');
ok(`exact: index.js minus the three sb hunks === ${BASE} byte-for-byte; exactly their whole lines removed`);

// 2. placement
const block = (h) => live.slice(live.lastIndexOf('\n', live.indexOf(h.begin)) + 1, live.indexOf(h.end) + h.end.length + 1);
const prevLine = (h) => { const a = live.lastIndexOf('\n', live.indexOf(h.begin)); return live.slice(live.lastIndexOf('\n', a - 1) + 1, a); };
const H = Object.fromEntries(HUNKS.map((h) => [h.name, h]));
assert.ok(prevLine(H['cash-dish-qty-held']).startsWith('    attachCustomerAttribution(heldUpdates, orderId, customer_uid,'), '🔴 the held hunk follows the held record\'s attribution');
assert.ok(prevLine(H['cash-dish-qty']).startsWith('  attachCustomerAttribution(updates, orderId, customer_uid,'), '🔴 the cash hunk follows the immediate record\'s attribution');
assert.strictEqual(prevLine(H['online-dish-qty']), '  /* sd:end reorder-price-snapshot */', '🔴 the online hunk follows the S-D snapshot hunk (the pending record is complete)');
for (const h of HUNKS) assert.ok(!/dish_qty/.test(unapplySbIndex(live)), `no dish_qty outside the hunks (${h.name})`);
ok('placement: after the held record\'s attribution, after the immediate record\'s attribution, after the online pending record\'s S-D hunk; dish_qty appears nowhere else in index.js');

// 3. behaviour — run each hunk as written
const X = Object.keys(MENU_BY_RESTAURANT.x_pizza);
const tables = { restaurantId: 'x_pizza', menu: MENU_BY_RESTAURANT.x_pizza };
const ctxUsable = { usableAsIdentity: true, objects: X.map((k, i) => ({ kind: 'dish', legacyKey: k, canonicalId: `cid${i}` })) };
for (const h of HUNKS) {
  const src = block(h);
  const run = (context) => {
    const orderId = 'XPZ-1';
    const rec = { order_id: orderId, total: 299, items_text: '2x', status: 'new', total_cents: 29900 };
    const other = { 'order_tracking/t': { a: 1 }, 'tasks/x': { b: 2 } };
    const ctx = { body: { items: [{ name: X[0], qty: 2, price: 1 }], total: 1 }, restaurantId: 'x_pizza', pricingTables: tables, orderId,
      contextOfTables: (t) => { assert.strictEqual(t, tables, 'the context is THIS charge\'s tables'); return context; },
      require: (m) => require(m.startsWith('./') ? path.join(__dirname, m) : m) };
    if (h.name === 'online-dish-qty') ctx.pendingOrderRecord = rec;
    else ctx[h.name === 'cash-dish-qty-held' ? 'heldUpdates' : 'updates'] = { [`orders/${orderId}`]: rec, ...other };
    const before = JSON.parse(JSON.stringify(ctx.pendingOrderRecord || ctx.heldUpdates || ctx.updates));
    vm.runInNewContext(src, ctx);
    const after = ctx.pendingOrderRecord || ctx.heldUpdates || ctx.updates;
    return { before, after: JSON.parse(JSON.stringify(after)) };
  };
  const { before, after } = run(ctxUsable);
  const r = h.name === 'online-dish-qty' ? after : after['orders/XPZ-1'];
  assert.deepStrictEqual(r.dish_qty, { cid0: 2 }, `🔴 ${h.name}: dish_qty stamped`);
  const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); if (h.name === 'online-dish-qty') delete c.dish_qty; else delete c['orders/XPZ-1'].dish_qty; return c; };
  assert.deepStrictEqual(strip(after), before, `🔴 ${h.name}: NOTHING else changed (every other key / update byte-equal)`);
  const u = run({ usableAsIdentity: false, objects: [] });
  assert.deepStrictEqual(u.after, u.before, `🔴 ${h.name}: an unusable context ⇒ no field, nothing changed`);
}
ok('behaviour: each hunk, run as written, ADDS dish_qty from THIS charge\'s tables and changes nothing else; an unusable context ⇒ untouched');

// 4. sensitivity
const h0 = HUNKS[0];
assert.throws(() => unapplySbIndex(live.replace(h0.begin, '/* sb:BEGIN x */')), /missing/, 'a missing begin');
assert.throws(() => unapplySbIndex(live + `${h0.begin}\n${h0.end}\n`), /more than once/, 'a duplicated hunk');
assert.throws(() => unapplySbIndex(live.replace(`    ${h0.begin}`, `    x; ${h0.begin}`)), /own lines/, 'a marker sharing a base line');
assert.notStrictEqual(fold(unapplySbIndex(`\n${live}`)), fold(base), 'a byte OUTSIDE every hunk fails the pin');
ok('sensitivity: missing / duplicated / shared-line markers throw; a byte outside every hunk fails the pin');

console.log(`sb-wiring.guard: OK (${n})`);
