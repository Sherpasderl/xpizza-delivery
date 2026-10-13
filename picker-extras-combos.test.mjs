// Per-product extras — PICKER SLICE, the money COMBINATIONS codex r1 P2-4 asked for (PLAN-picker-extras rev 2.2 §4).
// Run: node picker-extras-combos.test.mjs
// Every body is the one the REAL form sends; the server's price is computeServerTotal over it against the served catalog;
// each body's expected_net_cents must equal that net and pass the server's own gate (gateConfirmedNet via gateInputFromRequest).
//   8  ASAP cash + card, an existing cart + two picker adds
//   9  a SCHEDULED order (cash + card): same money, scheduled_for carried
//  10  payment return (restoreOrderForm) and 11 self-update (cartRestore) keep the picker's per-pizza extras exactly
//  12  a reward in the cart: the picker line serializes the same beside it (serialization identity only; the REAL server
//      reward quote, confirmed net and reward-bearing charge are picker-extras-money.test.mjs cell 14)
//  13  a LATE, extras-free quote (asked before the add, answered after the post-add quote) never wins
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { loadForm, settle, serve, envelope, res, closeAll, counter, BRAND } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { computeServerTotal } = require('./menu-pricing');
const { gateConfirmedNet, gateInputFromRequest } = require('./token-gate');
const { ok } = counter();
// a hung fake must fail the run, never stall it (memory: bound tests need their own deadline)
const WATCHDOG = setTimeout(() => { console.error('picker-extras-combos: FAILED — watchdog (a request never settled)'); process.exit(1); }, 300000);
const DIR = 'xpizza-orders';
const B = BRAND[DIR];
const L = 30, COMB = 33, VODKA = 32, CARN = 2;
const MOZZ = 'e4', PEPP = 'e7';
const G = (w, name) => w.eval(name);
const plain = (x) => JSON.parse(JSON.stringify(x));

function withGroup(base) {
  const m = plain(base);
  m.dishes.push({ id: L, cat: 'ny', name: 'NY Plain Slice', price: 624, emoji: '🍕', color: '#C8321A', desc: 'La clásica NY Plain Slice.' });
  [['Salsa Roja', 31], ['Salsa Vodka', VODKA], ['Combinada', COMB]].forEach(([choice, id]) => m.dishes.push({ id, cat: 'ny', name: `NY Plain Slice - ${choice}`, price: 624, variantOf: L, choice }));
  m.variant_items = { [String(L)]: { label: 'Salsa', basePrice: 624, variantIds: [31, VODKA, COMB] } };
  return m;
}
const tablesOf = (menu) => ({ restaurantId: 'x_pizza',
  menu: Object.fromEntries(menu.dishes.filter((d) => d.price > 0).map((d) => [d.name, d.price])),
  extras: Object.fromEntries(menu.extras.map((e) => [e.name, e.price])) });

// boot: the served menu WITH the group; quotes priced like the server (optionally held, to stage a late answer)
async function boot({ stash = null, holdQuotes = false } = {}) {
  const w = loadForm(DIR);
  const sent = []; const quotes = []; const redq = [];
  let menu = null;
  const respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, menu || { dishes: [], extras: [] }));
    if (url.includes('quoteOrder')) {
      const q = JSON.parse((init && init.body) || '{}');
      const t = computeServerTotal(q.items, 'x_pizza', tablesOf(menu));
      const answer = t.error ? { ok: false } : { ok: true, total_cents: Math.round(t.total * 100) };
      if (!holdQuotes) return res(answer);
      return new Promise((resolve) => quotes.push({ answer, release: () => resolve(res(answer)) }));
    }
    if (/createOrder|chargeOnlineOrder/.test(url)) { sent.push(JSON.parse((init && init.body) || '{}')); return res({ ok: true }); }
    if (url.includes('quoteRedemption')) { redq.push(JSON.parse((init && init.body) || '{}')); return new Promise(() => {}); }
    return new Promise(() => {});
  };
  await settle();
  menu = withGroup(B.menu(w));
  await serve(w, envelope(B.rid, menu));   // serve() installs its own responder for the menu refresh…
  w.__respond = respond;                   // …ours (quotes priced like the server, charge capture) takes over after it
  if (stash) { w.localStorage.setItem('xpizza_pending_pay', JSON.stringify(stash)); }
  return { w, sent, quotes, redq, menu };
}
const ctaTotal = (w) => Number(((w.document.getElementById('detail-cta').textContent || '').match(/L\s*([0-9]+)/) || [])[1]);
async function pickerAdd(w, vid, eids) {
  w.openDetailModal(L); await settle();
  w.document.querySelector(`#detail-scroll .detail-variant-row[data-id="${vid}"]`).dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await settle();
  for (const e of eids) { [...w.document.querySelectorAll('#detail-scroll .staged-extra-input')].find((i) => i.value === e).click(); await settle(); }
  const cta = ctaTotal(w);
  w.detailCtaTap(); await settle();
  return cta;
}
const server = (w, menu) => { const items = plain(w.redeemCartItems()); return items.length ? computeServerTotal(items, 'x_pizza', tablesOf(menu)).total : 0; };
// a standard existing cart, then two picker adds; returns the expected server total
async function buildCart(w, menu) {
  w.chg(CARN, 1); w.toggleDetailExtra(PEPP, CARN, 0); await settle();
  const before = server(w, menu);
  const c1 = await pickerAdd(w, COMB, [MOZZ]);
  assert.strictEqual(server(w, menu) - before, c1, 'Δ server total = the first button');
  const mid = server(w, menu);
  const c2 = await pickerAdd(w, COMB, [PEPP, MOZZ]);
  assert.strictEqual(server(w, menu) - mid, c2, 'Δ server total = the second button');
  return server(w, menu);
}
async function sendBoth(w, sent, menu, label) {
  w.requestServerQuote(); await settle();
  assert.ok(w.buildOrder(), `${label}: premise — the cart composes an order`);
  try { await w.submitOrder('confirmed'); } catch (_) {}
  await settle();
  w.selectPay('online'); const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {});
  await settle();
  assert.strictEqual(sent.length, 2, `${label}: one cash and one card request (${sent.length})`);
  return sent.map((b, i) => {
    const path = i === 0 ? 'cash' : 'card';
    const net = computeServerTotal(b.items, 'x_pizza', tablesOf(menu)).total;
    assert.strictEqual(b.expected_net_cents, Math.round(net * 100), `🔴 ${label} ${path}: expected_net_cents is the server net`);
    const g = gateConfirmedNet(gateInputFromRequest(b, { rid: 'x_pizza', reward: null, tables: tablesOf(menu), secret: 'picker-test', enforce: false, nowMs: Date.now() }));
    assert.ok(g.action === 'charge' && g.chargeNet === Math.round(net * 100), `🔴 ${label} ${path}: the server gate accepts and charges the server net (${JSON.stringify(g)})`);
    return { body: b, net, path };
  });
}
const extrasOf = (b, name) => b.items.filter((i) => i.name === name).flatMap((i) => i.extras.map((e) => `${e.instance}:${e.name}`)).sort();

// ── 8. ASAP cash + card ──
{
  const { w, sent, menu } = await boot();
  const want = await buildCart(w, menu);
  for (const { body, net, path } of await sendBoth(w, sent, menu, 'ASAP')) {
    assert.strictEqual(net, want, `🔴 ASAP ${path}: the server charges exactly the cart (${want})`);
    assert.deepStrictEqual(extrasOf(body, 'NY Plain Slice - Combinada'), ['0:Mozzarella', '1:Mozzarella', '1:Pepperoni'], `ASAP ${path}: each pizza carries its own extras`);
  }
  ok('ASAP: an existing cart + two picker adds → cash and card bodies charge exactly the cart; each pizza\'s extras on its instance; the gate accepts');
}
// ── 9. scheduled ──
{
  const { w, sent, menu } = await boot();
  const want = await buildCart(w, menu);
  const sat = new Date(); sat.setUTCDate(sat.getUTCDate() + ((6 - sat.getUTCDay() + 7) % 7 || 7)); sat.setUTCHours(19, 0, 0, 0);   // next Saturday 13:00 HN
  w.__scheduledFor = sat.getTime();
  for (const { body, net, path } of await sendBoth(w, sent, menu, 'scheduled')) {
    assert.strictEqual(net, want, `🔴 scheduled ${path}: the server charges exactly the cart`);
    if (path === 'cash') assert.strictEqual(body.scheduled_for, sat.getTime(), 'scheduled: the slot is carried');
  }
  ok('scheduled (next Saturday): the same money on cash and card, the slot carried');
}
// ── 10. payment return / 11. self-update keep the picker's per-pizza extras exactly ──
{
  const { w: a, menu } = await boot();
  const want = await buildCart(a, menu);
  const form = a.snapshotForm();
  const { w, sent } = await boot({ stash: { order_id: 'xp_picker_restore', form, ts: Date.now() } });
  w.restoreOrderForm(); await settle();
  assert.deepStrictEqual(plain(G(w, 'pizzaExtras')[COMB]), { 0: { [MOZZ]: 1 }, 1: { [PEPP]: 1, [MOZZ]: 1 } }, '🔴 payment return: the picker\'s per-pizza extras come back exactly');
  assert.strictEqual(server(w, menu), want, 'payment return: the same money');
  for (const { net, path } of await sendBoth(w, sent, menu, 'restored')) assert.strictEqual(net, want, `🔴 restored ${path}: the same charge`);
  const { w: s } = await boot();
  s.eval(`Object.keys(qty).forEach(k=>delete qty[k]); Object.assign(qty, ${JSON.stringify(form.qty)});
          Object.keys(pizzaExtras).forEach(k=>delete pizzaExtras[k]); Object.assign(pizzaExtras, ${JSON.stringify(form.extras)});`);
  s.cartRestore(form.cart); await settle();
  assert.deepStrictEqual(plain(G(s, 'pizzaExtras')[COMB]), { 0: { [MOZZ]: 1 }, 1: { [PEPP]: 1, [MOZZ]: 1 } }, '🔴 self-update: the same');
  assert.strictEqual(server(s, menu), want, 'self-update: the same money');
  ok('payment return and self-update restore the picker\'s per-pizza extras exactly; the restored cart charges the same (cash and card)');
}
// ── 12. a reward in the cart: the reward quote carries the picker lines exactly (the SAME serializer the order body uses) ──
{
  const { w, redq, menu } = await boot();
  const want = await buildCart(w, menu);
  const items = plain(w.redeemCartItems());
  w.__ACCOUNT.restoreRedeem({ type: 'free_pizza_choice', item_id: 'Carnivora', name: 'Carnivora' }, null, null); await settle();
  // the reward quote's network leg needs a signed-in customer (a Firebase token this harness does not mint), so the form's
  // hand-off to it is captured instead: forceRequote → __ACCOUNT.requoteRedeem(<the items>) — the exact items it quotes
  const handed = []; w.__ACCOUNT.requoteRedeem = (it) => { handed.push(JSON.parse(JSON.stringify(it))); return Promise.resolve(null); };
  w.forceRequote(); await settle();   // the ONE routing point: with a reward pending it re-quotes the reward
  assert.ok(handed.length >= 1, 'premise — a pending reward re-quotes');
  const body = { items: handed[handed.length - 1] };
  assert.deepStrictEqual(plain(w.__ACCOUNT.getRedeemPayload()), { type: 'free_pizza_choice', item_id: 'Carnivora', name: 'Carnivora' }, 'the reward stays pending beside the items');
  assert.deepStrictEqual(body.items, items, '🔴 the reward quote carries exactly the cart serialization the order body uses');
  assert.strictEqual(computeServerTotal(body.items, 'x_pizza', tablesOf(menu)).total, want, '🔴 with a reward: the items price exactly as without it (the reward is the server\'s, separately)');
  assert.deepStrictEqual(extrasOf(body, 'NY Plain Slice - Combinada'), ['0:Mozzarella', '1:Mozzarella', '1:Pepperoni']);
  ok('with a reward pending: the reward quote carries the picker lines exactly as the order body serializes them; the items price the same; the reward rides separately');
}
// ── 13. a LATE extras-free quote never wins ──
{
  const { w, sent, quotes, menu } = await boot({ holdQuotes: true });
  w.chg(CARN, 1); await settle();
  w.requestServerQuote(); await settle();                      // asked BEFORE the picker add (extras-free cart)
  const early = quotes.length;
  await pickerAdd(w, COMB, [MOZZ]);
  w.requestServerQuote(true); await settle();                  // the post-add quote
  assert.ok(quotes.length > early, 'premise — a second quote was asked');
  quotes[quotes.length - 1].release(); await settle();         // the post-add answer arrives first…
  for (let i = 0; i < early; i++) quotes[i].release();         // …then the stale one
  await settle();
  const want = server(w, menu);
  const cents = G(w, '__serverQuote').cents;
  assert.strictEqual(cents, Math.round(want * 100), `🔴 the stale extras-free quote did not overwrite the current one (${cents} vs ${want * 100})`);
  ok('a late, extras-free quote answered after the post-add quote never replaces it');
}
closeAll();
clearTimeout(WATCHDOG);
console.log('\npicker-extras-combos: OK');
process.exit(0);
