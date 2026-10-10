// HOTFIX (owner-confirmed live, 2026-10-09): "Reordenar" left the cart EMPTY — nothing on the cards, total L 0.
// Run: node reorder-whole-page.test.mjs
// The WHOLE customer chain, on both forms, through the real page: a signed-in customer (the account marker), the live
// menu applied as in production, the account chip → "Mis pedidos" (the real history pane, reading user_orders entries
// in the exact shape createOrder writes — create-order-build.js attachCustomerAttribution) → tap "Reordenar". The ONLY
// seam is account.js's Firebase SDK (a dynamic https import jsdom cannot run), replaced by a fake that serves the
// history read; the pane, the button, the reorder reader and the form's cart are all as shipped.
// Asserted where the customer and the order see it: the card steppers, CART (cartLines), calcTotal, the cart pill, and
// the checkout serialization (buildOrder) — plus the existing "no longer available" notice for an off-menu line.
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
// What each recipe must restore: [dish id, qty] and the expected total from the LIVE menu.
const WANT = {
  x_pizza: { lines: [[2, 2], [19, 1]], total: 2 * 340 + 624 + 39 },
  la_musa: { lines: [['dimsum_01', 2], ['noodle_01_pollo', 1]], total: 2 * 223 + 50 + 342 },
};

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
const transforms = (rid, marker) => ({
  'account.js': (code) => {
    const seam = 'async function ensureFirebase() {';
    assert.strictEqual(code.split(seam).length, 2, 'premise: account.js has exactly one ensureFirebase');
    return `try { localStorage.setItem(${JSON.stringify(marker)}, ${JSON.stringify(JSON.stringify({ uid: 'u_reorder', name: 'Ana Pérez', phone: '+50499990000' }))}); } catch (_) {}\n`
      + code.replace(seam, `${seam} if (window.__FB_FAKE) return window.__FB_FAKE;`);
  },
});

for (const [dir, rid, marker] of [['xpizza-orders', 'x_pizza', 'xpizza_acct'], ['la-musa-orders', 'la_musa', 'lamusa_acct']]) {
  const B = BRAND[dir];
  const w = loadForm(dir, { transforms: transforms(rid, marker) });
  w.__FB_FAKE = fakeFirebase(rid);
  await settle();
  await serve(w, envelope(B.rid, B.menu(w)));                       // the live menu, applied as in production
  const toasts = [];
  const toastEl = () => w.document.querySelector('.acct-toast, #acct-toast');

  // chip → sheet → "Mis pedidos" → "Reordenar"
  const chip = w.document.querySelector('#acct-chip button');
  assert.ok(chip && /Ana/.test(chip.textContent), `${rid}: premise — the signed-in chip`);
  chip.click(); await settle();
  const row = w.document.getElementById('acct-row-orders');
  assert.ok(row, `${rid}: premise — the account sheet shows "Mis pedidos"`);
  row.click(); await settle(); await settle();
  const btn = w.document.querySelector('#acct-pane-orders .acct-ordreorder');
  assert.ok(btn, `${rid}: premise — the history pane lists the order with a Reordenar button`);
  const obs = new w.MutationObserver(() => { const t = toastEl(); if (t && t.textContent) toasts.push(t.textContent.trim()); });
  obs.observe(w.document.body, { childList: true, subtree: true, characterData: true });
  btn.click(); await settle(); await settle();
  obs.disconnect();

  // ── what the customer and the order see ──
  const lines = w.eval('cartLines().map(l => [String(l.key), l.qty])');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(lines)), WANT[rid].lines.map(([id, n]) => [String(id), n]), `🔴 ${rid}: CART holds the reordered lines`);
  assert.strictEqual(w.calcTotal(), WANT[rid].total, `🔴 ${rid}: the total is the reordered order at today's prices`);
  for (const [id, n] of WANT[rid].lines) {
    const num = w.document.getElementById(`qty-${id}`) || w.document.getElementById(`qty-badge-num-${id}`);
    if (num) assert.strictEqual(num.textContent, String(n), `🔴 ${rid}: card ${id} shows its quantity`);
  }
  const visibleControls = WANT[rid].lines.filter(([id]) => { const c = w.document.getElementById(`qty-controls-${id}`); return c && c.classList.contains('visible'); }).length;
  const anyCard = WANT[rid].lines.some(([id]) => w.document.getElementById(`qty-controls-${id}`));
  if (anyCard) assert.ok(visibleControls > 0, `🔴 ${rid}: the reordered cards show their steppers`);
  // the checkout body's items are redeemCartItems() (buildOrder: `items: redeemCartItems()`, both forms); buildOrder itself
  // also needs the customer's details, which this chain does not fill, so its item serializer is asserted directly
  assert.strictEqual(w.eval('cartConflicts().length'), 0, `🔴 ${rid}: the reordered cart carries no conflict that would block the send`);
  const sent = JSON.parse(JSON.stringify(w.eval('redeemCartItems()')));
  assert.deepStrictEqual(sent.map((i) => i.qty), WANT[rid].lines.map(([, n]) => n), `🔴 ${rid}: the checkout serializes every reordered line`);
  assert.strictEqual(sent.reduce((t, i) => t + i.price * i.qty + (i.extrasTotal || 0), 0), WANT[rid].total, `🔴 ${rid}: …at the same total, extras included`);
  assert.ok(toasts.some((t) => /ya no está disponible/.test(t)) || /ya no está disponible/.test(w.document.body.textContent),
    `${rid}: the off-menu line produced today's notice`);
  ok(`${rid}: chip → Mis pedidos → Reordenar fills the cart — CART lines, L ${WANT[rid].total}, steppers, the checkout items; the off-menu line gets today's notice`);
}

// ── a NON-EMPTY cart: the real smart-cart prompt — "Agregar a mi pedido" merges, "Empezar de nuevo" replaces — on both ──
async function openHistoryAndReorder(w, choice) {
  w.document.querySelector('#acct-chip button').click(); await settle();
  w.document.getElementById('acct-row-orders').click(); await settle(); await settle();
  w.document.querySelector('#acct-pane-orders .acct-ordreorder').click(); await settle();
  const btn = w.document.getElementById(choice === 'add' ? 'acct-ro-add' : 'acct-ro-replace');
  assert.ok(btn, `premise — the smart-cart prompt offers ${choice}`);
  btn.click(); await settle(); await settle();
}
for (const [dir, rid, marker, other, otherPrice] of [['xpizza-orders', 'x_pizza', 'xpizza_acct', 3, 337], ['la-musa-orders', 'la_musa', 'lamusa_acct', 'dimsum_03', 198]]) {
  for (const choice of ['add', 'replace']) {
    const B = BRAND[dir];
    const w = loadForm(dir, { transforms: transforms(rid, marker) });
    w.__FB_FAKE = fakeFirebase(rid);
    await settle();
    await serve(w, envelope(B.rid, B.menu(w)));
    w.chg(other, 1); await settle();
    assert.strictEqual(w.calcTotal(), otherPrice, `${rid}: premise — one ${other} already in the cart`);
    await openHistoryAndReorder(w, choice);
    const keys = JSON.parse(JSON.stringify(w.eval('cartLines().map(l => String(l.key))'))).sort();
    const reordered = WANT[rid].lines.map(([id]) => String(id));
    if (choice === 'add') {
      assert.deepStrictEqual(keys, [String(other), ...reordered].sort(), `🔴 ${rid}: "Agregar" keeps the existing line and adds the reorder`);
      assert.strictEqual(w.calcTotal(), otherPrice + WANT[rid].total, `🔴 ${rid}: …and the total is both`);
    } else {
      assert.deepStrictEqual(keys, [...reordered].sort(), `🔴 ${rid}: "Empezar de nuevo" leaves ONLY the reorder in CART`);
      assert.strictEqual(w.calcTotal(), WANT[rid].total, `🔴 ${rid}: …and the total is the reorder alone`);
      const c = w.document.getElementById(`qty-controls-${other}`);
      if (c) assert.ok(!c.classList.contains('visible'), `🔴 ${rid}: the replaced dish's card is back to its zero state`);
    }
  }
}
ok('a non-empty cart, through the real prompt: "Agregar a mi pedido" merges (both lines, both totals), "Empezar de nuevo" leaves only the reorder in CART — both forms');

// ── an extra restored by reorder is CAPTURED like a toggled one: a later re-price surfaces exactly as it does for a toggle ──
{
  const conflictsAfterReprice = async (via) => {
    const dir = 'xpizza-orders'; const B = BRAND[dir];
    const w = loadForm(dir, { transforms: transforms('x_pizza', 'xpizza_acct') });
    w.__FB_FAKE = fakeFirebase('x_pizza');
    await settle();
    await serve(w, envelope(B.rid, B.menu(w)));
    if (via === 'reorder') {
      w.document.querySelector('#acct-chip button').click(); await settle();
      w.document.getElementById('acct-row-orders').click(); await settle(); await settle();
      w.document.querySelector('#acct-pane-orders .acct-ordreorder').click(); await settle(); await settle();
    } else {
      w.chg(2, 2); w.chg(19, 1); await settle();
      w.toggleDetailExtra('e1', 19, 0); await settle();
    }
    const m = B.menu(w); m.extras = m.extras.map((e) => (e.id === 'e1' ? { ...e, price: e.price + 11 } : e));
    await serve(w, envelope(B.rid, m));
    return JSON.parse(JSON.stringify(w.eval('cartConflicts().map(c => [String(c.key), c.unresolved || c.kind || null])')));
  };
  const viaToggle = await conflictsAfterReprice('toggle');
  const viaReorder = await conflictsAfterReprice('reorder');
  assert.ok(viaToggle.length > 0, 'premise: a re-priced option the customer chose is surfaced, not silently adopted');
  assert.deepStrictEqual(viaReorder, viaToggle, '🔴 a reordered extra is captured exactly like a toggled one (same conflict after a re-price)');
  ok('a reordered extra is captured as priced at reorder time — after a re-price it surfaces exactly as a toggled extra does');
}

closeAll();
console.log('\nreorder-whole-page: OK');
