// Pure stacked-view logic + markup builders — run: `node stacked-view.test.js` (no framework, repo idiom).
// The builders are ALSO co-verified by the jsdom real-writer branch harness (handler binding); here we assert
// the pure output: the baseline binding hooks are present and the prototype rebuild's elements are correct.
import assert from 'node:assert/strict';
import {
  destinationLabel, orderIdTail, stopNavInfo, resolveVisibleLabels,
  bagTagClass, bagTagHtml, phaseStripHtml, navBtnHtml, queuedPreviewHtml, coloniaOf, readyTimeHHMM, readyTimeLabel, pickupSubLabel,
  activeCardHtml, queueHtml, queueDetailHtml, incomingBannerHtml,
  stopHeaderHtml, combinedPickupHtml, interludeHtml, cancelBannerHtml, offerScreenHtml,
  pickupToRestaurantHtml, pickupReviewHtml, soloPickupHeaderInfo, deliverySummaryHtml,
  contactRowHtml, waTemplatesHtml, offerExpiredBannerHtml, splashHtml,
  relativeAgeLabel, helpDiagnosisHtml, cierreRechazadoHtml,
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

// ---------- coloniaOf (R4 / P1-4 / Codex r2 P2-8 — returns '' UNCONDITIONALLY; no address split, no alias) ----------
t('coloniaOf: reads ONLY order.address_area (verified field); applies the display rule; never splits the raw address (R4)', () => {
  // R4 privacy: the raw/formatted address is NEVER split or exposed — only the verified address_area is read.
  assert.equal(coloniaOf({ order: { address_detected: 'Col. Trejo, casa 1215' } }), '', 'address_detected is NOT split');
  assert.equal(coloniaOf({ order: { address_detected: 'Casa 14 Calle 3, Colonia Trejo, SPS' } }), '', 'a house-first address is never exposed');
  assert.equal(coloniaOf({ deliveryTask: { destination_address: 'Res. Los Robles, bloque C' } }), '', 'the destination address is NOT split either');
  assert.equal(coloniaOf({ order: { colonia: 'Col. Trejo' } }), '', 'an UNVERIFIED colonia alias is NOT read (Codex r2 P2-8)');
  assert.equal(coloniaOf({ order: { locality: 'Los Robles' } }), '', 'no locality alias either');
  assert.equal(coloniaOf({ order: {} }), '', 'empty when there is nothing');
  // R4 privacy, crucial: even WITH a populated raw address, only address_area surfaces — the raw address never leaks.
  assert.equal(coloniaOf({ order: { address_area: 'Trejo', address_detected: 'Casa 14 Calle 3, SPS' } }), 'Col. Trejo', 'only address_area surfaces; the raw address is ignored');
  // display rule (parity with the customer app): a bare name gets «Col. », an existing locality prefix is kept as-is.
  assert.equal(coloniaOf({ order: { address_area: 'Trejo' } }), 'Col. Trejo', 'bare name → «Col. {X}»');
  assert.equal(coloniaOf({ order: { address_area: '  Las Hadas  ' } }), 'Col. Las Hadas', 'trimmed, then «Col. »');
  for (const [raw, out] of [
    ['Col. Trejo', 'Col. Trejo'], ['Colonia Kennedy', 'Colonia Kennedy'], ['Barrio El Centro', 'Barrio El Centro'],
    ['Bo. Abajo', 'Bo. Abajo'], ['Residencial Las Hadas', 'Residencial Las Hadas'], ['Res. Los Robles', 'Res. Los Robles'],
    ['COL. Trejo', 'COL. Trejo'], ['residéncial Palmira', 'residéncial Palmira'],   // case- and accent-insensitive prefix match → kept as given
  ]) assert.equal(coloniaOf({ order: { address_area: raw } }), out, `prefix «${raw}» kept as given`);
  assert.equal(coloniaOf({ order: { address_area: '   ' } }), '', 'whitespace-only address_area → ""');
  assert.equal(coloniaOf({ order: { address_area: 42 } }), '', 'non-string address_area → ""');
});

// ---------- readyTimeHHMM / readyTimeLabel (Owner ruling #2 — pickup ready time from orders/{id}/prep/ready_at) ----------
t('readyTimeHHMM: formats an epoch to H:MM in America/Tegucigalpa (UTC-6), pure (no new Date)', () => {
  // 48120000 ms → UTC-6 = 07:22; verifies the fixed-offset arithmetic.
  assert.equal(readyTimeHHMM(48120000), '7:22', 'epoch → «7:22» at UTC-6');
  assert.equal(readyTimeHHMM(48120000 + 3 * 3600000), '10:22', '+3h');
  assert.equal(readyTimeHHMM(48120000 + 30 * 60000), '7:52', '+30m');
});
t('readyTimeLabel: «~H:MM» from prep.ready_at; HIDDEN («») when the field is absent — no fallback (ruling #2)', () => {
  assert.equal(readyTimeLabel({ prep: { ready_at: 48120000 } }), '~7:22', 'present → «~7:22»');
  assert.equal(readyTimeLabel({}), '', 'no prep → hidden');
  assert.equal(readyTimeLabel({ prep: {} }), '', 'no ready_at → hidden');
  assert.equal(readyTimeLabel({ prep: { ready_at: null } }), '', 'null ready_at → hidden');
  assert.equal(readyTimeLabel({ prep: { ready_at: 0 } }), '', 'zero/invalid → hidden');
  assert.equal(readyTimeLabel(null), '', 'no order → hidden');
});

t('pickupSubLabel: «{brand} ~H:MM · {brand} ~H:MM» across DISTINCT restaurants; time only where prep exists (ruling #2)', () => {
  const o = (name, ready) => ({ restaurant_display_name: name, ...(ready ? { prep: { ready_at: ready } } : {}) });
  // two distinct restaurants, both with ready times
  assert.equal(
    pickupSubLabel([o('X. Pizza', 48120000), o('La Musa', 48300000)]),
    'X. Pizza ~7:22 · La Musa ~7:25',
    'distinct brands joined with « · », each with its own ~H:MM');
  // ready time appended only where prep exists; brand alone otherwise (no fabricated time)
  assert.equal(
    pickupSubLabel([o('X. Pizza', 48120000), o('La Musa')]),
    'X. Pizza ~7:22 · La Musa',
    'brand with no prep shows brand alone');
  assert.equal(pickupSubLabel([o('X. Pizza'), o('La Musa')]), 'X. Pizza · La Musa', 'no ready times → brands only');
  // duplicate restaurant collapses to one entry, first appearance kept
  assert.equal(
    pickupSubLabel([o('X. Pizza', 48120000), o('X. Pizza', 48300000)]),
    'X. Pizza ~7:22',
    'same brand collapses to first appearance');
  // empties/garbage
  assert.equal(pickupSubLabel([]), '', 'empty list → «»');
  assert.equal(pickupSubLabel(null), '', 'null → «»');
  assert.equal(pickupSubLabel([{}, null]), '', 'no brand → «»');
});

t('stopHeaderHtml: explicit sub override renders (escaped) under «Recoger N pedidos» (apRecoger ready-time line)', () => {
  const html = stopHeaderHtml({ pickupCount: 2, sub: 'X. Pizza ~7:22 · La Musa ~7:25' }, DEPS);
  assert.ok(html.includes('Recoger 2 pedidos'), 'title');
  assert.ok(html.includes('X. Pizza ~7:22 · La Musa ~7:25'), 'sub override shown verbatim');
  // override is escaped — a brand with markup cannot inject
  const esc = stopHeaderHtml({ pickupCount: 2, sub: '<b>X</b>' }, DEPS);
  assert.ok(!esc.includes('<b>X</b>'), 'sub override is HTML-escaped');
  assert.ok(esc.includes('&lt;b&gt;X&lt;/b&gt;'), 'escaped form present');
  // empty sub override → no stray subtitle markup beyond the title
  assert.ok(stopHeaderHtml({ pickupCount: 2, sub: '' }, DEPS).includes('Recoger 2 pedidos'), 'empty sub still renders title');
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
t('activeCardHtml → waTemplatesHtml: the WhatsApp number reaches wa.me 504-normalized (Codex r3 P2-2), not the raw local', () => {
  const html = activeCardHtml(A, DEPS, { ordinal: 1 });   // A.customer_phone = '99998888'
  assert.ok(!/wa\.me\//.test(html), 'the active card no longer embeds a wa.me link — WhatsApp now opens the template sheet');
  const m = html.match(/data-wa-phone="([^"]*)"/);
  assert.ok(m, 'the WhatsApp button carries the order phone for the sheet to normalize');
  const sheet = waTemplatesHtml({ name: A.customer_name, brand: 'X. Pizza', phone: m[1], driverName: 'Leo' }, DEPS);
  assert.ok(sheet.includes('wa.me/50499998888?'), 'the sheet normalizes via the established waPhone helper (+504)');
  assert.ok(!sheet.includes('wa.me/99998888?'), 'NOT the un-normalized 8-digit local');
});
t('activeCardHtml: the nav link is BOUND to its rendered task (data-nav-task) (Codex r3 P1-1)', () => {
  const del = deepFreeze({ orderId: 'A', phase: 'delivery', deliveryTask: { id: 'A_d', destination_lat: 14, destination_lng: -87 }, order: { customer_name: 'Ana', display_number: 1, total: 385, payment_method: 'cash', lat: 14, lng: -87 } });
  assert.ok(activeCardHtml(del, DEPS, { ordinal: 1 }).includes('data-nav-task="A_d"'), 'delivery nav bound to the delivery task');
  const pk = deepFreeze({ orderId: 'A', phase: 'pickup', pickupTask: { id: 'A_p', destination_lat: 15, destination_lng: -88 }, deliveryTask: { id: 'A_d' }, order: { customer_name: 'Ana', display_number: 1 } });
  assert.ok(activeCardHtml(pk, DEPS, { ordinal: 1 }).includes('data-nav-task="A_p"'), 'pickup nav bound to the pickup task');
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
t('queuedPreviewHtml: «Después: {first name}» (name only — no address split) + the no-nav-yet hint + data-order-id', () => {
  const html = queuedPreviewHtml(B, 2, DEPS);
  // P1-4 / advisor 2026-10-24: post-accept the preview is NAME-ONLY (coloniaOf returns '' with no verified field);
  // the formatted address is never split into a «· {colonia}» suffix.
  assert.ok(html.includes('Después: Carlos') && !html.includes('Res. Los Robles'), 'first name only, no address split');
  assert.ok(html.includes('sin navegación aún'), 'hint');
  assert.ok(html.includes('data-order-id="B"'), 'orderId hook for the fail-closed tap');
});
t('queuedPreviewHtml: an unverified colonia alias is NOT appended (Codex r2 P2-8 — name only)', () => {
  const withAlias = deepFreeze({ orderId: 'B2', phase: 'pickup', order: { customer_name: 'Carlos Mejía', colonia: 'Los Robles' } });
  assert.ok(queuedPreviewHtml(withAlias, 2, DEPS).includes('Después: Carlos') && !queuedPreviewHtml(withAlias, 2, DEPS).includes('Los Robles'), 'name only, alias ignored');
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
  // Codex r2 P2-7: the Ayuda/«Problema» icon renders ONLY with a real order id — an empty/absent one yields NO button.
  assert.ok(stopHeaderHtml({ ordinal: 1, total: 1, canReportProblem: true, orderId: 'O1' }, DEPS).includes('id="btn-problema"'), 'Ayuda shown when capable AND an order id is threaded');
  assert.ok(stopHeaderHtml({ ordinal: 1, total: 1, canReportProblem: true, orderId: 'O1' }, DEPS).includes('data-order-id="O1"'), 'the real order id is on the button');
  assert.ok(!stopHeaderHtml({ ordinal: 1, total: 1, canReportProblem: true }, DEPS).includes('id="btn-problema"'), 'no order id → NO dead button (never data-order-id="")');
  assert.ok(!stopHeaderHtml({ ordinal: 1, total: 1, canReportProblem: true, orderId: '' }, DEPS).includes('id="btn-problema"'), 'empty order id → NO button');
});
t('stopHeaderHtml: explicit title override wins over the stop-count vocabulary (solo-pickup «Recoger ~H:MM» / «Revisá el pedido»)', () => {
  assert.ok(stopHeaderHtml({ title: 'Recoger ~7:22', sub: 'X. Pizza' }, DEPS).includes('Recoger ~7:22'), 'title override shown');
  assert.ok(!stopHeaderHtml({ title: 'Revisá el pedido' }, DEPS).includes('Única parada'), 'override suppresses the count title');
  assert.ok(stopHeaderHtml({ title: '<b>x</b>' }, DEPS).includes('&lt;b&gt;x&lt;/b&gt;'), 'title override is escaped');
});

// ---------- solo-pickup two-step: soloPickupHeaderInfo / pickupToRestaurantHtml / pickupReviewHtml (advisor 2026-10-24) ----------
const PK = deepFreeze({ orderId: 'A', phase: 'pickup',
  pickupTask: { id: 'A_p', destination_address: 'Blvd. del Norte', destination_lat: 15, destination_lng: -88 },
  deliveryTask: { id: 'A_d', destination_lat: 14, destination_lng: -87 },
  order: { customer_name: 'Daniela Mejía', restaurant_display_name: 'X. Pizza', display_number: 47, total: 385,
    payment_method: 'cash', items_text: 'Pizza grande, 2 Refrescos', prep: { ready_at: 48120000 } } });

t('soloPickupHeaderInfo: step-1 «Recoger ~H:MM»/brand; step-2 «Revisá el pedido»/«brand · listo ~H:MM»; ready omitted when absent', () => {
  assert.deepEqual(soloPickupHeaderInfo(PK.order, false), { title: 'Recoger ~7:22', sub: 'X. Pizza' });
  assert.deepEqual(soloPickupHeaderInfo(PK.order, true), { title: 'Revisá el pedido', sub: 'X. Pizza · listo ~7:22' });
  assert.deepEqual(soloPickupHeaderInfo({ restaurant_display_name: 'La Musa' }, false), { title: 'Recoger', sub: 'La Musa' });
  assert.deepEqual(soloPickupHeaderInfo({ restaurant_display_name: 'La Musa' }, true), { title: 'Revisá el pedido', sub: 'La Musa' });
});

t('pickupToRestaurantHtml: to-restaurant card — brand/addr, «Recoger» pill, «Cocina: listo», nav + «Ya estoy» slide; NO invented instructions', () => {
  const html = pickupToRestaurantHtml(PK, DEPS);
  assert.ok(html.includes('class="active-card"'), 'the stop card shell');
  assert.ok(html.includes('X. Pizza'), 'restaurant name (brandLabel)');
  assert.ok(html.includes('Blvd. del Norte'), 'restaurant address (pickupTask.destination_address)');
  assert.ok(html.includes('phase-pill pickup') && html.includes('>Recoger<'), 'the «Recoger» pill');
  assert.ok(html.includes('Cocina: listo ~7:22'), 'the kitchen-ready note (ruling #2)');
  assert.ok(html.includes('id="btn-at-restaurant"') && html.includes('Ya estoy en el restaurante'), 'the «Ya estoy» slide');
  assert.ok(html.includes('class="nav-dest">→ X. Pizza'), 'the nav button carries the «→ {restaurante}» destination sub-line (consistent with apRecoger)');
  assert.ok(!html.includes('id="btn-pickup"'), 'no server Recogí slide at step 1');
  assert.ok(!html.includes('Instrucciones del restaurante'), 'no invented instructions row (no such field exists)');
  const noReady = pickupToRestaurantHtml(deepFreeze({ ...PK, order: { ...PK.order, prep: undefined } }), DEPS);
  assert.ok(!noReady.includes('Cocina: listo'), 'ready note hidden when prep.ready_at absent (no fabricated time)');
});

t('pickupReviewHtml: review — number protagonist + name chip (R4 is pre-accept only → KEPT) + items + reminder + Recogí', () => {
  const html = pickupReviewHtml(PK, DEPS);
  assert.ok(html.includes('Número de pedido · decilo en ventanilla'), 'the «decilo en ventanilla» label');
  assert.ok(html.includes('sv-bignum') && html.includes('#47'), 'the order-number protagonist');
  assert.ok(html.includes('Daniela M.'), 'the customer-name chip is KEPT as first name + last initial (R4 is pre-accept only; «exactly as shown»)');
  assert.ok(html.includes('Pizza grande') && html.includes('Refrescos'), 'the structured items');
  assert.ok(html.includes('Revisá bebidas y salsas'), 'the reminder banner');
  assert.ok(html.includes('class="bag-chip">1 bolsa'), 'the «1 bolsa» bag chip on the items-card head (one order = one bag)');
  assert.ok(!html.includes('items-brand'), 'the brand + order-num is replaced by the bag chip on the items head');
  assert.ok(html.includes('</div><div class="sv-reminder">'), 'the reminder is NESTED inside the items card (directly after the items list, not a sibling)');
  assert.ok(html.includes('<div class="sv-reminder"><i>U</i>'), 'the reminder opens with the cup glyph (ICONS.cup → CUP_SVG), not the warn triangle');
  assert.ok(html.includes('id="btn-pickup"') && html.includes('Recogí el pedido'), 'the server Recogí slide');
  assert.ok(!html.includes('id="btn-at-restaurant"'), 'no «Ya estoy» slide at the review step');
});

t('pickupReviewHtml pay row: collectionFor-driven, affirmative-only (cash = prototype copy; pending online NEVER «pagado»)', () => {
  const pay = (order) => pickupReviewHtml(deepFreeze({ ...PK, order: { ...PK.order, ...order } }), DEPS);
  const cash = pay({ payment_method: 'cash' });
  assert.ok(cash.includes('Cobrar L 385 al entregar') && cash.includes('No cobrés aquí'), 'cash = prototype copy + reassurance');
  assert.ok(pay({ payment_method: 'card_delivery' }).includes('Con tarjeta'), 'card_delivery is collected at delivery (distinct subtitle)');
  const paidOnline = pay({ payment_method: 'online', payment_status: 'confirmed' });
  assert.ok(paidOnline.includes('Pagado en línea'), 'confirmed online → affirmative «Pagado en línea»');
  const pending = pay({ payment_method: 'online' });   // NOT confirmed
  assert.ok(pending.includes('Pago no confirmado') && !/pagado/i.test(pending), 'pending online is NEVER «pagado» (affirmative-only)');
  const free = pay({ free_order: true });
  assert.ok(free.includes('Pedido gratis'), 'free order → «Pedido gratis»');
  // the cobrar-icon tile tint: green for the COLLECT cases, amber for the UNCONFIRMED one, neutral for paid/free
  assert.ok(cash.includes('class="ico ok">'), 'cash → green-filled cobrar icon (ok tint)');
  assert.ok(pay({ payment_method: 'card_delivery' }).includes('class="ico ok">'), 'card_delivery → green cobrar icon (ok tint)');
  assert.ok(pending.includes('class="ico warn">'), 'unconfirmed payment → amber icon (warn tint)');
  assert.ok(paidOnline.includes('class="ico ">') && !/class="ico (ok|warn)"/.test(paidOnline), 'paid-online → neutral icon (no collect)');
  assert.ok(free.includes('class="ico ">') && !/class="ico (ok|warn)"/.test(free), 'free → neutral icon (nothing to collect)');
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
t('queueDetailHtml: STRUCTURED items from summary_lines render (itemLines), items_text is only the fallback (Codex r3 P2-3)', () => {
  const o = deepFreeze({ orderId: 'B', phase: 'delivery', order: { customer_name: 'Beto', display_number: 2,
    summary_lines: [{ name: 'Pizza grande', qty: 2, cents: 30000 }, { name: 'Baleada', qty: 1, cents: 5000 }], items_text: 'wrong fallback text' } });
  const html = queueDetailHtml(o, 2, DEPS);
  assert.ok(html.includes('Pizza grande') && html.includes('Baleada'), 'structured summary_lines items shown');
  assert.ok(html.includes('<b>2×</b>') && html.includes('3 artículos'), 'qty + total count from summary_lines (2 + 1)');
  assert.ok(!html.includes('wrong fallback text'), 'items_text NOT used when summary_lines is present');
});
t('queueDetailHtml: items_text fallback when summary_lines is absent/malformed', () => {
  const o = deepFreeze({ orderId: 'C', phase: 'delivery', order: { customer_name: 'Cindy', display_number: 3, items_text: '2 pizza, baleada' } });
  const html = queueDetailHtml(o, 2, DEPS);
  assert.ok(html.includes('pizza') && html.includes('baleada') && html.includes('2 artículos'), 'items_text fallback intact');
});
t('queueDetailHtml: the ACTIVE-stop variant drops the «En cola» chip + the «Sin navegación…» lock text, still read-only (Codex r2 P3-9)', () => {
  const o = deepFreeze({ orderId: 'B', phase: 'delivery', order: { customer_name: 'Carlos Mejía', display_number: 12, address_detected: 'Res. Los Robles', items_text: 'baleada', payment_method: 'cash', total: 385 } });
  const html = queueDetailHtml(o, 1, { ...DEPS, active: true });
  assert.ok(!html.includes('En cola'), 'no «En cola» chip for the active stop');
  assert.ok(!html.includes('Sin navegación') && !html.includes('lockchip'), 'no queued-only lock text for the active stop');
  assert.ok(html.includes('items-list') && html.includes('pay-ro-card'), 'still shows items + payment (read-only)');
  assert.ok(!html.includes('nav-primary') && !html.includes('id="btn-delivered"'), 'still read-only — no nav, no Entregado');
});

// ---------- incomingBannerHtml (privacy — brand/#/total only; «otro hub» REMOVED, SLICE3) ----------
t('incomingBannerHtml: pre-accept shows NO name/address and NO «otro hub»; shows brand + total + accept slide', () => {
  const html = incomingBannerHtml([deepFreeze({ orderId: 'X', phase: 'awaiting_acceptance', order: { display_number: 9, total: 200, customer_name: 'Secreta', address_detected: 'Col. Z' }, pickupTask: { assignment_deadline: 1760000000000 }, deliveryTask: {} })], { ...DEPS, collapsedBanners: new Set() });
  assert.ok(!html.includes('Secreta') && !html.includes('Col. Z'), 'no PII pre-accept');
  assert.ok(!html.includes('otro hub'), 'the legacy «otro hub» sub-label is gone (a cross-hub 2nd order is now the S.oferta takeover)');
  assert.ok(html.includes('btn-accept-inc-X') && html.includes('data-deadline="1760000000000"'));
});

// ---------- combinedPickupHtml (apRecoger / S19) ----------
t('combinedPickupHtml: per-bag rows (bag, brand, #, items, pay) + the hot/cold banner', () => {
  const html = combinedPickupHtml([
    deepFreeze({ orderId: 'A', order: { customer_name: 'Daniela', items_text: 'pizza', total: 385, payment_method: 'cash', display_number: 47 } }),
    deepFreeze({ orderId: 'B', order: { customer_name: 'Carlos', items_text: 'baleada', payment_method: 'online', payment_status: 'confirmed', display_number: 12 } }),
  ], DEPS, new Set(['A']));
  assert.ok(html.includes('Bolsa 1 · Daniela') && html.includes('Bolsa 2 · Carlos'));
  assert.ok(html.includes('a cobrar L 385') && html.includes('pagado en línea'));
  assert.ok(html.includes('pk-row done'), 'bag A marked picked up');
  assert.ok(html.includes('Lo caliente y lo frío, separados'), 'hot/cold banner');
});
t('combinedPickupHtml: P1-3 payment classification — card_delivery is «a cobrar … · tarjeta», unconfirmed is «pago no confirmado» (never collapsed to «pagado en línea»)', () => {
  const html = combinedPickupHtml([
    deepFreeze({ orderId: 'C', order: { customer_name: 'Cindy', total: 520, payment_method: 'card_delivery', display_number: 3 } }),
    deepFreeze({ orderId: 'D', order: { customer_name: 'Dario', payment_method: 'online', display_number: 4 } }),   // online, NOT confirmed
  ], DEPS, new Set());
  assert.ok(html.includes('a cobrar L 520') && html.toLowerCase().includes('tarjeta'), 'card_delivery → collect + «tarjeta»');
  assert.ok(html.includes('pago no confirmado'), 'unconfirmed online → «pago no confirmado», NOT «pagado en línea»');
  assert.ok(!html.includes('pagado en línea'), 'no non-cash order was mislabeled paid-online (the P1-3 bug)');
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

// ---------- deliverySummaryHtml (resumen / S16 — end-of-run summary; Pagos gated; collectionFor-driven) ----------
t('deliverySummaryHtml: cash — «Entregado a {first}», #/time, Cobraste + vuelto, day total; +L70/Ganado HIDDEN', () => {
  const html = deliverySummaryHtml({ order: { payment_method: 'cash', total: 385, display_number: 47 }, deliveredName: 'Daniela Mejía', time: '7:43', vuelto: 115, showEarnings: false, dayCashOwed: 385 }, DEPS);
  assert.ok(html.includes('Entregado a Daniela'), 'first name only in the title');
  assert.ok(html.includes('#47') && html.includes('7:43'), 'order # + time');
  assert.ok(html.includes('Cobraste') && html.includes('L 385') && html.includes('Efectivo que llevás para el cuadre'), 'cobro line (cash)');
  assert.ok(html.includes('Diste de vuelto') && html.includes('L 115'), 'vuelto line');
  assert.ok(html.includes('Efectivo a entregar hoy'), 'the money-grade day total (computeShiftCash.cashOwed)');
  assert.ok(!html.includes('+ L 70') && !html.includes('Ganado hoy'), 'Pagos rows HIDDEN until it ships');
  assert.ok(html.includes('id="btn-resumen-done"') && html.includes('Listo'), 'the «Listo» button');
});
t('deliverySummaryHtml: affirmative-only + Pagos gate — paid-online never «Cobraste»; vuelto cash-only; +L70 when earnings on', () => {
  const paid = deliverySummaryHtml({ order: { payment_method: 'online', payment_status: 'confirmed', total: 410 }, deliveredName: 'Ana', vuelto: 50, dayCashOwed: 0 }, DEPS);
  assert.ok(paid.includes('No cobraste nada') && paid.includes('Ya estaba pagado en línea'), 'paid online → affirmative, never «Cobraste L»');
  assert.ok(!/Cobraste L/.test(paid), 'no «Cobraste L X» for a paid-online order');
  assert.ok(!paid.includes('Diste de vuelto'), 'no vuelto row for a non-cash order even if a value is passed');
  const pending = deliverySummaryHtml({ order: { payment_method: 'online', total: 410 }, deliveredName: 'Ana', dayCashOwed: 0 }, DEPS);
  assert.ok(pending.includes('Sin cobro confirmado') && !/pagad/i.test(pending), 'pending online → never «pagado» (affirmative-only)');
  const earn = deliverySummaryHtml({ order: { payment_method: 'cash', total: 385 }, deliveredName: 'Daniela', vuelto: 115, showEarnings: true, dayCashOwed: 385 }, DEPS);
  assert.ok(earn.includes('+ L 70') && earn.includes('Tu pago por esta entrega'), 'earnings on → +L 70 shows');
});

// ---------- contactRowHtml + waTemplatesHtml (whatsapp / S.whatsapp) ----------
t('contactRowHtml: tel link for Llamar; WhatsApp is a BUTTON carrying phone/name/brand-from-order (no href, no greeting)', () => {
  const html = contactRowHtml({ customer_phone: '9999-8888', customer_name: 'Daniela Mejía', restaurant_display_name: 'La Musa' }, DEPS);
  assert.ok(/<a class="recipient-phone" href="tel:99998888"/.test(html), 'Llamar is a tel: link with the stripped number');
  assert.ok(/<button[^>]*class="recipient-whatsapp"/.test(html), 'WhatsApp is a button (opens the template sheet), not an <a href>');
  assert.ok(!/recipient-whatsapp[^>]*href=/.test(html), 'the WhatsApp control has NO direct href');
  assert.ok(html.includes('data-wa-phone="9999-8888"') && html.includes('data-wa-name="Daniela Mejía"'), 'carries the order phone + name');
  assert.ok(html.includes('data-wa-brand="La Musa"'), 'brand comes from the order (brandLabel), never hardwired');
});

t('waTemplatesHtml: 3 phase templates + a free message; brand-from-order + driver name interpolated; free has NO prefilled text', () => {
  const html = waTemplatesHtml({ name: 'Daniela Mejía', brand: 'La Musa', phone: '9999-8888', driverName: 'Marvin' }, DEPS);
  assert.ok(html.includes('Escribirle a Daniela'), 'title addresses the customer by first name');
  const btns = html.match(/<button class="wa-tpl"/g) || [];
  assert.equal(btns.length, 4, 'exactly 3 templates + 1 free message');
  assert.ok(/En camino<\/small>/.test(html) && /Al llegar<\/small>/.test(html) && /Dirección<\/small>/.test(html) && /Sin plantilla<\/small>/.test(html), 'the four phase labels');
  // the «en camino» template interpolates the driver name + the ORDER brand (never a literal brand)
  assert.ok(html.includes('soy Marvin, su repartidor de La Musa'), 'driver name + order brand woven into the draft');
  // no fabricated ETA: the prototype's sample «6 minutos» is NOT shipped (no live customer ETA exists)
  assert.ok(html.includes('Voy en camino.') && !/\d+\s*minutos/.test(html), 'template 1 says «Voy en camino.» — no hard-coded minutes');
  // the approved tiny note is part of the screen (advisor 2026-10-25 ruling #1) — verbatim
  assert.ok(html.includes('El nombre del restaurante viene del pedido; nunca va fijo en el app.'), 'the approved brand-source note, verbatim');
  // every template href is wa.me/<waPhone>?text=<encoded>; the free button opens the chat with NO text
  const hrefs = [...html.matchAll(/data-href="(https:\/\/wa\.me\/[^"]*)"/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 4, 'four wa.me hrefs');
  assert.ok(hrefs.slice(0, 3).every((h) => /\?text=/.test(h)), 'the three phase templates prefill an editable message');
  assert.ok(!/\?text=/.test(hrefs[3]), 'the free-message button opens WhatsApp with no prefilled text');
  assert.ok(hrefs.every((h) => h.includes('wa.me/50499998888')), 'wa.me uses waPhone(phone) — 8-digit HN local → +504');
});

t('waTemplatesHtml: brand-agnostic — a different order brand flows straight through (no hardwired restaurant)', () => {
  const xp = waTemplatesHtml({ name: 'Ana', brand: 'X. Pizza', phone: '98887777', driverName: 'Leo' }, DEPS);
  assert.ok(xp.includes('su repartidor de X. Pizza') && !xp.includes('La Musa'), 'the X. Pizza brand, nothing hardwired');
});

// ---------- offerExpiredBannerHtml (ofertaExpirada / S.ofertaExpirada) ----------
t('offerExpiredBannerHtml: «Se venció la oferta #N» + reassurance + «Ok»; MINUS the unknowable «pasó a otro repartidor»', () => {
  const html = offerExpiredBannerHtml({ num: '#47' }, DEPS);
  assert.ok(html.includes('Se venció la oferta #47'), 'names the expired offer');
  assert.ok(html.includes('Seguís disponible; no afecta tu cuenta.'), 'truthful reassurance (an un-accepted offer never touched cash)');
  assert.ok(html.includes('id="btn-offer-expired-ok"') && html.includes('>Ok<'), 'dismissible with «Ok»');
  // the client cannot know the offer went to another driver (no server signal) → that prototype sentence is dropped
  assert.ok(!/pas[oó] a otro repartidor/i.test(html), 'never claims it «se la pasó a otro repartidor» — unknowable client-side');
  assert.ok(!/Despacho/.test(html), 'no dispatch-attribution the client cannot verify');
});

t('offerExpiredBannerHtml: no num → no dangling «#»', () => {
  const html = offerExpiredBannerHtml({}, DEPS);
  assert.ok(html.includes('Se venció la oferta<') && !html.includes('oferta #'), 'omits the number cleanly when absent');
});

// ---------- relativeAgeLabel + helpDiagnosisHtml (help / S.help) ----------
t('relativeAgeLabel: «hace N s|min|h»; empty for unknown/negative (no fabricated time)', () => {
  assert.equal(relativeAgeLabel(3000), 'hace 3 s');
  assert.equal(relativeAgeLabel(45000), 'hace 45 s');
  assert.equal(relativeAgeLabel(120000), 'hace 2 min');
  assert.equal(relativeAgeLabel(3600000), 'hace 1 h');
  assert.equal(relativeAgeLabel(null), '');
  assert.equal(relativeAgeLabel(-5), '');
});
t('helpDiagnosisHtml: 3 rows (on-shift OK, REAL GPS freshness, dispatch reassurance) + «Entendido»', () => {
  const live = helpDiagnosisHtml({ gpsAgeMs: 3000, gpsLive: true }, DEPS);
  assert.ok(live.includes('¿Por qué no veo pedidos?'));
  assert.ok(live.includes('Estás en turno y disponible') && live.includes('Todo bien de tu lado'));
  assert.ok(live.includes('Tu GPS se vio hace 3 s') && live.includes('Despacho ve dónde estás'), 'live GPS row uses the real age');
  assert.ok(live.includes('Despacho asigna en cuanto entra un pedido cerca') && !live.includes('poco movimiento'), 'row 3 trimmed to the single dispatch line (owner)');
  assert.ok(live.includes('id="btn-help-done"') && live.includes('>Entendido<'));
  // stale/absent GPS → a TRUTHFUL variant, never a fake «hace 3 s» (the prototype only draws the live case)
  const stale = helpDiagnosisHtml({ gpsAgeMs: 300000, gpsLive: false }, DEPS);
  assert.ok(stale.includes('No se ve tu GPS desde hace 5 min') && stale.includes('Activá la ubicación'), 'stale GPS → truthful');
  assert.ok(!/se vio hace/.test(stale), 'a stale fix never claims it was just seen');
  const noFix = helpDiagnosisHtml({ gpsAgeMs: null, gpsLive: false }, DEPS);
  assert.ok(noFix.includes('No se ve tu GPS') && !/hace/.test(noFix), 'no fix → no fabricated age');
});

// ---------- cierreRechazadoHtml (cierreRechazado / S.cierreRechazado) — body only; the host wraps it in the cuadre shell ----------
t('cierreRechazadoHtml: rejection banner as a SIBLING above the receipt + the SUBMITTED amount (screen._cash.cashOwed)', () => {
  const html = cierreRechazadoHtml({ cashOwed: 1430, totalCollected: 2200, deliveries: 7 }, 'Dom 19 oct');
  // the prototype banner copy, verbatim
  assert.ok(html.includes('<b>No se pudo cerrar el turno</b>'), 'banner title');
  assert.ok(html.includes('El servidor rechazó el cierre. Tu efectivo NO quedó registrado y seguís en turno. Reintentá; si sigue, llamá a despacho.'), 'banner body, verbatim');
  assert.ok(html.includes('role="alert"'), 'the banner announces as an alert');
  // the banner is a SIBLING ABOVE the white receipt card (prototype), not inside it
  assert.ok(html.indexOf('rc-reject-banner') < html.indexOf('class="receipt"'), 'banner sits above the receipt card');
  // the hero shows cashOwed (not any other money field) formatted es-HN; mutant cashOwed→totalCollected is caught
  assert.ok(html.includes('Efectivo a entregar') && /<span>L<\/span>\s*1,430/.test(html), 'hero = cashOwed, formatted es-HN');
  assert.ok(!/2,200/.test(html), 'the hero must be cashOwed, never totalCollected');
  // the real date string the host passes (date-only on the rejection screen — the shift did not close)
  assert.ok(html.includes('Dom 19 oct'), 'uses the date the host passes');
  // body-only: the foot buttons live in the shell (showCierreRechazado), NOT in this builder
  assert.ok(!html.includes('Reintentar cierre') && !html.includes('Volver al turno'), 'no foot buttons in the body builder');
});
t('cierreRechazadoHtml: no fabricated amount when cash is absent/malformed (blank, never «L 0»)', () => {
  for (const bad of [undefined, null, {}, { cashOwed: NaN }, { cashOwed: 'x' }]) {
    const html = cierreRechazadoHtml(bad, 'Dom 19 oct');
    assert.ok(!/<span>L<\/span>\s*0\b/.test(html), `no fabricated L 0 for ${JSON.stringify(bad)}`);
    assert.ok(html.includes('No se pudo cerrar el turno'), 'the banner still renders');
  }
});

// ---------- splashHtml (splash / S.splash) ----------
t('splashHtml: Sola compass (.k-ring + .k-needle, host-animatable) + «Sherpa», on the navy overlay', () => {
  const html = splashHtml();
  assert.ok(html.includes('id="drv2-splash"') && html.includes('class="splash"'), 'the launch overlay');
  assert.ok(html.includes('class="k-ring"') && html.includes('class="k-needle"'), 'the compass ring + needle carry the classes the host animates');
  assert.ok(html.includes('>Sherpa<'), 'the «Sherpa» wordmark');
  assert.ok(/#8EC0FF/.test(html) && /#FFFFFF/.test(html), 'the established Sola palette (sky needle, white ring)');
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
  // Advisor 2026-10-24 / P1-4: NO verified locality field today → the offer OMITS the location line entirely —
  // never a split of the address, and never an invented «Zona por confirmar». It shows the km + the restaurants.
  assert.ok(!html.includes('Barrio El Centro') && !html.includes('Res. Los Robles'), 'the formatted address is NEVER split into the offer');
  assert.ok(!html.includes('Zona por confirmar'), 'no invented placeholder copy');
  assert.ok(!html.includes('class="of-area"'), 'the location line is omitted when there is no verified colonia');
  assert.ok(!html.includes('Daniela') && !html.includes('Carlos'), 'NO customer names before accept (R4)');
  assert.ok(html.includes('3.5 km total'), 'distance chip when provided');
  assert.ok(html.includes('Recogés primero en X. Pizza y luego en La Musa'), 'pickup-timing line without times');
  assert.ok((html.match(/id="btn-accept"/g) || []).length === 1, 'one accept slide');
  assert.ok(!html.includes('+ L 140') && !html.includes('+L 140'), 'earnings hidden (R2)');
});
t('offerScreenHtml: pickup line shows «(~H:MM)» per restaurant from prep.ready_at; omits it when absent (ruling #2)', () => {
  const withTimes = [
    deepFreeze({ orderId: 'A', phase: 'awaiting_acceptance', order: { restaurant_display_name: 'X. Pizza', display_number: 9, prep: { ready_at: 48120000 } } }),
    deepFreeze({ orderId: 'B', phase: 'awaiting_acceptance', order: { restaurant_display_name: 'La Musa', display_number: 12, prep: { ready_at: 48120000 + 3 * 60000 } } }),
  ];
  const h1 = offerScreenHtml(withTimes, DEPS, {});
  assert.ok(h1.includes('X. Pizza (~7:22)') && h1.includes('La Musa (~7:25)'), 'per-restaurant ready times from prep.ready_at');
  assert.ok(h1.includes('ambos listos cuando pasás'), 'the «ambos listos» tail when BOTH are known');
  const noTimes = [
    deepFreeze({ orderId: 'A', phase: 'awaiting_acceptance', order: { restaurant_display_name: 'X. Pizza', display_number: 9 } }),
    deepFreeze({ orderId: 'B', phase: 'awaiting_acceptance', order: { restaurant_display_name: 'La Musa', display_number: 12 } }),
  ];
  const h2 = offerScreenHtml(noTimes, DEPS, {});
  assert.ok(h2.includes('Recogés primero en X. Pizza y luego en La Musa.') && !h2.includes('(~'), 'no prep.ready_at → no times, no «ambos listos»');
});
t('offerScreenHtml: NEVER renders the of-area line today — coloniaOf is "" unconditionally (Codex r2 P2-8)', () => {
  const offers = [deepFreeze({ orderId: 'A', phase: 'awaiting_acceptance', order: { colonia: 'Col. Trejo', restaurant_display_name: 'X. Pizza', display_number: 9 } })];
  const html = offerScreenHtml(offers, DEPS, {});
  assert.ok(!html.includes('class="of-area"') && !html.includes('Col. Trejo'), 'no location line, even from an unverified alias');
});

console.log(`stacked-view.test.js: ${passed} passed`);
