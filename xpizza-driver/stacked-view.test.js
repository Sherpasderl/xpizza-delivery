// Pure stacked-view logic + markup builders — run: `node stacked-view.test.js` (no framework, repo idiom).
// The markup builders are ALSO co-verified by the jsdom real-writer branch harness (handler binding); here
// we assert the pure output: the baseline binding hooks are present and the slice-2 elements are correct.
import assert from 'node:assert/strict';
import {
  destinationLabel, orderIdTail, stopNavInfo, resolveVisibleLabels,
  bagTagClass, bagTagHtml, phaseStripHtml,
  activeCardHtml, queueHtml, queueDetailHtml, incomingBannerHtml,
} from './stacked-view.js';

let passed = 0;
function t(name, fn) { fn(); passed += 1; }
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const RESTAURANT = { lat: 14.10, lng: -87.22 };

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const ICONS = { nav: '<i>N</i>', check: '<i>C</i>', phone: '<i>P</i>', whatsapp: '<i>W</i>', pin: '<i>PIN</i>', cash: '<i>$</i>' };
const DEPS = { ICONS, esc, scheduledBadge: () => '', computeVuelto: () => null, RESTAURANT, navPref: undefined };

// ---------- destinationLabel: phase-correct (Codex P1-2) ----------
t('destinationLabel: pickup → restaurant brand name', () => {
  assert.equal(destinationLabel(deepFreeze({ phase: 'pickup', order: { restaurant_display_name: 'La Musa', address_detected: 'Col. Palmira' } })), 'La Musa');
});
t('destinationLabel: pickup w/o brand → pickup task destination_address (NOT the customer)', () => {
  assert.equal(destinationLabel(deepFreeze({ phase: 'pickup', order: { address_detected: 'Col. Palmira' }, pickupTask: { destination_address: 'Blvd Morazán' } })), 'Blvd Morazán');
});
t('destinationLabel: delivery → the customer address', () => {
  assert.equal(destinationLabel(deepFreeze({ phase: 'delivery', order: { address_detected: 'Col. Kennedy' }, deliveryTask: {} })), 'Col. Kennedy');
});
t('destinationLabel: delivery w/o order record → delivery task address', () => {
  assert.equal(destinationLabel(deepFreeze({ phase: 'delivery', deliveryTask: { destination_address: 'Res. El Trapiche' } })), 'Res. El Trapiche');
});

// ---------- orderIdTail ----------
t('orderIdTail: last 4 chars', () => assert.equal(orderIdTail('ord_9a3f9'), 'a3f9'));
t('orderIdTail: empty when no id', () => assert.equal(orderIdTail(null), ''));

// ---------- resolveVisibleLabels: Codex r2 P1-2 collision cases ----------
t('cross-hub pair with the SAME display number → both get an orderId tail; label+orderId+URL hold', () => {
  const stops = [
    { orderId: 'ordA1b2', phase: 'delivery', order: { restaurant_id: 'x_pizza', display_number: 5, address_detected: 'Col. Palmira', lat: 14.06, lng: -87.16 }, deliveryTask: {} },
    { orderId: 'ordC3d4', phase: 'delivery', order: { restaurant_id: 'la_musa', display_number: 5, address_detected: 'Col. Palmira', lat: 14.12, lng: -87.10 }, deliveryTask: {} },
  ];
  const infos = stops.map((o) => stopNavInfo(deepFreeze(o), RESTAURANT));
  const out = resolveVisibleLabels(infos);
  assert.equal(out[0].label, 'Col. Palmira · #5 · #' + orderIdTail('ordA1b2'));
  assert.equal(out[1].label, 'Col. Palmira · #5 · #' + orderIdTail('ordC3d4'));
  assert.notEqual(out[0].label, out[1].label);
  assert.equal(out[0].orderId, 'ordA1b2');
  assert.ok(out[0].waze.includes('14.06,-87.16') && out[0].maps.includes('destination=14.06,-87.16'));
  assert.equal(out[1].orderId, 'ordC3d4');
  assert.ok(out[1].waze.includes('14.12,-87.1') && out[1].maps.includes('destination=14.12,-87.1'));
});

t('absent order record → display number empty → orderId tail appended; label+orderId+URL hold', () => {
  const o = { orderId: 'ordZ9f0', phase: 'delivery', deliveryTask: { destination_address: 'Res. El Trapiche', destination_lat: 14.09, destination_lng: -87.19 } };
  const [out] = resolveVisibleLabels([stopNavInfo(deepFreeze(o), RESTAURANT)]);
  assert.equal(out.label, 'Res. El Trapiche · #' + orderIdTail('ordZ9f0'));
  assert.equal(out.orderId, 'ordZ9f0');
  assert.ok(out.waze.includes('14.09,-87.19') && out.maps.includes('destination=14.09,-87.19'));
});

t('distinct labels WITH display numbers → no orderId tail (stable)', () => {
  const stops = [
    { orderId: 'ordA', phase: 'delivery', order: { display_number: 7, address_detected: 'Col. Kennedy', lat: 14.06, lng: -87.16 }, deliveryTask: {} },
    { orderId: 'ordB', phase: 'delivery', order: { display_number: 8, address_detected: 'Col. Miraflores', lat: 14.12, lng: -87.10 }, deliveryTask: {} },
  ];
  const out = resolveVisibleLabels(stops.map((o) => stopNavInfo(deepFreeze(o), RESTAURANT)));
  assert.equal(out[0].label, 'Col. Kennedy · #7');
  assert.equal(out[1].label, 'Col. Miraflores · #8');
});

// ---------- bag tags ----------
t('bagTagClass: 1→a (marino), 2→b (celeste)', () => {
  assert.equal(bagTagClass(1), 'a');
  assert.equal(bagTagClass(2), 'b');
  assert.equal(bagTagClass(3), 'b');
});
t('bagTagHtml: renders the chip', () => assert.equal(bagTagHtml(1), '<span class="bagtag a">1</span>'));

// ---------- phase strip ----------
t('phaseStripHtml: fewer than 2 stops → empty', () => assert.equal(phaseStripHtml([{ n: 1, on: true }]), ''));
t('phaseStripHtml: 2 stops → ONLY the active segment is on (position-pinned), both numbered, no done', () => {
  const html = phaseStripHtml([{ n: 1, on: true }, { n: 2, on: false }]);
  // Pin the class of EACH segment in order: the active (stop 1) is `st on`, the inactive (stop 2) is bare `st`.
  // (A bare `includes('class="st on"')` would pass even if the on-class landed on the WRONG segment.)
  const segClasses = html.match(/<span class="st( on)?">/g);
  assert.deepEqual(segClasses, ['<span class="st on">', '<span class="st">'], 'segment 1 active (on), segment 2 inactive (no on)');
  assert.ok(html.includes('>1</span>') && html.includes('>2</span>'), 'numbered');
  assert.ok(!html.includes('done'), 'no done segment');
});
t('phaseStripHtml: the active flag moves with the data (stop 2 active → only segment 2 is on)', () => {
  const html = phaseStripHtml([{ n: 1, on: false }, { n: 2, on: true }]);
  const segClasses = html.match(/<span class="st( on)?">/g);
  assert.deepEqual(segClasses, ['<span class="st">', '<span class="st on">'], 'segment 1 inactive, segment 2 active');
});
t('phaseStripHtml: customer-name labels render "1 · Name" (escaped), no per-stop time', () => {
  const html = phaseStripHtml([{ n: 1, on: true, label: 'Daniela' }, { n: 2, on: false, label: 'Carlos <&>' }], esc);
  assert.ok(html.includes('>1 · Daniela</span>'), 'active name label');
  assert.ok(html.includes('>2 · Carlos &lt;&amp;&gt;</span>'), 'escaped queued name label');
  assert.ok(!html.includes('antes de'), 'no per-stop target time');
});

// ---------- activeCardHtml: delivery (binding hooks + slice-2 elements) ----------
t('activeCardHtml: delivery reproduces btn-delivered + slider shape + vuelto hooks + layers bag tag / pill / data-order-id / phase-correct Waze label', () => {
  const o = deepFreeze({
    orderId: 'ordA1b2', phase: 'delivery',
    order: { display_number: 5, customer_name: 'Daniela', address_detected: 'Col. Palmira', lat: 14.06, lng: -87.16, total: 385, payment_method: 'cash' },
    deliveryTask: {},
  });
  const html = activeCardHtml(o, DEPS, { ordinal: 1, solo: false, showActualPill: true, arrived: false, navLabel: 'Col. Palmira · #5' });
  // frozen binding hooks
  assert.ok(html.includes('id="btn-delivered"'), 'deliver slide id');
  assert.ok(html.includes('class="slide-fill"') && html.includes('class="slide-thumb"'), 'slider shape');
  assert.ok(html.includes('data-vuelto-open') && html.includes('data-total="385"'), 'cash vuelto hooks');
  // slice-2 layers
  assert.ok(html.includes('data-order-id="ordA1b2"'), 'identity hook');
  assert.ok(html.includes('<span class="bagtag a">1</span>'), 'bag tag 1');
  assert.ok(html.includes('class="pactual">Parada actual'), 'parada-actual pill');
  assert.ok(html.includes('Navegar con Waze') && html.includes('→ Col. Palmira · #5'), 'navBtn: «Navegar con {app}» + «→ {destino}» (Codex r1)');
  // Waze href targets the delivery coord (order.lat||deliveryTask), Maps secondary present
  assert.ok(html.includes('waze.com/ul?ll=14.06,-87.16'), 'waze targets customer');
  assert.ok(html.includes('maps/dir/?api=1&destination=14.06,-87.16'), 'maps secondary targets customer');
});

t('activeCardHtml: pickup → Waze label names the RESTAURANT and URL targets the hub (label matches URL)', () => {
  const o = deepFreeze({
    orderId: 'ordP', phase: 'pickup',
    order: { display_number: 47, restaurant_display_name: 'La Musa', address_detected: 'Col. Cliente' },
    pickupTask: { destination_lat: 14.11, destination_lng: -87.23, destination_address: 'Blvd Morazán' },
    deliveryTask: {},
  });
  const html = activeCardHtml(o, DEPS, { ordinal: 1, showActualPill: true, navLabel: 'La Musa · #47' });
  assert.ok(html.includes('id="btn-pickup"'), 'pickup slide id');
  assert.ok(html.includes('Navegar con Waze') && html.includes('→ La Musa · #47'), 'pickup navBtn names the restaurant destination');
  assert.ok(html.includes('waze.com/ul?ll=14.11,-87.23'), 'pickup URL targets the hub, not the customer');
});

t('activeCardHtml: awaiting_acceptance (PRIVACY, Codex r1 P1) → NO customer name/phone/tel/wa.me/address before accept; accept slide + countdown only', () => {
  // Populated customer fields — none may appear in the pre-acceptance offer card.
  const o = deepFreeze({ orderId: 'ordN', phase: 'awaiting_acceptance',
    order: { display_number: 9, customer_name: 'Daniela Núñez', customer_phone: '99998888', address_detected: 'Col. Palmira, casa 12', total: 385 },
    pickupTask: { assignment_deadline: 1760000000000 }, deliveryTask: { recipient_name: 'Daniela Núñez', destination_address: 'Col. Palmira, casa 12' } });
  const html = activeCardHtml(o, DEPS, { ordinal: 1 });
  assert.ok(html.includes('id="btn-accept"'), 'accept slide');
  assert.ok(!html.includes('nav-row'), 'no nav while awaiting');
  assert.ok(html.includes('accept-countdown') && html.includes('data-deadline="1760000000000"'), 'countdown hook');
  // PRIVACY negatives on POPULATED fields:
  assert.ok(!html.includes('Daniela'), 'no customer name before accept');
  assert.ok(!html.replace(/\D/g, '').includes('99998888'), 'no phone digit-run before accept');
  assert.ok(!html.includes('tel:') && !html.includes('wa.me'), 'no tel: / wa.me before accept');
  assert.ok(!html.includes('Col. Palmira') && !html.includes('address-block'), 'no exact address before accept');
  assert.ok(html.includes('Nuevo pedido'), 'offer shows the non-identifying "Nuevo pedido"');
});

t('activeCardHtml: arrived → arrived-note instead of nav-row', () => {
  const o = deepFreeze({ orderId: 'ordD', phase: 'delivery', order: { address_detected: 'Col. X', lat: 14.06, lng: -87.16 }, deliveryTask: {} });
  const html = activeCardHtml(o, DEPS, { ordinal: 1, arrived: true, navLabel: 'Col. X' });
  assert.ok(html.includes('arrived-note') && html.includes('donde el cliente'), 'arrived note');
  assert.ok(!html.includes('nav-row'), 'no nav-row when arrived');
});

// ---------- queueHtml: identity + bag tags ----------
t('queueHtml: each row carries data-q (index) AND data-order-id, with a bag tag', () => {
  const orders = [
    { orderId: 'ordB', phase: 'delivery', order: { display_number: 6, customer_name: 'Carlos', address_detected: 'Res. Los Castaños' }, deliveryTask: {} },
    { orderId: 'ordC', phase: 'delivery', order: { display_number: 7, customer_name: 'Eva', address_detected: 'Col. Y' }, deliveryTask: {} },
  ].map(deepFreeze);
  const html = queueHtml(orders, DEPS);
  assert.ok(html.includes('data-q="0"') && html.includes('data-order-id="ordB"'), 'row0 hooks');
  assert.ok(html.includes('data-q="1"') && html.includes('data-order-id="ordC"'), 'row1 hooks');
  assert.ok(html.includes('<span class="bagtag b">2</span>') && html.includes('<span class="bagtag b">3</span>'), 'bag tags 2,3');
  assert.ok(html.includes('Orden de despacho'), 'neutral queue label (no platform-order claim)');
});
t('queueHtml: empty → empty string', () => assert.equal(queueHtml([], DEPS), ''));

// ---------- queueDetailHtml: nav KEPT, lock copy KEPT, bag tag + phase label layered ----------
t('queueDetailHtml: label AND URL from ONE delivery target (Codex r1 P1-2) — a PICKUP-phase queued order still navigates to the CUSTOMER', () => {
  // The queued order is still in PICKUP phase, but the read-only sheet always navigates to the DELIVERY (the
  // approved behaviour). The caller resolves the nav over the DELIVERY phase (isPickup=false), so the label
  // names the customer and the URL targets the customer — they can never disagree (the reported bug).
  const o = deepFreeze({ orderId: 'ordB', phase: 'pickup',
    order: { display_number: 6, customer_name: 'Carlos', address_detected: 'Res. Los Castaños', lat: 14.12, lng: -87.10 },
    pickupTask: { destination_lat: 14.11, destination_lng: -87.23, destination_address: 'Blvd Morazán' }, deliveryTask: {} });
  const nav = resolveVisibleLabels([stopNavInfo(o, RESTAURANT, false)])[0];   // DELIVERY-forced nav object { label, waze, maps }
  const html = queueDetailHtml(o, 2, DEPS, nav);
  assert.ok(html.includes('waze-btn') && html.includes('maps-btn'), 'nav KEPT (Codex P1-1)');
  assert.ok(html.includes('Navegar con Waze') && html.includes('→ Res. Los Castaños'), 'label names the CUSTOMER destination');
  assert.ok(html.includes('waze.com/ul?ll=14.12,-87.1'), 'URL targets the customer (same delivery target as the label)');
  assert.ok(!html.includes('14.11,-87.23'), 'NOT the restaurant coords — label and URL agree (P1-2)');
  assert.ok(html.includes('Orden de entrega asignada por despacho.'), 'completion-lock copy KEPT');
  assert.ok(html.includes('id="queue-sheet-close"'), 'close button hook');
  assert.ok(html.includes('<span class="bagtag b">2</span>'), 'bag tag');
  assert.ok(!html.includes('id="btn-delivered"'), 'NO Entregado in the read-only sheet');
});

// ---------- incomingBannerHtml: reproduces banner hooks ----------
t('incomingBannerHtml: reproduces data-order-id / data-ib-toggle / btn-accept-inc / countdown / slider', () => {
  const pending = [deepFreeze({ orderId: 'ordX', phase: 'awaiting_acceptance', order: { display_number: 9, total: 200, address_detected: 'Col. Z' }, pickupTask: { assignment_deadline: 1760000000000 }, deliveryTask: {} })];
  const html = incomingBannerHtml(pending, { ...DEPS, collapsedBanners: new Set() });
  assert.ok(html.includes('data-order-id="ordX"'), 'order id');
  assert.ok(html.includes('data-ib-toggle="ordX"'), 'toggle hook');
  assert.ok(html.includes('id="btn-accept-inc-ordX"'), 'accept slide id');
  assert.ok(html.includes('accept-countdown') && html.includes('data-deadline="1760000000000"'), 'countdown');
  assert.ok(html.includes('class="slide-fill"') && html.includes('class="slide-thumb"'), 'slider shape');
  assert.ok(html.includes('· otro hub'), 'cross-hub sub');
  assert.ok(!html.includes('Col. Z'), 'PRIVACY (Codex r2): no exact address/destination in the pre-accept banner');
});
t('incomingBannerHtml: collapsed set marks the banner collapsed', () => {
  const pending = [deepFreeze({ orderId: 'ordX', phase: 'awaiting_acceptance', order: {}, pickupTask: { assignment_deadline: 1 }, deliveryTask: {} })];
  const html = incomingBannerHtml(pending, { ...DEPS, collapsedBanners: new Set(['ordX']) });
  assert.ok(html.includes('incoming-banner collapsed'), 'collapsed class');
});
t('incomingBannerHtml (PRIVACY, Codex r1 P1): with NO address it does NOT fall back to the customer name', () => {
  const pending = [deepFreeze({ orderId: 'ordP', phase: 'awaiting_acceptance',
    order: { display_number: 3, total: 300, customer_name: 'Secreto López' },   // name present, address absent
    pickupTask: { assignment_deadline: 1 }, deliveryTask: {} })];
  const html = incomingBannerHtml(pending, { ...DEPS, collapsedBanners: new Set() });
  assert.ok(!html.includes('Secreto'), 'the pre-accept banner never shows the customer name');
});

// ---------- PRIVACY gates on the queue + sheet (Codex r2 P1) — an awaiting_acceptance order never leaks ----------
t('queueHtml (PRIVACY, Codex r2 P1): an awaiting_acceptance row shows NO name/address (offer-safe)', () => {
  const orders = [deepFreeze({ orderId: 'ordW', phase: 'awaiting_acceptance',
    order: { display_number: 8, customer_name: 'Secreta Pérez', address_detected: 'Col. Escondida 7', total: 300 }, deliveryTask: {} })];
  const html = queueHtml(orders, DEPS);
  assert.ok(html.includes('data-order-id="ordW"'), 'row still rendered (hook present)');
  assert.ok(!html.includes('Secreta'), 'no customer name for a non-accepted row');
  assert.ok(!html.includes('Col. Escondida'), 'no address for a non-accepted row');
  assert.ok(html.includes('Nuevo pedido'), 'shows the non-identifying placeholder');
});
t('queueDetailHtml (PRIVACY, Codex r2 P1): an awaiting_acceptance order → NO name/phone/tel/wa.me/address/nav', () => {
  const o = deepFreeze({ orderId: 'ordW', phase: 'awaiting_acceptance',
    order: { display_number: 8, customer_name: 'Secreta Pérez', customer_phone: '99990000', address_detected: 'Col. Escondida 7', total: 300 },
    pickupTask: {}, deliveryTask: { recipient_name: 'Secreta Pérez', destination_address: 'Col. Escondida 7' } });
  const html = queueDetailHtml(o, 2, DEPS, { label: 'x', waze: 'https://waze.com/ul?ll=1,2', maps: 'https://maps' });
  assert.ok(!html.includes('Secreta'), 'no name');
  assert.ok(!html.replace(/\D/g, '').includes('99990000'), 'no phone digit-run');
  assert.ok(!html.includes('tel:') && !html.includes('wa.me'), 'no tel: / wa.me');
  assert.ok(!html.includes('Col. Escondida') && !html.includes('address-block'), 'no address');
  assert.ok(!html.includes('waze-btn') && !html.includes('waze.com/ul'), 'no customer navigation');
  assert.ok(html.includes('PENDIENTE'), 'shows the pending (non-accepted) pill');
});

console.log(`stacked-view.test.js: ${passed} passed`);
