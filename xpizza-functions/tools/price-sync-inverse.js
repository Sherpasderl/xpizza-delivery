'use strict';
// MENU PRICE SYNC — the INVERSE for price-DATA edits to menu-pricing.js, which older slices pin byte-for-byte
// (extras-wiring.guard: menu-pricing.js minus its extras hunks == 537bbbc; catalog/identity-record-guards: the sha of
// menu-pricing.js after every newer inverse). Those guards apply unapplyPriceSync FIRST (newest first), so a byte outside
// these exact hunks still fails them.
//
// Why price data changes here at all: the committed form bundle is generated from the in-repo bootstrap (the form MENU
// literal + these tables, which must agree — menu-gates source_malformed), so bringing a form's baked menu back in line
// with its brand's PUBLISHED catalog means moving both. Each hunk is one table row, `now` = the published price, `was` =
// the row as pinned. Add a hunk per synced row; never edit a pinned hunk.
const HUNKS = Object.freeze([
 {
  // la_musa, published catalog 2026-09-16 (portal publish, seq 5): dimsum_01 223→249, dimsum_03 198→286, dimsum_04 237→288
  "file": "menu-pricing.js",
  "now": "  dimsum_01: 249, dimsum_02: 248, dimsum_03: 286, dimsum_04: 288, dimsum_05: 260,\n",
  "was": "  dimsum_01: 223, dimsum_02: 248, dimsum_03: 198, dimsum_04: 237, dimsum_05: 260,\n"
 }
]);

function unapplyPriceSync(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`price-sync-inverse: ${file}: a price-sync hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
module.exports = { HUNKS, FILES, unapplyPriceSync };
