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

// §0d.3 step 2: the ONLY permitted la_musa differences, each applied EXACTLY ONCE where it occurs (a replacement that
// finds nothing throws, so this can never silently become identity):
//   (a) the cheapest choice row shows no amount (was "L 307");
//   (b) the disabled prompt is derived from the label: "Elegí una proteína" → "Elegí tu proteína";
//   (c) the selected CTA reads "Agregar · L {choice + staged extras}" (the amount markup is unchanged).
const once = (str, from, to, where) => {
  const n = str.split(from).length - 1;
  if (n !== 1) throw new Error(`STEP2 ${where}: expected exactly one ${JSON.stringify(from)}, found ${n}`);
  return str.replace(from, to);
};
const STEP2 = (golden) => {
  const g = structuredClone(golden);
  for (const [k, st] of Object.entries(g)) {
    if (!st || typeof st.scroll !== 'string') continue;
    st.scroll = once(st.scroll, '\n      <span class="detail-extras-price">L 307</span>', '', `${k} (a)`);
    if (st.cta.html === '<span>Elegí una proteína</span>') st.cta.html = '<span>Elegí tu proteína</span>';           // (b)
    else if (st.cta.html.startsWith('<span>Agregar al carrito</span>')) st.cta.html = once(st.cta.html, '<span>Agregar al carrito</span>', '<span>Agregar</span>', `${k} (c)`);
  }
  const touched = { b: g.opened.cta.html, c: g.stagedExtra.cta.html };
  if (touched.b !== '<span>Elegí tu proteína</span>' || !touched.c.startsWith('<span>Agregar</span>')) throw new Error('STEP2 did not apply (b)/(c)');
  return g;
};

const got = await captureLaMusa();
if (CAPTURE) {
  writeFileSync(GOLDEN, `${JSON.stringify(got, null, 2)}\n`);
  console.log(`captured ${Object.keys(got).length} la_musa picker states → group-picker-lamusa.golden.json`);
} else {
  assert.ok(existsSync(GOLDEN), 'the la_musa picker golden exists (captured on the 4e2a710 forms)');
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const want = STEP2(golden);
  // on a mismatch, name the field and show the first divergence (the full deepStrictEqual dump buries it)
  const firstDiff = (x, y, path) => {
    if (typeof x === 'string' && typeof y === 'string') { if (x === y) return null; let i = 0; while (x[i] === y[i]) i++; return `${path} @${i}: got ${JSON.stringify(x.slice(Math.max(0, i - 60), i + 80))} want ${JSON.stringify(y.slice(Math.max(0, i - 60), i + 80))}`; }
    if (x && y && typeof x === 'object' && typeof y === 'object') { for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) { const d = firstDiff(x[f], y[f], `${path}.${f}`); if (d) return d; } return null; }
    return x === y ? null : `${path}: got ${JSON.stringify(x)} want ${JSON.stringify(y)}`;
  };
  for (const k of Object.keys(want)) assert.deepStrictEqual(got[k], want[k], `🔴 la_musa picker state "${k}" changed beyond §0d.3's permitted differences — ${firstDiff(got[k], want[k], k)}`);
  assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(want).sort(), 'the same states');
  ok(`la_musa picker DOM: ${Object.keys(want).length} states equal the golden (step 1 byte-identical; step 2 = only the §0d.3 differences)`);
}
closeAll();
console.log('\ngroup-picker-golden: OK');
