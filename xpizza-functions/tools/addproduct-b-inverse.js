'use strict';
// 1D add-product PHASE B (rev 6) — the test-only INVERSE of this slice's index.js footprint (the split-file fold pattern, as
// tools/addproduct-inverse.js, d4c4-inverse.js, d4c5-inverse.js). Proof (i): unapplyAddProductB(index.js) === 4e2a710:index.js
// byte-for-byte. Proof (ii): the guards that pin index.js to an integration parent apply it FIRST, then add-product A's
// inverse, then D4-c4's and D4-c5's.
// The hunks: the group-intake + platform-groups imports; the cash group refusal; the card group decision; the
// choiceArmed flag; the acquireHostedAttempt argument; the choice_required branch; the quoteOrder / quoteRedemption checks;
// codex PB-1 r1 P1-3: the bound-reuse / charge-input imports, the bound-reuse fast path + preparation-failure precedence,
// and the charge_inputs_fp binding on the pending reward order.
// Each hunk must occur EXACTLY once, else this throws (a moved, duplicated or edited hunk is never tolerated).
// GENERATED from the base (4e2a710) vs candidate index.js; JSON-quoted strings.

const INDEX_HUNKS = [
 [
  "const GI = require('./catalog/group-intake');   // 1D add-product B (rev 6): the group rules at intake / quote (render capability only)\nconst BR = require('./catalog/bound-reuse');      // 1D add-product B (codex PB-1 r1 P1-3): a reward order's live checkout resumes from its BOUND snapshot\nconst CI = require('./catalog/charge-inputs');    // 1D add-product B (codex PB-1 r1 P1-3): the ONE charge-input canonicalizer (bound at issuance)\nconst { resolveHostedAttemptAction: resolveBoundReuse } = require('./hosted-charge-flow');   // the SAME reuse answer acquire's reuse gets\nconst { groupCapabilities } = require('./catalog/platform-groups');   // 1D add-product B: the two PLATFORM switches (no brand)\n",
  ""
 ],
 [
  "    // 1D add-product B (rev 6): the group rules, render capability on only — a bare launcher line or reward → 409\n    // choice_required; a choice whose launcher is 86'd → item_unavailable; an unreadable variant map → 503. Same snapshot,\n    // after the dedupe, before any write or reserve.\n    const groupRefusal = GI.cashRefusal(await GI.groupIssues({ caps: groupCapabilities(), gates: intakeGates, items: body.items, restaurantId,\n      rewardKeys: GI.rewardKeysOf(body.redeem), readAvailability: async () => (await db.ref(`restaurants/${restaurantId}/item_availability`).once('value')).val() }));\n    if (groupRefusal) { if (groupRefusal.retryAfter) res.set('Retry-After', String(groupRefusal.retryAfter)); return res.status(groupRefusal.status).json(groupRefusal.body); }\n",
  ""
 ],
 [
  "  /* 1D add-product B (codex PB-1 r1 P1-3; plan §0d.1) — BOUND REUSE, before any re-preparation: a reward order whose live\n     checkout was issued under the render capability resumes from its BOUND snapshot (same charge inputs, same verified\n     customer, a live URL by the existing classifier, the hold still this order's) — never re-priced, re-gated or re-checked\n     against today's catalog. Read-only; any doubt or error → null → the current path below (fresh issuance and rotation\n     always meet current enforcement). Answered exactly as acquire's reuse is (the same hosted-flow reuse branch). */\n  if (body.redeem != null && customer_uid && groupCapabilities().render) {\n    const boundAcq = await BR.probeBoundReuse(db, { orderId, uid: customer_uid, rid: restaurantId, body, now: Date.now() });\n    if (boundAcq) {\n      const never = () => { throw new Error('bound reuse never gates, releases or retires'); };\n      const flow = await resolveBoundReuse({ acq: boundAcq, orderId, totalCents: null, releaseHold: never, retireAttempt: never, runGate: never, log: console });\n      return res.status(flow.respond.status).json(flow.respond.body);\n    }\n  }\n",
  ""
 ],
 [
  "    if (!prep.ok) {\n      // 1D add-product B (codex PB-1 r1 P1-3): a failed preparation whose reward is a bare launcher (or unclassifiable by the\n      // gate snapshot) answers choice_required / menu_updating rather than its own error — render capability only.\n      const pr = GI.prepFailureRefusal(await GI.groupIssues({ caps: groupCapabilities(), gates: await gateReader().intakeGatesFor(restaurantId),\n        items: body.items, restaurantId, rewardKeys: GI.rewardKeysOf(body.redeem) }));\n      if (pr) { if (pr.retryAfter) res.set('Retry-After', String(pr.retryAfter)); return res.status(pr.status).json({ ...pr.body, order_id: orderId }); }\n      return res.status(prep.status).json({ ...prep.body, order_id: orderId });   // non-payable, nothing written, NO reserve yet\n    }\n",
  "    if (!prep.ok) return res.status(prep.status).json({ ...prep.body, order_id: orderId });   // non-payable, nothing written, NO reserve yet\n"
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
  "    // 1D add-product B (codex PB-1 r1 P1-3): the CHARGE-INPUT fingerprint this reward order is bound to (render capability only)\n    ...(redemptionCanonical && groupCapabilities().render && CI.chargeInputsFingerprint(body) ? { charge_inputs_fp: CI.chargeInputsFingerprint(body) } : {}),\n",
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
 ],
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
