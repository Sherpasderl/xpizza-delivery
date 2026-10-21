// Pure single-order-view helpers — run: `node single-order-view.test.js` (no framework, repo idiom).
import assert from 'node:assert/strict';
import { itemLines, navTarget, wazeHref, mapsHref, waPhone, waMessage, waHref, brandLabel } from './single-order-view.js';

let passed = 0;
function t(name, fn) { fn(); passed += 1; }
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

// ---------- itemLines: article = qty>0 & cents>=0; discount (cents<0) skipped; reward (cents===0) kept ----------
t('itemLines: absent summary_lines → null (fall back to items_text)', () => assert.equal(itemLines({}), null));
t('itemLines: empty array → null', () => assert.equal(itemLines({ summary_lines: [] }), null));
t('itemLines: non-array → null', () => assert.equal(itemLines({ summary_lines: 'x' }), null));
t('itemLines: malformed (non-string name) → null', () => assert.equal(itemLines({ summary_lines: [{ name: 5, qty: 1, cents: 100 }] }), null));
t('itemLines: malformed (non-integer qty) → null', () => assert.equal(itemLines({ summary_lines: [{ name: 'a', qty: 1.5, cents: 100 }] }), null));
t('itemLines: items kept; discount (cents<0) excluded; reward (cents===0) kept', () => {
  const r = itemLines({ summary_lines: [
    { name: 'Pizza', qty: 2, cents: 38500 },
    { name: 'Descuento · Recompensa', qty: 1, cents: -5000 },   // discount → NOT an item
    { name: 'Coca-Cola gratis', qty: 1, cents: 0 },             // zero-priced reward → IS an item
    { name: 'Nada', qty: 0, cents: 100 },                       // qty 0 → skipped
  ] });
  assert.deepEqual(r, [{ name: 'Pizza', qty: 2 }, { name: 'Coca-Cola gratis', qty: 1 }]);
});
t('itemLines: all discounts → null (no articles)', () => assert.equal(itemLines({ summary_lines: [{ name: 'd', qty: 1, cents: -1 }] }), null));
// codex r1 P2-5: cents is validated on EVERY line BEFORE filtering — one bad line fails the whole summary
// (→ items_text fallback), never silently dropping that line and under-counting the articles.
t('itemLines: a valid pizza + a drink MISSING cents → null (whole-summary items_text fallback, not just the pizza)', () =>
  assert.equal(itemLines({ summary_lines: [{ name: 'Pizza', qty: 1, cents: 38500 }, { name: 'Coca-Cola', qty: 1 }] }), null));
t('itemLines: null cents on any line → null', () =>
  assert.equal(itemLines({ summary_lines: [{ name: 'Pizza', qty: 1, cents: 38500 }, { name: 'Agua', qty: 1, cents: null }] }), null));
t('itemLines: non-numeric cents on any line → null', () =>
  assert.equal(itemLines({ summary_lines: [{ name: 'Pizza', qty: 1, cents: 38500 }, { name: 'Agua', qty: 1, cents: 'x' }] }), null));
t('itemLines: non-integer cents on any line → null', () =>
  assert.equal(itemLines({ summary_lines: [{ name: 'Pizza', qty: 1, cents: 1.5 }] }), null));

// ---------- navTarget: baseline precedence EXACTLY (?? for pickup, || for delivery), zero on BOTH axes ----------
const R = { lat: 15.5, lng: -88.03 };
t('nav pickup: pickup-task dest wins', () => assert.deepEqual(navTarget({ pickupTask: { destination_lat: 1, destination_lng: 2 } }, true, R), { lat: 1, lng: 2 }));
t('nav pickup: nullish → RESTAURANT (both axes)', () => assert.deepEqual(navTarget({ pickupTask: {} }, true, R), { lat: 15.5, lng: -88.03 }));
t('nav pickup: ZERO is KEPT (?? only coalesces null/undefined) — both axes', () => assert.deepEqual(navTarget({ pickupTask: { destination_lat: 0, destination_lng: 0 } }, true, R), { lat: 0, lng: 0 }));
t('nav delivery: order coords win', () => assert.deepEqual(navTarget({ order: { lat: 3, lng: 4 }, deliveryTask: { destination_lat: 9, destination_lng: 9 } }, false, R), { lat: 3, lng: 4 }));
t('nav delivery: ZERO order coord FALLS BACK to delivery-task dest (|| treats 0 as falsy) — both axes', () => assert.deepEqual(navTarget({ order: { lat: 0, lng: 0 }, deliveryTask: { destination_lat: 9, destination_lng: 8 } }, false, R), { lat: 9, lng: 8 }));
t('nav hrefs', () => { const h = navTarget({ order: { lat: 3, lng: 4 }, deliveryTask: {} }, false, R); assert.match(wazeHref(h), /ll=3,4/); assert.match(mapsHref(h), /destination=3,4/); });

// ---------- waPhone normalization (wa.me only) ----------
t('waPhone: 8-digit HN → 504 prefix', () => assert.equal(waPhone('9999-8888'), '50499998888'));
t('waPhone: already +504 → digits as-is (no double prefix)', () => assert.equal(waPhone('+504 9999 8888'), '50499998888'));
t('waPhone: already 504… (no +) → as-is', () => assert.equal(waPhone('50499998888'), '50499998888'));
t('waPhone: absent → ""', () => { assert.equal(waPhone(null), ''); assert.equal(waPhone(''), ''); });

// ---------- waMessage / waHref: brand from order (no literal), encoded once ----------
const brandedOrder = { restaurant_id: 'x_pizza', restaurant_display_name: 'X. Pizza', customer_name: 'Daniela Mejía', customer_phone: '9999-8888' };
t('waMessage en_camino: leads with the order-derived driver greeting (brandLabel); no hardcoded brand', () => {
  const m = waMessage(brandedOrder, 'en_camino');
  assert.ok(m.includes(brandLabel(brandedOrder)));        // brand from the order, whatever it is
});
t('waMessage llegue: addresses the customer by first name', () => {
  assert.ok(waMessage(brandedOrder, 'llegue').includes('Daniela'));
});
t('waMessage direccion: driver greeting + a request for the address', () => {
  const m = waMessage(brandedOrder, 'direccion');
  assert.ok(m.includes(brandLabel(brandedOrder)));
  assert.ok(/direcci/i.test(m));
});
t('waMessage: a different brand yields that brand, never a baked-in one (all phases)', () => {
  const lm = { restaurant_id: 'la_musa', restaurant_display_name: 'La Musa', customer_name: 'C' };
  for (const ph of ['en_camino', 'llegue', 'direccion']) {
    assert.ok(!waMessage(lm, ph).includes('X. Pizza'), `${ph} leaks a baked-in brand`);
  }
  assert.ok(waMessage(lm, 'en_camino').includes('La Musa'));
});
t('waHref: encodes the complete message exactly once, wa.me phone normalized', () => {
  const h = waHref(brandedOrder, 'en_camino');
  assert.ok(h.startsWith('https://wa.me/50499998888?text='));
  assert.ok(!/ /.test(h), 'no raw spaces (encoded once)');
  assert.equal((h.match(/%25/g) || []).length, 0, 'not double-encoded');
  // round-trips back to the exact raw message (single encode)
  assert.equal(decodeURIComponent(h.split('text=')[1]), waMessage(brandedOrder, 'en_camino'));
});
t('waHref: accents / & / quotes in dynamic parts are percent-encoded, not literal', () => {
  const tricky = { restaurant_id: 'other', restaurant_display_name: 'Café & "Más"', customer_name: 'José & Co', customer_phone: '99998888' };
  for (const ph of ['en_camino', 'llegue', 'direccion']) {
    const h = waHref(tricky, ph);
    const enc = h.split('text=')[1];
    assert.ok(!/[ &"]/.test(enc), `${ph}: raw space / & / quote not encoded`);  // only query param, so no literal & at all
    assert.equal(decodeURIComponent(enc), waMessage(tricky, ph), `${ph}: single encode round-trip`);
  }
});
t('waHref: no phone → ""', () => assert.equal(waHref({ restaurant_id: 'x_pizza', restaurant_display_name: 'X. Pizza' }, 'en_camino'), ''));

// ---------- PURITY (r5.1 #2): deep-frozen inputs, every helper, no throw, no mutation ----------
t('purity: helpers do not mutate deep-frozen inputs', () => {
  const o = deepFreeze({ order: { lat: 0, lng: 0, summary_lines: [{ name: 'P', qty: 1, cents: 100 }], customer_name: 'Ana', customer_phone: '99998888', restaurant_id: 'x_pizza', restaurant_display_name: 'X. Pizza' }, pickupTask: { destination_lat: 1, destination_lng: 2 }, deliveryTask: { destination_lat: 9, destination_lng: 8 } });
  assert.doesNotThrow(() => {
    itemLines(o.order); navTarget(o, true, Object.freeze({ lat: 15.5, lng: -88 })); navTarget(o, false, Object.freeze({ lat: 15.5, lng: -88 }));
    waPhone(o.order.customer_phone); waMessage(o.order, 'en_camino'); waMessage(o.order, 'llegue'); waMessage(o.order, 'direccion'); waHref(o.order, 'en_camino');
  });
});

console.log(`✓ single-order-view: ${passed} tests passed`);
