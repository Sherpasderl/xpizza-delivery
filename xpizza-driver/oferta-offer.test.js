// S.oferta OFFER branch — BUILDER test. run: `node oferta-offer.test.js`. The awaiting_acceptance branch of the REAL
// singleOrderCardHtml (single-order-view.js SLICE3:OFERTA-OFFER), rebuilt to the prototype S.oferta (:581): header
// «Nuevo pedido» + Sola + the countdown ring; the overview map (passed via deps.mapHtml); card.hi (rchip + #num +
// «X km» only when computed); the Recoger/Entregar timeline (R1 times omitted without a real field, R4 colonia from
// deps.area); «N artículos · 1 bolsa» + the cash rows (collectionFor/computeVuelto — same values as svPay, no new
// math); the hidden «Tu pago» mount (R2); the foot slide + the REAL-deadline reassign note.
import assert from 'node:assert/strict';
import { singleOrderCardHtml } from './single-order-view.js';
import { readyTimeLabel } from './stacked-view.js';   // the REAL R1 formatter the host passes as deps.ready

const computeVuelto = (total, tendered) => (tendered != null && tendered >= total) ? (tendered - total) : null;
const DEPS = { ICONS: {}, esc: (s) => String(s == null ? '' : s), scheduledBadge: () => '', computeVuelto, RESTAURANT: {} };
const offer = (over = {}) => ({ orderId: 'C', phase: 'awaiting_acceptance',
  pickupTask: { assignment_deadline: 1760000028000 },
  deliveryTask: { destination_lat: 15.4, destination_lng: -88 },
  order: { display_number: '9', total: 385, payment_method: 'cash', cash_tendered_cents: 50000, items_text: 'pizza, bebida, salsas', lat: 15.4, lng: -88, ...over } });

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok -', name); }

t('header: Sola + «Nuevo pedido» + the countdown ring (accept-countdown on the real deadline)', () => {
  const h = singleOrderCardHtml(offer(), { ...DEPS, nowMs: 1760000000000, mapHtml: '<svg id="map"></svg>' });
  assert.ok(h.includes('of-head') && h.includes('>Nuevo pedido<'), '«Nuevo pedido» header');
  assert.ok(h.includes('of-sola') && h.includes('of-ring') && h.includes('accept-countdown') && h.includes('data-deadline="1760000028000"'), 'Sola + ring on the real deadline');
  assert.ok(h.includes('<svg id="map"></svg>'), 'the overview map (deps.mapHtml) is rendered');
});

t('card: rchip + #num + «X km» only when computed; timeline Recoger/Entregar; R1 omits times, R4 renders the colonia', () => {
  const withKm = singleOrderCardHtml(offer(), { ...DEPS, nowMs: 1760000000000, offerKm: '1.6 km', area: 'Col. Trejo' });
  assert.ok(withKm.includes('of2-onum') && withKm.includes('>#9<'), 'the order #');
  assert.ok(withKm.includes('1.6 km') && !/km total/.test(withKm), 'the km chip reads «{X} km» (single-offer chip, never «km total»)');
  assert.ok(/Recoger<\/span>/.test(withKm) && !/~/.test(withKm), 'R1: no ready field → «Recoger» with NO time');
  assert.ok(withKm.includes('Entregar') && withKm.includes('· Col. Trejo'), 'R4: the colonia renders on the Entregar row');
  const noKm = singleOrderCardHtml(offer(), { ...DEPS, nowMs: 1760000000000 });
  assert.ok(!noKm.includes('km total') && !noKm.includes('of-dist'), 'no km chip when not computed');
  // ready ORIGINATES from the real formatter the host passes (readyTimeLabel → «~H:MM»); the render must show it
  // verbatim with NO doubled «~» (regression: the branch used to prepend its own ~).
  const readyLabel = readyTimeLabel({ prep: { ready_at: 1760000000000 } });
  assert.ok(readyLabel.startsWith('~') && readyLabel.length > 1, 'readyTimeLabel carries the «~H:MM» prefix');
  const withReady = singleOrderCardHtml(offer(), { ...DEPS, nowMs: 1760000000000, ready: readyLabel });
  assert.ok(withReady.includes('Recoger <b>' + readyLabel + '</b>') && !withReady.includes('~~'), 'R1: a real ready field → «Recoger ~H:MM», never a doubled ~');
});

t('items + cash: «N artículos · 1 bolsa» + «Cobrar L 385 en efectivo» / «Paga con L 500 · llevá vuelto» (same values, no new math)', () => {
  const h = singleOrderCardHtml(offer(), { ...DEPS, nowMs: 1760000000000 });
  assert.ok(h.includes('3 artículos · 1 bolsa') && h.includes('pizza, bebida, salsas'), 'the items row (from items_text)');
  assert.ok(h.includes('Cobrar <b>L 385</b> en efectivo'), 'the cash amount from collectionFor');
  assert.ok(h.includes('Paga con <b>L 500</b> · llevá vuelto'), 'the declared tender from computeVuelto');
  assert.ok(!/1,430/.test(h), 'no foreign amounts');
});

t('cash safety (R11): collectionFor «warning» → «Pago no confirmado / Revisar» (no amount); «free» → «Sin costo» — same copy as svPay, never dropped', () => {
  const warn = singleOrderCardHtml(offer({ payment_method: 'online', payment_status: 'pending' }), { ...DEPS, nowMs: 1760000000000 });
  assert.ok(warn.includes('Pago no confirmado') && warn.includes('Revisar'), 'an unconfirmed-online order shows the warning row (not a blank payment slot)');
  assert.ok(/of2-warn/.test(warn) && !/Cobrar/.test(warn), 'warning carries its warn styling and NEVER a collect amount');
  const free = singleOrderCardHtml(offer({ free_order: true, total: 0 }), { ...DEPS, nowMs: 1760000000000 });
  assert.ok(free.includes('Sin costo') && !/Cobrar/.test(free), 'a free order shows «Sin costo», no collect amount');
  // mutant: dropping either branch falls through to '' — these includes() assertions go RED, so the safety rows can't silently vanish.
});

t('R2: the «Tu pago» earnings block stays HIDDEN (no «+ L 70», no «Tu pago»)', () => {
  const h = singleOrderCardHtml(offer(), { ...DEPS, nowMs: 1760000000000 });
  assert.ok(!/\+ ?L ?70/.test(h) && !/Tu pago/.test(h), 'earnings hidden (R2)');
});

t('foot: the slide «Aceptar pedido» + the reassign note with N from the REAL deadline (never the literal «a tiempo»)', () => {
  const h = singleOrderCardHtml(offer(), { ...DEPS, nowMs: 1760000000000 });   // 28 s left
  assert.ok(h.includes('id="btn-accept"') && h.includes('>Aceptar pedido<'), 'the accept slide');
  assert.ok(h.includes('Si no aceptás en 28 s, despacho lo reasigna. No hay botón de rechazar.'), 'N from the real deadline');
  assert.ok(!/a tiempo/.test(h), 'never the live «a tiempo» wording');
});

console.log(`✓ oferta-offer: ${passed} checks passed`);
