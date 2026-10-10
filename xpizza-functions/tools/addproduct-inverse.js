'use strict';
// 1D add-product PHASE A — the test-only INVERSE of this slice's index.js footprint (the split-file fold pattern, as
// tools/d4c4-inverse.js and tools/d4c5-inverse.js). Proof (i): unapplyAddProduct(index.js) === 37dcf43:index.js
// byte-for-byte. Proof (ii): the guards that pin index.js to its integration parent apply it FIRST on the portal fold
// (with the moved-block hunks), then the D4-c4 and D4-c5 inverses — reproducing the bb37684 pin.
// INDEX hunks live in index.js itself: the menu-gates import, the createOrder + chargeOnlineOrder known-key refusal,
// the menu guard flag/variable, the acquireHostedAttempt argument, the menu_updating branch, the resetDraftToLive
// re-export. PORTAL hunks live in portal/functions.js's MOVED blocks and so exist only in the fold: the extras' records
// on the active read, the addProduct dependency of editCatalog / publishEdited, the getEditableCatalog assessment read.
// Each hunk must occur EXACTLY once, else this throws (a moved, duplicated or edited hunk is never tolerated).
// GENERATED from the base (37dcf43) vs candidate index.js and fold; JSON-quoted strings.

const INDEX_HUNKS = [
 [
  "const { absentFromMenu, MENU_UPDATING } = require('./catalog/menu-gates');   // 1D add-product A §0b.1: keys the gate snapshot cannot classify\n",
  ""
 ],
 [
  "    // 1D add-product A §0b.1: from the SAME snapshot, the known-key membership — a key it cannot classify (a product\n    // added after this snapshot, or a portal addition while the read fails) is refused, retryably, before any write.\n    const intakeGates = await gateReader().intakeGatesFor(restaurantId);\n    const unknownKeys = absentFromMenu(body.items, restaurantId, intakeGates.known);\n    if (unknownKeys.length) {\n      console.warn(`createOrder: ${orderId} — 503 menu_updating (keys the gate snapshot does not know: ${unknownKeys.join(', ')})`);\n      res.set('Retry-After', '2');\n      return res.status(503).json({ ...MENU_UPDATING });\n    }\n    const weekendKeys = intakeGates.weekend;\n",
  "    const weekendKeys = await gateReader().weekendOnlyKeysFor(restaurantId);\n"
 ],
 [
  "  let menuArmed = false;     // 1D add-product A §0b.1: a non-fresh request carrying a key the gate snapshot does not know\n  let clsForMenu = null;     // 1D add-product A: the preliminary classification, for the menu pre-gate below (null = failed)\n",
  ""
 ],
 [
  "      clsForMenu = clsG;   // 1D add-product A\n",
  ""
 ],
 [
  "    // 1D add-product A §0b.1: the known-key membership from the SAME snapshot, enforced like c4's race guard — a\n    // FRESH checkout (or a failed classifier) is refused here, before reserving; anything else (reuse, in_progress,\n    // paid, closed) is honoured and ARMS the guard in acquireHostedAttempt against a drift to a fresh issuance.\n    const intakeGates = await gateReader().intakeGatesFor(restaurantId);\n    const unknownKeys = absentFromMenu(body.items, restaurantId, intakeGates.known);\n    if (unknownKeys.length) {\n      const mg = OCS.chargePreGate('menu_updating', clsForMenu);\n      if (mg.refuse) {\n        console.warn(`chargeOnlineOrder: ${orderId} — 503 menu_updating (keys the gate snapshot does not know: ${unknownKeys.join(', ')})`);\n        res.set('Retry-After', '2');\n        return res.status(503).json({ ...MENU_UPDATING });\n      }\n      menuArmed = true;\n    }\n    const weekendKeys = intakeGates.weekend;\n",
  "    const weekendKeys = await gateReader().weekendOnlyKeysFor(restaurantId);\n"
 ],
 [
  "    acq = await acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, nowTs, cartBlocked, undefined, undefined, canonicalChargeFp, floorBelow, controlArmed !== null, menuArmed);   // P-SELFUPDATE §5 (2): refuseFresh; D4-c4: the race guard; add-product A: the menu guard\n",
  "    acq = await acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, nowTs, cartBlocked, undefined, undefined, canonicalChargeFp, floorBelow, controlArmed !== null);   // P-SELFUPDATE §5 (2): refuseFresh; D4-c4: the race guard\n"
 ],
 [
  "    }\n    if (acq.reason === 'menu_updating') {   // 1D add-product A §0b.1: a drift to a fresh issuance with a key the gate cannot classify\n      console.warn(`chargeOnlineOrder: ${orderId} — 503 menu_updating (menu guard)`);\n      res.set('Retry-After', '2');\n      return res.status(503).json({ ...MENU_UPDATING });\n",
  ""
 ],
 [
  "exports.resetDraftToLive = require('./portal/reset-draft').resetDraftToLive;   // 1D add-product A §0.1: \"Volver al menú publicado\" (full load; not an isolated portal fn)\n",
  ""
 ]
];

const PORTAL_HUNKS = [
 [
  "  return { built: { items: preview.items, structure: preview.structure, extras }, versionId, extraRecords: preview.extras };   // 1D add-product A: + the extras' records\n",
  "  return { built: { items: preview.items, structure: preview.structure, extras }, versionId };\n"
 ],
 [
  "        toPrecondition: decodeUpdateTimeForEdit,\n        addProduct: addProductIoForEdit(),   // 1D add-product A\n",
  "        toPrecondition: decodeUpdateTimeForEdit,\n"
 ],
 [
  "        alarm: (kind, detail) => paymentAlert(getDatabase(), kind, detail),\n        addProduct: addProductIoForEdit(),   // 1D add-product A\n",
  "        alarm: (kind, detail) => paymentAlert(getDatabase(), kind, detail),\n"
 ],
 [
  "        readActiveBuilt: readActiveBuiltForEdit,   // 1D add-product A: assess the saved draft against what is serving\n",
  ""
 ]
];

function unapply(src, hunks, label) {
  let out = src;
  for (const [now, was] of hunks) {
    const i = out.indexOf(now);
    if (i < 0 || out.indexOf(now, i + 1) !== -1) throw new Error(`addproduct-inverse (${label}): hunk not found exactly once: ${now.slice(0, 80)}`);
    out = out.slice(0, i) + was + out.slice(i + now.length);
  }
  return out;
}
// index.js alone → 37dcf43:index.js
const unapplyAddProduct = (src) => unapply(src, INDEX_HUNKS, 'index');
// the portal FOLD (index.js with the moved blocks re-inlined) → the base fold
const unapplyAddProductFold = (src) => unapply(unapply(src, PORTAL_HUNKS, 'portal'), INDEX_HUNKS, 'index');

module.exports = { unapplyAddProduct, unapplyAddProductFold, INDEX_HUNKS, PORTAL_HUNKS };
