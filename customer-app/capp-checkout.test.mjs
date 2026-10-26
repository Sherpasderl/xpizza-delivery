// Customer app S2a (PLAN-capp-S2-r4 §5.1, §7 Model) — the checkout flow model: G0 + each gate in order with its copy; the pickup
// switch clears the tip; tip null ⇒ «Hacer pedido» disabled; 0 via «Otro» = «Sin propina»; cash change against the QUOTED Total;
// deterministic bodies (entry_mode on EVERY quote body); the cartSig covers restaurant / cart / mode / pin / auth / tip (changing
// each ⇒ the ported module attaches no token); Total = the quote's net, never net + tip. The ported capp-confirm-quote.js is
// byte-identical to BOTH form copies. Light: no emulator.
// Run: node --test customer-app/capp-checkout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = require('./capp-checkout.js');
const { createConfirmQuote } = require('./capp-confirm-quote.js');
const { TIP_MAX_CENTS } = require(join(ROOT, 'xpizza-functions/tip.js'));

const ITEMS = [{ id: 'margherita', name: 'Margherita', dish_id: 'd_1', qty: 1, price: 250, subtotal: 250, extras: [], extrasTotal: 0 }];
const ctxOf = (o = {}) => ({ restaurantId: 'rid_a', items: ITEMS, itemsText: '1x Margherita (L250)', member: null, ...o });
const ready = () => { const f = C.freshFlow(null); C.setPin(f, 15.5, -88.0, true); Object.assign(f, { details: 'Portón negro', name: 'Ana', phone: '9999-0000', pay: 'cash' }); return f; };
const OPEN = { open: true, closedRefused: false, pickupOnlyCount: 0, outZone: false, member: false };

test('the ported quote module is byte-identical to BOTH form copies', () => {
  const app = readFileSync(join(ROOT, 'customer-app/capp-confirm-quote.js'));
  for (const f of ['xpizza-orders/form-confirm-quote.js', 'la-musa-orders/form-confirm-quote.js']) assert.ok(app.equals(readFileSync(join(ROOT, f))), `🔴 capp-confirm-quote.js drifted from ${f}`);
});

test('G0 + every gate, IN ORDER, with the prototype copy (missingStep :1812-1824)', () => {
  const f = ready();
  assert.equal(C.missingStep(f, OPEN), '', 'premise: a complete delivery flow places');
  // walk the gates from the LAST to the first: breaking an earlier gate must win over every later one
  const steps = [
    ['rtn', (x) => { x.rtn = true; x.rtnNum = '123'; }, {}],
    ['pay', (x) => { x.pay = ''; }, {}],
    ['email', (x) => { x.email = 'ana@'; }, {}],
    ['phone', (x) => { x.phone = '9999'; }, {}],
    ['name', (x) => { x.name = '  '; }, {}],
    ['details', (x) => { x.details = 'ab'; }, {}],
    ['pin', (x) => { x.pin.confirmed = false; }, {}],
    ['outZone', () => {}, { outZone: true }],
    ['pickupOnly', () => {}, { pickupOnlyCount: 1 }],
    ['closed', () => {}, { open: false }],
  ];
  const g = ready(); let ctx = { ...OPEN };
  for (const [code, mut, cx] of steps) {
    mut(g); ctx = { ...ctx, ...cx };
    assert.equal(C.missingStep(g, ctx), C.COPY[code], `with every gate up to «${code}» broken, «${C.COPY[code]}» wins`);
  }
  assert.equal(C.missingStep(ready(), { ...OPEN, closedRefused: true }), C.COPY.closed, 'a placement refused for closure also holds G0');
  assert.equal(C.COPY.closed, 'No disponible · cerrado', 'G0 = the prototype ASAP card copy (:1838)');
  assert.deepEqual([C.CLOSED_SHEET.title('Tienda', '10:00 p.m.'), C.CLOSED_SHEET.body], ['Tienda cerró a las 10:00 p.m.', 'Tu pedido no se envió.'], 'the closure sheet (:1974) WITHOUT the Programar sentence (owner 2026-10-26)');
  assert.ok(!C.CLOSED_SHEET.body.includes(C.CLOSED_SHEET.scheduleHint), 'the S4 sentence is kept apart, not rendered in S2');
  // pickup skips the delivery-only gates; a member skips name / phone unless editing
  const p = ready(); C.setMode(p, 'pickup'); p.pin.confirmed = false; p.details = '';
  assert.equal(C.missingStep(p, { ...OPEN, pickupOnlyCount: 3, outZone: true }), '', 'pickup ignores pin / details / zone / pickup-only');
  const m = ready(); m.name = ''; m.phone = '';
  assert.equal(C.missingStep(m, { ...OPEN, member: true }), '', 'a member does not retype name / phone');
  m.editWho = true;
  assert.equal(C.missingStep(m, { ...OPEN, member: true }), C.COPY.name, '«Cambiar» on the member row re-opens the guest checks');
});

test('tip: nothing preselected; presets / «Otro»; 0 = «Sin propina»; pickup clears it; capped at the server maximum', () => {
  const f = ready();
  assert.equal(f.tipChoice, null, 'nothing preselected'); assert.equal(C.tipChosen(f), false, 'tip null ⇒ «Hacer pedido» disabled');
  assert.ok(C.chooseTip(f, 40)); assert.deepEqual([f.tipChoice, C.tipCentsOf(f), C.tipChosen(f)], [{ kind: 'preset', lempiras: 40 }, 4000, true]);
  assert.ok(C.chooseTip(f, { other: 0 })); assert.deepEqual(f.tipChoice, { kind: 'none', lempiras: 0 }, '0 via «Otro» = «Sin propina»');
  assert.ok(C.tipChosen(f) && C.tipCentsOf(f) === 0);
  assert.ok(C.chooseTip(f, 0)); assert.equal(f.tipChoice.kind, 'none');
  assert.equal(C.chooseTip(f, 25), false, 'a non-preset number is refused'); assert.equal(C.chooseTip(f, { other: 1.5 }), false);
  assert.equal(C.TIP_MAX_LEMPIRAS * 100, TIP_MAX_CENTS, 'the client cap IS the server cap');
  assert.ok(C.chooseTip(f, { other: C.TIP_MAX_LEMPIRAS })); assert.equal(C.chooseTip(f, { other: C.TIP_MAX_LEMPIRAS + 1 }), false);
  C.chooseTip(f, 60); C.setMode(f, 'pickup');
  assert.deepEqual([f.tipChoice, f.tipCents, C.tipCentsOf(f), C.tipChosen(f)], [null, 0, 0, true], 'pickup clears the tip and never reaches the tip step');
  assert.equal(C.chooseTip(f, 20), false, 'no tip on pickup');
  C.setMode(f, 'delivery'); assert.equal(f.tipChoice, null, 'back to delivery: nothing preselected');
});

test('bodies are deterministic; entry_mode rides EVERY quote body; tip only when > 0; email only when valid', () => {
  const f = ready(); C.chooseTip(f, 20);
  const ctx = ctxOf({ orderId: 'XP251025-120000-AAAA' });
  assert.equal(JSON.stringify(C.orderBody(f, ctx)), JSON.stringify(C.orderBody(f, ctx)), 'byte-identical rebuild');
  for (const pay of ['cash', 'online']) {
    f.pay = pay;
    const q = C.quoteBody(f, ctx);
    assert.equal(q.entry_mode, 'app', `${pay}: the quote body carries entry_mode app`);
    assert.deepEqual(q, { restaurant_id: 'rid_a', items: ITEMS, mode: 'delivery', entry_mode: 'app', pin: { lat: 15.5, lng: -88, confirmed: true }, tip_cents: 2000 });
  }
  f.pay = 'online';
  const card = C.orderBody(f, ctx);
  assert.deepEqual([card.payment_method, card.entry_mode, card.tip_cents, card.cash_tendered, card.lat, card.pin_confirmed, card.customer_phone],
    ['online', 'app', 2000, undefined, 15.5, true, '+504 9999-0000']);
  assert.ok(!('quote_token' in card) && !('expected_net_cents' in card), 'tokens are attached only by the module');
  f.pay = 'cash'; f.tendered = '500';
  const cash = C.orderBody(f, ctx);
  assert.deepEqual([cash.payment_method, cash.entry_mode, cash.cash_tendered], ['cash', undefined, 500]);
  C.chooseTip(f, 0);
  assert.ok(!('tip_cents' in C.orderBody(f, ctx)) && !('tip_cents' in C.quoteBody(f, ctx)), '«Sin propina» sends no tip_cents (the dark-compatible body)');
  f.email = 'ana@'; assert.ok(!('customer_email' in C.orderBody(f, ctx)), 'an invalid email is not sent');
  f.email = ' ana@ej.hn '; assert.equal(C.orderBody(f, ctx).customer_email, 'ana@ej.hn');
  C.setMode(f, 'pickup');
  const pk = C.orderBody(f, ctx);
  assert.ok(!('lat' in pk) && !('pin_confirmed' in pk) && !('address_details' in pk) && !('pin' in C.quoteBody(f, ctx)), 'pickup carries no pin');
});

test('the cartSig covers restaurant / cart / mode / pin / auth / tip — changing each ⇒ no token attached', async () => {
  const f = ready(); C.chooseTip(f, 20);
  const ctx = ctxOf();
  const base = await C.cartSig(f, ctx);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(await C.cartSig(f, ctxOf()), base, 'deterministic');
  const variants = [
    ['restaurant', f, ctxOf({ restaurantId: 'rid_b' })],
    ['cart', f, ctxOf({ items: [{ ...ITEMS[0], price: 260 }] })],
    ['mode', (() => { const g = ready(); C.setMode(g, 'pickup'); return g; })(), ctx],
    ['pin', (() => { const g = ready(); C.chooseTip(g, 20); C.setPin(g, 15.51, -88.0, true); return g; })(), ctx],
    ['pin confirmed', (() => { const g = ready(); C.chooseTip(g, 20); g.pin.confirmed = false; return g; })(), ctx],
    ['auth', f, ctxOf({ member: { uid: 'u1' } })],
    ['tip', (() => { const g = ready(); C.chooseTip(g, 40); return g; })(), ctx],
  ];
  const cq = createConfirmQuote({ setInterval: () => 0, clearInterval: () => {} });
  cq.store({ quote_token: 'tok_for_base', net_total_cents: 33000 }, base);
  for (const [what, ff, cx] of variants) {
    const s = await C.cartSig(ff, cx);
    assert.notEqual(s, base, `${what} changes the signature`);
    const body = C.orderBody(ff, { ...cx, orderId: 'X' });
    assert.equal(cq.send(body, s, 33000), 'degraded', `${what}: the base token is NOT attached`);
    assert.ok(!('quote_token' in body));
  }
  const body = C.orderBody(f, { ...ctx, orderId: 'X' });
  assert.equal(cq.send(body, base, 33000), 'signed', 'non-vacuity: the matching signature attaches');
});

test('money: Total = the quote issued FOR THE SELECTED TIP (never net + tip); subtotal = food; cash change vs the quoted Total', () => {
  const f = ready(); C.chooseTip(f, 20);
  const resp = { ok: true, total_cents: 25000, net_total_cents: 29500, delivery: { delivery_cents: 4500, promo_discount_cents: 0 } };
  // the server's net already includes the tip once; the client never adds it
  const T = C.totals(f, { resp: { ...resp, net_total_cents: 31500 }, sig: 's', tipCents: 2000 }, 25000, 's');
  assert.deepEqual(T, { ready: true, subtotal: 25000, envio: 4500, envioFree: false, promoCents: 0, tip: 2000, total: 31500 });
  assert.notEqual(T.total, 31500 + 2000, 'not net + tip');
  assert.equal(C.totals(f, { resp, sig: 's', tipCents: 0 }, 25000, 's').reason, 'tip_requote', 'a quote for another tip is not this Total');
  assert.equal(C.totals(f, { resp, sig: 'old', tipCents: 2000 }, 25000, 's').reason, 'stale_quote');
  assert.equal(C.totals(f, { resp, sig: 's', tipCents: 2000 }, 26000, 's').reason, 'subtotal_mismatch', 'food ≠ the cart subtotal ⇒ re-quote');
  assert.equal(C.totals(f, null, 25000, 's').reason, 'no_quote');
  const promo = C.totals(f, { resp: { ...resp, delivery: { delivery_cents: 4500, promo_discount_cents: 4500 } }, sig: 's', tipCents: 2000 }, 25000, 's');
  assert.deepEqual([promo.envioFree, promo.promoCents], [true, 4500], 'an active promo strikes the envío («Gratis»)');
  f.tendered = '400'; assert.equal(C.changeCents(f, 31500), 8500, 'change against the QUOTED Total');
  f.tendered = '300'; assert.equal(C.changeCents(f, 31500), null, 'too little ⇒ no change shown');
});

test('hours: open / closed and the closing instant of the business day (the same [h1,m1,h2,m2] reader capp-ui uses)', () => {
  const H = [null, [11, 0, 22, 0], [11, 0, 22, 0], [11, 0, 22, 0], [11, 0, 22, 0], [11, 0, 22, 0], [11, 0, 22, 0]];
  const mon = (h, m) => new Date(2026, 9, 26, h, m, 0, 0);   // a Monday
  assert.equal(C.isOpenAt(H, mon(10, 59)), false); assert.equal(C.isOpenAt(H, mon(11, 0)), true); assert.equal(C.isOpenAt(H, mon(21, 59)), true); assert.equal(C.isOpenAt(H, mon(22, 0)), false);
  assert.equal(C.closingAt(H, mon(20, 0)), mon(22, 0).getTime());
  assert.equal(C.closingAt(H, new Date(2026, 9, 25, 12, 0)), null, 'a closed day (Sunday) has no closing');
  assert.equal(C.closingAt(null, mon(12, 0)), null, 'unreadable hours ⇒ null');
  assert.equal(C.isOpenAt(null, mon(12, 0)), false);
});

test('no restaurant literal in the model', () => {
  const src = readFileSync(join(ROOT, 'customer-app/capp-checkout.js'), 'utf8');
  assert.equal(src.match(/x_pizza|la_musa|xpizza|lamusa|X\.? ?Pizza|La Musa/i), null);
});
