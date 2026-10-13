// Per-product extras — PICKER SLICE, codex build r1 P2-2: the money combinations through the REAL server reward/net code.
// Run: node picker-extras-money.test.mjs
// A signed-in customer (account.js's Firebase SDK is the only seam, as in reorder-whole-page.test.mjs), the served NY Plain
// Slice group, picker adds with extras, then:
//   14  a REWARD: the reward quote is the server's own quoteRedemptionCore (computeRedemption → computeServerNet → issueQuote,
//       a signed token) over the form's real serialization; the confirmed net, the cash and card bodies, and the server's
//       gate (gateConfirmedNet, ENFORCED, with the reward resolved by prepareRedemption) all agree, and the reward lowers it;
//   15  REORDER "Agregar" onto a cart holding picker-added extras: merged lines, each pizza's extras where the cart shows
//       them, and the server charges the cart (Δ = the reorder's own total); 16 REORDER "Empezar de nuevo": only the reorder.
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { loadForm, settle, serve, envelope, res, closeAll, counter, BRAND } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
process.env.QUOTE_TOKEN_SECRET = 'picker-money-secret';   // the issuer signs only when provisioned — read per call
const { computeServerTotal } = require('./menu-pricing');
const { computeServerNet } = require('./compute-server-net');
const { quoteRedemptionCore, prepareRedemption } = require('./rewards-redeem-intake');
const { gateConfirmedNet, gateInputFromRequest } = require('./token-gate');
const { ok } = counter();
const WATCHDOG = setTimeout(() => { console.error('picker-extras-money: FAILED — watchdog (a request never settled)'); process.exit(1); }, 300000);
const DIR = 'xpizza-orders';
const B = BRAND[DIR];
const UID = 'u_picker';
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

// the server's RTDB, in memory: redemption on, a balance that covers the reward, no item 86'd
const DB_VALUES = { 'config/redemption_enabled': true, [`user_rewards/${UID}/x_pizza`]: { balance: 100000, reserved: 0 } };
const fakeDb = { ref: (p) => { const snap = { val: () => (p in DB_VALUES ? plain(DB_VALUES[p]) : null), exists: () => p in DB_VALUES }; return { get: async () => snap, once: async () => snap }; } };

// account.js's Firebase SDK → a signed-in customer whose history holds `entry` (null = no history)
function fakeFirebase(entry) {
  const snap = (v) => ({ exists: () => v != null, val: () => v });
  const user = { uid: UID, getIdToken: async () => 'tok', phoneNumber: '+50499990000' };
  return {
    app: {}, db: {},
    auth: { currentUser: user, authStateReady: async () => {} },
    authMod: { onAuthStateChanged: (a, cb) => { cb(user); return () => {}; }, signOut: async () => {} },
    dbMod: { ref: (db, path) => ({ path }), get: async (r) => snap(r && r.path === `user_orders/${UID}` && entry ? { o_picker_1: entry } : null),
      onValue: (r, cb) => { cb(snap(null)); return () => {}; }, off: () => {} },
  };
}
const transforms = {
  'account.js': (code) => {
    const seam = 'async function ensureFirebase() {';
    assert.strictEqual(code.split(seam).length, 2, 'premise: account.js has exactly one ensureFirebase');
    return `try { localStorage.setItem('xpizza_acct', ${JSON.stringify(JSON.stringify({ uid: UID, name: 'Ana Pérez', phone: '+50499990000' }))}); } catch (_) {}\n`
      + code.replace(seam, `${seam} if (window.__FB_FAKE) return window.__FB_FAKE;`);
  },
};

async function boot({ entry = null } = {}) {
  const w = loadForm(DIR, { transforms });
  w.__FB_FAKE = fakeFirebase(entry);
  const sent = []; const redq = [];
  let menu = null;
  await settle();
  menu = withGroup(B.menu(w));
  await serve(w, envelope(B.rid, menu));
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, menu));
    const body = JSON.parse((init && init.body) || '{}');
    if (url.includes('quoteRedemption')) {
      redq.push(body);
      // THE SERVER'S quote, not a fixture: the handler's own core over the form's body
      return quoteRedemptionCore(fakeDb, { redeem: body.redeem, items: body.items, restaurantId: 'x_pizza', customerUid: UID, tables: tablesOf(menu) })
        .then((q) => res(q.ok ? q : { ok: false, ...q.body }));
    }
    if (url.includes('quoteOrder')) {
      const t = computeServerTotal(body.items, 'x_pizza', tablesOf(menu));
      return res(t.error ? { ok: false } : { ok: true, total_cents: Math.round(t.total * 100) });
    }
    if (/createOrder|chargeOnlineOrder/.test(url)) { sent.push(body); return res({ ok: true }); }
    return new Promise(() => {});
  };
  return { w, sent, redq, menu };
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
const gross = (w, menu) => { const items = plain(w.redeemCartItems()); return items.length ? computeServerTotal(items, 'x_pizza', tablesOf(menu)).total : 0; };
const extrasOf = (items, name) => items.filter((i) => i.name === name).flatMap((i) => i.extras.map((e) => `${e.instance}:${e.name}`)).sort();
// what the cart review SHOWS for a line, per pizza
function shownExtras(w, re) {
  w.updateCartReviewBody();
  const el = [...w.document.querySelectorAll('.cart-review-item')].find((x) => re.test(x.textContent));
  return el ? [...el.querySelectorAll('.cart-review-item-extras')].map((e) => e.textContent) : null;
}
async function sendBoth(w, sent, label) {
  w.requestServerQuote(); await settle();
  assert.ok(w.buildOrder(), `${label}: premise — the cart composes an order`);
  try { await w.submitOrder('confirmed'); } catch (_) {}
  await settle(); await settle();
  w.selectPay('online'); const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {});
  await settle(); await settle();
  assert.strictEqual(sent.length, 2, `${label}: one cash and one card request (${sent.length})`);
  return sent.map((b, i) => ({ body: b, path: i === 0 ? 'cash' : 'card' }));
}

// ── 14. a REWARD beside picker extras, priced by the server's own reward + net code; cash and card charge the confirmed net ──
{
  const { w, sent, redq, menu } = await boot();
  w.chg(CARN, 1); w.toggleDetailExtra(PEPP, CARN, 0); await settle();
  await pickerAdd(w, COMB, [MOZZ]);
  await pickerAdd(w, COMB, [PEPP, MOZZ]);
  const items = plain(w.redeemCartItems());
  assert.deepStrictEqual(extrasOf(items, 'NY Plain Slice - Combinada'), ['0:Mozzarella', '1:Mozzarella', '1:Pepperoni'], 'premise: the picker put each pizza\'s extras on its own instance');
  const reward = { type: 'free_pizza_choice', item_id: 'Carnivora', name: 'Carnivora' };
  w.__ACCOUNT.restoreRedeem(reward, null, null);
  await w.__ACCOUNT.requoteRedeem(w.redeemCartItems()); await settle();
  assert.ok(redq.length >= 1, 'premise — the reward was quoted over the network leg (the server core answered)');
  assert.deepStrictEqual(redq[redq.length - 1].items, items, '🔴 the reward quote carries exactly the order serialization (picker extras included)');
  const prep = await prepareRedemption(fakeDb, { redeem: reward, items, restaurantId: 'x_pizza', itemsText: '', totalLempiras: gross(w, menu), customerUid: UID, tables: tablesOf(menu) });
  assert.ok(prep.ok, `premise — the server resolves the reward (${JSON.stringify(prep.body || {})})`);
  const net = computeServerNet({ items, reward: prep.redemption, rid: 'x_pizza', tables: tablesOf(menu) });
  assert.ok(!net.error && Number.isSafeInteger(net.net_total_cents), `premise — the server nets the reward-bearing cart (${JSON.stringify(net)})`);
  // x_pizza's reward ADDS a free pizza (net-invariant), so the amount cannot witness it — the resolved reward and the token's
  // binding to it (below: the same body gated WITHOUT the reward is refused) are what prove a reward-bearing charge
  assert.deepStrictEqual(prep.freeItems.map((f) => f.name), ['Carnivora'], 'premise — the server resolves a free Carnivora');
  assert.strictEqual(w.__ACCOUNT.getRedeemQuoteTotalCents(), net.net_total_cents, '🔴 the reward-adjusted total the form holds is the server net');
  assert.strictEqual(Math.round(w.redeemAdjustedTotal() * 100), net.net_total_cents, '🔴 …and it is the total the customer confirms');
  assert.strictEqual(w.__ACCOUNT.redeemQuoteMatches(w.redeemCartItems()), true, 'the quote matches the cart it was priced for');
  for (const { body, path } of await sendBoth(w, sent, 'reward')) {
    assert.deepStrictEqual(body.redeem, reward, `${path}: the reward rides with the order`);
    assert.deepStrictEqual(body.items, items, `🔴 ${path}: the body serializes exactly what was quoted`);
    assert.ok(typeof body.quote_token === 'string' && body.quote_token.length > 20, `${path}: the server's signed reward token rides with it`);
    assert.strictEqual(body.expected_net_cents, net.net_total_cents, `🔴 ${path}: expected_net_cents is the reward-adjusted server net`);
    const bprep = await prepareRedemption(fakeDb, { redeem: body.redeem, items: body.items, restaurantId: 'x_pizza', itemsText: '', totalLempiras: computeServerTotal(body.items, 'x_pizza', tablesOf(menu)).total, customerUid: UID, tables: tablesOf(menu) });
    const g = gateConfirmedNet(gateInputFromRequest(body, { rid: 'x_pizza', reward: bprep.redemption, tables: tablesOf(menu), secret: process.env.QUOTE_TOKEN_SECRET, enforce: true, nowMs: Date.now() }));
    assert.ok(g.action === 'charge' && g.chargeNet === net.net_total_cents, `🔴 ${path}: the ENFORCED server gate verifies the token for THIS cart + reward and charges the confirmed net (${JSON.stringify(g)})`);
    const noReward = gateConfirmedNet(gateInputFromRequest(body, { rid: 'x_pizza', reward: null, tables: tablesOf(menu), secret: process.env.QUOTE_TOKEN_SECRET, enforce: true, nowMs: Date.now() }));
    assert.notStrictEqual(noReward.action, 'charge', `🔴 ${path}: non-vacuity — the token is bound to the reward (gated without it, it does not charge: ${JSON.stringify(noReward)})`);
  }
  ok(`a reward beside picker extras: the server's reward quote prices the real serialization; confirmed net = server net (${net.net_total_cents}), a free Carnivora resolved; cash and card carry it with a signed token the enforced gate charges`);
}

// ── 15/16. REORDER onto a cart holding picker-added extras ──
const ENTRY = { ts: 1791500000000, total: 1013, order_type: 'pickup', restaurant: 'x_pizza', status: 'completed',
  items_text: '1x NY Plain Slice - Combinada (L624) [+ Mozzarella] | 1x Carnivora (L340)',
  items: [{ key: 'NY Plain Slice - Combinada', qty: 1, options: [{ name: 'Mozzarella', count: 1 }] }, { key: 'Carnivora', qty: 1 }] };
async function reorderViaUI(w, choice) {
  w.document.querySelector('#acct-chip button').click(); await settle();
  w.document.getElementById('acct-row-orders').click(); await settle(); await settle();
  const btn = w.document.querySelector('#acct-pane-orders .acct-ordreorder');
  assert.ok(btn, 'premise — the history pane lists the order with a Reordenar button');
  btn.click(); await settle(); await settle();
  const p = w.document.getElementById(choice === 'add' ? 'acct-ro-add' : 'acct-ro-replace');
  assert.ok(p, `premise — the smart-cart prompt offers "${choice}"`);
  p.click(); await settle(); await settle();
}
const REORDER_TOTAL = 624 + 50 + 340;   // the entry at today's prices: Combinada + Mozzarella, Carnivora
for (const choice of ['add', 'replace']) {
  const { w, sent, menu } = await boot({ entry: ENTRY });
  await pickerAdd(w, COMB, [PEPP]);                    // the picker: Combinada with Pepperoni on pizza 1
  const before = gross(w, menu);
  assert.strictEqual(before, 624 + 50, 'premise — the picker line alone');
  await reorderViaUI(w, choice);
  const items = plain(w.redeemCartItems());
  if (choice === 'add') {
    assert.deepStrictEqual(extrasOf(items, 'NY Plain Slice - Combinada'), ['0:Pepperoni', '1:Mozzarella'], '🔴 "Agregar": the picker\'s pizza keeps its Pepperoni; the reorder\'s Mozzarella lands on the NEW pizza 2');
    assert.deepStrictEqual(shownExtras(w, /Combinada/), ['+ Pizza 1: Pepperoni', '+ Pizza 2: Mozzarella'], '🔴 …exactly as the cart shows them');
    assert.strictEqual(gross(w, menu) - before, REORDER_TOTAL, '🔴 "Agregar": Δ server total = the reorder at today\'s prices');
  } else {
    assert.deepStrictEqual(extrasOf(items, 'NY Plain Slice - Combinada'), ['0:Mozzarella'], '🔴 "Empezar de nuevo": only the reorder\'s pizza and its Mozzarella — no picker extra survives');
    assert.deepStrictEqual(shownExtras(w, /Combinada/), ['+ Mozzarella'], '…as the cart shows it');
    assert.strictEqual(gross(w, menu), REORDER_TOTAL, '🔴 "Empezar de nuevo": the server total is the reorder alone');
  }
  assert.strictEqual(w.calcTotal(), gross(w, menu), 'the displayed total is the server total');
  for (const { body, path } of await sendBoth(w, sent, `reorder-${choice}`)) {
    assert.deepStrictEqual(body.items, items, `${choice} ${path}: the body is the merged cart's serialization`);
    const net = computeServerTotal(body.items, 'x_pizza', tablesOf(menu)).total;
    assert.strictEqual(net, gross(w, menu), `🔴 ${choice} ${path}: the server charges exactly the cart`);
    assert.strictEqual(body.expected_net_cents, Math.round(net * 100), `🔴 ${choice} ${path}: expected_net_cents is the server net`);
    const g = gateConfirmedNet(gateInputFromRequest(body, { rid: 'x_pizza', reward: null, tables: tablesOf(menu), secret: process.env.QUOTE_TOKEN_SECRET, enforce: false, nowMs: Date.now() }));
    assert.ok(g.action === 'charge' && g.chargeNet === Math.round(net * 100), `🔴 ${choice} ${path}: the server gate charges the server net (${JSON.stringify(g)})`);
  }
}
ok('reorder onto a cart with a picker-added extra: "Agregar" keeps the picker\'s pizza and puts the reorder\'s extra on a NEW pizza (Δ = the reorder); "Empezar de nuevo" leaves only the reorder; cash and card charge the cart through the server gate');
closeAll();
clearTimeout(WATCHDOG);
console.log('\npicker-extras-money: OK');
process.exit(0);
