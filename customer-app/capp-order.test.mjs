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
import { payView, line } from './test/fake-sdk-pay.mjs';

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

// advisor 11-01 (receipt ruling 1): a PAST order's «Estado» states only what is known — dropped on every cash order (delivered or
// cancelled: «Se cobra al …» would be false) and on a cancelled card order (the refund is not ours to guess); a card order that was
// delivered / collected keeps «Confirmado»
test('past receipt «Estado»: cash delivered / cash cancelled / card cancelled ⇒ none; card delivered / collected ⇒ «Confirmado»', () => {
  const past = { ...ORDER, pay: null, whenText: null, phoneText: null };
  const pay = (o) => [...dom(CappOrder.orderHtml(o, { ...CTX, past: true })).querySelectorAll('.receipt:last-of-type .rrow')].map((row) => [...row.children].map(txt).join(' '));
  assert.deepEqual(pay({ ...past, status: 'delivered', pay: 'cash' }), ['Pago Efectivo al entregar'], '🔴 RC-E1: cash delivered — no Estado');
  assert.deepEqual(pay({ ...past, status: 'cancelled', pay: 'cash' }), ['Pago Efectivo al entregar'], '🔴 RC-E2: cash cancelled — no Estado');
  assert.deepEqual(pay({ ...past, status: 'cancelled', pay: 'card' }), ['Pago Tarjeta'], '🔴 RC-E3: card cancelled — no Estado (refund not guessed)');
  assert.deepEqual(pay({ ...past, status: 'delivered', pay: 'card' }), ['Pago Tarjeta', 'Estado Confirmado'], '🔴 RC-E4: card delivered — «Confirmado»');
  assert.deepEqual(pay({ ...past, mode: 'pickup', status: 'collected', pay: 'card' }), ['Pago Tarjeta', 'Estado Confirmado'], 'card collected — «Confirmado»');
  assert.deepEqual(pay({ ...past, status: 'delivered', pay: null }), [], 'an unknown tender: no Pago / Estado');
  const live = [...dom(CappOrder.orderHtml({ ...ORDER, status: 'preparing', pay: 'cash' }, CTX)).querySelectorAll('.receipt:last-of-type .rrow')].map((row) => [...row.children].map(txt).join(' '));
  assert.deepEqual(live.slice(0, 2), ['Pago Efectivo al entregar', 'Estado Se cobra al entregar'], 'the LIVE screen is unchanged (not past)');
});
test('past receipt hold (option A): c.hold ends the sheet before the first receipt block with an empty marker; c.tailOnly = exactly that tail', () => {
  const o = { ...ORDER, status: 'delivered', pay: 'cash', whenText: null, phoneText: null };
  const held = dom(CappOrder.orderHtml(o, { ...CTX, past: true, hold: true }));
  assert.ok(held.querySelector('[data-rc-tail]') && !held.querySelector('.mk-card') && !held.querySelector('.receipt') && !held.querySelector('[data-act="order-again"]'), '🔴 RC-H: a delivery holds from its address card');
  const tail = CappOrder.orderHtml(o, { ...CTX, past: true, tailOnly: true });
  const heldStr = CappOrder.orderHtml(o, { ...CTX, past: true, hold: true }), fullStr = CappOrder.orderHtml(o, { ...CTX, past: true });
  assert.equal(heldStr.split('<div data-rc-tail></div>').length, 2, 'premise: ONE marker');
  assert.equal(heldStr.replace('<div data-rc-tail></div>', tail), fullStr, '🔴 RC-H: marker → tail = the full screen, byte for byte');
  const pk = { ...o, mode: 'pickup', status: 'collected' }, hp = dom(CappOrder.orderHtml(pk, { ...CTX, past: true, hold: true }));
  assert.ok(hp.querySelector('.mk-card') && !hp.querySelector('.receipt'), 'a pickup\'s «Recoger en» (the directory\'s) is drawn; the summary waits');
});

// Codex rcpt r1 #1: the LIVE screen (not past) is byte-identical to the pre-receipt CappOrder — the base module is loaded from its
// git blob (c6719256, the commit before the receipt) and both render the same grid: redeem × tender × mode × status × hold flags absent
test('the live order screen = the pre-receipt CappOrder byte for byte (base blob c6719256), across redeem 0/5 × cash/card/online/unknown × delivery/pickup × statuses × hold/tailOnly flags', async () => {
  const { execFileSync } = await import('node:child_process');
  const src = execFileSync('git', ['show', 'c6719256:customer-app/capp-order.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.ok(src.includes('function orderHtml(o, c)') && !src.includes('c.past'), 'premise: the base blob is the pre-receipt module');
  const mod = { exports: {} }; new Function('module', 'exports', 'require', 'self', src)(mod, mod.exports, require, globalThis);
  const BASE = mod.exports; assert.equal(typeof BASE.orderHtml, 'function');
  let n = 0;
  for (const redeem of [0, 5]) for (const pay of ['cash', 'card', 'online', undefined]) for (const mode of ['delivery', 'pickup'])
    for (const status of ['new', 'preparing', 'ready', 'out', 'delivered', 'collected', 'cancelled']) for (const receiptOpen of [false, true]) for (const flags of [{}, { hold: true }, { tailOnly: true }, { hold: true, tailOnly: true }]) {
      const o = { ...ORDER, redeem, pay, mode, status, driver: status === 'out' ? 'Carlos' : null, lines: [...ORDER.lines, { n: '', name: 'Sin cantidad', extras: '', total: null }] };
      const c = { ...CTX, receiptOpen, ...flags };   // Codex rcpt r2: hold / tailOnly set on the LIVE screen change nothing
      assert.equal(CappOrder.orderHtml(o, c), BASE.orderHtml(o, c), `🔴 RC-base: live render drifted (redeem ${redeem}, ${pay}, ${mode}, ${status}, open ${receiptOpen}, ${JSON.stringify(flags)})`); n++;
    }
  assert.equal(n, 896);
});

test('S2 mount points (MOCKUP-capp-S2-adjustment r3): an sdk order\'s c.pay — the notice after the status row, «Nuevo total aceptado» leading the subline, the Pago block in place of «Pagado en línea / Confirmado»; a malformed c.pay changes nothing', () => {
  const PA = require('./capp-pay-adjust.js');
  const view = payView({ total_cents: 87500, revision: 1, card: { brand: 'visa', last4: '4242' }, notice: { kind: 'decrease', revision: 1, old_total_cents: 92000, new_total_cents: 87500, changes: [line('line_removed', 'Crispy Bacon', -4500)] } });
  const fr = PA.frameOf(view, 'preparing', {});
  const pay = { notice: PA.noticeHtml(view, fr), block: PA.payHtml(view), statusSub: null };
  for (const status of ['new', 'preparing', 'out']) {   // out: the driver card follows the status row — the notice comes first
    const r = dom(CappOrder.orderHtml({ ...ORDER, status, driver: status === 'out' ? 'Carlos' : null }, { ...CTX, pay }));
    const note = r.querySelector('.notecard'), row = r.querySelector(status === 'new' ? '.mk-status' : '.statusrow');
    assert.ok(note && row && row.compareDocumentPosition(note) === 4 && row.nextElementSibling === note, `🔴 S2-mount: the notice sits right after the status row (${status})`);
    const rows = [...r.querySelectorAll('.rrow .k')].map(txt);
    assert.ok(!rows.includes('Pago') && !rows.includes('Estado'), `🔴 S2-mount: no «Pagado en línea» / «Confirmado» rows on an sdk order (${status}: ${rows.join(', ')})`);
    const blocks = [...r.querySelectorAll('.receipt, .receipt2')], pb = r.querySelector('.receipt .rbody p.note');
    assert.equal(txt(pb), 'Se cobra al recibir tu pedido.', `🔴 S2-mount: the Pago block is drawn (${status})`);
    assert.ok(blocks.indexOf(pb && pb.closest('.receipt')) === blocks.length - 2, `the Pago block sits before «Pago y entrega» (${status})`);
  }
  const d = dom(CappOrder.orderHtml({ ...ORDER, status: 'preparing' }, { ...CTX, pay: { ...pay, notice: '', statusSub: 'Nuevo total aceptado' } }));
  assert.equal(txt(d.querySelector('.statusrow .ssub')), 'Nuevo total aceptado · Te avisaremos cuando vaya en camino', '🔴 S2-D: the status line leads the subline');
  for (const bad of [null, {}, { notice: '<b>x</b>' }, { block: '' }, { block: 5 }, 'x']) {
    assert.equal(CappOrder.orderHtml(ORDER, { ...CTX, pay: bad }), CappOrder.orderHtml(ORDER, CTX), `🔴 S2-mount: a malformed c.pay (${JSON.stringify(bad)}) changes nothing`);
  }
});
