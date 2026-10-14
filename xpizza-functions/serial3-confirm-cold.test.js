'use strict';
// §3 r3 (codex serialization r3 P1) — the materialize-side duplicate guard through the ACTUAL production wiring, COLD.
// Run: node serial3-confirm-cold.test.js
//
// confirm / webhook / sweep / materialize run in other instances than the intake functions, so their catalog cache is
// cold. The guard therefore must not compute the legacy content key from menu names: chargeOnlineOrder computes BOTH keys
// at intake (warm) and persists them on the pending order. Composed here from the REAL pieces:
//   1. chargeOnlineOrder's real `card-content-keys` block (lifted from index.js, with its real `menuNamesOf` wiring) runs
//      against a WARM gate reader → the keys on the pending record;
//   2. index.js's real `confirmDeps(db)` (lifted verbatim) is built with a COLD gate reader that is never warmed;
//   3. the real materialize-guard.holdIfDuplicateSibling runs on that record with those deps.
// A legacy [A,B] cash sibling + an incoming [B,A] → HELD, with ZERO catalog reads on the cold side.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { holdIfDuplicateSibling } = require('./materialize-guard');
const { orderContentKey, orderContentKeyVerbatim, contentKeysRecord, legacyKeyByOrder, rateLimitKey } = require('./order-dedup');
const { createGateReader } = require('./catalog/menu-gates');
const { createPricingResolver } = require('./catalog/pricing-tables');
const { buildCatalogV2 } = require('./catalog/form-menu-source');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const between = (a, b, from = 0) => { const i = src.indexOf(a, from); assert.ok(i >= 0, `anchor: ${a}`); const j = src.indexOf(b, i); assert.ok(j > i, `anchor: ${b}`); return src.slice(i, j + b.length); };
const chStart = src.indexOf('chargeOnlineApp.all(');
const KEYS_BLOCK = between('  /* serial3:begin card-content-keys */', '  /* serial3:end card-content-keys */', chStart);
assert.ok(src.indexOf('/* serial3:begin card-content-keys */', chStart) < src.indexOf('chargeOnlineApp.use('), 'premise: the lifted block is chargeOnlineOrder\'s');
const WIRING = between('const menuOrderVersionOf = (tables) =>', '\n', 0) + between('const menuNamesOf = (rid, tables) =>', '\n', 0)
  + between('const rewardSuffixOf = (freeItems, itemsText) =>', '\n', 0);   // r5: the reward-provenance helper the block calls
// confirmDeps, verbatim: from its declaration to the function after it
const CONFIRM_DEPS = src.slice(src.indexOf('function confirmDeps(db) {'), src.indexOf('function runConfirm('));
assert.ok(CONFIRM_DEPS.length > 200 && /return \{\s*db,/.test(CONFIRM_DEPS), 'premise: confirmDeps lifted');

function fakeDb(store) {
  const ref = (p) => ({
    child: (k) => ref(`${p}/${k}`),
    async once() { return { val: () => store[p] }; },
    async set(v) { store[p] = v; },
    async transaction(fn) { const next = fn(store[p]); if (next === undefined) return { committed: false }; store[p] = next; return { committed: true, snapshot: { val: () => next } }; },
  });
  return { ref };
}
// the intake block, verbatim, over exactly the names it uses
const runKeys = new Function('ctx', `
  const { pendingOrderRecord, fields, orderType, isScheduled, scheduledForRaw, restaurantId, pricingTables, orderId, contentKeysRecord, gateReader, require,
    redemptionCanonical, redemptionFreeItems, rewardAppendText } = ctx;
  ${WIRING}
  ${KEYS_BLOCK}
  return pendingOrderRecord;`);
// confirmDeps, verbatim, with every OTHER free name it closes over stubbed (they are not on the guard's path) and the gate
// reader supplied — sloppy-mode `with` resolves the free names; the function's own parameter shadows it as in production
function liftConfirmDeps(provided) {
  const stub = () => {};
  const scope = new Proxy(provided, {
    has: (t, k) => typeof k === 'string' && k !== 'confirmDeps' && !(k in globalThis),
    get: (t, k) => (k in t ? t[k] : stub),
  });
  // eslint-disable-next-line no-new-func
  return new Function('scope', `with (scope) { ${CONFIRM_DEPS}\n return confirmDeps; }`)(scope);
}

(async () => {
  const b = buildCatalogV2('x_pizza');
  const menuOf = async () => ({ items: b.items, extras: b.extras, structure: b.structure });
  // intake: WARM (the request's intake gates loaded the pricing version)
  const warm = createGateReader({ getVersionId: async () => 'v1', getMenu: menuOf });
  await warm.intakeGatesFor('x_pizza');
  const resolver = createPricingResolver({ reader: { getTables: async () => ({ menu: Object.fromEntries(b.items.map((i) => [i.key, i.price])), extras: {}, versionId: 'v1', seq: 1 }) }, alarm: () => {} });
  const pricingTables = await resolver.getPricingTables('x_pizza');
  // confirm side: COLD — a real reader that is never warmed; every catalog read is counted
  let coldReads = 0;
  const cold = createGateReader({ getVersionId: async () => { coldReads += 1; return 'v1'; }, getMenu: async () => { coldReads += 1; return menuOf(); } });

  const names = b.structure.item_order.map((k) => b.items.find((i) => i.key === k).display.name);
  const price = (nm) => b.items.find((i) => i.display.name === nm).price;
  const A = `2x ${names[0]} (L${price(names[0])})`, B = `1x ${names[3]} (L${price(names[3])})`;
  const AB = `${A} | ${B}`, BA = `${B} | ${A}`;   // AB = menu order (a pre-§3 client)
  const PHONE = '+50499776655';
  const args = (t) => ({ phone: PHONE, itemsText: t, orderType: 'pickup', scheduledFor: null });
  const leaf = (k) => `recent_order_content/${rateLimitKey(PHONE)}/${k}`;
  assert.notStrictEqual(orderContentKey(args(BA)), orderContentKeyVerbatim(args(AB)), 'premise: the legacy stamp is under a key the canonical one is not');

  const intake = (t, reader = warm) => runKeys({ pendingOrderRecord: { order_id: 'X', customer_phone: PHONE, items_text: t, order_type: 'pickup', restaurant_id: 'x_pizza', payment_method: 'online' },
    fields: { customer_phone: PHONE, items_text: t }, orderType: 'pickup', isScheduled: false, scheduledForRaw: NaN, restaurantId: 'x_pizza', pricingTables, orderId: 'X',
    contentKeysRecord, gateReader: () => reader, require, redemptionCanonical: null, redemptionFreeItems: null, rewardAppendText: require('./order-dedup').rewardAppendText });
  const confirmed = (rec) => ({ ...rec, payment_status: 'confirmed', status: 'pending_payment' });
  // the legacy cash sibling is a real order with its OWN (menu-order) content — the guard verifies it before any hold (r4)
  const legacyCashSibling = (ytext = AB) => ({ [leaf(orderContentKeyVerbatim(args(AB)))]: { at: Date.now() - 30000, order_id: 'Y', payment_method: 'cash' },
    'orders/Y': { order_id: 'Y', status: 'preparing', customer_phone: PHONE, items_text: ytext, order_type: 'pickup', payment_method: 'cash' } });
  const confirmDeps = liftConfirmDeps({ gateReader: () => cold, paymentAlert: async () => {} });
  const quiet = async (fn) => { const logs = []; const w = console.warn; console.warn = (...a) => logs.push(a.join(' ')); try { return { r: await fn(), logs }; } finally { console.warn = w; } };

  // 1. the record intake persists (warm)
  const recBA = intake(BA);
  assert.strictEqual(recBA.content_key, orderContentKey(args(BA)), 'intake persists the order-independent key');
  assert.deepStrictEqual(recBA.content_legacy_order, [1, 0], 'intake persists the MENU-ORDER permutation of the order\'s own lines');
  assert.ok(!('content_key_legacy' in recBA), 'no free-floating legacy key is stored (r4)');
  assert.strictEqual(legacyKeyByOrder(args(BA), recBA.content_legacy_order), orderContentKeyVerbatim(args(AB)), '…from which the reader rebuilds the menu-order legacy key');
  ok('chargeOnlineOrder\'s real block (warm reader) persists content_key + content_legacy_order (the menu-order permutation) on the pending record');

  // 2. the actual confirmDeps, COLD
  { const store = legacyCashSibling(); store['orders/X'] = confirmed(recBA);
    const deps = confirmDeps(fakeDb(store));
    assert.ok(!('menuNamesFor' in deps), 'confirmDeps supplies no menu names');
    const held = await holdIfDuplicateSibling(deps, 'X', confirmed(recBA), 123);
    assert.strictEqual(held, true, '🔴 legacy [A,B] cash sibling + incoming [B,A] through the ACTUAL confirmDeps, cold → HELD (the codex r3 reproduction)');
    assert.strictEqual(store['orders/X'].payment_status, 'manual_reconciliation');
    assert.strictEqual(store['orders/X'].sibling_order_id, 'Y');
    assert.strictEqual(coldReads, 0, 'the cold side made ZERO catalog reads'); }
  { const store = legacyCashSibling(); const rec = intake(AB); store['orders/X'] = confirmed(rec);
    assert.strictEqual(await holdIfDuplicateSibling(confirmDeps(fakeDb(store)), 'X', confirmed(rec), 123), true, 'control: same order → held'); }
  ok('the ACTUAL confirmDeps with a COLD reader: legacy [A,B] sibling + incoming [B,A] → HELD (sibling Y linked); control held; zero catalog reads');

  // 3. an order created BEFORE the deploy (no persisted keys) → today's behaviour + a log
  { const old = { order_id: 'X', customer_phone: PHONE, items_text: AB, order_type: 'pickup', restaurant_id: 'x_pizza', payment_method: 'online' };
    const store = legacyCashSibling(); store['orders/X'] = confirmed(old);
    const { r, logs } = await quiet(() => holdIfDuplicateSibling(confirmDeps(fakeDb(store)), 'X', confirmed(old), 123));
    assert.strictEqual(r, true, 'pre-deploy order, same order → still held (incoming verbatim)');
    assert.ok(logs.some((l) => l.includes('content_key_legacy_unavailable') && l.includes('"order_id":"X"') && l.includes('"reason":"no_persisted_keys"')), 'the fallback is logged');
    const oldBA = { ...old, items_text: BA }; const store2 = legacyCashSibling(); store2['orders/X'] = confirmed(oldBA);
    assert.strictEqual((await quiet(() => holdIfDuplicateSibling(confirmDeps(fakeDb(store2)), 'X', confirmed(oldBA), 123))).r, false, 'pre-deploy order, permuted → not found: today\'s behaviour (the logged, bounded transition gap)'); }
  ok('a pending order created before the deploy (no persisted keys) → today\'s behaviour, logged with the order_id');

  // 4. intake itself cold (no snapshot): the legacy key is absent + its reason, logged; same-order still held
  { const { r: rec, logs } = await quiet(async () => intake(AB, createGateReader({ getVersionId: async () => 'v1', getMenu: menuOf })));
    assert.strictEqual(rec.content_key_legacy, undefined); assert.strictEqual(rec.content_key_legacy_reason, 'no_menu_snapshot');
    assert.ok(logs.some((l) => l.includes('content_key_legacy_unavailable') && l.includes('"order_id":"X"')), 'logged at intake');
    const store = legacyCashSibling(); store['orders/X'] = confirmed(rec);
    assert.strictEqual(await holdIfDuplicateSibling(confirmDeps(fakeDb(store)), 'X', confirmed(rec), 123), true, 'intake had no snapshot: a same-order legacy sibling is still found'); }
  ok('intake without a snapshot: content_key_legacy_reason persisted + logged; the guard reads the incoming verbatim key');

  // 5. r4 (a): the actual confirmDeps, cold — a stamp pointing at an UNRELATED live cash order → NOT held, logged
  { const store = legacyCashSibling('1x Margherita (L250)'); store['orders/X'] = confirmed(recBA);
    const { r, logs } = await quiet(() => holdIfDuplicateSibling(confirmDeps(fakeDb(store)), 'X', confirmed(recBA), 123));
    assert.strictEqual(r, false, '🔴 an unrelated live cash order behind the stamp → NOT held (the codex r4 false hold)');
    assert.strictEqual(store['orders/X'].payment_status, 'confirmed', 'the paid order is untouched');
    assert.ok(logs.some((l) => l.includes('"reason":"sibling_content_mismatch"') && l.includes('"sibling_id":"Y"')), 'logged'); }
  // 6. r4 (b): a corrupted persisted permutation → today's behaviour, logged; never a false hold
  { const bad = { ...recBA, content_legacy_order: [0, 0] }; const store = legacyCashSibling(); store['orders/X'] = confirmed(bad);
    const { r, logs } = await quiet(() => holdIfDuplicateSibling(confirmDeps(fakeDb(store)), 'X', confirmed(bad), 123));
    assert.strictEqual(r, false, 'a corrupted permutation → the permuted legacy sibling is not found (today\'s behaviour)');
    assert.ok(logs.some((l) => l.includes('"reason":"invalid_legacy_order"')), 'logged'); }
  ok('r4, through the ACTUAL confirmDeps cold: an unrelated sibling → not held + logged; a corrupted permutation → fallback + logged');

  console.log(`\nserial3-confirm-cold: OK (${n})`);
})().catch((e) => { console.error('serial3-confirm-cold FAILED:', e); process.exit(1); });
