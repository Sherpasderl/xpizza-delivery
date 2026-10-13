// Per-product extras — PICKER SLICE (PLAN-picker-extras rev 2.2; approved mockup v3/v4 screen 6). Run: node picker-extras.test.mjs
// X. Pizza's required-choice picker offers the CHOSEN choice's extras (extrasOfferedFor — the same set its own modal shows),
// as native checkboxes; the button totals the choice + the staged extras; the add puts those extras on the NEW pizza only.
// Money is checked as codex asked: with an existing cart, server total AFTER − server total BEFORE = the button's total.
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { loadForm, settle, serve, envelope, closeAll, counter, BRAND } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { computeServerTotal } = require('./menu-pricing');
const { ok } = counter();
const DIR = 'xpizza-orders';
const B = BRAND[DIR];
const L = 30, ROJA = 31, VODKA = 32, COMB = 33;
const MOZZ = 'e4', PEPP = 'e7';

function withGroup(w, { extrasPolicy, mutate } = {}) {
  const m = B.menu(w);
  const pol = extrasPolicy ? { extras_policy: extrasPolicy } : {};
  m.dishes.push({ id: L, cat: 'ny', name: 'NY Plain Slice', price: 624, emoji: '🍕', color: '#C8321A',
    desc: 'La clásica NY Plain Slice - 6 slices, queso mozzarella, salsa de tu elección.', ...pol });
  [['Salsa Roja', ROJA], ['Salsa Vodka', VODKA], ['Combinada', COMB]].forEach(([choice, id]) => {
    m.dishes.push({ id, cat: 'ny', name: `NY Plain Slice - ${choice}`, price: 624, variantOf: L, choice, ...pol, ...(id === COMB ? { tags: ['recommended'] } : {}) });
  });
  m.variant_items = { [String(L)]: { label: 'Salsa', basePrice: 624, variantIds: [ROJA, VODKA, COMB] } };
  if (mutate) mutate(m);
  return m;
}
const $ = (w, id) => w.document.getElementById(id);
const ctaText = (w) => $(w, 'detail-cta').textContent.replace(/\s+/g, ' ').trim();
const ctaTotal = (w) => Number((ctaText(w).match(/L\s*([0-9]+)/) || [])[1]);
const stagedInputs = (w) => [...$(w, 'detail-scroll').querySelectorAll('.staged-extra-input')];
const stagedIds = (w) => stagedInputs(w).map((i) => i.value);
const modalExtraIds = (w) => [...$(w, 'detail-scroll').querySelectorAll('[data-act="extra"]')].filter((r) => r.getAttribute('data-inst') === '0').map((r) => r.getAttribute('data-eid'));
const G = (w, name) => w.eval(name);
// the server prices from the PUBLISHED catalog (here: the served snapshot), keyed as X. Pizza prices — by name
const tablesOf = (w) => ({ restaurantId: 'x_pizza',
  menu: Object.fromEntries(G(w, 'MENU').filter((d) => d.price > 0).map((d) => [d.name, d.price])),
  extras: Object.fromEntries(G(w, 'EXTRAS').map((e) => [e.name, e.price])) });
const serverTotal = (w) => {
  const items = JSON.parse(JSON.stringify(w.redeemCartItems()));
  if (!items.length) return 0;
  const t = computeServerTotal(items, 'x_pizza', tablesOf(w));
  assert.ok(!t.error, `premise: the server prices the cart (${t.error})`);
  return t.total;
};
async function boot(opts) { const w = loadForm(DIR); await settle(); await serve(w, envelope(B.rid, withGroup(w, opts))); return w; }
async function pick(w, vid) { const r = $(w, 'detail-scroll').querySelector(`.detail-variant-row[data-id="${vid}"]`); r.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await settle(); }
async function tick(w, eid) { const i = stagedInputs(w).find((x) => x.value === eid); i.click(); await settle(); }   // a real click on the native checkbox → change

// ── 1. no extras before a choice; after it, exactly the chosen choice's own set, as native checkboxes ──
{
  const w = await boot();
  w.openDetailModal(L); await settle();
  assert.deepStrictEqual(stagedIds(w), [], 'nothing chosen → no extras');
  assert.strictEqual(ctaText(w), 'Elegí tu salsa');
  await pick(w, COMB);
  const shown = stagedIds(w);
  const offered = JSON.parse(JSON.stringify(G(w, 'extrasOfferedFor')(G(w, 'MENU').find((p) => p.id === COMB)).flatMap((g) => g.extras.map((e) => String(e.id)))));   // out of the page's realm
  assert.deepStrictEqual(shown, offered, 'after a choice: exactly extrasOfferedFor(the chosen choice), in order');
  assert.strictEqual(shown.length, G(w, 'EXTRAS').length, 'X. Pizza today: every extra (14), sauces included');
  assert.ok(stagedInputs(w).every((i) => i.type === 'checkbox' && i.closest('label.detail-extras-row')), 'each is a native checkbox inside its row label');
  // the same set the chosen choice's own modal shows when reopened from the cart
  w.closeDetailModal(); await settle(); w.chg(COMB, 1); await settle(); w.openDetailModal(COMB); await settle();
  assert.deepStrictEqual(modalExtraIds(w), shown, '🔴 the picker and the reopened line offer the SAME extras');
  ok('picker: no extras before a choice; after it, exactly the chosen choice\'s extrasOfferedFor (= its reopened modal), as native checkboxes');
}
// ── 2. extras_policy 'none' → no extras in the picker ──
{
  const w = await boot({ extrasPolicy: 'none' });
  w.openDetailModal(L); await settle(); await pick(w, COMB);
  assert.deepStrictEqual(stagedIds(w), [], "extras_policy 'none' → no extras");
  assert.strictEqual(ctaText(w), 'Agregar · L 624');
  ok("picker: extras_policy 'none' offers no extras");
}
// ── 3. the button totals the choice + staged extras; the add lands them on the NEW pizza only; Δ server total = the button ──
{
  const w = await boot();
  w.chg(2, 1); w.toggleDetailExtra(PEPP, 2, 0); await settle();               // an existing cart: a Carnivora with Pepperoni
  const before = serverTotal(w);
  w.openDetailModal(L); await settle(); await pick(w, COMB);
  await tick(w, MOZZ); await tick(w, PEPP);
  assert.strictEqual(ctaTotal(w), 724, 'the button: L 624 + Mozzarella 50 + Pepperoni 50');
  await tick(w, PEPP);
  assert.strictEqual(ctaTotal(w), 674, 'untick → L 674');
  const cta1 = ctaTotal(w);
  w.detailCtaTap(); await settle();
  assert.strictEqual(serverTotal(w) - before, cta1, '🔴 Δ server total = the button (first add)');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(G(w, 'pizzaExtras')[COMB])), { 0: { [MOZZ]: 1 } }, 'the extras sit on the new pizza');
  // the same choice again, different extras → pizza 2; pizza 1 untouched
  const before2 = serverTotal(w);
  w.openDetailModal(L); await settle(); await pick(w, COMB); await tick(w, PEPP);
  const cta2 = ctaTotal(w);
  w.detailCtaTap(); await settle();
  assert.strictEqual(serverTotal(w) - before2, cta2, '🔴 Δ server total = the button (second add of the same choice)');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(G(w, 'pizzaExtras')[COMB])), { 0: { [MOZZ]: 1 }, 1: { [PEPP]: 1 } }, 'pizza 1 keeps Mozzarella, pizza 2 has Pepperoni');
  // a third add with NOTHING staged: a plain pizza 3 (a full replace, even when empty)
  w.openDetailModal(L); await settle(); await pick(w, COMB); w.detailCtaTap(); await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(G(w, 'pizzaExtras')[COMB]))[2], {}, 'an empty staging → a plain new pizza');
  // the cart shows them per pizza
  w.updateCartReviewBody();
  const ex = [...w.document.querySelectorAll('.cart-review-item')].find((el) => /Combinada/.test(el.textContent)).querySelectorAll('.cart-review-item-extras');
  assert.deepStrictEqual([...ex].map((e) => e.textContent), ['+ Pizza 1: Mozzarella', '+ Pizza 2: Pepperoni']);
  ok('picker: the button totals choice + staged extras; each add puts them on the NEW pizza only (an empty staging = a plain pizza); Δ server total = the button');
}
// ── 4. a refused add writes nothing; a cancelled staging changes nothing; switching choice keeps the staged extras ──
{
  const w = await boot();
  w.openDetailModal(L); await settle(); await pick(w, COMB); await tick(w, MOZZ);
  await pick(w, VODKA);
  assert.deepStrictEqual(stagedInputs(w).filter((i) => i.checked).map((i) => i.value), [MOZZ], 'switching salsa keeps the staged extras');
  w.closeDetailModal(); await settle();
  assert.strictEqual(w.calcTotal(), 0, 'cancelled staging: nothing added');
  assert.ok(!G(w, 'pizzaExtras')[VODKA] && !G(w, 'pizzaExtras')[COMB], 'cancelled staging: no extras written');
  w.openDetailModal(L); await settle();
  assert.deepStrictEqual(stagedIds(w), [], 'a fresh open starts with nothing staged');
  await pick(w, COMB); await tick(w, MOZZ);
  w.eval(`soldOutById = (id) => id === ${COMB}`);   // the choice sells out before the add
  w.eval(`isSoldOut = (d) => !!d && d.id === ${COMB}`);
  w.detailCtaTap(); await settle();
  assert.strictEqual(G(w, 'qty')[COMB] || 0, 0, 'premise: the add was refused');
  assert.ok(!G(w, 'pizzaExtras')[COMB], '🔴 a refused add writes no extras');
  ok('picker: switching salsa keeps staged extras; a cancelled staging and a refused add write nothing');
}
// ── 5. keyboard + focus: Space on a focused extra toggles it, focus stays on it after the re-render; capture at staging ──
{
  const w = await boot();
  const noted = []; w.eval('(() => { const real = CART.noteExtra.bind(CART); CART.noteExtra = (ex) => { window.__noted = (window.__noted || []).concat(ex.id); return real(ex); }; })()');
  w.openDetailModal(L); await settle(); await pick(w, COMB);
  const inp = stagedInputs(w).find((i) => i.value === MOZZ);
  inp.focus(); inp.click(); await settle();        // Space on a focused checkbox = a click on it
  const again = stagedInputs(w).find((i) => i.value === MOZZ);
  assert.ok(again.checked, 'toggled on');
  assert.strictEqual(w.document.activeElement, again, '🔴 focus stays on the same extra after the re-render');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(w.eval('window.__noted'))), [MOZZ], 'captured AS PRICED NOW at staging (CART.noteExtra)');
  assert.ok(/Mozzarella/.test(again.closest('label').textContent), 'its accessible name is its label (name + price)');
  noted.length = 0;
  ok('picker: keyboard toggle on the native checkbox, focus kept across the re-render, the extra captured at staging');
}
// ── 6. scroll is kept on a tap (only a fresh open resets it) ──
{
  const w = await boot();
  w.openDetailModal(L); await settle(); await pick(w, COMB);
  const sc = $(w, 'detail-scroll'); sc.scrollTop = 230;
  await tick(w, MOZZ);
  assert.strictEqual(sc.scrollTop, 230, 'a tap keeps the scroll');
  ok('picker: the scroll position is kept across choice / extra taps');
}
// ── 7. repricing (codex r1 P2-3): the button shows the live price, the line keeps the captured one → a conflict checkout
//        refuses; the picker never calls acceptExtra to "make them equal" ──
{
  const w = loadForm(DIR); await settle();
  const menu = withGroup(w);
  await serve(w, envelope(B.rid, menu));
  w.eval('(() => { window.__accepted = 0; const real = CART.acceptExtra.bind(CART); CART.acceptExtra = (...a) => { window.__accepted++; return real(...a); }; })()');
  w.openDetailModal(L); await settle(); await pick(w, COMB); await tick(w, MOZZ);   // captured at L50
  w.closeDetailModal(); await settle();                                            // …then cancelled
  const repriced = JSON.parse(JSON.stringify(menu)); repriced.extras.find((e) => e.id === MOZZ).price = 70;
  await serve(w, envelope(B.rid, repriced));
  assert.strictEqual(G(w, 'EXTRAS').find((e) => e.id === MOZZ).price, 70, 'premise: Mozzarella is now L70 live');
  w.openDetailModal(L); await settle(); await pick(w, COMB); await tick(w, MOZZ);
  assert.strictEqual(ctaTotal(w), 694, 'the button shows the LIVE price (L624 + L70)');
  w.detailCtaTap(); await settle();
  const conflicts = JSON.parse(JSON.stringify(w.cartConflicts()));
  assert.ok(conflicts.length === 1 && /Combinada/.test(conflicts[0].record.name), '🔴 the line is a conflict (its Mozzarella was agreed at L50), so checkout refuses it');
  assert.strictEqual(w.eval('window.__accepted'), 0, '🔴 the picker never accepts a repriced extra on its own');
  ok('picker: a repriced extra is shown at its live price, stays a conflict on the line (checkout refuses), and is never auto-accepted');
}
closeAll();
console.log('\npicker-extras: OK');
process.exit(0);
