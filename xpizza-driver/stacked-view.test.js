// Pure stacked-view logic + markup builders — run: `node stacked-view.test.js` (no framework, repo idiom).
// The builders are ALSO co-verified by the jsdom real-writer branch harness (handler binding); here we assert
// the pure output: the baseline binding hooks are present and the prototype rebuild's elements are correct.
import assert from 'node:assert/strict';
import {
  destinationLabel, orderIdTail, stopNavInfo, resolveVisibleLabels,
  bagTagClass, bagTagHtml, phaseStripHtml, navBtnHtml, queuedPreviewHtml, coloniaOf,
  activeCardHtml, queueHtml, queueDetailHtml, incomingBannerHtml,
  stopHeaderHtml, combinedPickupHtml, interludeHtml, cancelBannerHtml, offerScreenHtml,
} from './stacked-view.js';

let passed = 0;
function t(name, fn) { fn(); passed += 1; }
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const RESTAURANT = { lat: 14.10, lng: -87.22 };

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const ICONS = { nav: '<i>N</i>', check: '<i>C</i>', phone: '<i>P</i>', whatsapp: '<i>W</i>', pin: '<i>PIN</i>', cash: '<i>$</i>', help: '<i>?</i>', door: '<i>D</i>', bell: '<i>B</i>', warn: '<i>!</i>', cup: '<i>U</i>', lock: '<i>L</i>' };
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

// ---------- stopNavInfo + resolveVisibleLabels (Codex P1-2 collision) ----------
t('stopNavInfo: label + URLs derive from ONE phase target', () => {
  const info = stopNavInfo(deepFreeze({ orderId: 'A', phase: 'delivery', order: { address_detected: 'Col. Kennedy', display_number: 47, lat: 14.1, lng: -87.1 }, deliveryTask: {} }), RESTAURANT);
  assert.equal(info.base, 'Col. Kennedy');
  assert.equal(info.displayNum, '#47');
  assert.ok(info.waze.includes('14.1') && info.waze.includes('-87.1'), 'waze targets the customer');
});
t('resolveVisibleLabels: same display-number across hubs → append orderId last-4', () => {
  const a = stopNavInfo(deepFreeze({ orderId: 'ordA1', phase: 'delivery', order: { address_detected: 'Col. X', display_number: 5 }, deliveryTask: {} }), RESTAURANT);
  const b = stopNavInfo(deepFreeze({ orderId: 'ordB2', phase: 'delivery', order: { address_detected: 'Col. X', display_number: 5 }, deliveryTask: {} }), RESTAURANT);
  const [la, lb] = resolveVisibleLabels([a, b]);
  assert.ok(la.label.endsWith('#ordA1'.slice(-4)) && lb.label.endsWith('#ordB2'.slice(-4)), 'orderId tails disambiguate');
});
t('resolveVisibleLabels: empty display number → orderId tail (never blank)', () => {
  const a = stopNavInfo(deepFreeze({ orderId: 'ord_zzzz', phase: 'delivery', deliveryTask: { destination_address: 'Res. Y' } }), RESTAURANT);
  const [la] = resolveVisibleLabels([a]);
  assert.ok(la.label.includes('#zzzz'), 'orderId tail appended');
});

// ---------- bag tags (S14) ----------
t('bagTagClass: stop 1 = a (marino), later = b (celeste)', () => { assert.equal(bagTagClass(1), 'a'); assert.equal(bagTagClass(2), 'b'); assert.equal(bagTagClass(3), 'b'); });
t('bagTagHtml: renders the ordinal', () => assert.ok(bagTagHtml(2, esc).includes('>2<') && bagTagHtml(2, esc).includes('bagtag b')));

// ---------- phaseStripHtml (S11: on/done/cancelled + deadline only with data) ----------
t('phaseStripHtml: <2 segments renders nothing', () => assert.equal(phaseStripHtml([{ n: 1, state: 'on' }], esc), ''));
t('phaseStripHtml: active=on, upcoming=plain, done=done, cancelled=cancelled; bars present', () => {
  const html = phaseStripHtml([{ n: 1, state: 'done', label: 'Daniela', time: '7:44' }, { n: 2, state: 'on', label: 'Carlos' }], esc);
  assert.ok(html.includes('st done') && html.includes('1 · Daniela · 7:44'), 'done segment + delivered time');
  assert.ok(html.includes('st on') && html.includes('2 · Carlos'), 'active segment');
  assert.ok((html.match(/class="bar"/g) || []).length === 2, 'a bar per segment');
});
t('phaseStripHtml: NO trailing time when none supplied (R1 — no invented deadline)', () => {
  const html = phaseStripHtml([{ n: 1, state: 'on', label: 'Ana' }, { n: 2, label: 'Beto' }], esc);
  assert.ok(html.includes('1 · Ana') && !html.includes('·  ·') && !/Ana · \d/.test(html), 'no made-up time');
});
t('phaseStripHtml: cancelled segment', () => assert.ok(phaseStripHtml([{ n: 1, state: 'cancelled', label: 'X' }, { n: 2, state: 'on', label: 'Y' }], esc).includes('st cancelled')));

// ---------- coloniaOf (R4 — area only) ----------
t('coloniaOf: first comma-segment of the address', () => assert.equal(coloniaOf({ order: { address_detected: 'Col. Trejo, casa 1215' } }), 'Col. Trejo'));
t('coloniaOf: delivery task fallback; empty when none', () => {
  assert.equal(coloniaOf({ deliveryTask: { destination_address: 'Res. Los Robles, bloque C' } }), 'Res. Los Robles');
  assert.equal(coloniaOf({ order: {} }), '');
});

// ---------- navBtnHtml (N3 — ONE primary + «Abrir en {otra}»; N6 external) ----------
t('navBtnHtml: Waze default → primary Waze + «Abrir en Google Maps en su lugar»; no two side-by-side buttons', () => {
  const html = navBtnHtml({ lat: 14.1, lng: -87.1 }, undefined, 'Parada 1 · Col. Trejo', DEPS);
  assert.ok(html.includes('Navegar con Waze') && html.includes('→ Parada 1 · Col. Trejo'), 'primary + destination');
  assert.ok(html.includes('Abrir en Google Maps en su lugar'), 'secondary link to the other app');
  assert.ok(!html.includes('waze-btn') && !html.includes('maps-btn'), 'no two side-by-side app buttons');
  assert.ok((html.match(/nav-primary/g) || []).length === 1, 'exactly one primary');
});
t('navBtnHtml: Maps pref → primary Google Maps + «Abrir en Waze»', () => {
  const html = navBtnHtml({ lat: 1, lng: 2 }, 'Maps', 'x', { ICONS, esc });
  assert.ok(html.includes('Navegar con Google Maps') && html.includes('Abrir en Waze en su lugar'));
});

// ---------- activeCardHtml (single nav, «Parada N ·», personalized slide, Llegué gated, no phase-pill, instr) ----------
const A = deepFreeze({ orderId: 'A', phase: 'delivery', deliveryTask: { destination_lat: 14.0, destination_lng: -87.0 },
  order: { customer_name: 'Daniela Núñez', customer_phone: '99998888', payment_method: 'cash', total: 385, display_number: 47, address_detected: 'Col. Palmira, casa 12', address_details: 'portón negro', lat: 14.0, lng: -87.0 } });
t('activeCardHtml: single-primary nav with «Parada N ·» label (N10); two-button nav gone', () => {
  const html = activeCardHtml(A, DEPS, { ordinal: 1, showActualPill: true, navLabel: 'Col. Palmira · #47' });
  assert.ok(html.includes('nav-primary') && html.includes('→ Parada 1 · Col. Palmira · #47'), 'single primary + «Parada N ·»');
  assert.ok(!html.includes('waze-btn') && !html.includes('maps-btn'), 'no two side-by-side buttons');
});
t('activeCardHtml: personalized delivery slide «Entregado · {first name} · L {monto}» (cash)', () => {
  assert.ok(activeCardHtml(A, DEPS, { ordinal: 1 }).includes('Entregado · Daniela · L 385'), 'first name + cash amount');
});
t('activeCardHtml: no «Entregar»/phase pill; «Parada actual» when showActualPill', () => {
  const html = activeCardHtml(A, DEPS, { ordinal: 1, showActualPill: true });
  assert.ok(!html.includes('phase-pill'), 'no phase pill');
  assert.ok(html.includes('Parada actual'), '«Parada actual» pill');
});
t('activeCardHtml: delivery instructions block (address_details), contact kept (S13)', () => {
  const html = activeCardHtml(A, DEPS, { ordinal: 1 });
  assert.ok(html.includes('class="instr"') && html.includes('portón negro'), 'instructions block');
  assert.ok(html.includes('recipient-phone') && html.includes('recipient-whatsapp'), 'contact kept on the active card');
});
t('activeCardHtml: «Llegué» HIDDEN until the capability (R9); shown when canNotifyArrival', () => {
  assert.ok(!activeCardHtml(A, DEPS, { ordinal: 1, canNotifyArrival: false }).includes('btn-llegue'), 'hidden by default');
  assert.ok(activeCardHtml(A, DEPS, { ordinal: 1, canNotifyArrival: true }).includes('Llegué · avisar a Daniela'), 'shown with the capability');
});
t('activeCardHtml: the frozen delivered slide id btn-delivered is present', () => assert.ok(activeCardHtml(A, DEPS, { ordinal: 1 }).includes('id="btn-delivered"')));
t('activeCardHtml (PRIVACY): an awaiting_acceptance offer shows NO name/phone/address/nav', () => {
  const offer = deepFreeze({ orderId: 'C', phase: 'awaiting_acceptance', pickupTask: { assignment_deadline: 1 }, deliveryTask: {}, order: { customer_name: 'Secreta', customer_phone: '1', address_detected: 'Col. Z', total: 100 } });
  const html = activeCardHtml(offer, DEPS, { ordinal: 1 });
  assert.ok(!html.includes('Secreta') && !html.includes('Col. Z') && !html.includes('recipient-phone') && !html.includes('nav-primary'), 'offer hides who/where');
});

// ---------- queuedPreviewHtml («Después» — first name + colonia; privacy on awaiting) ----------
const B = deepFreeze({ orderId: 'B', phase: 'pickup', deliveryTask: { destination_lat: 14.2, destination_lng: -87.2 },
  order: { customer_name: 'Carlos Mejía', display_number: 12, address_detected: 'Res. Los Robles, #4', lat: 14.2, lng: -87.2 } });
t('queuedPreviewHtml: «Después: {first name} · {colonia}» + the no-nav-yet hint + data-order-id', () => {
  const html = queuedPreviewHtml(B, 2, DEPS);
  assert.ok(html.includes('Después: Carlos · Res. Los Robles'), 'first name + colonia');
  assert.ok(html.includes('sin navegación aún'), 'hint');
  assert.ok(html.includes('data-order-id="B"'), 'orderId hook for the fail-closed tap');
});
t('queuedPreviewHtml: an awaiting_acceptance next stop shows no name (privacy)', () => {
  const html = queuedPreviewHtml(deepFreeze({ orderId: 'C', phase: 'awaiting_acceptance', order: { customer_name: 'Secreta', address_detected: 'Col. Z' } }), 2, DEPS);
  assert.ok(!html.includes('Secreta') && !html.includes('Col. Z'), 'no PII before accept');
});

// ---------- stopHeaderHtml (S9/S10 — «Parada N de M»/«Única parada»/pickup; Ayuda gated; deadline w/ data) ----------
t('stopHeaderHtml: «Parada 1 de 2» + «name · area»; end-shift always; Ayuda gated', () => {
  const html = stopHeaderHtml({ ordinal: 1, total: 2, name: 'Daniela Mejía', area: 'Col. Trejo', canReportProblem: false }, DEPS);
  assert.ok(html.includes('Parada 1 de 2') && html.includes('Daniela Mejía · Col. Trejo'));
  assert.ok(html.includes('id="btn-end-shift"'), 'end-shift always present');
  assert.ok(!html.includes('id="btn-problema"'), 'Ayuda hidden until the capability');
});
t('stopHeaderHtml: deadline only with data (R1); «Única parada»; «Recoger N pedidos»; Ayuda when capable', () => {
  assert.ok(!stopHeaderHtml({ ordinal: 1, total: 2 }, DEPS).includes('antes de'), 'no invented deadline');
  assert.ok(stopHeaderHtml({ ordinal: 1, total: 2, deadline: '7:48' }, DEPS).includes('Parada 1 de 2 · antes de 7:48'));
  assert.ok(stopHeaderHtml({ single: true }, DEPS).includes('Única parada'));
  assert.ok(stopHeaderHtml({ pickupCount: 2 }, DEPS).includes('Recoger 2 pedidos'));
  assert.ok(stopHeaderHtml({ ordinal: 1, total: 1, canReportProblem: true }, DEPS).includes('id="btn-problema"'));
});

// ---------- queueDetailHtml (S5/S6 — read-only: no contact, no nav, no Entregado; items + payment + lock) ----------
t('queueDetailHtml: read-only — NO nav, NO contact, NO «Entregado»; the lock banner; «Parada N · name»', () => {
  const html = queueDetailHtml(B, 2, DEPS);
  assert.ok(!html.includes('nav-primary') && !html.includes('waze'), 'no navigation');
  assert.ok(!html.includes('recipient-phone') && !html.includes('recipient-whatsapp'), 'no contact actions');
  assert.ok(!html.includes('id="btn-delivered"'), 'no Entregado');
  assert.ok(html.includes('Parada 2 · Carlos Mejía') && html.includes('En cola'), 'title + chip');
  assert.ok(html.includes('Sin navegación ni') && html.includes('hasta terminar la parada 1'), 'lock banner');
  assert.ok(html.includes('id="queue-sheet-close"'), 'close hook');
});
t('queueDetailHtml: items card (N artículos + qty×) + read-only payment row (no Revisar button)', () => {
  const o = deepFreeze({ orderId: 'B', phase: 'pickup', order: { customer_name: 'Carlos', display_number: 12, address_detected: 'Res. Los Robles', items_text: 'baleada, 2 catrachas', payment_method: 'card' } });
  const html = queueDetailHtml(o, 2, DEPS);
  assert.ok(html.includes('2 artículos') && html.includes('<b>1×</b>') && html.includes('<b>2×</b>'), 'items card with qty');
  assert.ok(html.includes('pay-ro-card') && !html.includes('>Revisar<'), 'read-only payment row, no Revisar button');
});

// ---------- incomingBannerHtml (privacy — brand/#/total/otro hub only) ----------
t('incomingBannerHtml: pre-accept shows NO name/address; shows brand + total + otro hub + accept slide', () => {
  const html = incomingBannerHtml([deepFreeze({ orderId: 'X', phase: 'awaiting_acceptance', order: { display_number: 9, total: 200, customer_name: 'Secreta', address_detected: 'Col. Z' }, pickupTask: { assignment_deadline: 1760000000000 }, deliveryTask: {} })], { ...DEPS, collapsedBanners: new Set() });
  assert.ok(!html.includes('Secreta') && !html.includes('Col. Z'), 'no PII pre-accept');
  assert.ok(html.includes('otro hub') && html.includes('btn-accept-inc-X') && html.includes('data-deadline="1760000000000"'));
});

// ---------- combinedPickupHtml (apRecoger / S19) ----------
t('combinedPickupHtml: per-bag rows (bag, brand, #, items, pay) + the hot/cold banner', () => {
  const html = combinedPickupHtml([
    deepFreeze({ orderId: 'A', order: { customer_name: 'Daniela', items_text: 'pizza', total: 385, payment_method: 'cash', display_number: 47 } }),
    deepFreeze({ orderId: 'B', order: { customer_name: 'Carlos', items_text: 'baleada', display_number: 12 } }),
  ], DEPS, new Set(['A']));
  assert.ok(html.includes('Bolsa 1 · Daniela') && html.includes('Bolsa 2 · Carlos'));
  assert.ok(html.includes('a cobrar L 385') && html.includes('pagado en línea'));
  assert.ok(html.includes('pk-row done'), 'bag A marked picked up');
  assert.ok(html.includes('Lo caliente y lo frío, separados'), 'hot/cold banner');
});
t('combinedPickupHtml: <2 orders renders nothing', () => assert.equal(combinedPickupHtml([{ orderId: 'A', order: {} }], DEPS), ''));

// ---------- interludeHtml (apAvance / S15) ----------
t('interludeHtml: «Parada 1 entregada» + cash/vuelto; +L70 HIDDEN (R2); 2nd nav sentence ALWAYS; live gated', () => {
  const html = interludeHtml({ deliveredName: 'Daniela', cash: 385, vuelto: 115, showEarnings: false, next: { name: 'Carlos', area: 'Res. Los Robles' }, liveTracking: false }, DEPS);
  assert.ok(html.includes('Parada 1 entregada') && html.includes('Cobraste L 385 · vuelto L 115'));
  assert.ok(!html.includes('+L 70') && !html.includes('+L70'), '+L70 hidden');
  assert.ok(html.includes('El botón de navegar ya apunta a su dirección.'), 'second sentence always');
  assert.ok(!html.includes('pasó a seguimiento en vivo'), 'live-tracking sentence omitted when off');
  assert.ok(html.includes('id="btn-interlude-go"') && html.includes('Ir a la parada 2'));
});
t('interludeHtml: earnings on → +L 70; live on → the live sentence', () => {
  const html = interludeHtml({ next: { name: 'Carlos' }, cash: 385, showEarnings: true, liveTracking: true }, DEPS);
  assert.ok(html.includes('+L 70') && html.includes('Carlos pasó a seguimiento en vivo.'));
});

// ---------- cancelBannerHtml (apCancelada / S17) ----------
t('cancelBannerHtml: «Pedido #N (name) cancelado» + no-cobrés + bag return + «Entendido»', () => {
  const html = cancelBannerHtml({ cancelledNum: '#1042', cancelledName: 'Daniela', cancelledAmount: 385, survivorName: 'Carlos', cancelledBrand: 'X. Pizza' }, DEPS);
  assert.ok(html.includes('Pedido #1042 (Daniela) cancelado') && html.includes('No cobrés sus L 385'));
  assert.ok(html.includes('devolvé la bolsa a X. Pizza') && html.includes('id="btn-cancel-ack"'));
});

// ---------- offerScreenHtml (apOferta / S18 — R4 privacy: colonia only, NO name) ----------
t('offerScreenHtml: colonia only (NO customer name), lock chip, rchip/#, pickup line, one accept slide; +L140 absent', () => {
  const offers = [
    deepFreeze({ orderId: 'A', phase: 'awaiting_acceptance', pickupTask: { assignment_deadline: 1760000000000 }, order: { customer_name: 'Daniela', restaurant_display_name: 'X. Pizza', address_detected: 'Barrio El Centro, casa 3', display_number: 9, total: 70 } }),
    deepFreeze({ orderId: 'B', phase: 'awaiting_acceptance', order: { customer_name: 'Carlos', restaurant_display_name: 'La Musa', address_detected: 'Res. Los Robles, bloque C', display_number: 12, total: 70 } }),
  ];
  const html = offerScreenHtml(offers, DEPS, { mapHtml: '<div class="map"></div>', distanceStr: '3.5 km total' });
  assert.ok(html.includes('2 pedidos juntos') && html.includes('Orden fijado por la plataforma'));
  assert.ok(html.includes('Barrio El Centro') && html.includes('Res. Los Robles'), 'colonia shown');
  assert.ok(!html.includes('Daniela') && !html.includes('Carlos'), 'NO customer names before accept (R4)');
  assert.ok(html.includes('3.5 km total'), 'distance chip when provided');
  assert.ok(html.includes('Recogés primero en X. Pizza y luego en La Musa'), 'pickup-timing line without times');
  assert.ok((html.match(/id="btn-accept"/g) || []).length === 1, 'one accept slide');
  assert.ok(!html.includes('+ L 140') && !html.includes('+L 140'), 'earnings hidden (R2)');
});

console.log(`stacked-view.test.js: ${passed} passed`);
