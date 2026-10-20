// Markup test for singleOrderCardHtml — real rendered DOM (jsdom) over the pure builder's string output.
// jsdom is a devDependency of ../xpizza-functions; resolve it BY NAME from there. Run: `node single-order-card.test.js`.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { singleOrderCardHtml, wazeHref, mapsHref, navTarget, waHref } from './single-order-view.js';
import { displayOrderLabel } from './order-helpers.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = require('jsdom');

let passed = 0;
function t(name, fn) { fn(); passed += 1; }
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SVG = (k) => `<svg data-ic="${k}"></svg>`;
// exactly the keys index.html's ICONS defines — so the builder can't rely on a key that doesn't exist in prod
const ICONS = Object.fromEntries(['bell', 'bike', 'cash', 'check', 'close', 'mobile', 'nav', 'phone', 'pin', 'store', 'uturn', 'warn', 'whatsapp'].map((k) => [k, SVG(k)]));
const DEPS = { ICONS, esc, scheduledBadge: () => '', computeVuelto: (total, tend) => { const a = Number(total), b = Number(tend); return b >= a ? b - a : null; }, RESTAURANT: { lat: 15.5, lng: -88.03 }, navPref: 'Waze' };
const dom = (html) => new JSDOM(`<div id="root">${html}</div>`).window.document;
const build = (o, extra = {}) => dom(singleOrderCardHtml(o, { ...DEPS, ...extra }));

// sample orders — brand ALWAYS from the order (restaurant_display_name), never a literal
const xpOrder = { restaurant_id: 'x_pizza', restaurant_display_name: 'X. Pizza', display_number: '1042', customer_name: 'Daniela Mejía', customer_phone: '9999-8888', payment_method: 'cash', total: 385, cash_tendered_cents: 50000, summary_lines: [{ name: 'Pizza pepperoni', qty: 2, cents: 38500 }, { name: 'Descuento', qty: 1, cents: -5000 }], address_detected: 'Col. Trejo, 12 calle', address_details: 'Portón negro, timbre a la derecha', lat: 15.52, lng: -88.01 };
const offer = { orderId: 'A', phase: 'awaiting_acceptance', pickupTask: { assignment_deadline: Date.now() + 28000, destination_lat: 15.5, destination_lng: -88.03, destination_address: 'Blvd. del Norte' }, order: xpOrder };
const pickup = { orderId: 'A', phase: 'pickup', pickupTask: { destination_lat: 15.5, destination_lng: -88.03, destination_address: 'Blvd. del Norte' }, order: xpOrder };
const delivery = { orderId: 'A', phase: 'delivery', deliveryTask: { destination_lat: 15.4, destination_lng: -88.0, destination_address: 'fallback addr' }, order: xpOrder };

// ---------- phase → correct slide/tap IDs (match attachActiveCardHandlers) ----------
t('offer: .sv-offer, #btn-accept slide, ring w/ deadline, no-reject footnote, NO other slide', () => {
  const doc = build(offer);
  assert.ok(doc.querySelector('.sv-offer'));
  assert.ok(doc.querySelector('#btn-accept.sv-slide'));
  assert.equal(doc.querySelector('.sv-ring').getAttribute('data-deadline'), String(offer.pickupTask.assignment_deadline));
  assert.match(doc.querySelector('.sv-foot-note').textContent, /reasigna/);
  assert.equal(doc.querySelector('#btn-pickup'), null);
  assert.equal(doc.querySelector('#btn-delivered'), null);
});
t('to-restaurant (pickup, not arrived): #btn-at-restaurant client toggle, restaurant name from brand, NO server slide', () => {
  const doc = build(pickup);
  assert.ok(doc.querySelector('#btn-at-restaurant.sv-slide'));
  assert.equal(doc.querySelector('.sv-name').textContent, 'X. Pizza');  // brandLabel(order), not a literal
  assert.equal(doc.querySelector('#btn-pickup'), null);
});
t('at-restaurant review (pickup + atRestaurant): #btn-pickup, big order #, items, reminder, NO at-restaurant tap', () => {
  const doc = build(pickup, { atRestaurant: true });
  assert.ok(doc.querySelector('#btn-pickup.sv-slide'));
  assert.equal(doc.querySelector('.sv-bignum').textContent, displayOrderLabel(xpOrder));
  assert.match(doc.querySelector('.sv-reminder').textContent, /bebidas y salsas/);
  assert.equal(doc.querySelector('#btn-at-restaurant'), null);
});
t('at-restaurant review also triggered by geofence arrived (no explicit tap)', () => {
  assert.ok(build(pickup, { arrived: true }).querySelector('#btn-pickup'));
});
t('to-customer (delivery): #btn-delivered, customer name, promoted reference, NO Llegué/problema (slice 3)', () => {
  const doc = build(delivery);
  assert.ok(doc.querySelector('#btn-delivered.sv-slide'));
  assert.equal(doc.querySelector('.sv-name').textContent, 'Daniela Mejía');
  assert.match(doc.querySelector('.sv-ref').textContent, /Portón negro/);
  assert.equal(doc.querySelector('.sv-addr').textContent.includes('Col. Trejo'), true);
  assert.equal([...doc.querySelectorAll('*')].some((e) => /Llegué|Problema con/.test(e.textContent || '')), false);
});

// ---------- offer ring tracks assignment_deadline (codex r1 P2-2): resume, don't restart ----------
t('ring: animation resumes from elapsed (negative animation-delay) — a re-render mid-way continues, not restarts', () => {
  const base = 1_000_000_000_000;
  const o60 = { ...offer, pickupTask: { ...offer.pickupTask, assignment_deadline: base + 60000 } };
  const run = o60.pickupTask.assignment_deadline;
  // at t0 (full 60 s left): duration = window, delay ≈ -0s
  const s0 = build(o60, { nowMs: base }).querySelector('.sv-ring-run').getAttribute('style');
  assert.match(s0, /animation-duration:60s/);
  assert.match(s0, /animation-delay:-0\.000s/);
  // re-render at +30 s: the ring has drained 30 s → delay ≈ -30s (RESUMES; it does not restart at -0s)
  const s30 = build(o60, { nowMs: base + 30000 }).querySelector('.sv-ring-run').getAttribute('style');
  assert.match(s30, /animation-duration:60s/);
  assert.match(s30, /animation-delay:-30\.000s/);
  // deadline passed → fully drained (elapsed clamped to the window)
  const sEnd = build(o60, { nowMs: run + 5000 }).querySelector('.sv-ring-run').getAttribute('style');
  assert.match(sEnd, /animation-delay:-60\.000s/);
  // no clock supplied → full ring (delay -0s), never NaN
  const sNo = build(o60).querySelector('.sv-ring-run').getAttribute('style');
  assert.match(sNo, /animation-delay:-0\.000s/);
  assert.ok(!/NaN/.test(s0 + s30 + sEnd + sNo), 'no NaN in any ring style');
});

// ---------- items from summary_lines (discount excluded), items_text fallback — shown on offer + review ----------
t('items: summary_lines → qty× articles, discount line excluded, count = Σqty', () => {
  const doc = build(offer);
  const items = [...doc.querySelectorAll('.sv-item')];
  assert.equal(items.length, 1);                        // the discount line is not an article
  assert.match(items[0].textContent, /2×/);
  assert.match(doc.querySelector('.sv-items-h').textContent, /2 artículos/);
});
t('items: absent summary_lines → items_text fallback, split on commas', () => {
  const o = { ...offer, order: { ...xpOrder, summary_lines: undefined, items_text: 'Pizza, Coca-Cola, Salsa' } };
  assert.equal(build(o).querySelectorAll('.sv-item').length, 3);
});
t('items: delivery (alCliente) shows NO items list (matches prototype)', () => {
  assert.equal(build(delivery).querySelector('.sv-items'), null);
});

// ---------- money strictly from collectionFor ----------
t('pay cash: "A cobrar" + amount + Efectivo + vuelto from declared tender', () => {
  const doc = build(delivery);
  assert.match(doc.querySelector('.sv-pay').textContent, /A cobrar/);
  assert.match(doc.querySelector('.sv-amt').textContent, /385/);
  assert.match(doc.querySelector('.sv-pay').textContent, /Efectivo/);
  assert.match(doc.querySelector('.sv-paywith').textContent, /Vuelto.*115/);   // 500 - 385
});
t('pay paid-online: "Pagado en línea", NO "A cobrar", NO vuelto', () => {
  const doc = build({ ...delivery, order: { ...xpOrder, payment_method: 'online', payment_status: 'confirmed' } });
  assert.match(doc.querySelector('.sv-pay').textContent, /Pagado en línea/);
  assert.equal(/A cobrar/.test(doc.querySelector('.sv-pay').textContent), false);
  assert.equal(doc.querySelector('.sv-paywith'), null);
});
t('pay warning: unconfirmed online → "Revisar", never an amount', () => {
  const doc = build({ ...delivery, order: { ...xpOrder, payment_method: 'online', payment_status: 'pending', total: 385 } });
  assert.match(doc.querySelector('.sv-pay.warn').textContent, /Revisar/);
  assert.equal(doc.querySelector('.sv-paywith'), null);
});

// ---------- nav target precedence (exact baseline operators via navTarget) ----------
t('nav pickup: primary=Waze href to pickupTask dest (?? RESTAURANT)', () => {
  const doc = build(pickup);
  assert.equal(doc.querySelector('.sv-nav-primary').getAttribute('href'), wazeHref(navTarget(pickup, true, DEPS.RESTAURANT)));
  assert.equal(doc.querySelector('.sv-nav-other').getAttribute('href'), mapsHref(navTarget(pickup, true, DEPS.RESTAURANT)));
});
t('nav delivery: target from order coords (|| deliveryTask dest)', () => {
  const doc = build(delivery);
  const tgt = navTarget(delivery, false, DEPS.RESTAURANT);
  assert.equal(tgt.lat, 15.52);   // order.lat wins
  assert.equal(doc.querySelector('.sv-nav-primary').getAttribute('href'), wazeHref(tgt));
});
t('navPref Maps → primary is Maps, secondary Waze', () => {
  const doc = build(delivery, { navPref: 'Maps' });
  const tgt = navTarget(delivery, false, DEPS.RESTAURANT);
  assert.equal(doc.querySelector('.sv-nav-primary').getAttribute('href'), mapsHref(tgt));
  assert.match(doc.querySelector('.sv-nav-primary').textContent, /Maps/);
});

// ---------- contact / WhatsApp phase template ----------
t('contact: Call (tel:) + WhatsApp (wa.me phase template) when phone present', () => {
  const doc = build(delivery);
  assert.ok(doc.querySelector('.sv-ct.call').getAttribute('href').startsWith('tel:'));
  assert.equal(doc.querySelector('.sv-ct.wa').getAttribute('href'), waHref(xpOrder, 'en_camino'));
});
t('contact: no phone → no contact row at all', () => {
  assert.equal(build({ ...delivery, order: { ...xpOrder, customer_phone: '' } }).querySelector('.sv-contact'), null);
});

// ---------- brand-agnostic ([[two-brands-mask-literals]]) ----------
t('brand chip: label + class from brandMeta; a DIFFERENT brand shows itself, never a baked-in one', () => {
  const lm = build({ ...delivery, order: { ...xpOrder, restaurant_id: 'la_musa', restaurant_display_name: 'La Musa' } });
  assert.equal(lm.querySelector('.sv-rchip').textContent, 'La Musa');
  assert.ok(lm.querySelector('.sv-rchip').classList.contains('lm'));
  assert.equal(/X\. ?Pizza|x_pizza/.test(lm.querySelector('#root').innerHTML), false);
  const third = build({ ...delivery, order: { ...xpOrder, restaurant_id: 'taco_loco', restaurant_display_name: 'Taco Loco' } });
  assert.ok(third.querySelector('.sv-rchip.neutral'));         // unknown id → neutral tint
  assert.equal(third.querySelector('.sv-rchip').textContent, 'Taco Loco');
});
t('brand chip: nameless brand → no chip (never a defaulted brand)', () => {
  assert.equal(build({ ...delivery, order: { ...xpOrder, restaurant_display_name: '' } }).querySelector('.sv-rchip'), null);
});
t('no hard-coded brand literal in any phase output', () => {
  for (const o of [offer, pickup, { ...pickup }, delivery]) {
    const html = singleOrderCardHtml(o, DEPS);
    // X. Pizza appears ONLY because the sample order carries it as its display name — swap to a 3rd brand and it is gone
    const neutral = singleOrderCardHtml({ ...o, order: { ...o.order, restaurant_id: 'z', restaurant_display_name: 'ZZZ' } }, DEPS);
    assert.equal(/X\. ?Pizza|la_musa|x_pizza/.test(neutral), false);
  }
});

// ---------- purity: deep-frozen inputs + deps, every phase, no throw / no mutation ----------
t('purity: deep-frozen o/order/deps, all phases render without mutation', () => {
  const frozenDeps = deepFreeze({ ...DEPS });
  assert.doesNotThrow(() => {
    for (const base of [offer, pickup, delivery]) {
      const o = deepFreeze(JSON.parse(JSON.stringify(base)));
      singleOrderCardHtml(o, frozenDeps);
      singleOrderCardHtml(o, { ...DEPS, atRestaurant: true, arrived: true });
    }
  });
});

console.log(`✓ single-order-card: ${passed} tests passed`);
