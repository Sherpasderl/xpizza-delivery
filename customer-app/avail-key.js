'use strict';
// ── availKey — canonical menu-item-availability key encoder (KDS Phase 2b · KDS_2B_PLAN.md #2/#11) ──
//
// ONE reversible, collision-free key used BYTE-IDENTICALLY by every surface that reads or writes the
// /restaurants/{rid}/item_availability/{key} node: the server (xpizza-functions), the KDS Disponibilidad
// panel, and BOTH order forms. If the copies ever DRIFT, a "86" flag silently becomes invisible — so this
// file is the single source of truth (xpizza-functions/avail-key.js) and avail-key.test.mjs asserts every
// other surface copy is byte-identical to it.
//
// The key mirrors the pricing key (menu-pricing.js): x_pizza → item NAME, la_musa → item id/slug.
// encodeURIComponent escapes every RTDB-forbidden char EXCEPT ".": it turns  # $ [ ] / space & … into
// %XX, and a literal "%" into "%25" (so the encoding is truly reversible and collision-free —
// 'A/B' → 'A%2FB' while the literal 'A%2FB' → 'A%252FB', distinct). The added .replace(".", "%2E")
// closes the last forbidden char. Reverse = decodeURIComponent.
//
// UMD-lite: NO `export` keyword, so the same bytes are a valid Node CommonJS module (server `require`)
// AND a classic browser <script> (the KDS/forms read window.availKey / window.decodeAvailKey). The two
// one-line function bodies below are the canonical definition — do not edit one copy without the others
// (the drift test will fail the build).
function availKey(raw)      { return encodeURIComponent(String(raw)).replace(/\./g, '%2E'); }
function decodeAvailKey(k)  { return decodeURIComponent(k); }
(function (root) {
  if (typeof module !== 'undefined' && module.exports) module.exports = { availKey, decodeAvailKey };
  else { root.availKey = availKey; root.decodeAvailKey = decodeAvailKey; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
