// «Rendimiento» (P-1 nav, owner 11-13 map Q4): the change's EXACT hunks, [now, was] per file, cut against
// REND_BASE (the P-1 branch's base: 5ffix 7c0774c7). Folded out FIRST by portalui-guards (the newest layer, above RP), so RP and every older pin
// judge exactly what they judged before. Regenerated only from the change's diff (D4c-grill/review-portal/p1/gen_rend_fold.py);
// an edit outside these hunks, or inside one, fails.
export const REND_BASE = '7c0774c7';
// Nav B (owner 11-14 — advisor ruling): «Ventas», «Calificaciones» and «Tu nivel» are three nav entries; the Rendimiento tab strip
// and its registry are RETIRED, so ventas.js is REND_BASE byte-for-byte again. ONE hunk stays: app.js's `portal:restaurant` carries
// the restaurant's name (Calificaciones' scope line — its own page now, calificaciones-view.js).
export const REND_FOLD = {
 "app.js": [
  [
   "  document.dispatchEvent(new CustomEvent('portal:restaurant', { detail: { rid, sales, name } }));   // P-1: the name labels Calificaciones' scope\n",
   "  document.dispatchEvent(new CustomEvent('portal:restaurant', { detail: { rid, sales } }));\n"
  ]
 ]
};
