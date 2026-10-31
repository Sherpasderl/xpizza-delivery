'use strict';
// DISH PHOTOS A2 step 10 — the slice's INVERSE for the MODULES older slices pin byte-for-byte (catalog/context-guards: catalog-publish.js
// by sha; catalog/identity-integrity-guards + identity-record-guards; extras-wiring and pmdisplay-wiring against their bases). TWO
// SAME-LINE hunks in catalog/catalog-publish.js: the photos commit hook on publishVersion's verifyVersionStructure line (before the flip)
// and the meta/photos delete on deleteVersion's extras line. Every fold site applies unapplyPhotosModule INNERMOST (newest first), then
// the older module inverses (formbake, public-menu-display, extras), so any byte outside these exact hunks still fails them.
// photos-module-wiring.guard.test.js proves this inverse reproduces BASE:catalog/catalog-publish.js byte-for-byte; each `now` occurs once.
const BASE = '743277de';
const HUNKS = Object.freeze([
 {
  "file": "catalog/catalog-publish.js",
  "now": "    await verifyVersionStructure(db, rid, versionId); if (input && input.photos) await input.photos.commit(db, rid, versionId); // throws on a broken menu_structure bijection; DISH PHOTOS A2 step 10: meta/photos + registry refs in ONE transaction, BEFORE the flip\n",
  "was": "    await verifyVersionStructure(db, rid, versionId); // throws on a broken menu_structure bijection\n"
 },
 {
  "file": "catalog/catalog-publish.js",
  "now": "  extras.forEach((d) => ops.push((b) => b.delete(d.ref))); ops.push((b) => b.delete(vref.collection('meta').doc('photos')));   // DISH PHOTOS A2: meta/photos is deleted with its version\n",
  "was": "  extras.forEach((d) => ops.push((b) => b.delete(d.ref)));\n"
 }
]);
function unapplyPhotosModule(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`photos-module-inverse: ${file}: a photos hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
module.exports = { BASE, HUNKS, FILES, unapplyPhotosModule };
