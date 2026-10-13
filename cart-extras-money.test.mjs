// HOTFIX (codex, reproduced LIVE 2026-10-13) — extras must be charged exactly as the cart shows them. Run: node cart-extras-money.test.mjs
//
// 1. X. Pizza OVERCHARGE: extras live per PIZZA INSTANCE; lowering the quantity left the removed pizza's extras in place, so
//    two Carnivora with Mozzarella on pizza 2, brought down to one, showed one plain Carnivora (L340) and charged L390.
// 2. La Musa UNDERCHARGE: re-adding the same choice from its picker REPLACED the line's extras, so Pollo + Arroz Blanco then
//    Pollo + Arroz Chino charged L769 instead of L819 (and Blanco twice charged one Blanco).
//
// Every payload here comes out of the REAL booted form (chg / toggleDetailExtra / the picker's own commit / restoreOrderForm),
// and the money check is the SERVER's own computeServerTotal over the body the form actually sent — on cash AND card.
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { counter, settle, envelope, loadForm, res, BRAND, closeAll } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { computeServerTotal } = require('./menu-pricing');
const { gateConfirmedNet, gateInputFromRequest } = require('./token-gate');
const { ok } = counter();
const CHARGE_RE = /createOrder|chargeOnlineOrder/;

async function boot(dir, { stash = null } = {}) {
  const B = BRAND[dir];
  const w = loadForm(dir);
  const sent = [];
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
    // the quote is PRICED like the server prices it — the actual request's items through computeServerTotal (codex hotfix r1 P2:
    // a constant one-cent quote put expected_net_cents:1 in the bodies, which the real gate refuses)
    if (url.includes('quoteOrder')) {
      const q = JSON.parse((init && init.body) || '{}');
      const t = computeServerTotal(q.items, B.rid);
      return res(t.error ? { ok: false } : { ok: true, total_cents: Math.round(t.total * 100) });
    }
    if (CHARGE_RE.test(url)) { sent.push(JSON.parse((init && init.body) || '{}')); return res({ ok: true }); }
    return new Promise(() => {});
  };
  if (stash) w.localStorage.setItem(dir === 'xpizza-orders' ? 'xpizza_pending_pay' : 'lamusa_pending_pay', JSON.stringify(stash));
  await settle();
  return { w, B, sent };
}
const G = (w, name) => w.eval(name);   // the form's top-level lexical bindings (const pizzaExtras, qty)

// what the customer SEES: the cart review lines (name, "+ extras" lines, price)
function visibleCart(w) {
  w.updateCartReviewBody();
  return [...w.document.querySelectorAll('.cart-review-item')].filter((el) => el.querySelector('[data-act="review-open"]')).map((el) => ({   // dish lines (not the free-delivery row)
    name: el.querySelector('.cart-review-item-name').textContent,
    extras: [...el.querySelectorAll('.cart-review-item-extras')].map((x) => x.textContent),
    price: Number(String(el.querySelector('.cart-review-item-price').textContent).replace(/[^0-9.]/g, '')),
  }));
}
// send the cart on the cash path AND the card path; every body re-priced by the SERVER
async function sendBoth(w, sent, rid) {
  w.requestServerQuote(); await settle();
  assert.ok(w.buildOrder(), 'premise — the cart composes an order');
  try { await w.submitOrder('confirmed'); } catch (_) {}
  await settle();
  w.selectPay('online'); const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {});
  await settle();
  assert.strictEqual(sent.length, 2, `premise — one cash and one card request were sent (${sent.length})`);
  return sent.map((b, i) => {
    const server = computeServerTotal(b.items, rid).total;
    const path = i === 0 ? 'cash' : 'card';
    // the outgoing confirmation equals the server's recompute, and the server's OWN gate (through its own request mapping) accepts it
    assert.strictEqual(b.expected_net_cents, Math.round(server * 100), `🔴 ${path}: expected_net_cents is the server's net (${b.expected_net_cents} vs ${server * 100})`);
    if (b.total !== undefined) assert.strictEqual(Number(b.total), server, `🔴 ${path}: the body's total is the server's (${b.total} vs ${server})`);
    const g = gateConfirmedNet(gateInputFromRequest(b, { rid, reward: null, tables: null, secret: 'hotfix-test', enforce: false, nowMs: Date.now() }));
    assert.ok(g.action === 'charge' && g.chargeNet === Math.round(server * 100), `🔴 ${path}: the confirmed-net gate accepts and charges the server net (${JSON.stringify(g)})`);
    return { body: b, server };
  });
}

// ═════════ 1. X. Pizza — removed pizzas never keep chargeable extras ═════════
const XP = 'xpizza-orders';
const CARN = 2, MOZZ = 'e4', PEPP = 'e7';
{
  // 2 → 1: Mozzarella on pizza 2, then one Carnivora removed
  const { w, sent } = await boot(XP);
  w.chg(CARN, 2); w.toggleDetailExtra(MOZZ, CARN, 1); await settle();
  assert.strictEqual(w.calcTotal(), 730, 'premise — two Carnivora (L680) with Mozzarella on pizza 2 (L50)');
  w.chg(CARN, -1); await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(G(w, 'pizzaExtras')[CARN] || {})), {}, '🔴 2→1: pizza 2\'s extras are gone with pizza 2');
  assert.strictEqual(w.calcTotal(), 340, '🔴 2→1: the total is one plain Carnivora');
  assert.deepStrictEqual(visibleCart(w), [{ name: 'Carnivora', extras: [], price: 340 }], 'the cart shows one plain Carnivora');
  for (const { body, server } of await sendBoth(w, sent, 'x_pizza')) {
    assert.deepStrictEqual(body.items.flatMap((i) => i.extras), [], '🔴 2→1: no extra in the order body');
    assert.strictEqual(server, 340, '🔴 2→1: the server charges L340, what the cart shows');
  }
  ok('X. Pizza 2→1: the removed pizza\'s Mozzarella leaves the cart, the total, and the cash AND card bodies (server L340, not L390)');
}
{
  // 3 → 1 with extras on every pizza: only pizza 1's stay
  const { w, sent } = await boot(XP);
  w.chg(CARN, 3); w.toggleDetailExtra(PEPP, CARN, 0); w.toggleDetailExtra(MOZZ, CARN, 1); w.toggleDetailExtra(MOZZ, CARN, 2); await settle();
  w.chg(CARN, -1); w.chg(CARN, -1); await settle();
  assert.deepStrictEqual(Object.keys(G(w, 'pizzaExtras')[CARN]), ['0'], '3→1: only pizza 1 keeps its extras');
  const want = 340 + 50;
  assert.strictEqual(w.calcTotal(), want);
  assert.deepStrictEqual(visibleCart(w), [{ name: 'Carnivora', extras: ['+ Pepperoni'], price: want }]);
  for (const { body, server } of await sendBoth(w, sent, 'x_pizza')) {
    assert.deepStrictEqual(body.items.flatMap((i) => i.extras.map((e) => e.name)), ['Pepperoni'], '🔴 3→1: only pizza 1\'s Pepperoni is sent');
    assert.strictEqual(server, want, `🔴 3→1: the server charges L${want}`);
  }
  ok('X. Pizza 3→1: only the remaining pizza\'s extras are shown, totalled and sent (cash and card)');
}
{
  // decrease → re-add with no extras: the new pizza 2 is plain (no ghost Mozzarella)
  const { w, sent } = await boot(XP);
  w.chg(CARN, 2); w.toggleDetailExtra(MOZZ, CARN, 1); w.chg(CARN, -1); w.chg(CARN, 1); await settle();
  assert.strictEqual(w.calcTotal(), 680, '🔴 decrease → re-add: two plain Carnivora');
  assert.deepStrictEqual(visibleCart(w), [{ name: 'Carnivora', extras: [], price: 680 }]);
  for (const { server } of await sendBoth(w, sent, 'x_pizza')) assert.strictEqual(server, 680, '🔴 decrease → re-add: no ghost extra is charged');
  ok('X. Pizza decrease → re-add: the re-added pizza is plain — the removed one\'s extra does not come back');
}
{
  // payment return with a stash written BEFORE the fix (stale instance 1 beside quantity 1): never revived
  const { w: a } = await boot(XP);
  a.chg(CARN, 1); a.toggleDetailExtra(PEPP, CARN, 0); await settle();
  const form = a.snapshotForm();
  form.extras = JSON.parse(JSON.stringify(form.extras)); form.extras[CARN]['1'] = { [MOZZ]: 1 };   // the stale instance a live stash can carry
  const { w, sent } = await boot(XP, { stash: { order_id: 'xp_hotfix_restore', form, ts: Date.now() } });
  w.restoreOrderForm(); await settle();
  assert.deepStrictEqual(Object.keys(G(w, 'pizzaExtras')[CARN]), ['0'], '🔴 restore: the stale instance is dropped');
  assert.strictEqual(w.calcTotal(), 390, 'restore: one Carnivora + its Pepperoni');
  assert.deepStrictEqual(visibleCart(w), [{ name: 'Carnivora', extras: ['+ Pepperoni'], price: 390 }]);
  for (const { body, server } of await sendBoth(w, sent, 'x_pizza')) {
    assert.deepStrictEqual(body.items.flatMap((i) => i.extras.map((e) => e.name)), ['Pepperoni']);
    assert.strictEqual(server, 390, '🔴 restore: the stale Mozzarella is not charged');
  }
  ok('X. Pizza payment return: a stash carrying a removed pizza\'s extras restores without them (cash and card bodies match the cart)');
}
{
  // self-update restore (order-self-update.js): the same cartRestore — stale instances dropped there too
  const { w: a } = await boot(XP);
  a.chg(CARN, 1); await settle();
  const snap = a.snapshotForm();
  const { w } = await boot(XP);
  w.eval(`Object.keys(qty).forEach(k=>delete qty[k]); Object.assign(qty, ${JSON.stringify(snap.qty)});
          Object.keys(pizzaExtras).forEach(k=>delete pizzaExtras[k]); Object.assign(pizzaExtras, { ${CARN}: { 0: {}, 1: { ${JSON.stringify(MOZZ)}: 1 } } });`);
  w.cartRestore(snap.cart); await settle();
  assert.deepStrictEqual(Object.keys(G(w, 'pizzaExtras')[CARN] || {}).filter((k) => k !== '0'), [], '🔴 self-update restore: the stale instance is dropped');
  assert.strictEqual(w.calcTotal(), 340);
  ok('X. Pizza self-update restore (cartRestore): a stale instance is dropped');
}

// ═════════ 2. La Musa — re-adding a choice accumulates its extras ═════════
const LM = 'la-musa-orders';
async function pickerAdd(w, launcher, variant, staged) {
  w.openDetailModal(launcher); await settle();
  w.selectVariant(variant); await settle();
  for (const [eid, n] of staged) for (let i = 0; i < n; i++) w.chgStagedExtra(eid, 1);
  await settle();
  const cta = w.document.getElementById('detail-cta').textContent.replace(/\s+/g, ' ');
  w.detailCtaTap(); await settle();
  return Number((cta.match(/L\s*([0-9]+)/) || [])[1]);
}
for (const [label, first, second, ctas, want] of [
  ['Pollo + Arroz Blanco, then Pollo + Arroz Chino', [['rice_white', 1]], [['rice_chinese', 1]], [392, 427], 819],
  ['Pollo + Arroz Blanco, twice', [['rice_white', 1]], [['rice_white', 1]], [392, 392], 784],
  ['Pollo + Arroz Blanco, then Pollo with nothing', [['rice_white', 1]], [], [392, 342], 734],
]) {
  const { w, sent } = await boot(LM);
  const c1 = await pickerAdd(w, 'noodle_01', 'noodle_01_pollo', first);
  const c2 = await pickerAdd(w, 'noodle_01', 'noodle_01_pollo', second);
  assert.deepStrictEqual([c1, c2], ctas, `${label}: premise — the two buttons read L${ctas.join(' and L')}`);
  assert.strictEqual(w.calcTotal(), want, `🔴 ${label}: the cart totals the two buttons (L${want})`);
  for (const { server } of await sendBoth(w, sent, 'la_musa')) assert.strictEqual(server, want, `🔴 ${label}: the server charges L${want}, the sum of what the customer was shown`);
  ok(`La Musa ${label}: L${ctas.join(' + L')} = L${want} in the cart and on the server (cash and card)`);
}
{
  // a refused add (the choice sold out) writes no extras
  const { w } = await boot(LM);
  w.openDetailModal('noodle_01'); await settle(); w.selectVariant('noodle_01_pollo'); w.chgStagedExtra('rice_white', 1); await settle();
  w.eval("soldOutById = (id) => id === 'noodle_01_pollo'");   // the form's own add guard (chg) now refuses this choice
  w.detailCtaTap(); await settle();
  assert.strictEqual(G(w, 'qty').noodle_01_pollo || 0, 0, 'premise — the add was refused');
  assert.ok(!G(w, 'pizzaExtras').noodle_01_pollo, '🔴 a refused add leaves no extras behind');
  ok('La Musa: a refused add (sold out) leaves no extras behind');
}
closeAll();
console.log('\ncart-extras-money: OK');
process.exit(0);
