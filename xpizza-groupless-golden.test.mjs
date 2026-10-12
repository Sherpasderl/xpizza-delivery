// 1D add-product B (rev 6, owner rule 1) — X. PIZZA WITH NO GROUPS IS TODAY'S FORM, as DOM, through the real form (jsdom).
//   node xpizza-groupless-golden.test.mjs                 compare against xpizza-groupless.golden.json
//   XP_GOLDEN_CAPTURE=1 node xpizza-groupless-golden.test.mjs   (re)capture — ONLY on the 4e2a710 forms (the baseline)
// The picker adoption adds a code path that runs only when the menu carries a group; every state captured here — the
// grid, an ordinary dish's modal through add / extras / sold-out, the cart review, a live re-apply — must stay
// BYTE-IDENTICAL to the pre-adoption form.
import assert from 'node:assert';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadForm, settle, serve, envelope, loadAvail, closeAll, counter, BRAND, paintedFor } from './form-harness.mjs';

const GOLDEN = new URL('./xpizza-groupless.golden.json', import.meta.url);
const CAPTURE = process.env.XP_GOLDEN_CAPTURE === '1';
const { ok } = counter();
const DIR = 'xpizza-orders';
const B = BRAND[DIR];
const painted = paintedFor(B);

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

async function capture() {
  const w = loadForm(DIR);
  await settle();
  const out = {};
  out.grid = painted(w);
  const ny = w.liveMenuGlobalGet('MENU').find((d) => d.cat === 'ny');
  const indiv = w.liveMenuGlobalGet('MENU').find((d) => d.cat === 'individual' && d.name !== 'Nutella');
  w.openDetailModal(indiv.id); await settle(); out.opened = snap(w);
  w.detailCtaTap(); await settle(); out.added = snap(w);
  const ex = w.liveMenuGlobalGet('EXTRAS')[0];
  w.toggleDetailExtra(ex.id, indiv.id, 0); await settle(); out.extra = snap(w);
  w.closeDetailModal(); await settle();
  w.openCartReview(); await settle();
  out.review = w.document.getElementById('cart-review-sheet').innerHTML;
  w.closeCartReview(); await settle();
  await loadAvail(w, { [w.availKey(ny.name)]: { available: false } });
  out.soldOutGrid = painted(w);
  w.openDetailModal(ny.id); await settle(); out.soldOutModal = snap(w);
  w.closeDetailModal(); await settle();
  // a live re-apply of the same groupless menu, then the grid again
  await serve(w, envelope(B.rid, B.menu(w)));
  out.reapplied = painted(w);
  return out;
}

const got = await capture();
if (CAPTURE) {
  writeFileSync(GOLDEN, `${JSON.stringify(got, null, 2)}\n`);
  console.log(`captured ${Object.keys(got).length} x_pizza groupless states → xpizza-groupless.golden.json`);
} else {
  assert.ok(existsSync(GOLDEN), 'the x_pizza groupless golden exists (captured on the 4e2a710 forms)');
  const want = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const firstDiff = (x, y, path) => {
    if (typeof x === 'string' && typeof y === 'string') { if (x === y) return null; let i = 0; while (x[i] === y[i]) i++; return `${path} @${i}: got ${JSON.stringify(x.slice(Math.max(0, i - 60), i + 80))} want ${JSON.stringify(y.slice(Math.max(0, i - 60), i + 80))}`; }
    if (x && y && typeof x === 'object' && typeof y === 'object') { for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) { const d = firstDiff(x[f], y[f], `${path}.${f}`); if (d) return d; } return null; }
    return x === y ? null : `${path}: got ${JSON.stringify(x)} want ${JSON.stringify(y)}`;
  };
  for (const k of Object.keys(want)) assert.deepStrictEqual(got[k], want[k], `🔴 x_pizza groupless state "${k}" changed — ${firstDiff(got[k], want[k], k)}`);
  assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(want).sort(), 'the same states');
  ok(`x_pizza with no groups: ${Object.keys(want).length} DOM states (grid, ordinary modal through add/extra, cart review, sold-out, live re-apply) equal the 4e2a710 golden`);
}
closeAll();
console.log('\nxpizza-groupless-golden: OK');
