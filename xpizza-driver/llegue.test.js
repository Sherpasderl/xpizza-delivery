// llegue.test.js — the arrived-at-customer delivery screen (prototype S.llegue), rendered by the PURE stacked-view
// builders stopHeaderHtml + activeCardHtml. Proves the flag-ON / flag-OFF split (no dead/false controls):
//   • header: «Estás donde {Nombre}» always (true by geofence); sub = «avisamos a las {t}…» only flag-ON + a notify
//     time, else the truthful «{area}» / «antes de {deadline}»;
//   • arrival banner «{name} ya sabe que llegaste» + the «Has llegado» note suppression: flag-ON only;
//   • the «entregá todo» items card: shown once arrived (display-only, existing order data);
//   • the body «Problema con este pedido»: flag-ON (canReportProblem) only;
//   • NOT arrived / pickup: none of the above (byte-stable).
// Run: `node llegue.test.js`
import assert from 'node:assert/strict';
import { stopHeaderHtml, activeCardHtml } from './stacked-view.js';

const ICONS = new Proxy({}, { get: (_, k) => `<svg data-ic="${String(k)}"></svg>` });
const deps = { ICONS, esc: (s) => String(s == null ? '' : s), scheduledBadge: () => '', RESTAURANT: { lat: 15.5, lng: -88.03 }, navPref: 'Waze' };

const order = {
  customer_name: 'Daniela Reyes', total: 385, payment_method: 'cash',
  address_detected: 'Col. Trejo, 12 calle, casa 1215', address_details: 'Portón negro',
  customer_phone: '+504 9999 0000',
  summary_lines: [{ name: 'Pizza grande', qty: 1, cents: 28000 }, { name: 'Coca-Cola', qty: 1, cents: 4500 }, { name: 'Salsa', qty: 2, cents: 2000 }],
};
const deliveryEntry = { orderId: 'o1', phase: 'delivery', order, deliveryTask: { id: 'd1', destination_address: order.address_detected, recipient_name: 'Daniela' }, pickupTask: { id: 'p1', destination_lat: 15.5, destination_lng: -88.03 } };
const card = (opts) => activeCardHtml(deliveryEntry, deps, { ordinal: 1, solo: true, showActualPill: true, navLabel: '', previewHtml: '', ...opts });

let passed = 0;
const t = (name, fn) => { try { fn(); passed += 1; } catch (e) { console.error(`✗ ${name}`); throw e; } };

// ---- header ----
t('header: «Estás donde {Nombre}» (first name) for the arrived delivery', () => {
  const h = stopHeaderHtml({ arrivedCustomer: true, name: 'Daniela Reyes', area: 'Col. Trejo' }, deps);
  assert.match(h, /Estás donde Daniela<\/div>|Estás donde Daniela</, 'title «Estás donde Daniela» (first name only)');
  assert.doesNotMatch(h, /Reyes/, 'no last name');
});
t('header flag-OFF (truthful): sub = «{area}», NO «avisamos a las»', () => {
  const h = stopHeaderHtml({ arrivedCustomer: true, name: 'Daniela', area: 'Col. Trejo', canNotifyArrival: false, notifiedAt: '' }, deps);
  assert.match(h, /sh-sub">Col\. Trejo</, 'sub is the area');
  assert.doesNotMatch(h, /avisamos a las/, 'NO arrival-notification claim while the flag is off');
});
t('header flag-OFF with a deadline, no area → sub = «antes de {deadline}»', () => {
  const h = stopHeaderHtml({ arrivedCustomer: true, name: 'Daniela', area: '', deadline: '7:48', canNotifyArrival: false }, deps);
  assert.match(h, /sh-sub">antes de 7:48</, 'deadline-only truthful sub');
});
t('header flag-ON + notify time: sub = «avisamos a las {t} · antes de {deadline}»', () => {
  const h = stopHeaderHtml({ arrivedCustomer: true, name: 'Daniela', area: 'Col. Trejo', deadline: '7:48', canNotifyArrival: true, notifiedAt: '7:41' }, deps);
  assert.match(h, /avisamos a las 7:41 · antes de 7:48/, 'flag-on notification sub');
});
t('header: NON-arrived keeps the «Parada N de M» / «{name}·{area}» header (unchanged)', () => {
  const h = stopHeaderHtml({ ordinal: 1, total: 2, name: 'Daniela', area: 'Col. Trejo' }, deps);
  assert.match(h, /Parada 1 de 2/);
  assert.doesNotMatch(h, /Estás donde/);
});

// ---- card: items ----
t('arrived delivery: the «entregá todo» items card shows the order lines', () => {
  const html = card({ arrived: true });
  assert.ok(/sv-deliver-items/.test(html), 'items card present');
  assert.match(html, /4 artículos/, 'total article count (1+1+2)');
  assert.match(html, /entregá todo/, 'the «entregá todo» chip');
  assert.ok(/Pizza grande/.test(html) && /Coca-Cola/.test(html) && /Salsa/.test(html), 'the item lines');
});
t('NOT arrived (en route): NO items card, NO banner — the nav button shows (byte-stable)', () => {
  const html = card({ arrived: false, navLabel: 'Col. Trejo' });
  assert.ok(!/sv-deliver-items/.test(html), 'no items card before arrival');
  assert.ok(!/arrival-banner/.test(html), 'no arrival banner');
  assert.ok(/nav-primary|nav-btn/.test(html), 'the nav button is shown');
});
t('street line: HIDDEN in the arrived-at-customer card (proto S.llegue), KEPT en-route (approved card)', () => {
  assert.ok(!/address-block/.test(card({ arrived: true })), 'street address-block hidden once arrived at the customer');
  assert.ok(/address-block/.test(card({ arrived: false })), 'street kept en-route (unchanged approved card)');
  // the one-line instruction (address_details) stays as the bold ref; «Entregar en mano» has no data source → omitted
  assert.match(card({ arrived: true }), /Portón negro/, 'the instruction (address_details) is kept');
});

// ---- card: flag-gated ----
t('flag-OFF arrived: NO arrival banner, NO body problema; the «Has llegado» note is kept', () => {
  const html = card({ arrived: true, canNotifyArrival: false });
  assert.ok(!/arrival-banner/.test(html), 'no arrival banner (flag off)');
  assert.ok(!/problema-btn/.test(html), 'no body problema (flag off)');
  assert.match(html, /Has llegado donde el cliente/, 'the «Has llegado» note is kept (truthful flag-off)');
});
t('flag-ON canNotifyArrival: the arrival banner shows, the «Has llegado» note is suppressed', () => {
  const html = card({ arrived: true, canNotifyArrival: true });
  assert.match(html, /arrival-banner/, 'arrival banner shown');
  assert.match(html, /Daniela ya sabe que llegaste/, 'banner copy with the first name');
  assert.ok(!/Has llegado donde el cliente/.test(html), 'the redundant «Has llegado» note is dropped');
});
t('flag-ON canReportProblem: the body «Problema con este pedido» shows', () => {
  const html = card({ arrived: true, canReportProblem: true });
  assert.match(html, /problema-btn/, 'body problema button shown');
  assert.match(html, /Problema con este pedido/, 'problema copy');
});
t('the «Llegué · avisar» button is still gated on canNotifyArrival (before arrival)', () => {
  assert.match(card({ arrived: false, canNotifyArrival: true }), /btn-llegue/, 'Llegué shown flag-on before arrival');
  assert.ok(!/btn-llegue/.test(card({ arrived: false, canNotifyArrival: false })), 'Llegué hidden flag-off');
});

console.log(`✓ llegue: ${passed} tests passed`);
