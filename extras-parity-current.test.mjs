// PER-PRODUCT EXTRAS — GATE 0, rendered-set parity on the CURRENT forms (PLAN rev 2.1 §13 gate 0). Run: node extras-parity-current.test.mjs
// For EVERY orderable product on BOTH brands, the extras the REAL current form's picker renders must equal
// eligibleExtras(projection, item) from the one evaluator (catalog/extras-eligibility.js), in pricing keys. Until this holds
// on live data, no restriction may become authoritative: a form that already hides (or shows) something the evaluator
// disagrees with would make every later shadow log meaningless.
//
//   default: each brand's code-seeded source (tools/seed-source-store buildSourceFromCode) against the form's own bundle.
//   LIVE (read-only, the advisor's run): EXTRAS_PARITY_<RID>_SOURCE=<source.json> and EXTRAS_PARITY_<RID>_MENU=<getPublicMenu
//   body.json> (RID = X_PIZZA / LA_MUSA) — the form is served that menu, the evaluator reads that source.
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { loadForm, settle, serve, envelope, closeAll, counter, BRAND } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { projectEligibility, eligibleExtras } = require('./catalog/extras-eligibility');
const { buildSourceFromCode } = require('./tools/seed-source-store');
const { ok } = counter();
const $ = (w, id) => w.document.getElementById(id);

// the extra ids the open detail modal renders as addable (ordinary rows, or a launcher's staged rows), unique, in order
function renderedExtraIds(w) {
  const scroll = $(w, 'detail-scroll');
  const ids = [...scroll.querySelectorAll('[data-act="extra"], [data-act="staged"]')].map((b) => b.getAttribute('data-eid'));
  return [...new Set(ids)];
}

async function parityFor(dir) {
  const B = BRAND[dir];
  const RID = B.rid;
  const envKey = RID.toUpperCase();
  const liveSrc = process.env[`EXTRAS_PARITY_${envKey}_SOURCE`];
  const liveMenu = process.env[`EXTRAS_PARITY_${envKey}_MENU`];
  const source = liveSrc ? JSON.parse(readFileSync(liveSrc, 'utf8')) : buildSourceFromCode(RID);
  const proj = projectEligibility(source);
  const w = loadForm(dir); await settle();
  if (liveMenu) await serve(w, JSON.parse(readFileSync(liveMenu, 'utf8')));
  const MENU = w.liveMenuGlobalGet('MENU');
  const EXTRAS = w.liveMenuGlobalGet('EXTRAS');
  const VARIANTS = w.liveMenuGlobalGet('VARIANT_ITEMS') || {};
  // the form's addressing → pricing keys (by data: x_pizza addresses dishes and extras by NAME, la_musa by ID)
  const byName = RID === 'x_pizza';
  const dishKey = (d) => (byName ? d.name : String(d.id));
  const extraKey = (e) => (byName ? e.name : String(e.id));
  const extraKeyById = new Map(EXTRAS.map((e) => [String(e.id), extraKey(e)]));
  let checked = 0; const mismatches = [];
  for (const d of MENU) {
    if (d.variantOf) continue;                       // reached through its launcher (checked there, and asserted equal below)
    if (!(d.price > 0) && !VARIANTS[d.id]) continue;  // "próximamente" rows are not orderable
    const key = dishKey(d);
    if (!proj.items[key]) { mismatches.push(`${key}: on the form, not in the source`); continue; }
    // open the picker the way a customer does: both forms show a dish's extras once it is in the cart (a launcher's picker
    // shows its staged extras at once)
    if (!VARIANTS[d.id]) { w.chg(d.id, 1); await settle(); }
    w.openDetailModal(d.id); await settle();
    const shown = renderedExtraIds(w).map((id) => extraKeyById.get(id) || `?${id}`);
    w.closeDetailModal(); await settle();
    if (!VARIANTS[d.id]) { w.chg(d.id, -1); await settle(); }
    const want = eligibleExtras(proj, key);
    if (JSON.stringify([...shown].sort()) !== JSON.stringify([...want].sort())) mismatches.push(`${key}: form shows [${shown.join(', ')}] vs evaluator [${want.join(', ')}]`);
    // a launcher's variants: the evaluator gives each its launcher's set (§3), which is what the launcher's picker shows
    if (VARIANTS[d.id]) for (const vid of VARIANTS[d.id].variantIds) {
      const v = MENU.find((m) => String(m.id) === String(vid));
      if (v && JSON.stringify(eligibleExtras(proj, dishKey(v))) !== JSON.stringify(want)) mismatches.push(`${dishKey(v)}: variant set differs from its launcher's`);
    }
    checked += 1;
  }
  return { RID, checked, mismatches, live: !!liveSrc };
}

for (const dir of ['xpizza-orders', 'la-musa-orders']) {
  const r = await parityFor(dir);
  assert.ok(r.checked > 0, `${r.RID}: premise — products were checked`);
  assert.deepStrictEqual(r.mismatches, [], `🔴 GATE 0 ${r.RID}${r.live ? ' (LIVE)' : ''}: the current form's picker and the evaluator disagree:\n  ${r.mismatches.join('\n  ')}`);
  ok(`${r.RID}${r.live ? ' (LIVE data)' : ''}: for all ${r.checked} orderable products the CURRENT form's rendered extras equal eligibleExtras (pricing keys)`);
}
closeAll();
console.log('\nextras-parity-current: OK');
