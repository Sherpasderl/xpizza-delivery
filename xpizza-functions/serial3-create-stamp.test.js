'use strict';
// §3 r2 (codex serialization r2 P1) — createOrder's REAL content-stamp / create-side alert block, lifted verbatim from
// index.js (with the real `menuNamesOf` wiring it calls), run against a fake RTDB, a real gate reader and the real
// pricing resolver's envelope. Run: node serial3-create-stamp.test.js
//
// A sibling stamped by a PRE-§3 client sits under the verbatim key of its MENU-ordered text. A new cart in another line
// order must still find it (re-tap + duplicate alert): the block rebuilds the legacy key in the pricing version's menu
// order from the gate reader's cached snapshot. With no cached snapshot it reads the incoming verbatim key, logged.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SCHED = require('./scheduled-orders');
const { orderContentKey, orderContentKeyVerbatim, readContentStamp, rateLimitKey, isContentRetap } = require('./order-dedup');
const { duplicateSiblingDecision } = require('./materialize-guard');
const { createGateReader } = require('./catalog/menu-gates');
const { createPricingResolver } = require('./catalog/pricing-tables');
const { buildCatalogV2 } = require('./catalog/form-menu-source');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const between = (a, b, from = 0) => { const i = src.indexOf(a, from); assert.ok(i >= 0, `anchor: ${a}`); const j = src.indexOf(b, i); assert.ok(j > i, `anchor: ${b}`); return src.slice(i, j + b.length); };
// createOrder's block: the FIRST `let phoneRetap = false;` (createOrderApp) through its catch
const coStart = src.indexOf('createOrderApp.all(');
const BLOCK = between('  let phoneRetap = false;', '  } catch (_) { phoneRetap = false; }', coStart);
assert.ok(src.indexOf('  let phoneRetap = false;', coStart) < src.indexOf('createOrderApp.use('), 'premise: the lifted block is createOrder\'s');
assert.ok(/readContentStamp\(db, [\s\S]*menuNamesOf\(restaurantId, pricingTables\)/.test(BLOCK), 'premise: the block passes the pricing version\'s menu names');
const WIRING = between('const menuOrderVersionOf = (tables) =>', '\n', 0) + between('const menuNamesOf = (rid, tables) =>', '\n', 0);
const WINDOW = between('const CONTENT_DEDUP_WINDOW_MS = ', ';', 0);

function fakeDb(store) {
  const ref = (p) => ({
    child: (k) => ref(`${p}/${k}`),
    async once() { if (p.split('/').length === 2 && p.startsWith('recent_order_content/')) { const pre = p + '/'; const o = {}; for (const [k, v] of Object.entries(store)) if (k.startsWith(pre)) o[k.slice(pre.length)] = v; return { val: () => (Object.keys(o).length ? o : null) }; } return { val: () => store[p] }; },
    async set(v) { store[p] = v; },
    async update(o) { for (const [k, v] of Object.entries(o)) { if (v === null) delete store[`${p}/${k}`]; else store[`${p}/${k}`] = v; } },
  });
  return { ref };
}
// the lifted code, verbatim, as an async function over exactly the names it uses
const run = new Function('ctx', `return (async () => {
  const { db, body, fields, orderType, orderId, restaurantId, pricingTables, SCHED, orderContentKey, readContentStamp, rateLimitKey,
    isContentRetap, duplicateSiblingDecision, gateReader, require } = ctx;
  ${WINDOW}
  ${WIRING}
  ${BLOCK}
  return phoneRetap;
})();`);

(async () => {
  const b = buildCatalogV2('x_pizza');
  const gate = createGateReader({ getVersionId: async () => 'v1', getMenu: async () => ({ items: b.items, extras: b.extras, structure: b.structure }) });
  const resolver = createPricingResolver({ reader: { getTables: async () => ({ menu: Object.fromEntries(b.items.map((i) => [i.key, i.price])), extras: {}, versionId: 'v1', seq: 1 }) }, alarm: () => {} });
  const pricingTables = await resolver.getPricingTables('x_pizza');
  const names = b.structure.item_order.map((k) => b.items.find((i) => i.key === k).display.name);
  const first = names[0], later = names[3];
  const A = `2x ${first} (L${b.items.find((i) => i.display.name === first).price})`, B = `1x ${later} (L${b.items.find((i) => i.display.name === later).price})`;   // "1x …" sorts before "2x …": canonical ≠ menu order
  const AB = `${A} | ${B}`, BA = `${B} | ${A}`;   // AB = menu order (what a pre-§3 client sent)
  const PHONE = '+50499887766';
  const args = (t) => ({ phone: PHONE, itemsText: t, orderType: 'delivery', scheduledFor: null });
  const leaf = (k) => `recent_order_content/${rateLimitKey(PHONE)}/${k}`;
  const call = async (store, itemsText, { warm = true } = {}) => {
    const gr = warm ? gate : createGateReader({ getVersionId: async () => 'v1', getMenu: async () => ({ items: b.items, extras: b.extras, structure: b.structure }) });
    if (warm) await gr.intakeGatesFor('x_pizza');   // the request's intake gates loaded the pricing version (v1)
    const logs = []; const origWarn = console.warn; console.warn = (...a) => logs.push(a.join(' '));
    try {
      const retap = await run({ db: fakeDb(store), body: { scheduled_for: null }, fields: { customer_phone: PHONE, items_text: itemsText, payment_method: 'cash' },
        orderType: 'delivery', orderId: 'Y', restaurantId: 'x_pizza', pricingTables, SCHED, orderContentKey, readContentStamp, rateLimitKey, isContentRetap,
        duplicateSiblingDecision, gateReader: () => gr, require });
      return { retap, logs };
    } finally { console.warn = origWarn; }
  };
  const liveOnlineLegacy = () => ({ [leaf(orderContentKeyVerbatim(args(AB)))]: { at: Date.now() - 30000, order_id: 'X', payment_method: 'online' }, 'orders/X': { status: 'preparing' } });

  assert.notStrictEqual(orderContentKeyVerbatim(args(AB)), orderContentKey(args(BA)), 'premise: the legacy stamp is under a key the canonical one is not');
  { const store = liveOnlineLegacy(); const r = await call(store, BA);
    assert.strictEqual(r.retap, true, '🔴 legacy [A,B] stamp + incoming [B,A]: a re-tap (the codex r2 reproduction)');
    assert.ok(store['dispatcher_alerts/duplicate_order_Y'] && store['dispatcher_alerts/duplicate_order_Y'].sibling_order_id === 'X', '🔴 …and the create-side duplicate alert links X');
    assert.ok(store[leaf(orderContentKey(args(BA)))], 'the new stamp is written under the order-independent key'); }
  { const store = liveOnlineLegacy(); const r = await call(store, AB);
    assert.strictEqual(r.retap, true); assert.ok(store['dispatcher_alerts/duplicate_order_Y'], 'control: same order → re-tap + alert'); }
  { const store = liveOnlineLegacy(); const r = await call(store, BA, { warm: false });   // no cached snapshot for the pricing version
    assert.strictEqual(r.retap, false, 'no snapshot + a permuted legacy stamp: not found (the bounded, logged gap)');
    assert.ok(r.logs.some((l) => l.includes('content_key_legacy_unavailable') && l.includes('"order_id":"Y"') && l.includes('"reason":"no_menu_snapshot"')), 'the fallback is logged with the order_id');
    const store2 = liveOnlineLegacy(); const r2 = await call(store2, AB, { warm: false });
    assert.strictEqual(r2.retap, true, 'no snapshot: a same-order legacy stamp is still found (incoming verbatim)'); assert.ok(store2['dispatcher_alerts/duplicate_order_Y']); }
  ok('createOrder\'s real stamp/alert block: a legacy [A,B] live online sibling is found from a [B,A] cash order (re-tap + alert); same-order control; no snapshot → incoming verbatim, logged');
  console.log(`\nserial3-create-stamp: OK (${n})`);
})().catch((e) => { console.error('serial3-create-stamp FAILED:', e); process.exit(1); });
