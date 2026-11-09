// S2 — the order's total changes after the card hold: frames A–G of the owner-approved MOCKUP-capp-S2-adjustment r3 (owner rulings
// 11-07), driven by the contract's projection (CONTRACT-sdk-customer r4 §1.2–§1.4, via the strict test fake) and the advisor's rulings
// (11-08: bank_pending = E without the well; under_review = a calm notice, no button, OWNER-PENDING; G = one button; A = «Más información»).
// The expected markup is copied from the mockup (only data-act added; the 3DS caption dropped — it is an English annotation).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { payView, line, component, OUTCOMES } from './test/fake-sdk-pay.mjs';
const require = createRequire(import.meta.url);
const A = require('./capp-pay-adjust.js');

const STORE = 'La Musa', CARD = { brand: 'visa', last4: '4242' };
const consent = (outcome, o = {}) => ({ adjustment_id: 'adj-2', outcome, old_total_cents: 58500, new_total_cents: 62500, delta_cents: 4000, expires_at: 1762564980000, changes: [line('line_added', 'Agua Pura 600 ml', 4000)], ...o });
const INC = (outcome, o = {}, v = {}) => payView({ total_cents: 58500, card: CARD, consent: consent(outcome, o), ...v });
const DEC = (changes = [line('line_unavailable', 'Pan de ajo', -6500)]) => payView({ total_cents: 52000, revision: 1, card: CARD, notice: { kind: 'decrease', revision: 1, old_total_cents: 58500, new_total_cents: 52000, changes } });
const fr = (v, local = {}, status = 'preparing') => A.frameOf(v, status, local) || {};
const flat = (s) => String(s == null ? '' : s).replace(/>\s+</g, '><').trim();
const all = (v, local = {}, status = 'preparing') => { const f = fr(v, local, status); return { f, html: `${A.noticeHtml(v, f) || ''}${A.payHtml(v) || ''}${A.sheetHtml(v, f, local, STORE) || ''}` }; };
const INFO = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path></svg>';

test('the fake is no laxer than the contract: unknown keys, an outcome outside the closed enum, changes that do not add up — refused', () => {
  assert.throws(() => payView({ total_cents: 1, extra: 1 }), /key/);
  assert.throws(() => INC('approved'), /closed enum/);
  assert.throws(() => INC('pending', { token: 'T-1' }), /key the contract does not/);
  assert.throws(() => INC('pending', { changes: [line('line_added', 'X', 3000)] }), /do not add up/);
  assert.equal(OUTCOMES.length, 10);
});

test('dark: no view, a foreign version, a cancelled order ⇒ no frame and no markup (§1.3 precedence)', () => {
  for (const [v, st] of [[null, 'preparing'], [{ ...INC('pending'), v: 2 }, 'preparing'], [INC('pending'), 'cancelled'], [DEC(), 'cancelled']]) {
    const { f, html } = all(v, {}, st);
    assert.deepEqual([f.notice, f.sheet, f.statusSub], [null, null, null], `🔴 S2-dark: no adjustment frame (${st})`);
    assert.equal(`${A.noticeHtml(v, f)}${A.sheetHtml(v, f, {}, STORE)}`, '', `🔴 S2-dark: no adjustment markup (${st})`);
  }
});

test('A: a committed decrease — the mockup\'s notice; «Un producto no estaba disponible.» only from a server line_unavailable', () => {
  const v = DEC();
  const f = fr(v);
  assert.deepEqual([f.notice, f.sheet], ['decrease', null], '🔴 S2-A: a decrease draws the notice, no sheet');
  assert.equal(flat(A.noticeHtml(v, f)), flat(`<div class="notecard" role="status">${INFO}<div class="t"><b>Actualizamos tu total</b><p>Un producto no estaba disponible. Tu nuevo total es L 520 y es lo único que se te cobra.</p><button class="lnk" data-act="adj-more">Más información</button></div></div>`), '🔴 S2-A: the notice is the mockup\'s');
  assert.equal(flat(A.payHtml(v)), flat('<div class="receipt"><button class="toggle" aria-expanded="true">Pago <span>Visa ···· 4242</span><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg></button><div class="rbody"><div class="rrow tot"><span>Total</span><span class="r">L 520</span></div><p class="note">Se cobra al recibir tu pedido.</p></div></div>'), '🔴 S2-pay: the payment block is the mockup\'s');
  const removed = DEC([line('line_removed', 'Pan de ajo', -6500)]);
  assert.ok(!/no estaba disponible/.test(A.noticeHtml(removed, fr(removed))), '🔴 S2-A: a plain removal invents no reason');
  assert.equal(fr(DEC(), {}, 'delivered').notice, null, '§1.3: the notice only while the order is active');
});

test('B: «Más información» — the help sheet over A or C, the only place holds are explained; never over E or G', () => {
  const v = DEC(), f = fr(v, { help: true });
  assert.equal(f.sheet, 'help', '🔴 S2-B: help opens over A');
  assert.equal(flat(A.sheetHtml(v, f, {}, STORE)), flat('<div class="scrim" data-act="adj-ok"></div><div class="sheet" role="dialog" aria-label="¿Cómo funciona el cobro?"><div class="grab"></div><div class="errsheet"><div class="icon calm"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 10h18"></path></svg></div><h2>¿Cómo funciona el cobro?</h2><p>Al hacer tu pedido, tu banco reserva el monto en tu tarjeta. El cobro real se hace cuando recibís tu pedido, y solo por el total final (L 520).</p><p>Si el total cambia, tu banco puede mostrar por unos días un cargo pendiente por el monto anterior. No se cobra: el banco lo libera solo.</p><div class="acts"><button class="primary" data-act="adj-ok">Entendido</button></div></div></div>'), '🔴 S2-B: the help sheet is the mockup\'s');
  assert.equal(fr(INC('pending'), { help: true }).sheet, 'help', 'help opens over C');
  assert.equal(fr(INC('action_required'), { help: true }).sheet, 'verify', '🔴 S2-B: help never covers the bank verification');
  assert.equal(fr(INC('declined'), { help: true }).sheet, 'declined', '🔴 S2-B: help never covers G');
});

test('C: `pending` — the consent sheet: the restaurant (data), the change list, old → new, the card, the anchored countdown', () => {
  const v = INC('pending');
  const f = fr(v, { left: 180000 });
  assert.equal(f.sheet, 'consent', '🔴 S2-C: pending asks for consent');
  const h = flat(A.sheetHtml(v, f, { left: 180000 }, STORE));
  for (const s of ['aria-label="La Musa cambió tu pedido"', '<h2>La Musa cambió tu pedido</h2>', '<p>La Musa agregó esto a tu pedido. Revisalo antes de aceptar el nuevo total.</p>',
    '<div class="osum"><div class="sumrow"><span>+ Agua Pura 600 ml</span><span>L 40</span></div><div class="sumrow tot"><span>Total</span><span><span class="strike">L 585</span>L 625</span></div></div>',
    'Se cobra a tu Visa ···· 4242 al recibir tu pedido.', '<button class="primary" data-act="adj-accept">Aceptar nuevo total</button><button class="btn2 wide" data-act="adj-keep">Mantener mi pedido</button>',
    '<p class="cdown">Tenés 3 min para responder</p>']) assert.ok(h.includes(s), `🔴 S2-C: the consent sheet carries ${s}`);
  assert.ok(flat(A.sheetHtml(v, f, { left: 30000 }, STORE)).includes('Tenés 1 min para responder'), 'the countdown follows the anchored deadline, never below 1');
  assert.ok(flat(A.sheetHtml(v, f, {}, 'Café <b>Ocote</b>')).includes('<h2>Café &lt;b&gt;Ocote&lt;/b&gt; cambió tu pedido</h2>'), '🔴 S2-C: the restaurant is escaped data (brand-agnostic)');
  const noCard = payView({ total_cents: 58500, consent: consent('pending') });
  assert.ok(flat(A.sheetHtml(noCard, fr(noCard), {}, STORE)).includes('<p class="note">Se cobra al recibir tu pedido. <button'), '§4: no card ⇒ the copy without the label');
  const other = payView({ total_cents: 58500, card: { brand: 'other', last4: '0005' }, consent: consent('pending') });
  assert.ok(flat(A.sheetHtml(other, fr(other), {}, STORE)).includes('Se cobra a tu ···· 0005 al'), '§4: brand `other` ⇒ no brand word');
  const ro = fr(v, { readOnly: true });
  const hro = flat(A.sheetHtml(v, ro, { readOnly: true }, STORE));
  assert.ok(ro.sheet === 'consent' && !/data-act="adj-(accept|keep)"/.test(hro) && hro.includes('data-owner-pending="read_only"'), '🔴 S2-C-ro: a shared-link viewer sees the change without buttons (§3.2, OWNER-PENDING copy)');
});

test('C: every Change kind of §2 draws a row; the mockup draws only line_added — the rest are OWNER-PENDING rows (name + signed effect)', () => {
  const changes = [line('line_added', 'Agua', 4000, { config: 'Fría' }), line('line_removed', 'Pan', -6500), line('line_unavailable', 'Lasaña', -16000), line('line_qty', 'Pizza', 29500, { qty_old: 1, qty_new: 2 }), line('line_price', 'Té', 500), component('delivery', 4500, 6000), component('tip', 2000, 3000), component('discount', 0, 1000)];
  const delta = changes.reduce((s, c) => s + c.delta_cents, 0);
  const v = payView({ total_cents: 58500, consent: consent('pending', { new_total_cents: 58500 + delta, delta_cents: delta, changes }) });
  const rows = (flat(A.sheetHtml(v, fr(v), {}, STORE)).match(/<div class="sumrow">.*?<\/div>/g) || []);
  assert.deepEqual(rows, ['<div class="sumrow"><span>+ Agua · Fría</span><span>L 40</span></div>', '<div class="sumrow"><span>Pan</span><span>− L 65</span></div>', '<div class="sumrow"><span>Lasaña · no disponible</span><span>− L 160</span></div>',
    '<div class="sumrow"><span>Pizza</span><span>L 295</span></div>', '<div class="sumrow"><span>Té</span><span>L 5</span></div>', '<div class="sumrow"><span>Envío</span><span>L 15</span></div>', '<div class="sumrow"><span>Propina</span><span>L 10</span></div>', '<div class="sumrow"><span>Descuento</span><span>− L 10</span></div>'], '🔴 S2-C-changes: one row per Change, signed effect');
});

test('E: processing / bank_pending ⇒ E without the well; action_required ⇒ E with the SDK well (no buttons either way)', () => {
  const head = '<div class="scrim"></div><div class="sheet" role="dialog" aria-label="Verificando con tu banco" aria-live="polite"><div class="grab"></div><div class="errsheet"><i class="ring" aria-hidden="true"></i><h2>Verificando con tu banco…</h2><p>Tu banco pide confirmar el nuevo total. No cerrés la app.</p>';
  for (const [o, well] of [['processing', false], ['bank_pending', false], ['action_required', true]]) {
    const v = INC(o), f = fr(v);
    assert.deepEqual([f.sheet, f.well], ['verify', well], `🔴 S2-E: ${o} ⇒ E${well ? ' with' : ' without'} the well`);
    assert.equal(flat(A.sheetHtml(v, f, {}, STORE)), flat(head + (well ? '<div class="ph3ds" id="adj-3ds"></div>' : '') + '</div></div>'), `🔴 S2-E: ${o} ⇒ the mockup's sheet`);
  }
});

test('D: accepted ⇒ the status line only; the payment block at the committed total', () => {
  const v = INC('accepted', {}, { total_cents: 62500, revision: 1 }), f = fr(v);
  assert.deepEqual([f.statusSub, f.sheet, f.notice], ['Nuevo total aceptado', null, null], '🔴 S2-D: accepted ⇒ the status line only');
  assert.ok(flat(A.payHtml(v)).includes('<span class="r">L 625</span>'), 'the new total');
});

test('F: kept / expired / not_applied, the countdown at zero while still pending, and G dismissed ⇒ the line from total_cents', () => {
  const kept = (t) => flat(`<div class="closednote" role="status">${INFO}<span>Tu pedido sigue como estaba. Total ${t}.</span></div>`);
  for (const [why, v, local] of [['kept', INC('kept'), {}], ['expired', INC('expired'), {}], ['not_applied', INC('not_applied'), {}], ['left 0 while pending', INC('pending'), { left: 0 }], ['G dismissed', INC('declined'), { dismissed: { 'adj-2': true } }]]) {
    const f = fr(v, local);
    assert.deepEqual([f.notice, f.sheet], ['kept', null], `🔴 S2-F: ${why} ⇒ F, no sheet`);
    assert.equal(flat(A.noticeHtml(v, f)), kept('L 585'), `🔴 S2-F: ${why} ⇒ the mockup's line`);
  }
  const later = INC('kept', {}, { total_cents: 60000, revision: 2 });
  assert.equal(flat(A.noticeHtml(later, fr(later))), kept('L 600'), '🔴 S2-F-total: F always reads total_cents, never old_total_cents (§1.3)');
  assert.equal(fr(INC('declined'), { dismissed: { other: true } }).sheet, 'declined', 'dismissing is per adjustment');
});

test('G: declined ⇒ ONE button «Mantener mi pedido» (owner)', () => {
  const v = INC('declined'), f = fr(v);
  assert.equal(f.sheet, 'declined', '🔴 S2-G: declined draws G');
  assert.equal(flat(A.sheetHtml(v, f, {}, STORE)), flat('<div class="scrim"></div><div class="sheet" role="alertdialog" aria-label="No pudimos actualizar tu total"><div class="grab"></div><div class="errsheet"><div class="icon"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 10h18"></path><path d="M7 15h4"></path></svg></div><h2>No pudimos actualizar tu total</h2><p>Tu banco no autorizó el nuevo total. Tu pedido sigue como estaba (L 585).</p><div class="acts"><button class="primary" data-act="adj-keep">Mantener mi pedido</button></div></div></div>'), '🔴 S2-G: the mockup\'s sheet, one button');
});

test('R: under_review ⇒ a calm inline notice, NO button, no sheet (advisor 11-08; copy OWNER-PENDING, flagged in the markup)', () => {
  const v = INC('under_review'), f = fr(v);
  assert.deepEqual([f.notice, f.sheet], ['review', null], '🔴 S2-R: under_review ⇒ the calm notice, no sheet');
  const h = A.noticeHtml(v, f);
  assert.ok(/data-owner-pending="under_review"/.test(h) && !/<button/.test(h), '🔴 S2-R: no button; the placeholder is flagged');
});

test('terminal order: no consent UI (§1.3 precedence)', () => {
  for (const o of OUTCOMES) { const f = fr(INC(o), {}, 'delivered'); assert.deepEqual([f.sheet, f.notice, f.statusSub], [null, null, null], `🔴 S2-terminal: ${o} on a delivered order draws nothing`); }
});

test('the owner\'s copy rules across every outcome: no hold words outside B; no wallet; no second card', () => {
  const states = [[DEC(), {}], ...OUTCOMES.map((o) => [INC(o), {}])];
  for (const [v, local] of states) {
    const { html } = all(v, local);
    assert.ok(html.length > 0, 'premise: the frame drew');
    assert.ok(!/reserv|retenid|pendiente|bloque|hold/i.test(html), `🔴 S2-copy: no hold jargon outside «Más información» (${html.slice(0, 80)}…)`);
    assert.ok(!/apple pay|google pay|wallet|billetera/i.test(html), '🔴 S2-copy: no wallet affordance (§2.7)');
    assert.ok(!/Usar otra tarjeta/.test(html), '🔴 S2-copy: no second card (owner 11-07)');
  }
});
