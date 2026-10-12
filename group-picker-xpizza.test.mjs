// 1D add-product B (rev 6, PB-2 step 2.3) — X. Pizza adopts the SHARED required-choice picker, through the real form
// (jsdom harness), driven ONLY by a served snapshot: variant_items + variants + tags + extras_policy. Run: node group-picker-xpizza.test.mjs
// The first-use data is the pinned NY Plain Slice (§0b.9): cat 'ny', "Salsa Roja" / "Salsa Vodka" / "Combinada",
// variant names "NY Plain Slice - {choice}", CTA "Elegí tu salsa". Equal prices render as APPROVED-1/2; unequal as
// APPROVED-MOCKUP-precios-distintos.
import assert from 'node:assert';
import { loadForm, settle, serve, envelope, loadAvail, closeAll, counter, BRAND, paintedFor } from './form-harness.mjs';

const { ok } = counter();
const DIR = 'xpizza-orders';
const B = BRAND[DIR];
const painted = paintedFor(B);
const L = 30, ROJA = 31, VODKA = 32, COMB = 33;

// The snapshot getPublicMenu serves once the portal publishes the group: the launcher + 3 variants + the map.
function withGroup(w, { prices = [624, 624, 624], extrasPolicy, recommended = true } = {}) {
  const m = B.menu(w);
  const pol = extrasPolicy ? { extras_policy: extrasPolicy } : {};
  m.dishes.push({ id: L, cat: 'ny', name: 'NY Plain Slice', price: Math.min(...prices), emoji: '🍕', color: '#C8321A',
    desc: 'La clásica NY Plain Slice - 6 slices, queso mozzarella, salsa de tu elección.', ...pol });
  [['Salsa Roja', ROJA], ['Salsa Vodka', VODKA], ['Combinada', COMB]].forEach(([choice, id], i) => {
    m.dishes.push({ id, cat: 'ny', name: `NY Plain Slice - ${choice}`, price: prices[i], variantOf: L, choice, ...pol,
      ...(recommended && id === COMB ? { tags: ['recommended'] } : {}) });
  });
  m.variant_items = { [String(L)]: { label: 'Salsa', basePrice: Math.min(...prices), variantIds: [ROJA, VODKA, COMB] } };
  return m;
}
const $ = (w, id) => w.document.getElementById(id);
const cta = (w) => $(w, 'detail-cta');
const ctaText = (w) => cta(w).textContent.replace(/\s+/g, ' ').trim();
const rows = (w) => [...$(w, 'detail-scroll').querySelectorAll('.detail-variant-row')];
const modalOpen = (w) => $(w, 'detail-modal').classList.contains('open');
const reviewHtml = async (w) => { w.openCartReview(); await settle(); const h = $(w, 'cart-review-sheet').innerHTML; w.closeCartReview(); await settle(); return h; };
const click = async (w, el) => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await settle(); };

// ── 1. equal prices: the card, the modal (APPROVED-1), the choice (APPROVED-2), Add commits ONE and closes ─────────
{
  const w = loadForm(DIR);
  await settle();
  await serve(w, envelope(B.rid, withGroup(w)));
  assert.strictEqual(w.liveMenuGlobalGet('VARIANT_ITEMS')[String(L)].label, 'Salsa', 'premise: the served group applied');
  const card = $(w, `card-${L}`);
  assert.ok(card, 'the launcher has a card');
  assert.strictEqual(card.querySelector('.pizza-card-price').textContent, 'L 624', 'equal prices: "L 624", no "desde"');
  for (const v of [ROJA, VODKA, COMB]) assert.strictEqual($(w, `card-${v}`), null, `choice ${v} is not a card of its own`);
  const plus = card.querySelector('.qty-add-btn');
  assert.strictEqual(plus.getAttribute('data-act'), 'open', 'the card\'s "+" OPENS the picker');
  await click(w, plus);
  assert.ok(modalOpen(w), 'tapping "+" opened the picker');
  assert.strictEqual(w.calcTotal(), 0, '…and added nothing');

  // APPROVED-1: nothing chosen
  assert.strictEqual($(w, 'detail-header-title').textContent, 'NY Plain Slice');
  const scroll = $(w, 'detail-scroll');
  assert.strictEqual(scroll.querySelector('.detail-price').textContent, 'L 624');
  assert.strictEqual(scroll.querySelector('.detail-cat-label').textContent, 'Salsa · Requerido');
  assert.deepStrictEqual(rows(w).map((r) => r.querySelector('.detail-extras-name').textContent), ['Salsa Roja', 'Salsa Vodka', 'Combinada']);
  assert.deepStrictEqual(rows(w).map((r) => (r.querySelector('.choice-badge') || {}).textContent || null), [null, null, 'Recomendada'], 'the gold "Recomendada" pill, on Combinada only');
  assert.strictEqual(scroll.querySelectorAll('.choice-delta').length, 0, 'equal prices: no row shows an amount');
  assert.strictEqual(scroll.querySelectorAll('.detail-qty-section, .detail-extras-row').length, 0, 'no quantity and no extras in the picker');
  assert.ok(cta(w).disabled && cta(w).classList.contains('detail-cta--group'), 'the CTA is disabled (the picker\'s grey)');
  assert.strictEqual(ctaText(w), 'Elegí tu salsa');

  // APPROVED-2: Combinada chosen — through the real row click (the id is resolved back through MENU: a NUMBER)
  await click(w, rows(w)[2]);
  assert.deepStrictEqual(rows(w).map((r) => r.classList.contains('sel')), [false, false, true], 'only Combinada is selected');
  assert.ok(!cta(w).disabled, 'chosen → enabled');
  assert.strictEqual(ctaText(w), 'Agregar · L 624');

  await click(w, cta(w));
  assert.ok(!modalOpen(w), 'Add closes the picker');
  assert.strictEqual(w.calcTotal(), 624, 'ONE NY Plain Slice - Combinada, L 624');
  const review = await reviewHtml(w);
  assert.ok(review.includes('NY Plain Slice - Combinada') && !/>NY Plain Slice</.test(review), 'the cart line is the VARIANT, never the bare launcher');

  // reopen = a fresh choice
  w.openDetailModal(L); await settle();
  assert.deepStrictEqual(rows(w).map((r) => r.classList.contains('sel')), [false, false, false], 'reopen: nothing staged');
  assert.ok(cta(w).disabled && ctaText(w) === 'Elegí tu salsa', 'reopen: the CTA asks again');
  w.closeDetailModal(); await settle();

  // a bare launcher can never become a cart line, whatever calls chg
  w.chg(L, 1); await settle();
  assert.strictEqual(w.calcTotal(), 624, 'chg(launcher, +1) is refused at the single write point');
  // a STALE "add" control naming the launcher (rendered before the dish became a launcher) opens the picker, never adds
  const stale = w.document.createElement('button'); stale.setAttribute('data-act', 'inc'); stale.setAttribute('data-id', String(L));
  w.document.body.appendChild(stale);
  await click(w, stale);
  assert.ok(modalOpen(w) && $(w, 'detail-header-title').textContent === 'NY Plain Slice', 'a stale "inc" on the launcher opens its picker');
  assert.strictEqual(w.calcTotal(), 624, '…and adds nothing');
  w.closeDetailModal(); await settle(); stale.remove();
  ok('equal prices: card "L 624" whose "+" opens the picker; APPROVED-1 (Recomendada pill, no amounts, "Elegí tu salsa" disabled) → APPROVED-2 ("Agregar · L 624"); Add commits ONE variant line and closes; reopen is fresh; a bare launcher is never a cart line');
}

// ── 2. unequal prices (APPROVED-MOCKUP-precios-distintos): "desde", deltas above the cheapest, CTA = the chosen price ──
{
  const w = loadForm(DIR);
  await settle();
  await serve(w, envelope(B.rid, withGroup(w, { prices: [624, 644, 654] })));
  assert.strictEqual($(w, `card-${L}`).querySelector('.pizza-card-price').textContent, 'desde L 624');
  w.openDetailModal(L); await settle();
  assert.strictEqual($(w, 'detail-scroll').querySelector('.detail-price').textContent, 'desde L 624');
  assert.deepStrictEqual(rows(w).map((r) => (r.querySelector('.choice-delta') || {}).textContent || null), [null, '+L 20', '+L 30'], 'nothing on the cheapest, +L delta on the rest');
  w.selectVariant(VODKA); await settle();
  assert.strictEqual(ctaText(w), 'Agregar · L 644');
  w.detailCtaTap(); await settle();
  assert.strictEqual(w.calcTotal(), 644, 'charged the CHOSEN price, never the launcher minimum');
  ok('unequal prices: "desde L 624", rows "+L 20" / "+L 30" (nothing on the cheapest), "Agregar · L 644", the cart carries the chosen variant\'s price');
}

// ── 3. availability: per-choice 86 between selection and Add; whole-dish (launcher) 86 blocks every choice ──────────
{
  const w = loadForm(DIR);
  await settle();
  await serve(w, envelope(B.rid, withGroup(w)));
  w.openDetailModal(L); await settle();
  w.selectVariant(VODKA); await settle();
  assert.strictEqual(ctaText(w), 'Agregar · L 624', 'premise: Vodka chosen and addable');
  await loadAvail(w, { [w.availKey('NY Plain Slice - Salsa Vodka')]: { available: false } });
  assert.ok(cta(w).disabled && ctaText(w) === 'Agotado', 'the chosen choice sold out while the picker was open → "Agotado", disabled');
  w.detailCtaTap(); await settle();
  assert.strictEqual(w.calcTotal(), 0, '…and Add does nothing');
  w.selectVariant(ROJA); await settle();
  assert.strictEqual(ctaText(w), 'Agregar · L 624', 'another choice is still addable (child-only 86)');

  await loadAvail(w, { [w.availKey('NY Plain Slice')]: { available: false } });
  assert.ok(cta(w).disabled && ctaText(w) === 'Agotado', 'the WHOLE dish 86\'d → every choice is sold out');
  w.chg(ROJA, 1); await settle();
  assert.strictEqual(w.calcTotal(), 0, 'and the write point refuses a choice of an 86\'d launcher');
  w.closeDetailModal(); await settle();
  assert.ok($(w, `card-${L}`).classList.contains('sold-out'), 'the launcher card shows Agotado');
  ok('availability: a choice 86\'d between selection and Add → "Agotado" + no add; a sibling stays addable; the launcher 86\'d blocks every choice (picker AND write point) and greys the card');
}

// ── 4. cart-review reopening: the variant line opens ITS modal (launcher\'s look); extras_policy 'none' hides extras ──
for (const extrasPolicy of [undefined, 'none']) {
  const w = loadForm(DIR);
  await settle();
  await serve(w, envelope(B.rid, withGroup(w, { extrasPolicy })));
  w.openDetailModal(L); await settle();
  w.selectVariant(ROJA); await settle();
  w.detailCtaTap(); await settle();
  w.openCartReview(); await settle();
  const line = $(w, 'cart-review-sheet').querySelector(`[data-act="review-open"][data-id="${ROJA}"]`);
  assert.ok(line, 'the variant line is reopenable');
  await click(w, line);
  assert.ok(modalOpen(w) && $(w, 'detail-header-title').textContent === 'NY Plain Slice - Salsa Roja', 'reopened: the VARIANT\'s modal');
  const scroll = $(w, 'detail-scroll');
  assert.strictEqual(scroll.querySelector('.detail-photo-label').textContent.trim(), '🍕', 'it shows its launcher\'s photo');
  assert.ok(scroll.querySelector('.detail-desc').textContent.startsWith('La clásica NY Plain Slice'), '…and description');
  assert.strictEqual(scroll.querySelector('.detail-qty-num').textContent, '1');
  const extrasRows = scroll.querySelectorAll('.detail-extras-row').length;
  if (extrasPolicy === 'none') assert.strictEqual(extrasRows, 0, 'extras_policy "none": no extras section');
  else assert.ok(extrasRows > 0, 'extras_policy absent: today\'s extras section');
  w.closeDetailModal(); await settle();
}
ok('cart-review reopening: the variant line opens the variant\'s own modal with its launcher\'s photo/description; extras_policy "none" hides the extras section, absent keeps today\'s');

// ── 5. atomic state through self-update: deferred while the picker is open; a rollback removes the launcher ──────────
{
  const w = loadForm(DIR);
  await settle();
  const base = B.menu(w);
  await serve(w, envelope(B.rid, withGroup(w)));
  w.openDetailModal(L); await settle();
  w.selectVariant(COMB); await settle();
  const groupless = { ...base, variant_items: {} };
  await serve(w, envelope(B.rid, groupless));
  assert.ok(w.liveMenuGlobalGet('VARIANT_ITEMS')[String(L)], 'a snapshot arriving while the picker is open is DEFERRED (the staged choice stands)');
  assert.strictEqual(ctaText(w), 'Agregar · L 624', '…and the open picker is untouched');
  w.closeDetailModal(); await settle(); await settle();
  assert.deepStrictEqual(w.liveMenuGlobalGet('VARIANT_ITEMS'), {}, 'on close the deferred rollback applies — MENU and VARIANT_ITEMS together');
  assert.strictEqual($(w, `card-${L}`), null, 'the launcher card is gone');
  ok('self-update: a snapshot during an open picker is deferred and lands on close, MENU and VARIANT_ITEMS as ONE unit (a rollback removes the launcher)');
}

// ── 6. the live boundary refuses what the picker cannot draw — the prior menu stands ─────────────────────────────────
{
  const w = loadForm(DIR);
  await settle();
  const before = painted(w);
  const menuBefore = w.liveMenuGlobalGet('MENU');
  const cases = {
    'a choice id that names no dish': (m) => { m.variant_items[String(L)].variantIds = [ROJA, 99]; },
    'string choice ids naming numeric dishes (coercion only)': (m) => { m.variant_items[String(L)].variantIds = [String(ROJA), String(VODKA)]; },
    'an extras_policy other than "none"': (m) => { m.dishes[m.dishes.length - 1].extras_policy = 'all'; },
    'a map with no choices': (m) => { m.variant_items[String(L)].variantIds = []; },
  };
  for (const [label, corrupt] of Object.entries(cases)) {
    const m = withGroup(w); corrupt(m);
    await serve(w, envelope(B.rid, m));
    assert.strictEqual(w.liveMenuGlobalGet('MENU'), menuBefore, `🔴 ${label} is refused — MENU is the identical prior array`);
    assert.strictEqual(painted(w), before, `🔴 ${label} — nothing rendered`);
  }
  // applied, then a snapshot that drops the choices but OMITS the map: the retained map is re-judged and refused
  await serve(w, envelope(B.rid, withGroup(w)));
  const applied = w.liveMenuGlobalGet('MENU');
  assert.notStrictEqual(applied, menuBefore, 'premise: the valid group applied');
  const dropped = B.menu(w); dropped.dishes = dropped.dishes.filter((d) => d.variantOf === undefined);
  await serve(w, envelope(B.rid, dropped));
  assert.strictEqual(w.liveMenuGlobalGet('MENU'), applied, '🔴 dropping the choices while omitting the map is refused (the retained map is re-judged)');
  ok(`the live boundary refuses ${Object.keys(cases).length} undrawable shapes + a retained map whose choices vanished — the prior menu stands`);
}

// ── 6b. an UNREADABLE map never surfaces a bare launcher: the grid hides every dish of a group it cannot draw ─────────
{
  const w = loadForm(DIR);
  await settle();
  const m = withGroup(w);
  w.liveMenuGlobalSet('MENU', m.dishes);
  w.liveMenuGlobalSet('VARIANT_ITEMS', {});          // what the boot path falls back to when the bundled map is refused
  w.renderMenu(); await settle();
  for (const id of [L, ROJA, VODKA, COMB]) assert.strictEqual($(w, `card-${id}`), null, `dish ${id} of the undrawable group is not in the grid`);
  assert.ok($(w, 'card-19'), 'premise: ordinary dishes still render');
  ok('an unreadable variant map hides the whole group from the grid — a bare launcher is never offered as an ordinary dish');
}

// ── 7. no groups ⇒ today: the groupless grid is byte-identical with and without an empty served map ──────────────────
{
  const w = loadForm(DIR);
  await settle();
  const before = painted(w);
  assert.strictEqual(Object.keys(w.liveMenuGlobalGet('VARIANT_ITEMS')).length, 0, 'the bundle has no groups → an empty map (a page-realm object, so compared by keys)');
  await serve(w, envelope(B.rid, B.menu(w)));
  assert.strictEqual(painted(w), before, 'a groupless snapshot paints exactly today\'s grid');
  ok('no groups: the grid is today\'s, byte for byte');
}

closeAll();
console.log('\ngroup-picker-xpizza: OK');
