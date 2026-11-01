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

// ── S2b-geo (MOCKUP-capp-S2b-geo-address.html; PLAN-colonia r1 §1) — the reverse-geocode of the confirmed pin, display only ──
// recorded Google Geocoder result shapes (address_components)
const GC = {
  full: [{ address_components: [{ long_name: '10', types: ['street_number'] }, { long_name: 'Calle 10', types: ['route'] }, { long_name: 'Jardines del Valle', types: ['neighborhood', 'political'] }, { long_name: 'San Pedro Sula', types: ['locality', 'political'] }, { long_name: '7FG2+XX', types: ['plus_code'] }] }],
  routeOnly: [{ address_components: [{ long_name: '5', types: ['street_number'] }, { long_name: 'Calle 10', types: ['route'] }, { long_name: 'San Pedro Sula', types: ['locality', 'political'] }] }],
  areaOnly: [{ address_components: [{ long_name: 'Unnamed Road', types: ['route'] }, { long_name: 'Jardines del Valle', types: ['sublocality_level_1', 'sublocality', 'political'] }, { long_name: 'San Pedro Sula', types: ['locality'] }] }],
  localityOnly: [{ address_components: [{ long_name: 'San Pedro Sula', types: ['locality', 'political'] }, { long_name: 'Cortés', types: ['administrative_area_level_1'] }] }],
  subOnly: [{ address_components: [{ long_name: 'Rivera Hernández', types: ['sublocality', 'political'] }] }],
  // the neighborhood sits on a later result: priority by TYPE across the results, in result order
  split: [{ address_components: [{ long_name: 'Calle 10', types: ['route'] }, { long_name: 'Sector Norte', types: ['sublocality_level_1', 'sublocality'] }] }, { address_components: [{ long_name: 'Jardines del Valle', types: ['neighborhood'] }] }],
};
const pinned = () => { const f = C.freshFlow(null); C.setPin(f, 15.52, -88.04, true); return f; };

test('S2b-geo areaFromGeocode (PLAN §1): neighborhood ▸ sublocality_level_1 ▸ sublocality; never locality / route / street_number; raw', () => {
  assert.equal(C.areaFromGeocode(GC.full), 'Jardines del Valle', 'neighborhood');
  assert.equal(C.areaFromGeocode(GC.areaOnly), 'Jardines del Valle', 'sublocality_level_1 only');
  assert.equal(C.areaFromGeocode(GC.subOnly), 'Rivera Hernández', 'sublocality only');
  assert.equal(C.areaFromGeocode(GC.split), 'Jardines del Valle', 'a neighborhood on a later result beats an earlier sublocality');
  assert.equal(C.areaFromGeocode(GC.localityOnly), '', 'locality only ⇒ none (never the city)');
  assert.equal(C.areaFromGeocode(GC.routeOnly), '', 'a route is never the area');
  assert.equal(C.areaFromGeocode([{ address_components: [{ long_name: 'Casa 14 Calle 3', types: ['neighborhood'] }] }]), 'Casa 14 Calle 3', 'a street-bearing name passes through RAW (the server filter is the authority)');
  for (const empty of [[], null, undefined, [{}], [{ address_components: [{ long_name: '  ', types: ['neighborhood'] }] }]]) assert.equal(C.areaFromGeocode(empty), '', `empty ⇒ '' (${JSON.stringify(empty)})`);
});

test('S2b-geo routeFrom: the route long_name ONLY — no street_number, no plus_code; «Unnamed Road» is no street', () => {
  assert.equal(C.routeFrom(GC.full), 'Calle 10', 'the route, not «Calle 10 10» nor the plus code');
  assert.equal(C.routeFrom(GC.areaOnly), '', '🔴 «Unnamed Road» ⇒ no street');
  assert.equal(C.routeFrom([{ address_components: [{ long_name: 'unnamed road', types: ['route'] }] }]), '', 'any case');
  assert.equal(C.routeFrom(GC.localityOnly), '');
  assert.equal(C.routeFrom([{ address_components: [{ long_name: '7FG2+XX', types: ['plus_code'] }, { long_name: '10', types: ['street_number'] }] }]), '', 'a plus code / number alone is never a street');
});

test('S2b-geo displayArea (advisor ruling 2026-10-26): a name that already says Colonia / Col. / Barrio / Bo. / Residencial / Res. is shown as given; else «Col. {X}»', () => {
  for (const given of ['Colonia Trejo', 'Col. Kennedy', 'Col Kennedy', 'Barrio Río de Piedras', 'Bo. Guamilito', 'Bo Guamilito', 'Residencial Los Castaños', 'Res. Lomas', 'RESIDENCIAL Z', 'Cólonia Acento', 'BARRIO Abajo'])
    assert.equal(C.displayArea(given), given, `${given}: as given`);
  for (const [x, want] of [['Jardines del Valle', 'Col. Jardines del Valle'], ['Colonial Hills', 'Col. Colonial Hills'], ['Bosques de Jucutuma', 'Col. Bosques de Jucutuma'], ['Resplandor', 'Col. Resplandor'], ['Barrios Unidos', 'Col. Barrios Unidos'], ['Colinas', 'Col. Colinas']])
    assert.equal(C.displayArea(x), want, `🔴 near-miss ${x}: whole word only`);
});

test('S2b-geo addrLine: A1 «{street}, Col. {X}» · b «{street}» · b2 «Col. {X}» · c none ⇒ \'\' (today\'s row)', () => {
  const cases = [[GC.full, 'Calle 10, Col. Jardines del Valle'], [GC.routeOnly, 'Calle 10'], [GC.areaOnly, 'Col. Jardines del Valle'], [GC.localityOnly, ''], [[], '']];
  for (const [r, want] of cases) { const f = pinned(); assert.equal(C.applyGeocode(f, f.pinV, r), true); assert.equal(C.addrLine(f), want, JSON.stringify(want)); }
  const f = pinned(); assert.equal(C.addrLine(f), '', 'pending (no reply yet) ⇒ today\'s row');
  const u = C.freshFlow(null); C.setPin(u, 15.52, -88.04, false); u.geo = { v: u.pinV, street: 'Calle 10', area: 'X' };
  assert.equal(C.addrLine(u), '', 'an UNCONFIRMED pin never shows a geo line');
});

test('S2b-geo pin-version binding: every pin change bumps the version and clears the geo SYNCHRONOUSLY; the same pin keeps both; a superseded reply is discarded', () => {
  const f = pinned(); const v1 = f.pinV;
  C.applyGeocode(f, v1, GC.full); assert.equal(C.addrLine(f), 'Calle 10, Col. Jardines del Valle');
  C.setPin(f, 15.52, -88.04, true);
  assert.deepEqual([f.pinV, C.addrLine(f)], [v1, 'Calle 10, Col. Jardines del Valle'], 'the same coordinates: same version, geo kept (no second geocode)');
  C.setPin(f, 15.53, -88.05, true); const v2 = f.pinV;
  assert.equal(v2, v1 + 1, '🔴 a new pin bumps the pin version');
  assert.deepEqual([f.geo, C.addrLine(f)], [null, ''], '🔴 a new pin: the old street / area are gone at once');
  assert.equal(C.applyGeocode(f, v1, GC.full), false, '🔴 A\'s late reply after the pin moved to B is discarded');
  assert.equal(C.addrLine(f), '');
  assert.equal(C.applyGeocode(f, v2, GC.areaOnly), true); assert.equal(C.addrLine(f), 'Col. Jardines del Valle', 'B\'s own reply applies');
  assert.equal(C.applyGeocode(f, v1, GC.full), false, 'released B then A: A never overwrites B'); assert.equal(C.addrLine(f), 'Col. Jardines del Valle');
  C.setPin(f, 15.53, -88.05, false); assert.equal(C.addrLine(f), '', 'confirmed → unconfirmed is a pin change too');
});

test('S2b-geo body (PLAN-colonia §1): a delivery order body carries address_area — RAW — only for the CONFIRMED pin\'s bound, non-empty area; never in the quote body or the cart signature', () => {
  const ctxO = ctxOf({ orderId: 'XP251025-120000-AAAA' });
  const f = ready(); C.chooseTip(f, 20);
  const sig0 = JSON.stringify(C.sigInput(f, ctxOf()));
  for (const pay of ['cash', 'online']) { f.pay = pay; assert.ok(!('address_area' in C.orderBody(f, ctxO)), `${pay}: pending ⇒ no key (submit never waits)`); }
  C.applyGeocode(f, f.pinV, GC.full);
  for (const pay of ['cash', 'online']) {
    f.pay = pay;
    assert.equal(C.orderBody(f, ctxO).address_area, 'Jardines del Valle', `🔴 ${pay}: the bound area rides the order body`);
    assert.ok(!('address_area' in C.quoteBody(f, ctxOf())) && !JSON.stringify(C.quoteBody(f, ctxOf())).includes('Jardines'), `${pay}: never in the quote body`);
  }
  assert.equal(JSON.stringify(C.sigInput(f, ctxOf())), sig0, '🔴 the order identity (cart signature) is EQUAL with and without the area');
  const raw = ready(); C.applyGeocode(raw, raw.pinV, [{ address_components: [{ long_name: 'Casa 14 Calle 3', types: ['neighborhood'] }] }]);
  assert.equal(C.orderBody(raw, ctxO).address_area, 'Casa 14 Calle 3', 'raw: the server filter is the only authority');
});

test('S2b-geo body: NO address_area when the area is superseded, empty (street only / none / failure), the pin unconfirmed, or the order is pickup', () => {
  const ctxO = ctxOf({ orderId: 'XP251025-120000-AAAA' });
  const moved = ready(); const v1 = moved.pinV; C.setPin(moved, moved.pin.lat + 0.01, moved.pin.lng, true); C.applyGeocode(moved, v1, GC.full);
  assert.ok(!('address_area' in C.orderBody(moved, ctxO)), '🔴 A\'s area never rides B\'s pin (superseded)');
  for (const r of [GC.routeOnly, GC.localityOnly, []]) { const f = ready(); C.applyGeocode(f, f.pinV, r); assert.ok(!('address_area' in C.orderBody(f, ctxO)), `empty area ⇒ no key (${JSON.stringify(r).slice(0, 60)})`); }
  const stale = ready(); stale.geo = { v: stale.pinV - 1, street: '', area: 'Jardines del Valle' };
  assert.ok(!('address_area' in C.orderBody(stale, ctxO)), '🔴 a geo bound to another version ⇒ no key');
  const un = ready(); C.setPin(un, un.pin.lat, un.pin.lng, false); un.geo = { v: un.pinV, street: '', area: 'Jardines del Valle' };
  assert.ok(!('address_area' in C.orderBody(un, ctxO)), '🔴 an unconfirmed pin ⇒ no key');
  const pk = ready(); C.applyGeocode(pk, pk.pinV, GC.full); C.setMode(pk, 'pickup');
  assert.ok(!('address_area' in C.orderBody(pk, ctxO)), '🔴 pickup ⇒ no key');
});
