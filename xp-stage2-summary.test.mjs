// HOTFIX — X. Pizza's pay-step summary ("Resumen del pedido", renderStage2Summary) must show each pizza's extras and price
// them. Run: node xp-stage2-summary.test.mjs
//
// X. Pizza keeps extras PER PIZZA INSTANCE (pizzaExtras[key] = { 0: {extraId: 1}, 1: {…} }). The summary read that object
// as a flat {extraId: qty} map, so it showed NO extras and left them out of the line subtotal while the Total included
// them: 2× Carnivora with Pepperoni on pizza 1 rendered "2x Carnivora L 680 · Total L 730" (display only — the charge is
// server-priced and the order text serializes per instance).
//
// Every cart here comes out of the REAL booted form (chg / toggleDetailExtra); the summary is compared with the form's own
// cart review (updateCartReviewBody — the format the fix mirrors) and with calcTotal (the pricing it must add up to). The
// sensitivity cell boots the SAME form and swaps in the PRE-FIX function, read from git at the base (207170e).
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { counter, settle, envelope, loadForm, res, BRAND, closeAll } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { computeServerTotal } = require('./menu-pricing');
const { ok } = counter();
const XP = 'xpizza-orders', LM = 'la-musa-orders';
const CARN = 2, MOZZ = 'e4', PEPP = 'e7';

async function boot(dir) {
  const B = BRAND[dir];
  const w = loadForm(dir);
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
    if (url.includes('quoteOrder')) {   // priced like the server prices it
      const q = JSON.parse((init && init.body) || '{}');
      const t = computeServerTotal(q.items, B.rid);
      return res(t.error ? { ok: false } : { ok: true, total_cents: Math.round(t.total * 100) });
    }
    return new Promise(() => {});
  };
  await settle();
  return w;
}
const money = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
// what the pay step SHOWS
function summary(w) {
  w.renderStage2Summary();
  const box = w.document.getElementById('s2-summary');
  const rows = [...box.querySelectorAll('.review-item')].map((el) => ({
    name: el.querySelector('.review-item-name').textContent.trim(),
    extras: [...el.querySelectorAll('.review-item-extras')].map((x) => x.textContent.trim()),
    price: money(el.querySelector('.review-item-price').textContent),
  }));
  return { dishes: rows.filter((r) => /^\d+x /.test(r.name)), envio: rows.filter((r) => r.name === 'Envío'), total: money(box.querySelector('.review-total span:last-child').textContent) };
}
// what the cart review SHOWS (the format the fix mirrors)
function cartReview(w) {
  w.updateCartReviewBody();
  return [...w.document.querySelectorAll('.cart-review-item')].filter((el) => el.querySelector('[data-act="review-open"]')).map((el) => ({
    extras: [...el.querySelectorAll('.cart-review-item-extras')].map((x) => x.textContent.trim()),
    price: money(el.querySelector('.cart-review-item-price').textContent),
  }));
}
const sum = (xs) => xs.reduce((a, r) => a + r.price, 0);
const extraName = (w, id) => w.eval('EXTRAS').find((e) => e.id === id).name;

// the cart cells, each built through the form's own writers
const CELLS = [
  { name: '2× Carnivora, an extra on pizza 1', build: (w) => { w.chg(CARN, 2); w.toggleDetailExtra(PEPP, CARN, 0); }, extras: (w) => [`+ Pizza 1: ${extraName(w, PEPP)}`] },
  { name: '2× Carnivora, an extra on pizza 2 only', build: (w) => { w.chg(CARN, 2); w.toggleDetailExtra(MOZZ, CARN, 1); }, extras: (w) => [`+ Pizza 2: ${extraName(w, MOZZ)}`] },
  { name: '2× Carnivora, extras on BOTH pizzas', build: (w) => { w.chg(CARN, 2); w.toggleDetailExtra(PEPP, CARN, 0); w.toggleDetailExtra(MOZZ, CARN, 1); w.toggleDetailExtra(PEPP, CARN, 1); },
    extras: null },   // two pizzas listed; the names' order inside pizza 2 is the instance object's own order — compared with the cart review
  { name: 'qty 1 with an extra (no "Pizza n:" prefix)', build: (w) => { w.chg(CARN, 1); w.toggleDetailExtra(PEPP, CARN, 0); }, extras: (w) => [`+ ${extraName(w, PEPP)}`] },
  { name: 'no extras', build: (w) => { w.chg(CARN, 2); }, extras: () => [] },
];

async function runCell(w, c, { orderType = 'pickup' } = {}) {
  c.build(w); await settle();
  if (orderType === 'delivery' && typeof w.setOrderType === 'function') { w.setOrderType('delivery'); await settle(); }
  w.requestServerQuote(); await settle();
  return { s: summary(w), review: cartReview(w), calc: w.calcTotal() };
}

// ═════════ the fix: each pizza's extras shown, priced, and the lines add up ═════════
for (const c of CELLS) {
  const w = await boot(XP);
  const { s, review, calc } = await runCell(w, c);
  assert.strictEqual(s.dishes.length, 1, `${c.name}: one dish line`);
  const pizzaExtras = JSON.parse(JSON.stringify(w.eval('pizzaExtras')[CARN] || {}));
  // the instance keys the form holds name the pizzas the summary must list (an extra-less pizza lists nothing)
  const want = c.extras ? c.extras(w) : null;
  if (!want) {   // order of names inside one pizza is the instance object's own order (as the cart review)
    assert.deepStrictEqual(s.dishes[0].extras, review[0].extras, `🔴 ${c.name}: the summary lists the pizzas exactly as the cart review (${JSON.stringify(s.dishes[0].extras)} vs ${JSON.stringify(review[0].extras)})`);
    assert.strictEqual(s.dishes[0].extras.length, 2, `${c.name}: both pizzas listed`);
  } else assert.deepStrictEqual(s.dishes[0].extras, want, `🔴 ${c.name}: extras shown per pizza (${JSON.stringify(s.dishes[0].extras)}; pizzaExtras ${JSON.stringify(pizzaExtras)})`);
  assert.deepStrictEqual(s.dishes[0].extras, review[0].extras, `🔴 ${c.name}: the same per-pizza lines as the cart review`);
  assert.strictEqual(s.dishes[0].price, review[0].price, `🔴 ${c.name}: the same line price as the cart review`);
  assert.strictEqual(sum(s.dishes), calc, `🔴 ${c.name}: Σ lines (${sum(s.dishes)}) == calcTotal (${calc})`);
  assert.strictEqual(sum(s.dishes) + sum(s.envio), s.total, `🔴 ${c.name}: Σ lines + Envío (${sum(s.dishes)} + ${sum(s.envio)}) == the displayed Total (${s.total})`);
  ok(`X. Pizza — ${c.name}: ${JSON.stringify(s.dishes[0])}; Σ lines == calcTotal == Total (L ${s.total}) — matches the cart review`);
  closeAll();
}
// the reproduced case, in numbers: 2× Carnivora + Pepperoni on pizza 1 → the line carries the extra (was L 680 / Total L 730)
{
  const w = await boot(XP);
  const { s } = await runCell(w, CELLS[0]);
  const carn = w.eval('MENU').find((p) => p.id === CARN), pep = w.eval('EXTRAS').find((e) => e.id === PEPP);
  assert.strictEqual(s.dishes[0].price, 2 * carn.price + pep.price, `🔴 2× ${carn.name} + ${pep.name}: line = 2×${carn.price} + ${pep.price}`);
  assert.strictEqual(s.total, 2 * carn.price + pep.price);
  ok(`the reproduced case: "2x ${carn.name}" + "Pizza 1: ${pep.name}" — line L ${s.dishes[0].price} == Total L ${s.total} (was L ${2 * carn.price} vs L ${s.total})`);
  closeAll();
}
// delivery: the Envío row (Gratis) adds nothing, the lines still add up to the Total
{
  const w = await boot(XP);
  w.eval("orderType='delivery'");
  const { s } = await runCell(w, CELLS[1]);
  assert.strictEqual(s.envio.length, 1, 'premise — delivery shows the Envío row');
  assert.strictEqual(sum(s.dishes) + sum(s.envio), s.total, `🔴 delivery: Σ lines + Envío == Total (${sum(s.dishes)} + ${sum(s.envio)} vs ${s.total})`);
  ok(`delivery: Σ lines + Envío (Gratis) == Total (L ${s.total})`);
  closeAll();
}

// ═════════ sensitivity: the PRE-FIX function (from git, the base) in the same booted form → RED ═════════
{
  const base = execFileSync('git', ['show', '207170e:xpizza-orders/index.html'], { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8', maxBuffer: 64 << 20 });
  const i = base.indexOf('function renderStage2Summary(){'); assert.ok(i > 0, 'premise — the base has the function');
  let d = 0, j = i; for (; j < base.length; j++) { if (base[j] === '{') d++; else if (base[j] === '}') { d--; if (d === 0) break; } }
  const old = base.slice(i, j + 1);
  assert.ok(old.includes('const extras=pizzaExtras[p.id]||{};'), 'premise — the base reads the per-instance map as flat');
  const w = await boot(XP);
  w.eval(old);   // a global function declaration: replaces the page's renderStage2Summary
  const { s, calc } = await runCell(w, CELLS[0]);
  assert.deepStrictEqual(s.dishes[0].extras, [], 'mutant premise — the old read shows no extras');
  assert.notStrictEqual(sum(s.dishes), calc, '🔴 must be RED under the old read: Σ lines != calcTotal');
  assert.notStrictEqual(sum(s.dishes), s.total, '🔴 must be RED under the old read: the lines do not add up to the Total');
  ok(`MUTANT (the pre-fix read, from git 207170e): no extras shown, Σ lines L ${sum(s.dishes)} != Total L ${s.total} — RED, as reproduced`);
  closeAll();
}

// ═════════ La Musa control: its line-level copy is untouched and still adds up ═════════
{
  const w = await boot(LM);
  const dish = w.eval('MENU').find((p) => !(p.group) && p.id && !p.soldOut);
  w.chg(dish.id, 2); await settle();
  w.requestServerQuote(); await settle();
  const s = summary(w);
  assert.strictEqual(sum(s.dishes) + sum(s.envio), s.total, `La Musa control: Σ lines + Envío == Total (${sum(s.dishes)} vs ${s.total})`);
  ok(`La Musa control (not changed): Σ lines == Total (L ${s.total})`);
  closeAll();
}
console.log('\nxp-stage2-summary: OK');
process.exit(0);
