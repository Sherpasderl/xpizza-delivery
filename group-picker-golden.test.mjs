// 1D add-product B (rev 6, §0d.3) — la_musa's REQUIRED-CHOICE PICKER, as DOM, through the real form (jsdom harness).
//   node group-picker-golden.test.mjs               compare against group-picker-lamusa.golden.json
//   GP_GOLDEN_CAPTURE=1 node group-picker-golden.test.mjs   (re)capture — ONLY on the 4e2a710 forms (step 1's baseline)
// Step 1 of the shared-picker extraction must leave every captured byte IDENTICAL. Step 2's ONLY permitted differences
// are the three enumerated in §0d.3, applied by STEP2 below — nothing else may move.
import assert from 'node:assert';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadForm, settle, loadAvail, closeAll, counter } from './form-harness.mjs';

const GOLDEN = new URL('./group-picker-lamusa.golden.json', import.meta.url);
const CAPTURE = process.env.GP_GOLDEN_CAPTURE === '1';
const { ok } = counter();

const snap = (w) => {
  const d = w.document;
  const cta = d.getElementById('detail-cta');
  return {
    title: d.getElementById('detail-header-title').textContent,
    scroll: d.getElementById('detail-scroll').innerHTML,
    cta: cta ? { className: cta.className, disabled: !!cta.disabled, html: cta.innerHTML, style: cta.getAttribute('style') || '' } : null,
    open: d.getElementById('detail-modal').classList.contains('open'),
  };
};

async function captureLaMusa() {
  const w = loadForm('la-musa-orders');
  await settle();
  const out = {};
  const card = w.document.getElementById('card-noodle_01');
  out.card = card ? card.outerHTML : null;
  w.openDetailModal('noodle_01'); await settle();
  out.opened = snap(w);
  for (const vid of ['noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron']) { w.selectVariant(vid); await settle(); out[`selected:${vid}`] = snap(w); }
  // a staged extra on the chosen line: the CTA amount includes it
  const extraId = w.liveMenuGlobalGet('EXTRAS').find((e) => typeof e.id === 'string' && e.id.startsWith('sauce_')).id;
  w.chgStagedExtra(extraId, 1); await settle(); out.stagedExtra = snap(w);
  // commit: one line of the chosen variant, the modal closes
  w.detailCtaTap(); await settle();
  w.openCartReview(); await settle();
  out.committed = { open: w.document.getElementById('detail-modal').classList.contains('open'),
    review: w.document.getElementById('cart-review-sheet').innerHTML, total: (w.document.getElementById('cart-review-total') || {}).textContent || null };
  w.closeCartReview(); await settle();
  // a choice that is sold out between selection and Add: the CTA must refuse
  w.openDetailModal('noodle_01'); await settle();
  w.selectVariant('noodle_01_pollo'); await settle();
  await loadAvail(w, { [w.availKey('noodle_01_pollo')]: { available: false } });
  w.updateDetailModal(); await settle();
  out.soldOutChoice = snap(w);
  w.closeDetailModal(); await settle();
  return out;
}

// §0d.3 step 2: the ONLY permitted la_musa differences (filled in when step 2 lands; identity until then)
const STEP2 = (golden) => golden;

const got = await captureLaMusa();
if (CAPTURE) {
  writeFileSync(GOLDEN, `${JSON.stringify(got, null, 2)}\n`);
  console.log(`captured ${Object.keys(got).length} la_musa picker states → group-picker-lamusa.golden.json`);
} else {
  assert.ok(existsSync(GOLDEN), 'the la_musa picker golden exists (captured on the 4e2a710 forms)');
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const want = STEP2(golden);
  for (const k of Object.keys(want)) assert.deepStrictEqual(got[k], want[k], `🔴 la_musa picker state "${k}" changed beyond §0d.3's permitted differences`);
  assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(want).sort(), 'the same states');
  ok(`la_musa picker DOM: ${Object.keys(want).length} states equal the golden (step 1 byte-identical; step 2 = only the §0d.3 differences)`);
}
closeAll();
console.log('\ngroup-picker-golden: OK');
