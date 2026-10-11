// 1D add-product B (codex PB-2 r1 P2-6) — a required choice is operable by KEYBOARD, on BOTH forms (real page, jsdom).
// Run: node group-picker-keyboard.test.mjs
//   every choice row carries a native radio (one group name, checked state, an accessible name); Tab reaches it; Enter,
//   Space and the arrows choose (Space/arrows as the browser performs them: the native radio moves `checked` and fires
//   `change`, which jsdom does not synthesize from a key); after the choice re-renders the picker, focus is back on the
//   checked radio, so the arrows keep working; the commit button enables and adds the chosen choice — no pointer used.
import assert from 'node:assert';
import { loadForm, settle, serve, envelope, closeAll, counter, BRAND } from './form-harness.mjs';

const { ok } = counter();
const $ = (w, id) => w.document.getElementById(id);
const radios = (w) => [...$(w, 'detail-scroll').querySelectorAll('input.choice-radio')];
const ctaText = (w) => $(w, 'detail-cta').textContent.replace(/\s+/g, ' ').trim();
const cartKeys = (w) => JSON.parse(JSON.stringify(w.eval('cartLines().map(l => [String(l.key), l.qty])')));
const key = (w, el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
// what the browser does for Space on an unchecked radio, or an arrow within the group: check it, fire `change`
const nativeCheck = (w, el) => { el.focus(); el.checked = true; el.dispatchEvent(new w.Event('change', { bubbles: true })); };

const FIX = {
  'la-musa-orders': { launcher: 'noodle_01', ids: ['noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron'], labels: ['Sin Proteína', 'Pollo · +L 35', 'Camarones · +L 107'], prompt: 'Elegí tu proteína' },
  'xpizza-orders': { launcher: 30, ids: ['31', '32', '33'], labels: ['Salsa Roja', 'Salsa Vodka · +L 20', 'Combinada · Recomendada · +L 30'], prompt: 'Elegí tu salsa',
    setup: async (w) => {
      const m = BRAND['xpizza-orders'].menu(w);
      m.dishes.push({ id: 30, cat: 'ny', name: 'NY Plain Slice', price: 624 });
      [['Salsa Roja', 31, 624], ['Salsa Vodka', 32, 644], ['Combinada', 33, 654, ['recommended']]].forEach(([c, id, p, tags]) => m.dishes.push({ id, cat: 'ny', name: `NY Plain Slice - ${c}`, price: p, variantOf: 30, choice: c, ...(tags ? { tags } : {}) }));
      m.variant_items = { 30: { label: 'Salsa', basePrice: 624, variantIds: [31, 32, 33] } };
      await serve(w, envelope('x_pizza', m));
    } },
};

for (const dir of Object.keys(FIX)) {
  const F = FIX[dir];
  const w = loadForm(dir); await settle();
  if (F.setup) await F.setup(w);
  w.openDetailModal(F.launcher); await settle();
  let rs = radios(w);
  assert.strictEqual(rs.length, 3, `${dir}: each of the 3 choice rows carries a native radio`);
  assert.deepStrictEqual(rs.map((r) => r.type), ['radio', 'radio', 'radio'], `${dir}: …of type radio`);
  assert.strictEqual(new Set(rs.map((r) => r.name)).size, 1, `${dir}: one group name (the browser's radio group: Tab stop + arrows)`);
  assert.deepStrictEqual(rs.map((r) => r.value), F.ids.map(String), `${dir}: each radio's value is its choice`);
  assert.deepStrictEqual(rs.map((r) => r.getAttribute('aria-label')), F.labels, `${dir}: each radio is labelled with the row's visible text`);
  assert.ok(rs.every((r) => !r.checked && r.tabIndex === 0 && !r.disabled), `${dir}: unchecked, focusable, enabled`);
  assert.ok($(w, 'detail-cta').disabled && ctaText(w) === F.prompt, `${dir}: premise — nothing chosen, the commit button is disabled`);

  // Enter on the focused first radio chooses it
  rs[0].focus();
  assert.strictEqual(w.document.activeElement, rs[0], `${dir}: Tab reaches the group (the radio takes focus)`);
  key(w, rs[0], 'Enter'); await settle();
  rs = radios(w);
  assert.ok(rs[0].checked && rs[0].closest('.detail-variant-row').classList.contains('sel'), `🔴 ${dir}: Enter chose the first choice (checked + the row selected)`);
  assert.strictEqual(w.document.activeElement, rs[0], `🔴 ${dir}: after the re-render, focus is back on the checked radio`);
  assert.ok(!$(w, 'detail-cta').disabled && ctaText(w).startsWith('Agregar'), `🔴 ${dir}: the commit button enabled by keyboard`);

  // ArrowDown (the browser moves `checked` to the next radio and fires change)
  nativeCheck(w, rs[1]); await settle();
  rs = radios(w);
  assert.ok(rs[1].checked && !rs[0].checked, `🔴 ${dir}: the arrow moved the choice to the second`);
  assert.strictEqual(w.document.activeElement, rs[1], `${dir}: focus follows the checked radio`);

  // Space on the third
  nativeCheck(w, rs[2]); await settle();
  rs = radios(w);
  assert.ok(rs[2].checked, `${dir}: Space chose the third`);

  // commit by keyboard (the button is a real <button>: Enter/Space activate it)
  $(w, 'detail-cta').click(); await settle();
  assert.deepStrictEqual(cartKeys(w), [[String(F.ids[2]), 1]], `🔴 ${dir}: the keyboard-chosen choice is the cart line`);
  ok(`${dir}: the 3 choice rows are native labelled radios in one group; Enter / arrows / Space choose, focus returns to the checked radio after the re-render, the commit button enables and adds the choice — no pointer`);
}

closeAll();
console.log('\ngroup-picker-keyboard: OK');
