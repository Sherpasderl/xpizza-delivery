// Owner (2026-10-12) — a launcher card's count, through the REAL page on BOTH brands. The pill on a group's card shows the
// TOTAL of its choices in the cart (1 Salsa Roja + 1 Combinada → 2); its "+" opens the picker again; its "−" opens the cart
// sheet (which choice to remove is ambiguous; the cart has per-line steppers); removing in the cart updates the pill.
// A non-group card is unchanged. Run: node group-card-count.test.mjs
import assert from 'node:assert';
import { loadForm, settle, serve, envelope, closeAll, counter, BRAND } from './form-harness.mjs';

const { ok } = counter();
const $ = (w, id) => w.document.getElementById(id);
const click = async (w, el) => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await settle(); };
const modalOpen = (w) => $(w, 'detail-modal').classList.contains('open');
const sheetOpen = (w) => $(w, 'cart-review-sheet').classList.contains('open');
const shown = (el) => !!el && el.style.display !== 'none';

// X. Pizza: the pinned NY Plain Slice group, served the way getPublicMenu serves it once the portal publishes it.
const XP = { L: 30, A: 31, B: 32, C: 33 };
function xpGroup(w) {
  const m = BRAND['xpizza-orders'].menu(w);
  m.dishes.push({ id: XP.L, cat: 'ny', name: 'NY Plain Slice', price: 624, emoji: '🍕', color: '#C8321A', desc: 'La clásica NY Plain Slice.' });
  [['Salsa Roja', XP.A], ['Salsa Vodka', XP.B], ['Combinada', XP.C]].forEach(([choice, id]) =>
    m.dishes.push({ id, cat: 'ny', name: `NY Plain Slice - ${choice}`, price: 624, variantOf: XP.L, choice, ...(id === XP.C ? { tags: ['recommended'] } : {}) }));
  m.variant_items = { [String(XP.L)]: { label: 'Salsa', basePrice: 624, variantIds: [XP.A, XP.B, XP.C] } };
  return m;
}

const BRANDS = [
  { dir: 'xpizza-orders', L: XP.L, A: XP.A, B: XP.C, setup: async (w) => {
      await serve(w, envelope(BRAND['xpizza-orders'].rid, xpGroup(w)));
    } },
  // La Musa ships Pad Thai as a group in its bundle (noodle_01 + Sin proteína / Pollo / Camarón)
  { dir: 'la-musa-orders', L: 'noodle_01', A: 'noodle_01_pollo', B: 'noodle_01_camaron', setup: async () => {} },
];

for (const b of BRANDS) {
  const w = loadForm(b.dir);
  await settle();
  await b.setup(w);
  const card = $(w, `card-${b.L}`);
  assert.ok(card, `${b.dir}: premise — the launcher has a card`);
  const add = $(w, `qty-add-${b.L}`), controls = $(w, `qty-controls-${b.L}`), num = $(w, `qty-${b.L}`), badge = $(w, `qty-badge-${b.L}`);
  assert.ok(add && controls && num && badge, `${b.dir}: the launcher card carries the stepper, the badge and the "+"`);
  const pill = () => num.textContent;
  const plus = controls.querySelector('[data-act="inc"]'), minus = controls.querySelector('[data-act="dec"]');

  // 0 → the "+" alone; it opens the picker and adds nothing
  assert.ok(shown(add) && !controls.classList.contains('visible'), `${b.dir}: empty → only the "+"`);
  await click(w, add);
  assert.ok(modalOpen(w), `${b.dir}: "+" opens the picker`);
  assert.strictEqual(w.calcTotal(), 0, `${b.dir}: …and adds nothing`);

  // add a choice → the pill shows 1
  w.selectVariant(b.A); await settle();
  await click(w, $(w, 'detail-cta'));
  assert.ok(!modalOpen(w), `${b.dir}: Add closes the picker`);
  assert.strictEqual(pill(), '1', `${b.dir}: one choice in the cart → the pill shows 1`);
  assert.ok(!shown(add) && controls.classList.contains('visible') && card.classList.contains('has-items'), `${b.dir}: the stepper is open, the "+" hidden`);

  // the stepper's "+" opens the picker again (same or another choice); a DIFFERENT choice → 2
  await click(w, plus);
  assert.ok(modalOpen(w), `${b.dir}: the stepper's "+" opens the picker`);
  assert.strictEqual(pill(), '1', `${b.dir}: …and does not add by itself`);
  w.selectVariant(b.B); await settle();
  await click(w, $(w, 'detail-cta'));
  assert.strictEqual(pill(), '2', `${b.dir}: two different choices → the pill shows the TOTAL, 2`);
  // the same choice again → 3 (a choice line can hold more than one)
  await click(w, plus); w.selectVariant(b.A); await settle(); await click(w, $(w, 'detail-cta'));
  assert.strictEqual(pill(), '3', `${b.dir}: the same choice again → 3`);
  const total3 = w.calcTotal();

  // "−" opens the cart sheet and removes nothing
  await click(w, minus);
  assert.ok(sheetOpen(w), `${b.dir}: "−" opens the cart`);
  assert.strictEqual(w.calcTotal(), total3, `${b.dir}: …and removes nothing`);
  assert.strictEqual(pill(), '3', `${b.dir}: …so the pill still shows 3`);

  // removing in the cart updates the pill, down to the bare "+"
  const dec = (id) => $(w, 'cart-review-sheet').querySelector(`[data-act="review-dec"][data-id="${id}"]`);
  await click(w, dec(b.B));
  assert.strictEqual(pill(), '2', `${b.dir}: a choice removed in the cart → the pill shows 2`);
  await click(w, dec(b.A));
  assert.strictEqual(pill(), '1', `${b.dir}: one more removed → 1`);
  w.closeCartReview(); await settle();

  // an outside tap collapses the stepper to the badge, which shows the TOTAL (never the launcher's own 0)
  await new Promise((r) => setTimeout(r, 200));   // registerOutsideClick arms after a tick
  await click(w, w.document.body);
  assert.ok(!controls.classList.contains('visible') && shown(badge) && $(w, `qty-badge-num-${b.L}`).textContent === '1', `${b.dir}: outside tap → the badge shows 1`);

  // a menu re-render keeps the count (the live-menu re-sync repaints a launcher through its choices)
  w.liveMenuRenderAll(); await settle();
  assert.strictEqual($(w, `qty-${b.L}`).textContent, '0', `${b.dir}: premise — the bare re-render draws 0`);
  w.cartLines().forEach((l) => w.chg(l.key, 0)); await settle();
  assert.strictEqual($(w, `qty-${b.L}`).textContent, '1', `${b.dir}: the re-sync repaints the launcher card's count`);

  // the last one removed in the cart → back to the bare "+"
  w.openCartReview(); await settle();
  await click(w, dec(b.A));
  assert.strictEqual($(w, `qty-${b.L}`).textContent, '0');
  assert.ok(shown($(w, `qty-add-${b.L}`)) && !$(w, `qty-controls-${b.L}`).classList.contains('visible'), `${b.dir}: empty again → only the "+"`);
  assert.ok(!$(w, `card-${b.L}`).classList.contains('has-items'), `${b.dir}: …and the card is no longer highlighted`);
  w.closeCartReview(); await settle();
  ok(`${b.dir}: the launcher card counts its choices (0 → 1 → 2 → 3); "+" opens the picker; "−" opens the cart and removes nothing; cart removals update the pill down to the bare "+"; the badge and a re-render show the total`);

  // a NON-group card is unchanged: its own stepper adds and removes its own quantity
  const plainBtn = [...w.document.querySelectorAll('.qty-add-btn[data-act="inc"]')].find((el) => !w.soldOutById(el.getAttribute('data-id')));
  assert.ok(plainBtn, `${b.dir}: premise — a plain card`);
  const plain = { id: plainBtn.getAttribute('data-id') };
  await click(w, $(w, `qty-add-${plain.id}`));
  assert.strictEqual($(w, `qty-${plain.id}`).textContent, '1', `${b.dir}: a plain card's "+" adds one`);
  await click(w, $(w, `qty-controls-${plain.id}`).querySelector('[data-act="dec"]'));
  assert.strictEqual($(w, `qty-${plain.id}`).textContent, '0', `${b.dir}: a plain card's "−" removes one`);
  assert.ok(!sheetOpen(w), `${b.dir}: …without opening the cart`);
  ok(`${b.dir}: a non-group card keeps its own stepper ("+" adds, "−" removes, no cart sheet)`);
}

// La Musa's LIST layout: a group in a list category counts the same way (its row carries the same stepper)
{
  const dir = 'la-musa-orders'; const B = BRAND[dir];
  const w = loadForm(dir); await settle();
  const m = B.menu(w);
  const list = m.categories.find((c) => c.layout === 'list');
  assert.ok(list, 'premise — la_musa has a list-layout category');
  const sub = Array.isArray(list.subcats) && list.subcats.length ? { subcat: list.subcats[0] } : {};
  m.dishes.push({ id: 'soda_grp', cat: list.id, name: 'Sodas', price: 40, ...sub });
  [['Coca', 'soda_grp_coca', 40], ['Sprite', 'soda_grp_sprite', 45]].forEach(([c, id, p]) => m.dishes.push({ id, cat: list.id, name: `Sodas - ${c}`, price: p, variantOf: 'soda_grp', choice: c, ...sub }));
  m.variant_items = Object.assign(JSON.parse(JSON.stringify(w.eval('VARIANT_ITEMS'))), { soda_grp: { label: 'Sabor', basePrice: 40, variantIds: ['soda_grp_coca', 'soda_grp_sprite'] } });
  await serve(w, envelope(B.rid, m));
  const row = $(w, 'card-soda_grp');
  assert.ok(row && row.classList.contains('bev-row'), 'premise — the group renders as a list row');
  w.chg('soda_grp_coca', 1); w.chg('soda_grp_sprite', 1); await settle();
  assert.strictEqual($(w, 'qty-soda_grp').textContent, '2', 'list row: two choices → 2');
  assert.ok(!shown($(w, 'qty-add-soda_grp')) && $(w, 'qty-controls-soda_grp').classList.contains('visible'), 'list row: the stepper shows the total');
  await click(w, $(w, 'qty-controls-soda_grp').querySelector('[data-act="dec"]'));
  assert.ok(sheetOpen(w) && $(w, 'qty-soda_grp').textContent === '2', 'list row: "−" opens the cart and removes nothing');
  ok('la-musa-orders (list layout): a group row counts its choices too; "−" opens the cart');
}

closeAll();
console.log('\ngroup-card-count: OK');
