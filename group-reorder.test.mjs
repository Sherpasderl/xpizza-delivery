// 1D add-product B (rev 6, §0b.9 / §0c.2) — REORDER with required-choice groups, on BOTH forms. Run: node group-reorder.test.mjs
// The reorder reader (account.js) is lifted and run INSIDE the real loaded page, so MENU, qty, pizzaExtras, itemIsLauncher
// and soldOutById are the form's own — only the account sheet's closure-scoped CONFIG (its rid) and UI hooks (toast, closeSheet, the smart-cart
// prompt) are shimmed. A variant line restores as that variant; a legacy BARE launcher line is dropped and counted in the notice.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { loadForm, settle, serve, envelope, loadAvail, closeAll, counter, BRAND } from './form-harness.mjs';
import { liftReader } from './d4b-reorder-reader.mjs';

const { ok } = counter();

function installReader(w, dir) {
  w.CONFIG = { restaurant_id: BRAND[dir].rid };   // account.js's own closure constant — the brand id, nothing more
  const src = liftReader(readFileSync(new URL(`./${dir}/account.js`, import.meta.url), 'utf8'));
  w.__toasts = [];
  w.toast = (m) => w.__toasts.push(m);
  w.closeSheet = () => {};
  w.reorderCartPrompt = (onAdd) => onAdd();
  w.eval(`${src}\nwindow.__reorder = reorderFromEntry;`);
}
// The reader writes qty / pizzaExtras (it never reaches CART — a PRE-EXISTING gap on 4e2a710, reported to the advisor
// 2026-10-09); so the assertion is at the layer it writes, read from the page realm.
const q = (w, id) => w.eval(`qty[${JSON.stringify(id)}] || 0`);

// ── x_pizza: the served NY Plain Slice group; recipe keys are NAMES ──────────────────────────────────────────────────
{
  const dir = 'xpizza-orders'; const B = BRAND[dir];
  const w = loadForm(dir);
  await settle();
  const m = B.menu(w);
  m.dishes.push({ id: 30, cat: 'ny', name: 'NY Plain Slice', price: 624 });
  [['Salsa Roja', 31], ['Salsa Vodka', 32], ['Combinada', 33]].forEach(([c, id]) => m.dishes.push({ id, cat: 'ny', name: `NY Plain Slice - ${c}`, price: 624, variantOf: 30, choice: c }));
  m.variant_items = { 30: { label: 'Salsa', basePrice: 624, variantIds: [31, 32, 33] } };
  await serve(w, envelope(B.rid, m));
  installReader(w, dir);
  w.__reorder({ items: [{ key: 'NY Plain Slice - Combinada', qty: 2 }, { key: 'NY Plain Slice', qty: 1 }] }); await settle();
  assert.deepStrictEqual([q(w, 33), q(w, 30)], [2, 0], 'the variant line restored (2 × Combinada); the bare launcher line did not');
  assert.deepStrictEqual([...w.__toasts], ['1 producto ya no está disponible'], 'the dropped launcher line is counted in today\'s notice');

  await loadAvail(w, { [w.availKey('NY Plain Slice')]: { available: false } });
  w.__toasts.length = 0;
  w.__reorder({ items: [{ key: 'NY Plain Slice - Salsa Roja', qty: 1 }] }); await settle();
  assert.strictEqual(q(w, 31), 0, 'the whole dish 86\'d → its choice is not restored');
  assert.deepStrictEqual([...w.__toasts], ['Esos productos ya no están disponibles.']);
  ok('x_pizza reorder: a variant line restores as the variant; a bare launcher line is dropped + counted; a choice of an 86\'d launcher is dropped');
}

// ── la_musa: the live Pad Thai group; recipe keys are IDS. A historical bare "Pad Thai" line (e.g. a reward) drops ──
{
  const dir = 'la-musa-orders';
  const w = loadForm(dir);
  await settle();
  installReader(w, dir);
  w.__reorder({ items: [{ key: 'noodle_01_pollo', qty: 1 }, { key: 'noodle_01', qty: 1 }] }); await settle();
  assert.deepStrictEqual([q(w, 'noodle_01_pollo'), q(w, 'noodle_01')], [1, 0], 'Pad Thai - Pollo restored; the bare noodle_01 (L 414) was not');
  assert.deepStrictEqual([...w.__toasts], ['1 producto ya no está disponible']);
  ok('la_musa reorder: Pad Thai - Pollo restores; a legacy bare Pad Thai line is dropped and counted, never charged at L 414');
}

closeAll();
console.log('\ngroup-reorder: OK');
