// S2-checkout — the MARKUP of the owner-approved MOCKUP-capp-S2-sdk-checkout v7 (owner 11-08; the exact build target): 1 the
// payment row in the pay bar, 2 the chooser sheet, 3 «Agregar tarjeta» (its inputs come from an injected field host — advisor Q9:
// none without one), 4 / 4b the processing sheet, 5 the decline sheet (v2), 6 / 7 the gate wells (v2). The expected markup is the
// mockup's, with only data-act added (and frame 3's one inline style as a class). 4c is the SDK's own native challenge (contract
// §8, VENDOR): not DOM here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { listCards } from './test/fake-sdk-checkout.mjs';
const require = createRequire(import.meta.url);
const H = require('./capp-pay-checkout.js');
const P = require('./capp-pay-card.js');

const flat = (s) => String(s == null ? '' : s).replace(/>\s+</g, '><').trim();
const VISA = '<svg class="bb" viewBox="0 0 40 26" aria-hidden="true"><rect x=".5" y=".5" width="39" height="25" rx="4" fill="#FFFFFF" stroke="#D2D5DB"></rect><text x="20" y="17.6" text-anchor="middle" font-family="Red Hat Display, Arial, sans-serif" font-weight="800" font-style="italic" font-size="11.5" letter-spacing=".2" fill="#1A1F71">VISA</text></svg>';
const MC = '<svg class="bb" viewBox="0 0 40 26" aria-hidden="true"><rect x=".5" y=".5" width="39" height="25" rx="4" fill="#FFFFFF" stroke="#D2D5DB"></rect><circle cx="16" cy="13" r="7" fill="#EB001B"></circle><circle cx="24" cy="13" r="7" fill="#F79E1B" fill-opacity=".92"></circle></svg>';
const CARDS = P.cardsVm(listCards([{ card_id: 'c_v', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028, expired: false }, { card_id: 'c_m', brand: 'mastercard', last4: '8810', exp_month: 3, exp_year: 2027, expired: false }]));

test('1: the pay bar — the payment row (brand tile · label · chevron), the charge line + «Más información», «Hacer pedido · L X»', () => {
  const h = H.payBarHtml({ method: { kind: 'card', brand: 'visa', label: 'Visa ···· 4242' }, total_cents: 58500, cta: { label: 'Hacer pedido · L 585', enabled: true } });
  assert.equal(flat(h), flat(`<div class="paybar pay"><div class="urows"><button class="urow payrow" aria-label="Cambiar forma de pago" data-act="paysheet">${VISA}<span class="t"><b>Visa ···· 4242</b></span><svg class="i chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></button></div><p class="payline"><span>Total L 585 · Se cobra al recibir tu pedido.</span><button class="lnk" data-act="adj-more">Más información</button></p><button class="primary" data-act="place">Hacer pedido · L 585</button></div>`), '🔴 CO-1: the mockup\'s pay bar');
  assert.ok(flat(H.payBarHtml({ method: { kind: 'card', brand: 'visa', label: 'Visa ···· 4242' }, total_cents: 58500, cta: { label: 'Elegí cómo pagar', enabled: false } })).includes('<button class="primary" data-act="place" disabled>Elegí cómo pagar</button>'), 'a disabled primary names the step');
  const none = flat(H.payBarHtml({ method: null, total_cents: 58500, cta: { label: 'Elegí cómo pagar', enabled: false } }));
  assert.ok(!none.includes('urow payrow') && !none.includes('payline'), '🔴 CO-1: no method (6 / 7) ⇒ no row, no charge line — the gate well stands in');
});

test('2: the chooser sheet — ✕, the saved cards (tile, label, expiry, a checkmark on the selected), «Agregar tarjeta», «Efectivo al entregar» for members where allowed', () => {
  const h = H.chooserHtml({ cards: CARDS, selected: { kind: 'card', card_id: 'c_v' }, cash: true });
  assert.equal(flat(h), flat(`<div class="scrim" data-act="paysheet-close"></div><div class="sheet" role="dialog" aria-label="Elegí cómo pagar"><div class="grab"></div>
    <div class="topbar"><button class="iconbtn" aria-label="Cerrar" data-act="paysheet-close"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"></path><path d="M18 6L6 18"></path></svg></button><h2>Elegí cómo pagar</h2><span class="sp"></span></div>
    <div class="body"><div class="urows">
      <button class="urow" aria-pressed="true" data-act="paypick" data-card="c_v">${VISA}<span class="t"><b>Visa ···· 4242</b><span>Vence 12/28</span></span><svg class="i tick" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"></path></svg></button>
      <button class="urow" aria-pressed="false" data-act="paypick" data-card="c_m">${MC}<span class="t"><b>Mastercard ···· 8810</b><span>Vence 03/27</span></span></button>
      <button class="urow" data-act="addcard"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg><span class="t"><b>Agregar tarjeta</b></span></button>
      <button class="urow" aria-pressed="false" data-act="paypick" data-card="cash"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"></rect><circle cx="12" cy="12" r="2.5"></circle><path d="M6 9h.01M18 15h.01"></path></svg><span class="t"><b>Efectivo al entregar</b><span>Pagás cuando llegue tu pedido.</span></span></button>
    </div></div></div>`), '🔴 CO-2: the mockup\'s chooser');
  const g = flat(H.chooserHtml({ cards: { rows: [], selected: null }, selected: null, cash: false }));
  assert.ok(!g.includes('Efectivo al entregar'), '🔴 CO-2: no cash row for a guest / a store without cash');
  const ex = flat(H.chooserHtml({ cards: P.cardsVm(listCards([{ card_id: 'c_x', brand: 'visa', last4: '4242', exp_month: 10, exp_year: 2026, expired: true }])), selected: null, cash: true }));
  assert.ok(/data-card="c_x" disabled/.test(ex) && ex.includes('<span>Venció en 10/26</span>'), '🔴 CO-2: an expired card is shown, not selectable');
});

test('3: «Agregar tarjeta» — the back arrow, the stacked fields from the injected field host (brand tile in the número field, the CVV ⓘ), the save toggle (members), the lock note, ONE pinned «Guardar tarjeta» disabled until valid', () => {
  const host = { input: (f) => ({ number: '<input id="c-num" inputmode="numeric" autocomplete="cc-number">', expiry: '<input id="c-exp" inputmode="numeric" autocomplete="cc-exp" placeholder="MM / AA">', cvv: '<input id="c-cvv" inputmode="numeric" autocomplete="cc-csc" placeholder="3 dígitos">', name: '<input id="c-name" autocomplete="cc-name" placeholder="Como aparece en la tarjeta">' })[f] };
  const fv = P.formVm({ number: { state: 'valid', brand: 'visa' }, expiry: { state: 'invalid', touched: true }, cvv: { state: 'empty' }, name: { state: 'valid' } }, { member: true });
  const h = flat(H.formHtml(fv, host));
  assert.ok(h.startsWith(flat('<div class="flow px"><div class="flowbar"><button class="iconbtn" aria-label="Volver" data-act="addcard-back"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5"></path><path d="M11 18l-6-6 6-6"></path></svg></button></div><h1 class="flowtitle">Agregar tarjeta</h1>')), '🔴 CO-3: the back arrow (owner 11-08), the title');
  assert.ok(h.includes(flat(`<div class="fld brand"><label for="c-num">Número de tarjeta</label><input id="c-num" inputmode="numeric" autocomplete="cc-number">${VISA}</div>`)), '🔴 CO-3: the brand tile inside the número field');
  assert.ok(h.includes(flat('<div class="fld bad"><label for="c-exp">Vencimiento</label><input id="c-exp" inputmode="numeric" autocomplete="cc-exp" placeholder="MM / AA" aria-invalid="true" aria-describedby="c-exp-err"><div class="err" id="c-exp-err" role="alert"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5"></path><path d="M12 16h.01"></path></svg><span>Revisá la fecha de vencimiento</span></div></div>')), '🔴 CO-3: the field error, v6 language');
  assert.ok(h.includes('<label for="c-cvv">CVV<button class="infobtn" aria-label="Qué es el CVV" data-act="cvv-info">'), 'the CVV ⓘ');
  assert.ok(h.includes('<div class="togrow"><span class="t">Guardar tarjeta para la próxima</span><button class="switch" role="switch" aria-checked="true" aria-label="Guardar tarjeta para la próxima" data-act="savecard"></button></div>'), '🔴 CO-3: the save toggle ON (owner ruling 2)');
  assert.ok(h.includes('<span>Tus datos van cifrados directo al banco. Solo guardamos los últimos 4 dígitos.</span>'), 'the lock note');
  assert.ok(h.endsWith(flat('<div class="paybar"><button class="primary" data-act="addcard-save" disabled>Guardar tarjeta</button></div></div>')), '🔴 CO-3: ONE pinned «Guardar tarjeta», disabled until valid');
  assert.ok(!flat(H.formHtml(P.formVm({}, { member: false }), host)).includes('togrow'), '🔴 CO-3: no save toggle for a guest');
  const none = flat(H.formHtml(fv, null));
  assert.ok(!/<input/.test(none), '🔴 CO-3: no field host ⇒ no inputs in the webview (advisor Q9)');
});

test('4 / 4b: the processing sheet — the large ring, «Procesando tu pago…», the amount, the card line, the calm line; 4b adds the owner\'s under_review line', () => {
  const four = '<div class="sheet proc" role="dialog" aria-label="Procesando tu pago" aria-live="polite"><div class="grab"></div><i class="ring lg" aria-hidden="true"></i><h2>Procesando tu pago…</h2><div><div class="amt">L 585</div><div class="cardl">' + VISA + '<span>Visa ···· 4242</span></div></div><p class="note">Esto toma unos segundos. No cerrés la app.</p>';
  assert.equal(flat(H.procHtml({ total_cents: 58500, card: { brand: 'visa', label: 'Visa ···· 4242' }, review: false })), flat(`<div class="scrim"></div>${four}</div>`), '🔴 CO-4: the mockup\'s sheet');
  assert.equal(flat(H.procHtml({ total_cents: 58500, card: { brand: 'visa', label: 'Visa ···· 4242' }, review: true })), flat(`<div class="scrim"></div>${four}<p class="note review">Estamos confirmando tu pago con el banco. Te avisamos en cuanto esté listo.</p></div>`), '🔴 CO-4b: + the under_review line');
  assert.ok(!/<button/.test(H.procHtml({ total_cents: 1, card: null, review: true })), 'no buttons (nothing to do but wait)');
});

test('5: the decline sheet (v2, owner preference) — per bucket, «Probar otra tarjeta» + «Pagar en efectivo» for a member where allowed; a guest one button', () => {
  const s = (b, ctx) => flat(H.declineHtml(P.nextStep(P.readPlacement({ outcome: 'declined', order_id: 'o', attempt_id: 'a', decline: b, pay_deadline_at: 1 }), ctx), ctx));
  assert.equal(s('retryable', { guest: false, cashAllowed: true }), flat('<div class="scrim"></div><div class="sheet" role="alertdialog" aria-label="Tu banco no autorizó el pago"><div class="grab"></div><div class="errsheet"><div class="icon"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 10h18"></path><path d="M7 15h4"></path></svg></div><h2>Tu banco no autorizó el pago</h2><p>Parece que la tarjeta no tiene fondos suficientes. Podés probar otra tarjeta o pagar en efectivo; tu pedido sigue igual.</p><div class="acts"><button class="primary" data-act="decl-other_card">Probar otra tarjeta</button><button class="btn2 wide" data-act="decl-cash">Pagar en efectivo</button></div></div></div>'), '🔴 CO-5: the mockup\'s sheet');
  const g = s('retryable', { guest: true, cashAllowed: true });
  assert.ok(g.includes('<p>Parece que la tarjeta no tiene fondos suficientes. Podés probar con otra tarjeta; tu pedido sigue igual.</p>') && !g.includes('decl-cash'), '🔴 CO-5: a guest — one button, no cash');
  assert.ok(s('wrong_data', { guest: false, cashAllowed: true }).includes('<h2>Revisá los datos de la tarjeta</h2>') && s('wrong_data', { guest: false, cashAllowed: true }).includes('<button class="primary" data-act="decl-fix">Corregir datos</button>'), 'wrong data');
});

test('6 / 7 in the pay bar (v7 frames 6, 7): the expired card\'s row dimmed with «Venció en», then the well, then the disabled «Elegí cómo pagar»; 7 the well alone', () => {
  const ctx = { guest: false, cashAllowed: true };
  const six = flat(H.payBarHtml({ method: { kind: 'card', brand: 'visa', label: 'Visa ···· 4242', sub: 'Venció en 10/26', dim: true }, total_cents: 58500, cta: { label: 'Elegí cómo pagar', enabled: false }, gate: H.gateHtml('token_expired', ctx) }));
  assert.equal(six, flat(`<div class="paybar pay"><div class="urows"><button class="urow payrow dim" aria-label="Cambiar forma de pago" data-act="paysheet">${VISA}<span class="t"><b>Visa ···· 4242</b><span>Venció en 10/26</span></span><svg class="i chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></button></div>${H.gateHtml('token_expired', ctx)}<button class="primary" data-act="place" disabled>Elegí cómo pagar</button></div>`), '🔴 CO-6-bar: frame 6\'s bar (no charge line under a well)');
  const seven = flat(H.payBarHtml({ method: null, total_cents: 58500, cta: { label: 'Elegí cómo pagar', enabled: false }, gate: H.gateHtml('unavailable', ctx) }));
  assert.equal(seven, flat(`<div class="paybar pay">${H.gateHtml('unavailable', ctx)}<button class="primary" data-act="place" disabled>Elegí cómo pagar</button></div>`), '🔴 CO-7-bar: frame 7\'s bar');
  assert.ok(flat(H.payBarHtml({ method: null, total_cents: 1, cta: { label: 'x', enabled: true, act: 'confirm', id: 'cta' } })).includes('<button class="primary" id="cta" data-act="confirm">x</button>'), 'the host\'s primary hooks (id, act)');
});

test('6 / 7: the gate wells (v2, owner preference) — expired saved card; card payment unavailable (member: cash; guest: «Reintentar»)', () => {
  assert.equal(flat(H.gateHtml('token_expired', { guest: false, cashAllowed: true })), flat('<div class="gate" role="status"><b>Tu tarjeta guardada venció</b><span class="note">Agregá una tarjeta para pagar en línea, o pagá en efectivo al recibir tu pedido.</span><div class="row2"><button class="btn2 dark" data-act="addcard">Agregar tarjeta</button><button class="btn2" data-act="decl-cash">Pagar en efectivo</button></div></div>'), '🔴 CO-6: the mockup\'s well');
  assert.equal(flat(H.gateHtml('unavailable', { guest: false, cashAllowed: true })), flat('<div class="gate" role="status"><b>El pago con tarjeta no está disponible ahora</b><span class="note">Podés pagar en efectivo al recibir tu pedido. Todo lo demás sigue igual.</span><div class="row2"><button class="btn2 dark" data-act="decl-cash">Pagar en efectivo</button></div></div>'), '🔴 CO-7: the mockup\'s well');
  const g = flat(H.gateHtml('unavailable', { guest: true, cashAllowed: true }));
  assert.ok(g.includes('<span class="note">Intentá de nuevo en unos minutos. Tu pedido queda guardado.</span>') && g.includes('<button class="btn2 dark" data-act="sdk-retry">Reintentar</button>') && !g.includes('efectivo'), '🔴 CO-7: a guest — «Reintentar», never cash');
  assert.ok(!flat(H.gateHtml('token_expired', { guest: false, cashAllowed: false })).includes('decl-cash'), 'no cash where the store has none');
});

test('brand tiles: the mockup\'s Visa and Mastercard; any other brand gets the plain card icon (no invented logo); text is escaped', () => {
  assert.equal(H.brandTile('visa'), VISA); assert.equal(H.brandTile('mastercard'), MC);
  for (const b of ['amex', 'other', null]) assert.ok(H.brandTile(b).startsWith('<svg class="i"') && !/text-anchor/.test(H.brandTile(b)), `🔴 CO-tile: ${b} ⇒ the plain card icon`);
  assert.ok(flat(H.payBarHtml({ method: { kind: 'card', brand: 'visa', label: '<b>x</b>' }, total_cents: 1, cta: { label: 'a', enabled: true } })).includes('<b>&lt;b&gt;x&lt;/b&gt;</b>'), 'escaped');
});
