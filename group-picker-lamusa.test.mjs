// 1D add-product B (rev 6, §0d.4 / §0b.7) — La Musa under the UNIFORM group rules, through the real form (jsdom).
// Run: node group-picker-lamusa.test.mjs
//   whole-dish availability: 86-ing the launcher ("Pad Thai") blocks every choice — the declared strengthening;
//   extras_policy 'none' (served on the launcher + every choice) hides the extras in the picker AND the choice's own modal.
import assert from 'node:assert';
import { loadForm, settle, serve, envelope, loadAvail, closeAll, counter, BRAND } from './form-harness.mjs';

const { ok } = counter();
const DIR = 'la-musa-orders';
const B = BRAND[DIR];
const $ = (w, id) => w.document.getElementById(id);
const ctaText = (w) => $(w, 'detail-cta').textContent.replace(/\s+/g, ' ').trim();
const GROUP = ['noodle_01', 'noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron'];

// ── whole-dish availability ─────────────────────────────────────────────────────────────────────────────────────────
{
  const w = loadForm(DIR);
  await settle();
  w.openDetailModal('noodle_01'); await settle();
  w.selectVariant('noodle_01_pollo'); await settle();
  assert.ok(ctaText(w).startsWith('Agregar'), 'premise: Pollo chosen and addable');
  await loadAvail(w, { [w.availKey('noodle_01')]: { available: false } });
  w.updateDetailModal(); await settle();
  assert.ok($(w, 'detail-cta').disabled && ctaText(w) === 'Agotado', 'the WHOLE dish 86\'d → the chosen protein is sold out');
  w.detailCtaTap(); await settle();
  w.chg('noodle_01_pollo', 1); await settle();
  assert.strictEqual(w.calcTotal(), 0, 'neither the CTA nor the write point adds a choice of an 86\'d launcher');
  w.closeDetailModal(); await settle();
  ok('la_musa: 86-ing "Pad Thai" blocks Pad Thai - Pollo in the picker and at the write point (rev 6 §0d.4, declared)');
}

// ── extras_policy 'none' ────────────────────────────────────────────────────────────────────────────────────────────
for (const policy of [undefined, 'none']) {
  const w = loadForm(DIR);
  await settle();
  const m = B.menu(w);
  if (policy) m.dishes = m.dishes.map((d) => (GROUP.includes(d.id) ? { ...d, extras_policy: policy } : d));
  await serve(w, envelope(B.rid, m));
  assert.strictEqual(w.liveMenuGlobalGet('MENU').find((d) => d.id === 'noodle_01').extras_policy, policy, 'premise: the snapshot applied');
  w.openDetailModal('noodle_01'); await settle();
  const pickerExtras = $(w, 'detail-scroll').querySelectorAll('.detail-extras-row').length;
  w.selectVariant('noodle_01_sin'); await settle();
  w.detailCtaTap(); await settle();
  w.openDetailModal('noodle_01_sin'); await settle();
  const variantExtras = $(w, 'detail-scroll').querySelectorAll('.detail-extras-row').length;
  w.closeDetailModal(); await settle();
  if (policy === 'none') assert.deepStrictEqual([pickerExtras, variantExtras], [0, 0], 'extras_policy "none": no extras in the picker or the choice\'s modal');
  else assert.ok(pickerExtras > 0 && variantExtras > 0, 'extras_policy absent: today\'s extras in both');
}
ok('la_musa: extras_policy "none" hides extras in the picker and in the choice\'s own modal; absent keeps today\'s');

closeAll();
console.log('\ngroup-picker-lamusa: OK');
