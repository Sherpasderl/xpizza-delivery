// --set c1 — C-1a (PLAN-capp-c1-build r0; D-3 r3 frames 9.1 store / 9.4 home) and C-3r (frame 13 on «Volver a pedir») side-by-sides.
// The directory is a directory-2 body built with the REAL ratings chain — rating-v2 fulfilmentUpdater → v2Updater →
// aggregate.buildPublicStats → directory.ratingsOf — placed in the real ENTRY_FIELDS order over the pinned s7a2 «complete» entries:
// x_pizza «★ 4,8 (124)» (124 live ratings), la_musa «Nuevo en Sherpa» (2 ratings, first served 10 days before the run's pinned clock).
// D-3 r3 is drawn light only (dark pairs are real-only, reviewed for contrast + text fit). 9.4's «Para vos» row is C-1b (not built):
// classify it, never fix it here. The frame-13 scene pairs with the S7a-states frame 13 capture (the owner-approved note).
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { directoryScenario, sbsNow, MEMBER_SEED, memberExtra } from './fixtures.mjs';
import { frame, pairPhone, s7a } from './scenes.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FN = createRequire(path.join(ROOT, 'xpizza-functions/x.js'));
const DIRM = FN('./directory/directory.js'), AGG = FN('./ratings/aggregate.js'), RV2 = FN('./ratings/rating-v2.js');
const DAY = 86400e3, NOW = sbsNow();
function stats(rid, stars, firstServedAt = null) {
  const nodes = stars.map((s, i) => { const o = {}; const n = RV2.fulfilmentUpdater({ restaurantId: rid, now: NOW - 5 * DAY + i }, o)(null); return RV2.v2Updater({ fields: { store: s }, uid: 'u' + i, now: NOW - 4 * DAY + i }, o)(n); });
  return AGG.buildPublicStats({ rid, nowMs: NOW, orders: [], ratings: nodes, priceOf: () => null, firstServedAt });
}
// 124 ratings averaging 4.8 (99 fives + 25 fours = 595 / 124 = 4.798 ⇒ 4,8) — the frame's own numbers
const XP = stats('x_pizza', [...Array(99).fill(5), ...Array(25).fill(4)]), LM = stats('la_musa', [5, 4], NOW - 10 * DAY);
function body() {
  const b = directoryScenario('complete').body; b.representation_version = DIRM.REPRESENTATION_VERSION;
  const by = { x_pizza: XP, la_musa: LM };
  b.restaurants = b.restaurants.map((e) => Object.fromEntries(DIRM.ENTRY_FIELDS.map((k) => [k, k === 'ratings' ? DIRM.ratingsOf(by[e.restaurant_id] || null) : (e[k] === undefined ? null : e[k])])));
  const xr = b.restaurants.find((e) => e.restaurant_id === 'x_pizza').ratings, lr = b.restaurants.find((e) => e.restaurant_id === 'la_musa').ratings;
  if (!(xr && xr.rating_avg === 4.8 && xr.rating_count === 124) || !(lr && Object.keys(lr).join() === 'new_until')) throw new Error('C1 SBS: the real chain did not publish the frame\'s numbers');
  return b;
}
const DIR = { directoryBody: body(), directoryEtag: '"sbs-c1-ratings"' };

const lightOnly = (m) => (theme) => (theme === 'light' ? m : null);
const both = (m) => () => m;
const homeReady = { until: 'document.querySelector(".hsec .rcard .rating, .rlist .rcard .rating")', ms: 20000 };   // the rated card painted
const openStore = (rid) => [homeReady, { run: `(document.querySelector('.hsec[aria-label="Todos los restaurantes"] .rcard[data-rid="${rid}"]') || document.querySelector('.rlist .rcard[data-rid="${rid}"]')).click()` },
  { until: 'document.querySelector(".sinfo .facts .rating, #top .info .facts .rating, .sinfo .facts .pill.new, #top .info .facts .pill.new")', ms: 20000 }, { wait: 500 }];
const tab = (t) => ({ run: `(() => { const b = [...document.querySelectorAll('[data-act="tab"][data-tab="${t}"]')].find((x) => x.getClientRects().length); if (!b) throw new Error('no visible ${t} tab'); b.click(); })()` });
const TEXTFIT = 'text fit (rule 16b): «★ 4,8 (124) · Abierto · cierra …» on ONE line at 390 — no wrap, no truncation';

// C-3r: the member's past order XPZ261023-OLD003 (2× Margherita, option-less) was charged at L 250 a dish — S-D's v1 snapshot of THAT
// charge; today's menu serves L 299 ⇒ «Volver a pedir» opens the cart with frame 13 «Cambió el precio de Margherita: antes L 250, ahora L 299.»
const OLD_SNAP = { 'XPZ261023-OLD003': { v: 1, lines: [{ unit_cents: 25000, line_cents: 50000 }] } };

export const C1_SCENES = [
  // ── C-1a · 9.1 store ──
  { name: 'C1a-store-desk-1440', width: 1440, height: 900, fixtures: DIR, steps: openStore('x_pizza'), themes: ['light', 'dark'], mock: lightOnly(frame('r1')),
    note: 'the rating first fact; the heart + share at the hero top-right (a GUEST: the heart shown)' },
  { name: 'C1a-store-phone-390', width: 390, height: 844, fixtures: DIR, steps: openStore('x_pizza'), themes: ['light', 'dark'], mock: lightOnly(pairPhone('r1', 0)), note: TEXTFIT },
  { name: 'C1a-store-phone-new-390', width: 390, height: 844, fixtures: DIR, steps: openStore('la_musa'), themes: ['light', 'dark'], mock: lightOnly(pairPhone('r1', 1)),
    note: 'below the threshold: «Nuevo en Sherpa», no number' },
  { name: 'C1a-store-phone-member-390', width: 390, height: 844, seed: MEMBER_SEED(), fixtures: { ...DIR, extra: memberExtra() }, steps: openStore('x_pizza'), themes: ['light'], mock: lightOnly(pairPhone('r1', 0)),
    note: 'a MEMBER: the heart slot reserved (hidden) until C-1b — the share and search keep their places' },
  // ── C-1a · 9.4 home ──
  { name: 'C1a-home-desk-1440', width: 1440, height: 900, fixtures: DIR, steps: [homeReady, { wait: 400 }], themes: ['light', 'dark'], mock: lightOnly(frame('r4')),
    note: 'the «Para vos» row is C-1b (not built) — classify; the rated card meta is what C-1a owns' },
  { name: 'C1a-home-phone-390', width: 390, height: 844, fixtures: DIR, steps: [homeReady, { wait: 400 }], themes: ['light', 'dark'], mock: lightOnly(pairPhone('r4', 0)), note: TEXTFIT.replace('Abierto · cierra …', 'Abierto · Envío desde L 45') },
  // ── C-3r · frame 13 on «Volver a pedir» (option-less, the v1 rule) ──
  { name: 'C3r-frame13-reorder-390', width: 390, height: 844, seed: MEMBER_SEED(), fixtures: { ...DIR, extra: memberExtra({ snapshots: OLD_SNAP }) },
    steps: [homeReady, tab('orders'), { until: 'document.querySelector(\'.orow [data-act="reorder"][data-oid="XPZ261023-OLD003"]\')', ms: 20000 }, { run: `document.querySelector('.orow [data-act="reorder"][data-oid="XPZ261023-OLD003"]').click()` },
      { until: 'document.querySelector(\'.cartnote[role="status"] .cn-l\')', ms: 20000 }, { wait: 600 }],
    themes: ['light', 'dark'], mock: s7a(13), note: 'frame 13: «Cambió el precio de Margherita: antes L 250, ahora L 299.» + the struck old subtotal' },
];
