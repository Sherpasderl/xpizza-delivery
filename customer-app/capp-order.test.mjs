// capp-order — «Pedido recibido» (v6 orderHtml) + S4 C / R + the guest offer slot: the pure render, against the approved copy.
// Run: node --test customer-app/capp-order.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const require = createRequire(import.meta.url);
const { JSDOM } = createRequire(join(ROOT, 'xpizza-functions/x.js'))('jsdom');
const CappOrder = require('./capp-order.js');

const T0 = Date.UTC(2026, 9, 22, 0, 0, 0);
const ORDER = { order_id: 'XP-1', mode: 'delivery', status: 'new', storeName: 'X. Pizza', branch: 'Centro', storeAddr: 'Av. 1',
  lines: [{ n: 2, name: 'Carnívora', extras: 'Extra queso', total: 570 }, { n: 1, name: 'Crispy Bacon', extras: '', total: 265 }],
  fee: 45, tip: 40, total: 920, pay: 'online', addr: 'Col. Jardines del Valle', details: 'Portón negro', notes: '', whenText: 'Lo antes posible', phoneText: '+504 9612-3344' };
const CTX = { entry: 'app', now: T0, dark: false, offerHtml: '', helpOk: false, shareOk: false };
const dom = (html) => new JSDOM(`<div id="r">${html}</div>`).window.document.getElementById('r');
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

test('«new» (v6 row 42): title, status line, half-filled first segment of 5, the receipt blocks in the open; no window / number / help / share / PIN when their data is absent (fail closed)', () => {
  const r = dom(CappOrder.orderHtml(ORDER, CTX));
  assert.equal(txt(r.querySelector('.mk-title')), 'Pedido recibido');
  assert.equal(txt(r.querySelector('.mk-status')), 'Estamos por empezar a preparar tu pedido');
  const sg = [...r.querySelectorAll('.segbar .sg')];
  assert.deepEqual(sg.map((x) => x.className), ['sg active', 'sg', 'sg', 'sg', 'sg'], '🔴 OR-new: the drawn segbar');
  assert.deepEqual([...r.querySelectorAll('.receipt2 h3')].map(txt), ['Tu pedido', 'Pago y entrega']);
  assert.equal(r.querySelector('.mk-num'), null, '🔴 OR-num: no «Orden #» line until the server returns the display number');
  assert.equal(r.querySelector('.mk-window'), null, 'no window without an estimate');
  assert.equal(r.querySelector('[data-act="order-help"]'), null, '🔴 OR-help: no «Ayuda» without the platform help number');
  assert.equal(r.querySelector('[data-act="order-share"]'), null, '🔴 OR-share: no «Compartir seguimiento» without a tracking link');
  assert.equal(r.querySelector('.pincard'), null);
  assert.equal(txt(r.querySelector('.mk-label')), 'X. Pizza · Centro'); assert.ok(r.querySelector('.mk-home'), 'delivery ⇒ the home marker');
  assert.ok(r.querySelector('[data-act="order-close"]'), 'app entry ⇒ the close control'); assert.equal(r.querySelector('.credit'), null);
  const [rc, pr] = r.querySelectorAll('.receipt2'); const cells = (row) => [...row.children].map(txt); const rows = [...rc.querySelectorAll('.rrow')].map(cells);
  assert.deepEqual(rows, [['2× Carnívora+ Extra queso', 'L 570'], ['1× Crispy Bacon', 'L 265'], ['Envío', 'L 45'], ['Propina', 'L 40'], ['Total', 'L 920']]);
  assert.deepEqual([...pr.querySelectorAll('.rrow')].map(cells), [['Pago', 'Pagado en línea · PixelPay'], ['Estado', 'Confirmado'], ['Cuándo', 'Lo antes posible'], ['WhatsApp', '+504 9612-3344']]);
});
test('«new»: the display number, the window, «Ayuda» and «Compartir seguimiento» appear once their data exists; link entry ⇒ no close, «Enviado por Sherpa»', () => {
  const r = dom(CappOrder.orderHtml({ ...ORDER, display_number: 47, windowText: '7:35 – 7:50 p. m.' }, { ...CTX, entry: 'link', helpOk: true, shareOk: true }));
  assert.equal(txt(r.querySelector('.mk-num')), 'Orden #47 · Te avisamos por WhatsApp');
  assert.equal(txt(r.querySelector('.mk-window')), 'Llega 7:35 – 7:50 p. m.');
  assert.ok(r.querySelector('[data-act="order-help"]') && r.querySelector('[data-act="order-share"]'));
  assert.equal(r.querySelector('[data-act="order-close"]'), null); assert.equal(txt(r.querySelector('.credit')), 'Enviado por Sherpa');
});
test('pickup «new»: 3 segments, «Recoger en» card, no home marker, no share; cash ⇒ «Efectivo al recoger» / «Se cobra al recoger»', () => {
  const r = dom(CappOrder.orderHtml({ ...ORDER, mode: 'pickup', pay: 'cash' }, { ...CTX, shareOk: true }));
  assert.equal(r.querySelectorAll('.segbar .sg').length, 3);
  assert.equal(txt(r.querySelector('.mk-card .k')), 'Recoger en'); assert.equal(r.querySelector('.mk-home'), null);
  assert.equal(r.querySelector('[data-act="order-share"]'), null);
  assert.ok(/Efectivo al recoger/.test(txt(r)) && /Se cobra al recoger/.test(txt(r)));
});
test('S4 C (owner option B): «Pedido programado», no order number, the segbar unfilled, no share, the drawn line + status', () => {
  const at = T0 + 3 * 3600000;
  const r = dom(CappOrder.orderHtml({ ...ORDER, display_number: 47, scheduled: true, scheduledFor: at, whenText: 'Hoy 9:00 p. m.' }, { ...CTX, shareOk: true }));
  assert.equal(txt(r.querySelector('.mk-title')), 'Pedido programado');
  assert.equal(txt(r.querySelector('.mk-num')), 'Te avisamos por WhatsApp cuando entre a cocina', '🔴 OR-C: no «Orden #» before release');
  assert.equal(txt(r.querySelector('.mk-status')), 'Tu pedido está programado. Lo empezamos a preparar antes de tu horario.');
  assert.deepEqual([...r.querySelectorAll('.segbar .sg')].map((x) => x.className), ['sg', 'sg', 'sg', 'sg', 'sg'], '🔴 OR-C: unfilled');
  assert.equal(r.querySelector('[data-act="order-share"]'), null);
  assert.equal(txt(r.querySelector('.mk-window')), 'Programado · llega Hoy 9:00 p. m.', '🔴 OR-C: v6 etaRange\'s scheduled line (S4 C\'s drawn anchor)');
});
test('S4 R (owner 11-01): no release by scheduled_for + 30 min ⇒ «Revisando tu pedido» with the approved copy; one ms before ⇒ still C', () => {
  const at = T0;
  const R = dom(CappOrder.orderHtml({ ...ORDER, scheduled: true, scheduledFor: at }, { ...CTX, now: at + CappOrder.REVIEW_AFTER_MS }));
  assert.equal(txt(R.querySelector('.mk-title')), 'Revisando tu pedido');
  assert.equal(txt(R.querySelector('.mk-num')), 'Te avisamos por WhatsApp');
  assert.equal(txt(R.querySelector('.mk-status')), 'Estamos revisando tu horario con el restaurante. Te escribimos por WhatsApp si hay que cambiarlo.');
  const C = dom(CappOrder.orderHtml({ ...ORDER, scheduled: true, scheduledFor: at }, { ...CTX, now: at + CappOrder.REVIEW_AFTER_MS - 1 }));
  assert.equal(txt(C.querySelector('.mk-title')), 'Pedido programado', '🔴 OR-R: the boundary');
});
test('the guest offer sits in v6\'s .rw slot: after the status row, before the delivery details', () => {
  const r = dom(CappOrder.orderHtml(ORDER, { ...CTX, offerHtml: '<div class="guestcard offer">OFFER</div>' }));
  const kids = [...r.querySelector('.mk-sheet').children].map((x) => x.className.split(' ')[0]);
  assert.ok(kids.indexOf('guestcard') > kids.indexOf('mk-status') && kids.indexOf('guestcard') < kids.indexOf('mk-card'), `order: ${kids.join(',')}`);
});
test('the live v6 states: headlines, the driver card on out / arriving, «Parada rápida» copy when stacked, the PIN card ONLY with a PIN, the receipt folded', () => {
  const o = { ...ORDER, driver: 'Carlos' };
  const h = (x) => txt(dom(CappOrder.orderHtml(x, CTX)).querySelector('.mk-title'));
  assert.equal(h({ ...o, status: 'preparing' }), 'Tu pedido se está preparando');
  assert.equal(h({ ...o, status: 'out' }), 'Carlos está en camino');
  assert.equal(h({ ...o, status: 'arriving' }), 'Carlos está llegando');
  assert.equal(h({ ...o, status: 'delivered' }), '¡Pedido entregado!');
  assert.equal(h({ ...o, status: 'cancelled' }), 'Pedido cancelado');
  assert.equal(h({ ...o, mode: 'pickup', status: 'ready' }), '¡Tu pedido está listo para recoger!');
  const out = dom(CappOrder.orderHtml({ ...o, status: 'out' }, CTX));
  assert.equal(txt(out.querySelector('.drivercard .t b')), 'Carlos'); assert.equal(out.querySelector('.pincard'), null, '🔴 OR-pin: fail closed without a PIN');
  assert.ok(out.querySelector('.mk-driver'), 'the driver on the route'); assert.ok(out.querySelector('.receipt .toggle'), 'the receipt folds once live');
  const pin = dom(CappOrder.orderHtml({ ...o, status: 'out', pin: '4821' }, CTX));
  assert.equal(txt(pin.querySelector('.pincard .pin')), '4 8 2 1');
  const st = dom(CappOrder.orderHtml({ ...o, status: 'out', stacked: true }, CTX));
  assert.equal(txt(st.querySelector('.ssub')), 'Tu repartidor tiene una parada rápida en camino a la tuya, luego va directo hacia vos.');
  assert.equal(st.querySelectorAll('.mk-dot').length, 2, 'stacked ⇒ the other stop');
});
test('escaping: store, driver, address and line names are text, never markup', () => {
  const r = dom(CappOrder.orderHtml({ ...ORDER, storeName: '<b>x</b>', addr: '<img src=x onerror=1>', lines: [{ n: 1, name: '<i>y</i>', total: 1 }], status: 'out', driver: '<s>d</s>' }, CTX));
  assert.equal(r.querySelector('b b, img, .rrow i, .t s'), null);
});
// ONE source (advisor ruling): the order number is the forms' own state machine — customer-app/form-order-number.js is a BYTE copy of
// the order forms' (which are byte-equal to each other, order-number.test.mjs); a drift fails here
test('one source: customer-app/form-order-number.js is byte-identical to the order forms\' copies', () => {
  const mine = readFileSync(join(HERE, 'form-order-number.js'));
  for (const f of ['xpizza-orders/form-order-number.js', 'la-musa-orders/form-order-number.js']) assert.ok(mine.equals(readFileSync(join(ROOT, f))), `🔴 customer-app/form-order-number.js drifted from ${f}`);
});
test('one source: status-view.js (the tracker\'s words) and form-live-status.js (S5\'s window) are byte-identical to their sources', () => {
  assert.ok(readFileSync(join(HERE, 'status-view.js')).equals(readFileSync(join(ROOT, 'xpizza-track/status-view.js'))), '🔴 customer-app/status-view.js drifted from xpizza-track/status-view.js');
  assert.ok(readFileSync(join(HERE, 'form-live-status.js')).equals(readFileSync(join(ROOT, 'xpizza-orders/form-live-status.js'))), '🔴 customer-app/form-live-status.js drifted from xpizza-orders/form-live-status.js');
});
test('fromTracking: the tracker\'s statuses onto v6\'s — ready is still preparing for a delivery; out for a pickup is ready; completed = delivered / collected; unknown ⇒ null; arriving is never derived', () => {
  const f = (st, mode = 'delivery', x = {}) => { const v = CappOrder.fromTracking({ status: st, ...x }, mode); return v && v.status; };
  assert.deepEqual([f('new'), f('preparing'), f('ready'), f('out_for_delivery'), f('delivered'), f('completed'), f('cancelled'), f('weird')], ['new', 'preparing', 'preparing', 'out', 'delivered', 'delivered', 'cancelled', null]);
  assert.deepEqual([f('ready', 'pickup'), f('out_for_delivery', 'pickup'), f('completed', 'pickup')], ['ready', 'ready', 'collected']);
  assert.equal(CappOrder.fromTracking({ status: 'out_for_delivery', driver_name: 'C', is_active_drop: false }, 'delivery').stacked, true);
  assert.equal(CappOrder.fromTracking({ status: 'out_for_delivery', driver_name: 'C' }, 'delivery').stacked, false, 'absent ⇒ not stacked (fail-safe)');
});


// the receipt's items_text lines (NOTE-getMyOrders-receipt: lines null) parse EXACTLY as the forms' own history parser — the function is
// read from BOTH forms' account.js (byte-identical there) and run on the same inputs, so a change on either side is red here
test('receipt textLines = the forms\' parseOrderItems (la-musa-orders + xpizza-orders account.js), input by input', () => {
  const C = require('./capp-order.js');
  const IN = ['1x Pad Thai (L210) [+ 1x Huevo] | 2x Spring Rolls (L90)', '2x Margherita (L324) [+ 1x Mozzarella, 2x Albahaca]', '3x Agua', 'Promo especial', ' | 1x A (L1,000.50) | ', '', null, '1x Nombre (con paréntesis) (L99)'];
  for (const f of ['la-musa-orders/account.js', 'xpizza-orders/account.js']) {
    const src = readFileSync(join(ROOT, f), 'utf8'), m = src.match(/ {2}function parseOrderItems\(txt\) \{[\s\S]*?\n {2}\}\n/);
    assert.ok(m, `premise: ${f} carries parseOrderItems`);
    const parse = new Function(`${m[0]}; return parseOrderItems;`)();
    for (const t of IN) assert.deepEqual(C.textLines(t), parse(t).map((x) => ({ n: x.qty, name: x.name, extras: x.extras, total: null })), `🔴 RC-drift: ${f} vs textLines on ${JSON.stringify(t)}`);
  }
  assert.deepEqual(C.textLines('1x Pad Thai (L210) [+ 1x Huevo]'), [{ n: '1', name: 'Pad Thai', extras: '1× Huevo', total: null }], 'the shape the receipt draws');
});
