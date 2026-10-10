'use strict';
// 1D add-product PHASE B (rev 6) — the test-only INVERSE of this slice's index.js footprint (the split-file fold pattern, as
// tools/addproduct-inverse.js, d4c4-inverse.js, d4c5-inverse.js). Proof (i): unapplyAddProductB(index.js) === 4e2a710:index.js
// byte-for-byte. Proof (ii): the guards that pin index.js to an integration parent apply it FIRST, then add-product A's
// inverse, then D4-c4's and D4-c5's.
// The hunks: the group-intake + platform-groups imports; the cash group refusal; the card group decision; the
// choiceArmed flag; the acquireHostedAttempt argument; the choice_required branch; the quoteOrder / quoteRedemption checks.
// Each hunk must occur EXACTLY once, else this throws (a moved, duplicated or edited hunk is never tolerated).
// GENERATED from the base (4e2a710) vs candidate index.js; JSON-quoted strings.

const INDEX_HUNKS = [
 [
  "const GI = require('./catalog/group-intake');   // 1D add-product B (rev 6): the group rules at intake / quote (render capability only)\nconst { groupCapabilities } = require('./catalog/platform-groups');   // 1D add-product B: the two PLATFORM switches (no brand)\n",
  ""
 ],
 [
  "    // 1D add-product B (rev 6): the group rules, render capability on only — a bare launcher line or reward → 409\n    // choice_required; a choice whose launcher is 86'd → item_unavailable; an unreadable variant map → 503. Same snapshot,\n    // after the dedupe, before any write or reserve.\n    const groupRefusal = GI.cashRefusal(await GI.groupIssues({ caps: groupCapabilities(), gates: intakeGates, items: body.items, restaurantId,\n      rewardKeys: GI.rewardKeysOf(body.redeem), readAvailability: async () => (await db.ref(`restaurants/${restaurantId}/item_availability`).once('value')).val() }));\n    if (groupRefusal) { if (groupRefusal.retryAfter) res.set('Retry-After', String(groupRefusal.retryAfter)); return res.status(groupRefusal.status).json(groupRefusal.body); }\n",
  ""
 ],
 [
  "  let choiceArmed = false;   // 1D add-product B: a non-fresh request carrying a bare launcher (line or reward) — no fresh URL\n",
  ""
 ],
 [
  "    }\n    // 1D add-product B (rev 6): the group rules (render capability only), decided like the guard above — a FRESH issuance\n    // is refused here; a verified reuse keeps its BOUND snapshot and only arms the guard in acquireHostedAttempt (so a\n    // reuse → fresh rotation is refused there); parent-86'd choices join cartBlocked (acquire enforces it the same way).\n    {\n      const gd = GI.chargeDecision(await GI.groupIssues({ caps: groupCapabilities(), gates: intakeGates, items: body.items, restaurantId,\n        rewardKeys: (redemptionFreeItems || []).map((fi) => fi.item_id),\n        readAvailability: async () => (await db.ref(`restaurants/${restaurantId}/item_availability`).once('value')).val() }), clsForMenu);\n      if (gd.respond) { if (gd.respond.retryAfter) res.set('Retry-After', String(gd.respond.retryAfter)); return res.status(gd.respond.status).json({ ...gd.respond.body, order_id: orderId }); }\n      if (gd.armMenu) menuArmed = true;\n      if (gd.armChoice) choiceArmed = true;\n      for (const b of gd.block) if (!cartBlocked.includes(b)) cartBlocked.push(b);\n",
  ""
 ],
 [
  "    acq = await acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, nowTs, cartBlocked, undefined, undefined, canonicalChargeFp, floorBelow, controlArmed !== null, menuArmed, choiceArmed);   // P-SELFUPDATE §5 (2): refuseFresh; D4-c4: the race guard; add-product A: the menu guard\n",
  "    acq = await acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, nowTs, cartBlocked, undefined, undefined, canonicalChargeFp, floorBelow, controlArmed !== null, menuArmed);   // P-SELFUPDATE §5 (2): refuseFresh; D4-c4: the race guard; add-product A: the menu guard\n"
 ],
 [
  "    }\n    if (acq.reason === 'choice_required') {   // 1D add-product B: a drift to a fresh issuance carrying a bare launcher\n      console.warn(`chargeOnlineOrder: ${orderId} — 409 choice_required (group guard)`);\n      return res.status(409).json({ ...GI.CHOICE_REQUIRED, order_id: orderId });\n",
  ""
 ],
 [
  "      // 1D add-product B: a bare launcher quotes as choice_required (render capability on only — no read otherwise)\n      if (groupCapabilities().render) {\n        const qr = GI.quoteRefusal(await GI.groupIssues({ caps: groupCapabilities(), gates: await gateReader().intakeGatesFor(restaurantId), items: body.items, restaurantId }));\n        if (qr) return res.status(200).json({ ok: false, ...qr });\n      }\n",
  ""
 ],
 [
  "      // 1D add-product B: a bare launcher (line or reward) quotes as choice_required (render capability on only)\n      if (groupCapabilities().render) {\n        const qr = GI.quoteRefusal(await GI.groupIssues({ caps: groupCapabilities(), gates: await gateReader().intakeGatesFor(restaurantId), items: body.items, restaurantId, rewardKeys: GI.rewardKeysOf(body.redeem) }));\n        if (qr) return res.status(409).json({ ok: false, ...qr });\n      }\n",
  ""
 ]
];

function apply(src, hunks, label) {
  let out = src;
  for (const [cand, base] of hunks) {
    const n = out.split(cand).length - 1;
    if (n !== 1) throw new Error(`${label}: a hunk occurs ${n}× (expected exactly once): ${JSON.stringify(cand.slice(0, 120))}`);
    out = out.replace(cand, () => base);
  }
  return out;
}
const unapplyAddProductB = (indexSrc) => apply(indexSrc, INDEX_HUNKS, 'addproduct-b-inverse index.js');

module.exports = { unapplyAddProductB, INDEX_HUNKS };
