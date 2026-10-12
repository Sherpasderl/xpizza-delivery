// 1D add-product B (rev 6 §0d.1, owner 2026-10-10) — REWARDS with required-choice groups, on BOTH forms (real page, jsdom).
// Run: node group-rewards.test.mjs
//   the reward list offers a group as its CHOICES (each its own row) and never the bare launcher — one shared rule
//   (GroupPicker.rewardDishes) over each brand's eligibility data;
//   a restored reward (payment return) that names a bare launcher is DROPPED with "Elegí de nuevo tu premio" — never
//   submitted bare — while a restored choice reward is kept.
import assert from 'node:assert';
import { loadForm, settle, serve, envelope, closeAll, counter, BRAND } from './form-harness.mjs';

const { ok } = counter();
const keysOf = (w) => JSON.parse(JSON.stringify(w.buildRedeemCatalog().map((c) => c.key)));
const toastText = (w) => (w.document.getElementById('acct-toast') || {}).textContent || '';
const payload = (w) => JSON.parse(JSON.stringify(w.__ACCOUNT.getRedeemPayload()));

// ── la_musa: the live Pad Thai group ────────────────────────────────────────────────────────────────────────────────
{
  const w = loadForm('la-musa-orders');
  await settle();
  const keys = keysOf(w);
  assert.ok(!keys.includes('noodle_01'), '🔴 la_musa: the bare Pad Thai launcher is NOT a reward row');
  for (const k of ['noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron']) assert.ok(keys.includes(k), `la_musa: ${k} is its own reward row`);
  assert.ok(keys.includes('dimsum_01') && !keys.some((k) => k.startsWith('beer_')) && keys.includes('rice_white'), 'la_musa: the brand\'s eligibility data is unchanged (dishes, no alcohol, acompañamientos)');

  w.__ACCOUNT.restoreRedeem({ type: 'points_ala_carte', items: [{ id: 'noodle_01', qty: 1, name: 'Pad Thai' }, { id: 'dimsum_01', qty: 1, name: 'Wonton' }] }, null, null);
  await settle();
  assert.strictEqual(payload(w), null, '🔴 la_musa: a restored selection holding the bare launcher is dropped whole — nothing to submit');
  assert.strictEqual(toastText(w), 'Elegí de nuevo tu premio', 'la_musa: …with the notice');
  w.__ACCOUNT.restoreRedeem({ type: 'points_ala_carte', items: [{ id: 'noodle_01_pollo', qty: 1, name: 'Pad Thai - Pollo' }] }, null, null);
  assert.deepStrictEqual(payload(w), { type: 'points_ala_carte', items: [{ id: 'noodle_01_pollo', qty: 1, name: 'Pad Thai - Pollo' }] }, 'la_musa: a restored CHOICE reward is kept');
  ok('la_musa: Pad Thai appears in rewards as its three choices, never the bare launcher; a restored bare-launcher reward is dropped with "Elegí de nuevo tu premio", a restored choice is kept');
}

// ── x_pizza: a group in an ELIGIBLE category (individual) — the same rule, the brand's own data ──────────────────────
{
  const dir = 'xpizza-orders'; const B = BRAND[dir];
  const w = loadForm(dir);
  await settle();
  const m = B.menu(w);
  m.dishes.push({ id: 40, cat: 'individual', name: 'Slice Duo', price: 300 });
  m.dishes.push({ id: 41, cat: 'individual', name: 'Slice Duo - Roja', price: 300, variantOf: 40, choice: 'Roja' });
  m.dishes.push({ id: 42, cat: 'individual', name: 'Slice Duo - Blanca', price: 320, variantOf: 40, choice: 'Blanca' });
  m.variant_items = { 40: { label: 'Salsa', basePrice: 300, variantIds: [41, 42] } };
  await serve(w, envelope(B.rid, m));
  const keys = keysOf(w);
  assert.ok(!keys.includes('Slice Duo'), '🔴 x_pizza: the bare launcher is NOT a reward row');
  assert.ok(keys.includes('Slice Duo - Roja') && keys.includes('Slice Duo - Blanca'), 'x_pizza: each choice is its own reward row');
  assert.ok(keys.includes('Carnivora') && !keys.includes('Margherita NY'), 'x_pizza: the brand\'s eligibility data is unchanged (12" individual only)');

  w.__ACCOUNT.restoreRedeem({ type: 'free_pizza_choice', item_id: 'Slice Duo', name: 'Slice Duo' }, null, null);
  await settle();
  assert.strictEqual(payload(w), null, '🔴 x_pizza: a restored bare-launcher reward is dropped');
  assert.strictEqual(toastText(w), 'Elegí de nuevo tu premio');
  w.__ACCOUNT.restoreRedeem({ type: 'free_pizza_choice', item_id: 'Slice Duo - Blanca', name: 'Slice Duo - Blanca' }, null, null);
  assert.deepStrictEqual(payload(w), { type: 'free_pizza_choice', item_id: 'Slice Duo - Blanca', name: 'Slice Duo - Blanca' }, 'x_pizza: a restored choice reward is kept');
  ok('x_pizza: a group in an eligible category appears as its choices only; a restored bare-launcher reward is dropped with the notice, a choice kept');
}

closeAll();
console.log('\ngroup-rewards: OK');
