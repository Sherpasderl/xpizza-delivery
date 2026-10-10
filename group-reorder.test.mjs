// 1D add-product B (rev 6, §0b.9 / §0c.2) — REORDER with required-choice groups, on BOTH forms, through the WHOLE page.
// Run: node group-reorder.test.mjs
// The same chain as reorder-whole-page.test.mjs (the reorder hotfix): a signed-in customer, the live menu applied as in
// production, chip → "Mis pedidos" → tap "Reordenar" on a user_orders entry in the shape createOrder writes. The ONLY
// seam is account.js's Firebase SDK. Asserted at the CART / checkout level: a variant line restores as that variant
// (CART line, calcTotal, the real buildOrder() body); a legacy BARE launcher line is dropped and counted in today's
// notice — never a cart line, never charged; a choice of an 86'd launcher is dropped.
import assert from 'node:assert';
import { loadForm, settle, serve, envelope, loadAvail, closeAll, counter, BRAND } from './form-harness.mjs';

const { ok } = counter();

function fakeFirebase(entry) {
  const snap = (v) => ({ exists: () => v != null, val: () => v });
  const user = { uid: 'u_reorder', getIdToken: async () => 'tok' };
  return {
    app: {}, db: {},
    auth: { currentUser: user, authStateReady: async () => {} },
    authMod: { onAuthStateChanged: (a, cb) => { cb(user); return () => {}; }, signOut: async () => {} },
    dbMod: { ref: (db, path) => ({ path }), get: async (r) => snap(r && r.path === `user_orders/${user.uid}` ? { o1: entry } : null), onValue: (r, cb) => { cb(snap(null)); return () => {}; }, off: () => {} },
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
async function reorderViaUI(w) {
  w.document.querySelector('#acct-chip button').click(); await settle();
  w.document.getElementById('acct-row-orders').click(); await settle(); await settle();
  const btn = w.document.querySelector('#acct-pane-orders .acct-ordreorder');
  assert.ok(btn, 'premise — the history pane lists the order with a Reordenar button');
  btn.click(); await settle(); await settle();
}
const cartKeys = (w) => JSON.parse(JSON.stringify(w.eval('cartLines().map(l => [String(l.key), l.qty])')));
const toast = (w) => (w.document.getElementById('acct-toast') || {}).textContent || '';
function checkout(w) {
  assert.strictEqual(w.buildOrder(), true, 'buildOrder accepts the cart');
  return JSON.parse(JSON.stringify(w.eval('({ items: currentOrder.items.map(i => [i.name, i.qty]), total: currentOrder.total })')));
}

// ── x_pizza: the served NY Plain Slice group; recipe keys are NAMES ──────────────────────────────────────────────────
async function xpPage(entry) {
  const dir = 'xpizza-orders'; const B = BRAND[dir];
  const w = loadForm(dir, { transforms: transforms('xpizza_acct') });
  w.__FB_FAKE = fakeFirebase(entry);
  await settle();
  const m = B.menu(w);
  m.dishes.push({ id: 30, cat: 'ny', name: 'NY Plain Slice', price: 624 });
  [['Salsa Roja', 31, 624], ['Salsa Vodka', 32, 644], ['Combinada', 33, 654]].forEach(([c, id, p]) => m.dishes.push({ id, cat: 'ny', name: `NY Plain Slice - ${c}`, price: p, variantOf: 30, choice: c }));
  m.variant_items = { 30: { label: 'Salsa', basePrice: 624, variantIds: [31, 32, 33] } };
  await serve(w, envelope(B.rid, m));
  return w;
}
{
  const entry = { ts: 1, total: 1932, order_type: 'pickup', restaurant: 'x_pizza', status: 'completed', items_text: 'x',
    items: [{ key: 'NY Plain Slice - Combinada', qty: 2 }, { key: 'NY Plain Slice', qty: 1 }] };
  const w = await xpPage(entry);
  await reorderViaUI(w);
  assert.deepStrictEqual(cartKeys(w), [['33', 2]], '🔴 x_pizza: CART holds the variant line only — the bare launcher is no cart line');
  assert.strictEqual(w.calcTotal(), 2 * 654, '🔴 x_pizza: the total is the variant at ITS price (never the launcher minimum)');
  assert.deepStrictEqual(checkout(w), { items: [['NY Plain Slice - Combinada', 2]], total: 1308 }, '🔴 x_pizza: the checkout body carries the variant, never the launcher');
  assert.strictEqual(toast(w), '1 producto ya no está disponible', 'x_pizza: the dropped launcher line is counted in today\'s notice');
}
{
  const entry = { ts: 1, total: 624, order_type: 'pickup', restaurant: 'x_pizza', status: 'completed', items_text: 'x', items: [{ key: 'NY Plain Slice - Salsa Roja', qty: 1 }] };
  const w = await xpPage(entry);
  await loadAvail(w, { [w.availKey('NY Plain Slice')]: { available: false } });
  await reorderViaUI(w);
  assert.deepStrictEqual(cartKeys(w), [], '🔴 x_pizza: a choice of an 86\'d launcher is not restored');
  assert.strictEqual(toast(w), 'Esos productos ya no están disponibles.');
}
ok('x_pizza reorder (whole page): a variant line restores as the variant at its price (CART, calcTotal, checkout body); a bare launcher line is dropped + counted; a choice of an 86\'d launcher is dropped');

// ── la_musa: the live Pad Thai group; recipe keys are IDS. A historical bare "Pad Thai" line (e.g. a reward) drops ──
{
  const dir = 'la-musa-orders'; const B = BRAND[dir];
  const entry = { ts: 1, total: 756, order_type: 'pickup', restaurant: 'la_musa', status: 'completed', items_text: 'x',
    items: [{ key: 'noodle_01_pollo', qty: 1 }, { key: 'noodle_01', qty: 1 }] };
  const w = loadForm(dir, { transforms: transforms('lamusa_acct') });
  w.__FB_FAKE = fakeFirebase(entry);
  await settle();
  await serve(w, envelope(B.rid, B.menu(w)));
  await reorderViaUI(w);
  assert.deepStrictEqual(cartKeys(w), [['noodle_01_pollo', 1]], '🔴 la_musa: CART holds Pad Thai - Pollo only');
  assert.strictEqual(w.calcTotal(), 342, '🔴 la_musa: L 342 — the bare noodle_01 (L 414) is never charged');
  assert.deepStrictEqual(checkout(w), { items: [['Pad Thai - Pollo', 1]], total: 342 }, '🔴 la_musa: the checkout body carries the choice only');
  assert.strictEqual(toast(w), '1 producto ya no está disponible');
  ok('la_musa reorder (whole page): Pad Thai - Pollo restores (CART, L 342, checkout body); a legacy bare Pad Thai line is dropped and counted, never charged at L 414');
}

closeAll();
console.log('\ngroup-reorder: OK');
