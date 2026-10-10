// HOTFIX (owner-confirmed live, 2026-10-09): "Reordenar" left the cart EMPTY — nothing on the cards, total L 0.
// Run: node reorder-whole-page.test.mjs
// The WHOLE customer chain, on both forms, through the real page: a signed-in customer (the account marker), the live
// menu applied as in production, the account chip → "Mis pedidos" (the real history pane, reading user_orders entries
// in the exact shape createOrder writes — create-order-build.js attachCustomerAttribution) → tap "Reordenar". The ONLY
// seam is account.js's Firebase SDK (a dynamic https import jsdom cannot run), replaced by a fake that serves the
// history read; the pane, the button, the smart-cart prompt, the reorder reader and the form's cart are all as shipped.
// Asserted where the customer and the order see it: the card steppers, the cart pill, CART (cartLines), calcTotal and
// the REAL checkout body (buildOrder() → currentOrder: items + total) — plus the existing "no longer available" notice.
import assert from 'node:assert';
import { loadForm, settle, serve, envelope, closeAll, counter, BRAND } from './form-harness.mjs';

const { ok } = counter();

const ENTRY = {
  x_pizza: { ts: 1791500000000, total: 1343, order_type: 'pickup', restaurant: 'x_pizza', status: 'completed',
    items_text: '2x Carnivora (L340) | 1x Margherita NY (L624) [+ Salsa Roja] | 1x Gone Dish (L100)',
    items: [{ key: 'Carnivora', qty: 2 }, { key: 'Margherita NY', qty: 1, options: [{ name: 'Salsa Roja', count: 1 }] }, { key: 'Gone Dish', qty: 1 }] },
  la_musa: { ts: 1791500000000, total: 788, order_type: 'pickup', restaurant: 'la_musa', status: 'completed',
    items_text: '2x Sichuan Spicy Wonton (L223) [+ 1x Arroz Blanco] | 1x Pad Thai - Pollo (L342) | 1x Gone (L1)',
    items: [{ key: 'dimsum_01', qty: 2, options: [{ id: 'rice_white', qty: 1 }] }, { key: 'noodle_01_pollo', qty: 1 }, { key: 'gone_99', qty: 1 }] },
};
/* Per brand: the restored lines [dish id, qty], the total from the LIVE menu, which of those dishes have a CARD on the
   grid (a choice of a group has none — it is reached through its launcher), the extra the recipe restores (for the
   ledger cells) with the form's OWN hand-toggle for it, and another dish to pre-load the cart with. */
const BRANDS = [
  { dir: 'xpizza-orders', rid: 'x_pizza', marker: 'xpizza_acct', lines: [[2, 2], [19, 1]], total: 2 * 340 + 624 + 39, cards: [2, 19], noCard: [],
    extra: { id: 'e1', price: 39, on: 19, toggle: (w) => w.toggleDetailExtra('e1', 19, 0) }, other: { id: 3, price: 337 } },
  { dir: 'la-musa-orders', rid: 'la_musa', marker: 'lamusa_acct', lines: [['dimsum_01', 2], ['noodle_01_pollo', 1]], total: 2 * 223 + 50 + 342, cards: ['dimsum_01'], noCard: ['noodle_01_pollo'],
    extra: { id: 'rice_white', price: 50, on: 'dimsum_01', toggle: (w) => w.chgDetailExtra('rice_white', 'dimsum_01', 1) }, other: { id: 'dimsum_03', price: 198 } },
];

function fakeFirebase(rid) {
  const snap = (v) => ({ exists: () => v != null, val: () => v });
  const user = { uid: 'u_reorder', getIdToken: async () => 'tok', phoneNumber: '+50499990000' };
  return {
    app: {}, db: {},
    auth: { currentUser: user, authStateReady: async () => {} },
    authMod: { onAuthStateChanged: (a, cb) => { cb(user); return () => {}; }, signOut: async () => {} },
    dbMod: {
      ref: (db, path) => ({ path }),
      get: async (r) => snap(r && r.path === `user_orders/${user.uid}` ? { o_reorder_1: ENTRY[rid] } : null),
      onValue: (r, cb) => { cb(snap(null)); return () => {}; },
      off: () => {},
    },
  };
}
const transforms = (marker) => ({
  'account.js': (code) => {
    const seam = 'async function ensureFirebase() {';
    assert.strictEqual(code.split(seam).length, 2, 'premise: account.js has exactly one ensureFirebase');
    return `try { localStorage.setItem(${JSON.stringify(marker)}, ${JSON.stringify(JSON.stringify({ uid: 'u_reorder', name: 'Ana Pérez', phone: '+50499990000' }))}); } catch (_) {}\n`
      + code.replace(seam, `${seam} if (window.__FB_FAKE) return window.__FB_FAKE;`);
  },
});
async function page(b) {
  const B = BRAND[b.dir];
  const w = loadForm(b.dir, { transforms: transforms(b.marker) });
  w.__FB_FAKE = fakeFirebase(b.rid);
  await settle();
  await serve(w, envelope(B.rid, B.menu(w)));                       // the live menu, applied as in production
  return w;
}
// chip → sheet → "Mis pedidos" → "Reordenar" [→ the smart-cart prompt's choice]
async function reorderViaUI(w, choice) {
  const chip = w.document.querySelector('#acct-chip button');
  assert.ok(chip && /Ana/.test(chip.textContent), 'premise — the signed-in chip');
  chip.click(); await settle();
  const row = w.document.getElementById('acct-row-orders');
  assert.ok(row, 'premise — the account sheet shows "Mis pedidos"');
  row.click(); await settle(); await settle();
  const btn = w.document.querySelector('#acct-pane-orders .acct-ordreorder');
  assert.ok(btn, 'premise — the history pane lists the order with a Reordenar button');
  btn.click(); await settle(); await settle();
  if (choice) {
    const p = w.document.getElementById(choice === 'add' ? 'acct-ro-add' : 'acct-ro-replace');
    assert.ok(p, `premise — the smart-cart prompt offers "${choice}"`);
    p.click(); await settle(); await settle();
  } else {
    assert.strictEqual(w.document.getElementById('acct-ro-add'), null, 'premise — an empty cart reorders without the prompt');
  }
}
const cartKeys = (w) => JSON.parse(JSON.stringify(w.eval('cartLines().map(l => [String(l.key), l.qty])')));
const sorted = (a) => a.map(([k, n]) => [String(k), n]).sort();
const pill = (w) => w.document.getElementById('cart-total').textContent;
// the REAL checkout body: buildOrder() → currentOrder (both forms send `items: redeemCartItems()` and `total: calcTotal()`)
function checkout(w) {
  assert.strictEqual(w.buildOrder(), true, 'buildOrder accepts the cart (no conflict blocks the send)');
  return JSON.parse(JSON.stringify(w.eval('({ items: currentOrder.items, total: currentOrder.total })')));
}
const lineTotal = (items) => items.reduce((t, i) => t + i.price * i.qty + (i.extrasTotal || 0), 0);   // x_pizza's subtotal excludes extras, la_musa's includes them

function assertFilled(w, b, { lines, total }) {
  assert.deepStrictEqual(cartKeys(w), lines.map(([id, n]) => [String(id), n]), `🔴 ${b.rid}: CART holds the reordered lines`);
  assert.strictEqual(w.calcTotal(), total, `🔴 ${b.rid}: calcTotal is the reordered cart at today's prices`);
  assert.strictEqual(pill(w), `L ${total}`, `🔴 ${b.rid}: the cart pill shows it`);
  for (const id of b.cards) {
    const n = lines.find(([k]) => String(k) === String(id))[1];
    // A card in the cart shows its quantity in ONE of its two real states: the open stepper, or — once any click lands
    // outside it (the form's own registerOutsideClick, which this UI chain's clicks can trigger) — the collapsed badge.
    // Either way it is never back in its zero state ("+" only), which is what the owner saw.
    const controls = w.document.getElementById(`qty-controls-${id}`);
    const num = w.document.getElementById(`qty-${id}`);
    const badge = w.document.getElementById(`qty-badge-${id}`);
    const badgeNum = w.document.getElementById(`qty-badge-num-${id}`);
    const addBtn = w.document.getElementById(`qty-add-${id}`);
    assert.ok(controls && num && badge && badgeNum && addBtn, `premise — card ${id} is on the grid`);
    const open = controls.classList.contains('visible');
    const collapsed = badge.style.display !== 'none';
    assert.ok(open || collapsed, `🔴 ${b.rid}: card ${id} shows its stepper or its quantity badge`);
    assert.strictEqual(addBtn.style.display, 'none', `🔴 ${b.rid}: card ${id} is not in its zero state`);
    assert.strictEqual((open ? num : badgeNum).textContent, String(n), `🔴 ${b.rid}: card ${id} shows its quantity`);
  }
  for (const id of b.noCard) assert.strictEqual(w.document.getElementById(`card-${id}`), null, `${b.rid}: ${id} is a choice of a group — no card of its own (by design)`);
  const body = checkout(w);
  assert.deepStrictEqual(body.items.map((i) => i.qty), lines.map(([, n]) => n), `🔴 ${b.rid}: the checkout body carries every reordered line`);
  assert.strictEqual(body.total, total, `🔴 ${b.rid}: the checkout body's total`);
  assert.strictEqual(lineTotal(body.items), total, `🔴 ${b.rid}: …and its lines (extras included) sum to it`);
}

// ── 1. an empty cart: Reordenar fills it — both forms ───────────────────────────────────────────────────────────────
for (const b of BRANDS) {
  const w = await page(b);
  await reorderViaUI(w, null);
  assertFilled(w, b, b);
  assert.strictEqual((w.document.getElementById('acct-toast') || {}).textContent, '1 producto ya no está disponible', `${b.rid}: the off-menu line produced today's notice`);
}
ok('an empty cart: chip → Mis pedidos → Reordenar fills it on both forms — steppers, pill, CART, calcTotal and the real checkout body (items + total); the off-menu line gets today\'s notice');

// ── 2. a non-empty cart, through the real prompt: "Agregar" merges, "Empezar de nuevo" replaces — both forms ────────
for (const b of BRANDS) {
  for (const choice of ['add', 'replace']) {
    const w = await page(b);
    w.chg(b.other.id, 1); await settle();
    assert.strictEqual(w.calcTotal(), b.other.price, `${b.rid}: premise — one ${b.other.id} already in the cart`);
    await reorderViaUI(w, choice);
    if (choice === 'add') {
      assert.deepStrictEqual(sorted(cartKeys(w)), sorted([[b.other.id, 1], ...b.lines]), `🔴 ${b.rid}: "Agregar" keeps the existing line and adds the reorder`);
      assert.strictEqual(w.calcTotal(), b.other.price + b.total, `🔴 ${b.rid}: …and the total is both`);
      assert.strictEqual(pill(w), `L ${b.other.price + b.total}`, `🔴 ${b.rid}: the pill shows both`);
      assert.strictEqual(checkout(w).total, b.other.price + b.total, `🔴 ${b.rid}: the checkout body is the merged cart`);
    } else {
      assertFilled(w, b, b);
      const c = w.document.getElementById(`qty-controls-${b.other.id}`);
      assert.ok(c && !c.classList.contains('visible'), `🔴 ${b.rid}: the replaced dish's card is back to its zero state`);
    }
  }
}
ok('a non-empty cart, through the real prompt on both forms: "Agregar a mi pedido" merges (lines, pill, checkout body), "Empezar de nuevo" leaves ONLY the reorder');

/* ── 3. THE CAPTURED-OPTIONS LEDGER (codex r1 P2) — both forms ───────────────────────────────────────────────────────
   The customer chose the recipe's extra by hand earlier (captured at its price), the merchant then re-prices it +L11,
   and the customer reorders:
     "Empezar de nuevo" = a WHOLE NEW cart → the reorder's extra is captured at TODAY's price: no conflict, and the pill,
                          CART and the checkout body carry the new price;
     "Agregar"          = a merge → the earlier capture is KEPT (the price that customer agreed to); the re-price surfaces
                          exactly as it does for an extra toggled by hand. */
async function capturedThenRepriced(b) {
  const B = BRAND[b.dir];
  const w = await page(b);
  w.chg(b.extra.on, 1); await settle();
  b.extra.toggle(w); await settle();
  const m = B.menu(w); m.extras = m.extras.map((e) => (e.id === b.extra.id ? { ...e, price: e.price + 11 } : e));
  await serve(w, envelope(B.rid, m));
  assert.strictEqual(w.liveMenuGlobalGet('EXTRAS').find((e) => e.id === b.extra.id).price, b.extra.price + 11, `${b.rid}: premise — the extra was re-priced live`);
  return w;
}
const conflicts = (w) => JSON.parse(JSON.stringify(w.eval('cartConflicts().map(c => String(c.key))'))).sort();
const agreedExtraPrice = (w, id) => w.eval(`(function(){ const ex = findMenuExtra(${JSON.stringify(id)}); const k = CART.noteExtra(ex); return CART.extraAgreed(k).price; })()`);
for (const b of BRANDS) {
  {
    const w = await capturedThenRepriced(b);
    assert.ok(conflicts(w).length > 0, `${b.rid}: premise — the hand-chosen extra, re-priced, is surfaced (not silently adopted)`);
    await reorderViaUI(w, 'replace');
    assert.deepStrictEqual(conflicts(w), [], `🔴 ${b.rid}: "Empezar de nuevo" carries NO captured price from the discarded cart (no conflict)`);
    assertFilled(w, b, { lines: b.lines, total: b.total + 11 });
  }
  {
    const w = await capturedThenRepriced(b);
    const before = conflicts(w);
    await reorderViaUI(w, 'add');
    assert.ok(conflicts(w).length > 0 && before.every((k) => conflicts(w).includes(k)), `🔴 ${b.rid}: "Agregar" keeps the ledger — the earlier capture still stands against the re-price`);
    assert.strictEqual(agreedExtraPrice(w, b.extra.id), b.extra.price, `🔴 ${b.rid}: the agreed price after the merge is the ORIGINAL L ${b.extra.price}, not the re-price`);
  }
}
ok('the captured-options ledger, on both forms: after a +L11 re-price, "Empezar de nuevo" captures the reorder\'s extra at today\'s price (no conflict; pill, CART, checkout at +11) while "Agregar" keeps the earlier agreed price');

closeAll();
console.log('\nreorder-whole-page: OK');
