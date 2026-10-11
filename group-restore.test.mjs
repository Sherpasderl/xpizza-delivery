// 1D add-product B (codex PB-2 r1: P1, P2-2, P2-3) — a bare LAUNCHER never reaches a charge, on BOTH forms (real page, jsdom).
// Run: node group-restore.test.mjs
//   P1  a cart saved BEFORE its dish became a launcher (the real snapshotForm() of a page with no group), restored on a
//       page where it is one — through the PAYMENT-RETURN restore (restoreOrderForm) and the SELF-UPDATE restore
//       (order-self-update.js afterReload): the launcher line stays visible and BLOCKED ('choice'), the customer is told
//       "Elegí de nuevo tu …", buildOrder() refuses, and removing the line lets the rest through. A dish that becomes a
//       launcher WHILE in the cart (a live update) is blocked the same way. buildOrder() refuses on the RAW cart even if
//       the resolution's marking were lost (the send boundary stands on its own).
//   P2-2 a group in a layout:'list' category renders the launcher's single "+" that opens the picker; no control and no
//       direct chg()/cartSync() write can give a launcher quantity — on both forms.
//   P2-3 a restored reward whose dish's LAUNCHER is 86'd is dropped with a notice (the parent-or-variant reader).
import assert from 'node:assert';
import { loadForm, settle, serve, envelope, loadAvail, closeAll, counter, BRAND } from './form-harness.mjs';

const { ok } = counter();
const plain = (o) => JSON.parse(JSON.stringify(o));
const conflicts = (w) => plain(w.eval('cartConflicts().map(l => [String(l.key), l.unresolved])'));
const cartKeys = (w) => plain(w.eval('cartLines().map(l => [String(l.key), l.qty])'));
const errText = (w) => (w.document.getElementById('err3') || w.document.getElementById('err1') || {}).textContent || '';
const toastText = (w) => (w.document.getElementById('acct-toast') || {}).textContent || '';
const isLauncher = (w, id) => plain(w.eval(`itemIsLauncher(findMenuItem(${JSON.stringify(id)}))`));
const STASH = { 'xpizza-orders': 'xpizza_pending_pay', 'la-musa-orders': 'lamusa_pending_pay' };

/* The self-update adapter registers with window.SherpaClient; the page is unstamped here, so a minimal ACTIVE client is
   installed before order-self-update.js runs, and it hands back the adapter — whose afterReload is the real restore. */
const selfUpdateSeam = {
  'order-self-update.js': (code) => 'window.SherpaClient = { inert: false, registerAdapter: function (a) { window.__PSU_ADAPTER = a; } };\n' + code,
};

// ── the brands' fixtures: one dish that is ORDINARY on the first page and a LAUNCHER on the second ──────────────────
const FIX = {
  'xpizza-orders': {
    launcher: 30, other: null, label: 'salsa', name: 'NY Plain Slice',
    noGroup: (w) => { const m = BRAND['xpizza-orders'].menu(w); m.dishes = m.dishes.filter((d) => !d.variantOf && d.id !== 30); m.dishes.push({ id: 30, cat: 'ny', name: 'NY Plain Slice', price: 624 }); m.variant_items = {}; return m; },
    group: (w) => {
      const m = BRAND['xpizza-orders'].menu(w); m.dishes = m.dishes.filter((d) => d.id !== 30 && !d.variantOf);
      m.dishes.push({ id: 30, cat: 'ny', name: 'NY Plain Slice', price: 624 });
      [['Salsa Roja', 31, 624], ['Salsa Vodka', 32, 644], ['Combinada', 33, 654]].forEach(([c, id, p]) => m.dishes.push({ id, cat: 'ny', name: `NY Plain Slice - ${c}`, price: p, variantOf: 30, choice: c }));
      m.variant_items = { 30: { label: 'Salsa', basePrice: 624, variantIds: [31, 32, 33] } };
      return m;
    },
  },
  'la-musa-orders': {
    launcher: 'noodle_01', other: 'dimsum_01', label: 'proteína', name: 'Pad Thai',
    noGroup: (w) => { const m = BRAND['la-musa-orders'].menu(w); m.dishes = m.dishes.filter((d) => !d.variantOf); m.variant_items = {}; return m; },
    group: null,   // the bundled Pad Thai group
  },
};
const otherOf = (w, dir) => FIX[dir].other || plain(w.eval('MENU.find(p => !p.variantOf && p.price > 0 && !itemIsLauncher(p)).id'));

// the menu WITH the group, as served: x_pizza's fixture, or la_musa's bundled Pad Thai group read off a fresh page
async function groupMenu(dir) {
  const f = loadForm(dir); await settle();
  if (FIX[dir].group) return FIX[dir].group(f);
  const m = BRAND[dir].menu(f); m.variant_items = plain(f.eval('VARIANT_ITEMS')); return m;
}
async function groupPage(dir, opts) {
  const w = loadForm(dir, opts); await settle();
  if (FIX[dir].group) await serve(w, envelope(BRAND[dir].rid, FIX[dir].group(w)));
  return w;
}
// the REAL writer: a page where the dish is ordinary — the customer adds it, the form snapshots itself
async function savedBeforeGroup(dir) {
  const w = loadForm(dir); await settle();
  await serve(w, envelope(BRAND[dir].rid, FIX[dir].noGroup(w)));
  const L = FIX[dir].launcher; const O = otherOf(w, dir);
  assert.strictEqual(isLauncher(w, L), false, `${dir}: premise — ${L} is an ordinary dish on the first page`);
  w.chg(L, 1); w.chg(O, 1);
  assert.deepStrictEqual(cartKeys(w).map((k) => k[0]).sort(), [String(L), String(O)].sort(), `${dir}: premise — both lines are in the saved cart`);
  return { snap: plain(w.snapshotForm()), O };
}
function assertBlockedThenRemovable(w, dir, O, how, { toldAtOnce }) {
  const L = FIX[dir].launcher;
  const told = `Elegí de nuevo tu ${FIX[dir].label} para ${FIX[dir].name}.`;
  assert.strictEqual(isLauncher(w, L), true, `${dir} ${how}: premise — ${L} is a launcher on this page`);
  assert.deepStrictEqual(conflicts(w), [[String(L), 'choice']], `🔴 ${dir} ${how}: the launcher line is BLOCKED ('choice'), the rest is not`);
  if (toldAtOnce) assert.strictEqual(errText(w), told, `🔴 ${dir} ${how}: the customer is told at once to choose again`);
  assert.strictEqual(w.buildOrder(), false, `🔴 ${dir} ${how}: buildOrder() refuses — no body with a bare launcher`);
  assert.strictEqual(errText(w), told, `🔴 ${dir} ${how}: the refusal tells the customer to choose again`);
  w.chg(L, -1);
  assert.deepStrictEqual(cartKeys(w), [[String(O), 1]], `${dir} ${how}: removing the launcher line leaves the rest`);
  assert.strictEqual(w.buildOrder(), true, `${dir} ${how}: …which then builds`);
}

for (const dir of ['xpizza-orders', 'la-musa-orders']) {
  // ── P1: payment-return restore ──────────────────────────────────────────────────────────────────────────────────
  {
    const { snap, O } = await savedBeforeGroup(dir);
    const w = await groupPage(dir);
    w.localStorage.setItem(STASH[dir], JSON.stringify({ order_id: 'o_restore', ts: Date.now(), form: snap }));
    w.restoreOrderForm(); await settle();
    assertBlockedThenRemovable(w, dir, O, 'payment-return restore', { toldAtOnce: true });
  }
  // ── P1: self-update restore (the 426 / update reload) ───────────────────────────────────────────────────────────
  {
    const { snap, O } = await savedBeforeGroup(dir);
    const w = await groupPage(dir, { transforms: selfUpdateSeam });
    assert.ok(w.__PSU_ADAPTER && typeof w.__PSU_ADAPTER.afterReload === 'function', `${dir}: premise — the self-update adapter registered`);
    w.__PSU_ADAPTER.afterReload({ v: 1, mode: 'menu', form: snap }); await settle();
    assertBlockedThenRemovable(w, dir, O, 'self-update restore', { toldAtOnce: true });
  }
  // ── P1: a dish that becomes a launcher WHILE in the cart (a live update) ────────────────────────────────────────
  {
    const w = loadForm(dir); await settle();
    await serve(w, envelope(BRAND[dir].rid, FIX[dir].noGroup(w)));
    const L = FIX[dir].launcher; const O = otherOf(w, dir);
    w.chg(L, 1); w.chg(O, 1);
    await serve(w, envelope(BRAND[dir].rid, await groupMenu(dir)));
    assertBlockedThenRemovable(w, dir, O, 'live update made it a launcher', { toldAtOnce: false });
  }
  // ── P1: the send boundary stands on its own (the resolution's marking removed) ──────────────────────────────────
  {
    const { snap } = await savedBeforeGroup(dir);
    const w = await groupPage(dir);
    w.localStorage.setItem(STASH[dir], JSON.stringify({ order_id: 'o_restore', ts: Date.now(), form: snap }));
    w.restoreOrderForm(); await settle();
    w.GroupPicker.markLauncherLines = (lines) => lines;   // as if cartLines() stopped marking
    assert.deepStrictEqual(conflicts(w), [], `${dir}: premise — with the marking removed, no conflict is reported`);
    const warned = [];
    const prev = w.console.warn; w.console.warn = (...a) => { warned.push(String(a[0])); };
    assert.strictEqual(w.buildOrder(), false, `🔴 ${dir}: buildOrder() still refuses — it reads the RAW cart`);
    w.console.warn = prev;
    assert.ok(warned.includes('cart_blocked_build_launcher'), `${dir}: …and says why`);
  }
  ok(`${dir}: a cart saved before its group, restored through payment return AND self-update, keeps the launcher line visible + BLOCKED ('choice') with "Elegí de nuevo tu ${FIX[dir].label} para ${FIX[dir].name}."; buildOrder refuses (also on the raw cart alone); a live update that makes an in-cart dish a launcher is blocked the same way; removing the line lets the rest build`);

  // ── P2-2: no control and no direct write gives a launcher quantity ──────────────────────────────────────────────
  {
    const w = await groupPage(dir);
    const L = FIX[dir].launcher;
    w.chg(L, 1);
    assert.deepStrictEqual(cartKeys(w), [], `🔴 ${dir}: chg(launcher, +1) adds nothing`);
    w.eval(`qty[${JSON.stringify(L)}] = 2; cartSync(${JSON.stringify(L)});`);
    assert.deepStrictEqual(cartKeys(w), [], `🔴 ${dir}: the write point (cartSync) refuses a launcher's quantity`);
    assert.strictEqual(plain(w.eval(`qty[${JSON.stringify(L)}]`)), 0, `${dir}: qty follows the cart (0)`);
  }
}
ok('both forms: chg(launcher, +1) and a direct cartSync write leave the cart empty (the quantity write point refuses a launcher)');

// ── P2-2: a group in a layout:'list' category (la_musa's list rows; x_pizza has no list layout) ──────────────────────
{
  const dir = 'la-musa-orders'; const B = BRAND[dir];
  const w = loadForm(dir); await settle();
  const m = B.menu(w);
  const list = m.categories.find((c) => c.layout === 'list');
  assert.ok(list, 'premise — la_musa has a list-layout category');
  const sub = Array.isArray(list.subcats) && list.subcats.length ? { subcat: list.subcats[0] } : {};   // a sub-grouped list renders by subcat
  m.dishes.push({ id: 'soda_grp', cat: list.id, name: 'Sodas', price: 40, ...sub });
  [['Coca', 'soda_grp_coca', 40], ['Sprite', 'soda_grp_sprite', 45]].forEach(([c, id, p]) => m.dishes.push({ id, cat: list.id, name: `Sodas - ${c}`, price: p, variantOf: 'soda_grp', choice: c, ...sub }));
  m.variant_items = Object.assign(plain(w.eval('VARIANT_ITEMS')), { soda_grp: { label: 'Sabor', basePrice: 40, variantIds: ['soda_grp_coca', 'soda_grp_sprite'] } });
  await serve(w, envelope(B.rid, m));
  assert.strictEqual(isLauncher(w, 'soda_grp'), true, 'premise — the list-category group is a launcher');
  const row = w.document.getElementById('card-soda_grp');
  assert.ok(row && row.classList.contains('bev-row'), 'premise — it renders as a list row');
  const btns = [...row.querySelectorAll('[data-act]')].map((b) => b.getAttribute('data-act'));
  assert.deepStrictEqual(btns, ['open'], '🔴 the launcher row carries ONE control, and it opens the picker (no plain stepper)');
  assert.strictEqual(row.querySelector('.bev-row-price').textContent, 'desde L 40', 'the row shows the derived price');
  row.querySelector('[data-act="open"]').click(); await settle();
  assert.ok(w.document.querySelector('.detail-overlay.open'), '🔴 tapping "+" opens the picker');
  assert.deepStrictEqual(cartKeys(w), [], '…and adds nothing');
  // a stale stepper (as before this fix) — its "inc" opens the picker too, never a cart line
  const fake = w.document.createElement('button'); fake.setAttribute('data-act', 'inc'); fake.setAttribute('data-id', 'soda_grp'); w.document.body.appendChild(fake);
  w.closeDetailModal(); await settle();
  assert.ok(!w.document.querySelector('.detail-overlay.open'), 'premise — the picker is closed again');
  fake.click(); await settle();
  assert.ok(w.document.querySelector('.detail-overlay.open'), '🔴 an "inc" control on a launcher OPENS its picker (the delegate rule, as on x_pizza)');
  assert.deepStrictEqual(cartKeys(w), [], '🔴 …and adds nothing');
  ok('la_musa: a group in a layout:\'list\' category renders the launcher\'s single "+" (derived price) that opens the picker; an "inc" on it adds nothing');
}

// ── P2-3: a restored reward whose launcher is 86'd is dropped with a notice ─────────────────────────────────────────
{
  const w = loadForm('la-musa-orders'); await settle();
  await loadAvail(w, { [w.availKey('noodle_01')]: { available: false } });
  assert.strictEqual(w.soldOutById('noodle_01_pollo'), true, 'premise — Pollo reads sold out through its 86\'d launcher');
  w.__ACCOUNT.restoreRedeem({ type: 'points_ala_carte', items: [{ id: 'noodle_01_pollo', qty: 1, name: 'Pad Thai - Pollo' }] }, null, null);
  await settle();
  assert.strictEqual(plain(w.__ACCOUNT.getRedeemPayload()), null, '🔴 la_musa: the restored Pollo reward is dropped (Pad Thai 86\'d)');
  assert.strictEqual(toastText(w), 'Tu premio ya no está disponible. Elegí otro.', 'la_musa: …with the notice');
  await loadAvail(w, {});
  w.__ACCOUNT.restoreRedeem({ type: 'points_ala_carte', items: [{ id: 'noodle_01_pollo', qty: 1, name: 'Pad Thai - Pollo' }] }, null, null);
  assert.ok(plain(w.__ACCOUNT.getRedeemPayload()), 'la_musa: available again → the reward is kept (sensitivity)');
  ok('la_musa: Pad Thai 86\'d → a restored Pollo reward is dropped with "Tu premio ya no está disponible. Elegí otro."; available → kept');
}
{
  const dir = 'xpizza-orders'; const B = BRAND[dir];
  const w = loadForm(dir); await settle();
  const m = B.menu(w);
  m.dishes.push({ id: 40, cat: 'individual', name: 'Slice Duo', price: 300 });
  m.dishes.push({ id: 41, cat: 'individual', name: 'Slice Duo - Roja', price: 300, variantOf: 40, choice: 'Roja' });
  m.dishes.push({ id: 42, cat: 'individual', name: 'Slice Duo - Blanca', price: 320, variantOf: 40, choice: 'Blanca' });
  m.variant_items = { 40: { label: 'Salsa', basePrice: 300, variantIds: [41, 42] } };
  await serve(w, envelope(B.rid, m));
  await loadAvail(w, { [w.availKey('Slice Duo')]: { available: false } });
  w.__ACCOUNT.restoreRedeem({ type: 'free_pizza_choice', item_id: 'Slice Duo - Blanca', name: 'Slice Duo - Blanca' }, null, null);
  await settle();
  assert.strictEqual(plain(w.__ACCOUNT.getRedeemPayload()), null, '🔴 x_pizza: the restored choice reward is dropped (its launcher 86\'d)');
  assert.strictEqual(toastText(w), 'Tu premio ya no está disponible. Elegí otro.');
  ok('x_pizza: a restored choice reward whose launcher is 86\'d is dropped with the notice');
}

closeAll();
console.log('\ngroup-restore: OK');
