'use strict';
// PLAN-A A-1 (A8a step 1: text-version provenance readers, writes OFF) — the slice's test-only INVERSE. Byte-exact HUNKS over
// index.js and the zero-diff-pinned modules (createorder-classify.js, rewards-redeem-intake.js); unapplyA1Index /
// unapplyA1Module swap each back, so the result === 341d1b1a:<file> byte-for-byte (a1-wiring.guard). It is the NEWEST slice:
// every index.js fold and every pin chain applies it FIRST.
const BASE = '341d1b1a';
const HUNKS = Object.freeze([
 {
  "file": "index.js",
  "now": "const { shouldEarnOnStatus, earnPreview } = require('./rewards-core');     //   pure terminal-state gate + the reward-card earn_preview\nconst { resolveRedemptionForOrder, prepareRedemption, quoteRedemptionCore } = require('./rewards-redeem-intake');\n/* a1:begin require */\nconst TV = require('./catalog/text-version');   // PLAN-A A8a step 1: text-version provenance (writeMode hard-wired legacy in A-1)\n/* a1:end require */   // Phase B1 intake (cash/online) + B2 read-only quote\nconst { classifyExistingOrder, computeIncomingFingerprint, computeCanonicalIncomingFingerprint } = require('./createorder-classify');   // F1: method/state/content-aware idempotent-return (no false \"order placed\")\n",
  "was": "const { shouldEarnOnStatus, earnPreview } = require('./rewards-core');     //   pure terminal-state gate + the reward-card earn_preview\nconst { resolveRedemptionForOrder, prepareRedemption, quoteRedemptionCore } = require('./rewards-redeem-intake');   // Phase B1 intake (cash/online) + B2 read-only quote\nconst { classifyExistingOrder, computeIncomingFingerprint, computeCanonicalIncomingFingerprint } = require('./createorder-classify');   // F1: method/state/content-aware idempotent-return (no false \"order placed\")\n"
 },
 {
  "file": "index.js",
  "now": "  const scheduledForRawEarly = SCHED.normalizeScheduledFor(body.scheduled_for);\n  /* a1:begin cash-paid-text-full */\n  const paidTextFull = sanitizeText(body.items_text, Infinity);   // PLAN-A A8a: the untruncated paid text, kept in memory (the 'a8' candidate's source)\n  /* a1:end cash-paid-text-full */\n  const incomingFp = await computeIncomingFingerprint(\n",
  "was": "  const scheduledForRawEarly = SCHED.normalizeScheduledFor(body.scheduled_for);\n  const incomingFp = await computeIncomingFingerprint(\n"
 },
 {
  "file": "index.js",
  "now": "        : null;\n      /* a1:begin cash-a8-incoming */\n      // PLAN-A A8a: ONLY a record marked 'a8' costs the untruncated recompute (from the same snapshot `ev`); unmarked → today's path\n      const a8Incoming = (ev && ev[TV.ORDER_FIELD] === TV.TEXT_A8)\n        ? await computeIncomingFingerprint(\n          { orderId, restaurantId, total, itemsText: paidTextFull, items: body.items, redeem: body.redeem,\n            customerUid: customer_uid, scheduledForRaw: scheduledForRawEarly, orderType },\n          { orderBreakdownCents, prepareRedemption, orderFingerprint, schedFingerprintExtra: SCHED.fingerprintExtra, db, tables: pricingTables, eligible: redeemEligible })\n        : null;\n      /* a1:end cash-a8-incoming */\n      const cls = classifyExistingOrder(ev,\n        { paymentMethod: fields.payment_method, restaurantMatches: sameRestaurant(ev.restaurant_id, restaurantId) },\n        incomingFp, { isPaymentStatusClosed: MR.isStatusChangeClosedToAutomation, canonicalIncoming, a8Incoming });\n      if (cls.action === '409') {\n",
  "was": "        : null;\n      const cls = classifyExistingOrder(ev,\n        { paymentMethod: fields.payment_method, restaurantMatches: sameRestaurant(ev.restaurant_id, restaurantId) },\n        incomingFp, { isPaymentStatusClosed: MR.isStatusChangeClosedToAutomation, canonicalIncoming });\n      if (cls.action === '409') {\n"
 },
 {
  "file": "index.js",
  "now": "  // byte-for-byte (B1 stays inert until B2 flips the flag on and starts sending `redeem`).\n  /* a1:begin cash-version-decl */\n  let cashTextVersion = TV.TEXT_LEGACY;   // PLAN-A A8a: legacy unless a retained 'a8' reservation selected otherwise\n  /* a1:end cash-version-decl */\n  let redemptionCanonical = null;    // stamped onto the order when a reward is applied\n",
  "was": "  // byte-for-byte (B1 stays inert until B2 flips the flag on and starts sending `redeem`).\n  let redemptionCanonical = null;    // stamped onto the order when a reward is applied\n"
 },
 {
  "file": "index.js",
  "now": "    // hold); the completion state consumes, cancel releases. See rewards-redeem-intake.resolveRedemptionForOrder.\n    const a1Cash = { paidTextFull, writeMode: TV.WRITE_MODE };   // PLAN-A A8a: the reservation's own marker selects the binding\n    const rd = await resolveRedemptionForOrder(db, {\n",
  "was": "    // hold); the completion state consumes, cancel releases. See rewards-redeem-intake.resolveRedemptionForOrder.\n    const rd = await resolveRedemptionForOrder(db, {\n"
 },
 {
  "file": "index.js",
  "now": "      context: contextOfTables(pricingTables),   // 1D D4-b\n      ...a1Cash,   // PLAN-A A8a\n    });\n",
  "was": "      context: contextOfTables(pricingTables),   // 1D D4-b\n    });\n"
 },
 {
  "file": "index.js",
  "now": "    if (rd.ownsHold) redemptionReserved = { uid: customer_uid, rid: restaurantId, orderId };\n    /* a1:begin cash-selected-version */\n    if (rd.textVersion === TV.TEXT_A8) cashTextVersion = TV.TEXT_A8;   // a retained 'a8' reservation → the order carries its binding\n    /* a1:end cash-selected-version */\n  }\n",
  "was": "    if (rd.ownsHold) redemptionReserved = { uid: customer_uid, rid: restaurantId, orderId };\n  }\n"
 },
 {
  "file": "index.js",
  "now": "  }\n  /* a1:begin cash-a8-store-fp */\n  if (cashTextVersion === TV.TEXT_A8 && redemptionCanonical && redemptionPriced) {   // the retained binding's text (fields.items_text is the a8 text)\n    const _schedExtraA8 = Number.isFinite(scheduledForRaw) ? SCHED.fingerprintExtra({ scheduled_for: scheduledForRaw, order_type: orderType }) : '';\n    storeFp = orderFingerprint(orderId, redemptionPriced.total_cents, fields.items_text, [_schedExtraA8, `rf:${redemptionFingerprint(redemptionCanonical)}`].filter(Boolean).join('|'));\n  }\n  /* a1:end cash-a8-store-fp */\n\n",
  "was": "  }\n\n"
 },
 {
  "file": "index.js",
  "now": "    if (redemptionCanonical) heldUpdates[`orders/${orderId}`].redemption = redemptionCanonical;   // bind the reward to the order (reserved until release→completion)\n    /* a1:begin cash-marker-held */\n    Object.assign(heldUpdates[`orders/${orderId}`], TV.markerFields(cashTextVersion));   // PLAN-A A8a: presence for 'a8' only, beside the fingerprint\n    /* a1:end cash-marker-held */\n    /* serial3:begin cash-reward-provenance-held */\n",
  "was": "    if (redemptionCanonical) heldUpdates[`orders/${orderId}`].redemption = redemptionCanonical;   // bind the reward to the order (reserved until release→completion)\n    /* serial3:begin cash-reward-provenance-held */\n"
 },
 {
  "file": "index.js",
  "now": "  if (redemptionCanonical) updates[`orders/${orderId}`].redemption = redemptionCanonical;   // bind the reward to the order (reserved until completion consumes)\n  /* a1:begin cash-marker */\n  Object.assign(updates[`orders/${orderId}`], TV.markerFields(cashTextVersion));   // PLAN-A A8a: presence for 'a8' only, beside the fingerprint\n  /* a1:end cash-marker */\n  /* serial3:begin cash-reward-provenance */\n",
  "was": "  if (redemptionCanonical) updates[`orders/${orderId}`].redemption = redemptionCanonical;   // bind the reward to the order (reserved until completion consumes)\n  /* serial3:begin cash-reward-provenance */\n"
 },
 {
  "file": "index.js",
  "now": "  let effTotal = total;\n  /* a1:begin card-paid-text */\n  // PLAN-A A8a: the untruncated paid text (the 'a8' candidate's source) and today's legacy paid text, BEFORE any reward append\n  const paidTextFullC = sanitizeText(body.items_text, Infinity);\n  const legacyPaidTextC = fields.items_text;\n  let cardTextVersion = TV.TEXT_LEGACY;   // legacy unless a retained 'a8' reservation selects otherwise (A-1: writeMode is legacy)\n  /* a1:end card-paid-text */\n  /* 1D add-product B (codex PB-1 r1 P1-3; plan §0d.1) — BOUND REUSE, before any re-preparation: a reward order whose live\n",
  "was": "  let effTotal = total;\n  /* 1D add-product B (codex PB-1 r1 P1-3; plan §0d.1) — BOUND REUSE, before any re-preparation: a reward order whose live\n"
 },
 {
  "file": "index.js",
  "now": "    try {\n      /* a1:begin card-classify-a8 */\n      const a8FpG = () => orderFingerprint(orderId, totalCentsG, `${paidTextFullC}${fields.items_text.slice(legacyPaidTextC.length)}`, [isScheduledG ? SCHED.fingerprintExtra({ scheduled_for: schedForRawG, order_type: orderType }) : '', redemptionFp ? `rf:${redemptionFp}` : ''].filter(Boolean).join('|'));\n      /* a1:end card-classify-a8 */\n      clsG = await classifyHostedAttempt(db, orderId, fingerprintG, nowTs, canonicalFpG, a8FpG);\n      clsForMenu = clsG;   // 1D add-product A\n",
  "was": "    try {\n      clsG = await classifyHostedAttempt(db, orderId, fingerprintG, nowTs, canonicalFpG);\n      clsForMenu = clsG;   // 1D add-product A\n"
 },
 {
  "file": "index.js",
  "now": "  const fingerprint = orderFingerprint(orderId, total_cents, fields.items_text, [isScheduled ? SCHED.fingerprintExtra({ scheduled_for: scheduledForRaw, order_type: orderType }) : '', redemptionFp ? `rf:${redemptionFp}` : ''].filter(Boolean).join('|'));   // v2: + redeemed-SET hash (design-gate #2)\n  /* a1:begin card-a8-candidate */\n  const a8TextC = `${paidTextFullC}${fields.items_text.slice(legacyPaidTextC.length)}`;   // the same reward append over the untruncated paid text\n  const a8FingerprintC = orderFingerprint(orderId, total_cents, a8TextC, [isScheduled ? SCHED.fingerprintExtra({ scheduled_for: scheduledForRaw, order_type: orderType }) : '', redemptionFp ? `rf:${redemptionFp}` : ''].filter(Boolean).join('|'));\n  /* a1:end card-a8-candidate */\n  // 1D D4-b §B.3: the CANONICAL counterpart of `fingerprint` — same inputs, items_text → the canonical digest. A lazy,\n",
  "was": "  const fingerprint = orderFingerprint(orderId, total_cents, fields.items_text, [isScheduled ? SCHED.fingerprintExtra({ scheduled_for: scheduledForRaw, order_type: orderType }) : '', redemptionFp ? `rf:${redemptionFp}` : ''].filter(Boolean).join('|'));   // v2: + redeemed-SET hash (design-gate #2)\n  // 1D D4-b §B.3: the CANONICAL counterpart of `fingerprint` — same inputs, items_text → the canonical digest. A lazy,\n"
 },
 {
  "file": "index.js",
  "now": "    const f = CB.formatOf(probeOrder, 'fp_format');\n    if (!f.ok || !TV.textVersionOf(probeOrder, TV.ORDER_FIELD).ok) return res.status(409).json(OE.orderExistsBody('binding_format_invalid', orderId));   // PLAN-A A8a: + a malformed text-version marker\n    orderBindingFormat = f.format;\n",
  "was": "    const f = CB.formatOf(probeOrder, 'fp_format');\n    if (!f.ok) return res.status(409).json(OE.orderExistsBody('binding_format_invalid', orderId));\n    orderBindingFormat = f.format;\n"
 },
 {
  "file": "index.js",
  "now": "      selectedFormat: orderBindingFormat,\n      canonicalBinding: () => CB.canonicalReservationFields({ redemption: redemptionResolved, context: contextOfTables(pricingTables), selectedOrderBinding: selectedOrder, configVersion: REDEMPTION_CONFIG_VERSION }),\n      /* a1:begin card-reserve-candidates */\n      // the EXISTING order's text version (probeOrder, this request's snapshot) takes precedence over the reservation and the write mode\n      ...(orderBindingFormat === CB.FORMAT_LEGACY ? { a8OrderFingerprint: a8FingerprintC, writeMode: TV.WRITE_MODE,\n        orderTextVersion: probeOrder ? (TV.textVersionOf(probeOrder, TV.ORDER_FIELD).ok ? TV.textVersionOf(probeOrder, TV.ORDER_FIELD).version : 'invalid') : null } : {}),\n      /* a1:end card-reserve-candidates */\n    });\n    if (!rr.ok) return res.status(409).json({ error: 'redemption_reserve_failed', reason: rr.reason, order_id: orderId });\n    redemptionOwnsHold = (rr.action === 'created' || rr.action === 're_reserved');\n    /* a1:begin card-retained-a8 */\n    // PLAN-A A8a step 1 + Q4 (c): a RETAINED 'a8' reservation → the pending record carries ITS binding: the a8 text, the\n    // marker, and (recomputed HERE, only on this branch) the reward provenance, the §3 content keys and the content stamp.\n    if (rr.selected_text_version === TV.TEXT_A8) {\n      cardTextVersion = TV.TEXT_A8;\n      fields.items_text = a8TextC;\n      pendingOrderRecord.items_text = a8TextC;\n      Object.assign(pendingOrderRecord, TV.markerFields(TV.TEXT_A8));\n      const rsA8 = redemptionCanonical ? rewardSuffixOf(redemptionFreeItems, a8TextC) : null;\n      if (rsA8) pendingOrderRecord.reward_text_appended = rsA8; else delete pendingOrderRecord.reward_text_appended;\n      Object.assign(pendingOrderRecord, contentKeysRecord({ phone: fields.customer_phone, itemsText: a8TextC, orderType, scheduledFor: isScheduled ? scheduledForRaw : null },\n        { menuNames: menuNamesOf(restaurantId, pricingTables), orderId, suffix: rsA8 }));\n      try {\n        const _sfA8 = SCHED.normalizeScheduledFor(body.scheduled_for);\n        const ckA8 = orderContentKey({ phone: fields.customer_phone, itemsText: a8TextC, orderType, scheduledFor: Number.isFinite(_sfA8) ? _sfA8 : null });\n        if (fields.customer_phone && ckA8) await db.ref(`recent_order_content/${rateLimitKey(fields.customer_phone)}/${ckA8}`).set({ at: Date.now(), order_id: orderId, payment_method: fields.payment_method });\n      } catch (_) { /* best-effort, like the original stamp */ }\n    }\n    /* a1:end card-retained-a8 */\n  }\n",
  "was": "      selectedFormat: orderBindingFormat,\n      canonicalBinding: () => CB.canonicalReservationFields({ redemption: redemptionResolved, context: contextOfTables(pricingTables), selectedOrderBinding: selectedOrder, configVersion: REDEMPTION_CONFIG_VERSION }) });\n    if (!rr.ok) return res.status(409).json({ error: 'redemption_reserve_failed', reason: rr.reason, order_id: orderId });\n    redemptionOwnsHold = (rr.action === 'created' || rr.action === 're_reserved');\n  }\n"
 },
 {
  "file": "index.js",
  "now": "    /* extras:begin card-acquire */\n    acq = await acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, nowTs, cartBlocked, undefined, undefined, canonicalChargeFp, floorBelow, controlArmed !== null, menuArmed, choiceArmed, extrasArmed,\n      /* a1:begin card-acquire-binding */\n      { a8Fp: () => a8FingerprintC, fresh: cardTextVersion },   // PLAN-A A8a: the a8 candidate (compared only against an 'a8' record) + this request's fresh version\n      /* a1:end card-acquire-binding */\n    );   // P-SELFUPDATE §5 (2): refuseFresh; D4-c4: the race guard; add-product A: the menu guard; per-product extras: the extras guard\n    /* extras:end card-acquire */\n",
  "was": "    /* extras:begin card-acquire */\n    acq = await acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, nowTs, cartBlocked, undefined, undefined, canonicalChargeFp, floorBelow, controlArmed !== null, menuArmed, choiceArmed, extrasArmed);   // P-SELFUPDATE §5 (2): refuseFresh; D4-c4: the race guard; add-product A: the menu guard; per-product extras: the extras guard\n    /* extras:end card-acquire */\n"
 },
 {
  "file": "createorder-classify.js",
  "now": "const { formatOf, FORMAT_LEGACY, canonicalOrderFingerprint } = require('./catalog/canonical-binding');   // 1D D4-b\n/* a1:begin text-version-require */\nconst TV = require('./catalog/text-version');   // PLAN-A A8a step 1\n/* a1:end text-version-require */\n\n",
  "was": "const { formatOf, FORMAT_LEGACY, canonicalOrderFingerprint } = require('./catalog/canonical-binding');   // 1D D4-b\n\n"
 },
 {
  "file": "createorder-classify.js",
  "now": "   in every format (§A.4: absent fingerprint ≠ absent tag). */\n/* a1:begin classify-signature */\n/* PLAN-A A8a step 1: a legacy-format record marked 'a8' is compared ONLY against `a8Incoming` (the untruncated paid-text\n   fingerprint, computed by the caller only for such a record); absent → `incomingFp` exactly; a malformed marker → 409\n   binding_format_invalid. A null candidate keeps today's fail-open (case 4 skipped). */\nfunction classifyExistingOrder(existing, { paymentMethod, restaurantMatches }, incomingFp, { isPaymentStatusClosed, canonicalIncoming = null, a8Incoming = null } = {}) {\n/* a1:end classify-signature */\n  if (!existing) return { action: '200' };                                             // caller only enters this on exists()\n",
  "was": "   in every format (§A.4: absent fingerprint ≠ absent tag). */\nfunction classifyExistingOrder(existing, { paymentMethod, restaurantMatches }, incomingFp, { isPaymentStatusClosed, canonicalIncoming = null } = {}) {\n  if (!existing) return { action: '200' };                                             // caller only enters this on exists()\n"
 },
 {
  "file": "createorder-classify.js",
  "now": "  if (!fmt.ok) return { action: '409', reason: 'binding_format_invalid' };\n  /* a1:begin classify-select */\n  const tv = TV.textVersionOf(existing, TV.ORDER_FIELD);\n  if (!tv.ok) return { action: '409', reason: 'binding_format_invalid' };\n  if (tv.version === TV.TEXT_A8) incomingFp = a8Incoming;\n  /* a1:end classify-select */\n  if (fmt.format === FORMAT_LEGACY) {\n",
  "was": "  if (!fmt.ok) return { action: '409', reason: 'binding_format_invalid' };\n  if (fmt.format === FORMAT_LEGACY) {\n"
 },
 {
  "file": "rewards-redeem-intake.js",
  "now": "// Combined intake for the CASH path (createOrder): prepare + reserve (bound to the order fingerprint + set hash).\n/* PLAN-A A8a step 1: `paidTextFull` (the untruncated sanitized paid text) builds the 'a8' candidate — the same reward\n   append over it — so the reservation's OWN text-version marker selects the binding (rewards-reserve); `writeMode` is the\n   request's (A-1: always legacy). The result carries `textVersion` and the SELECTED composed text, so the caller writes\n   the order with the binding the reservation holds. Absent `paidTextFull` → today's call exactly. */\nasync function resolveRedemptionForOrder(db, { redeem, items, restaurantId, orderId, customerUid, itemsText, totalLempiras, schedExtra, now, tables, eligible = null, context = null, paidTextFull = null, writeMode = 'legacy' }) {\n  requireTables('resolveRedemptionForOrder', restaurantId, tables);   // GRILL-FIX #2\n",
  "was": "// Combined intake for the CASH path (createOrder): prepare + reserve (bound to the order fingerprint + set hash).\nasync function resolveRedemptionForOrder(db, { redeem, items, restaurantId, orderId, customerUid, itemsText, totalLempiras, schedExtra, now, tables, eligible = null, context = null }) {\n  requireTables('resolveRedemptionForOrder', restaurantId, tables);   // GRILL-FIX #2\n"
 },
 {
  "file": "rewards-redeem-intake.js",
  "now": "  const fp = orderFingerprint(orderId, prep.priced.total_cents, prep.itemsText, fingerprintExtra(schedExtra, prep.redemptionFp));   // bind hold to THIS order + redeemed set\n  const a8Text = typeof paidTextFull === 'string' ? `${paidTextFull}${prep.itemsText.slice(String(itemsText == null ? '' : itemsText).length)}` : null;\n  const a8Fp = a8Text != null ? orderFingerprint(orderId, prep.priced.total_cents, a8Text, fingerprintExtra(schedExtra, prep.redemptionFp)) : null;\n  const rr = await reserveRedemption(db, { uid: customerUid, rid: restaurantId, orderId, cost: prep.redemption.cost,\n    canonical: prep.canonical, orderFingerprint: fp, configVersion: REDEMPTION_CONFIG_VERSION, now,   // atomic Σ-cost debit, idempotent\n    ...(a8Fp != null ? { a8OrderFingerprint: a8Fp, writeMode } : {}),\n    /* 1D D4-b §A.6: consulted only for a canonical-tagged reservation record. This path is reached only for a NEW\n",
  "was": "  const fp = orderFingerprint(orderId, prep.priced.total_cents, prep.itemsText, fingerprintExtra(schedExtra, prep.redemptionFp));   // bind hold to THIS order + redeemed set\n  const rr = await reserveRedemption(db, { uid: customerUid, rid: restaurantId, orderId, cost: prep.redemption.cost,\n    canonical: prep.canonical, orderFingerprint: fp, configVersion: REDEMPTION_CONFIG_VERSION, now,   // atomic Σ-cost debit, idempotent\n    /* 1D D4-b §A.6: consulted only for a canonical-tagged reservation record. This path is reached only for a NEW\n"
 },
 {
  "file": "rewards-redeem-intake.js",
  "now": "     rather than letting the charge side reconstruct a second copy of it. */\n  const a8Selected = rr.selected_text_version === 'a8';\n  return { ok: true, canonical: prep.canonical, priced: prep.priced, itemsText: a8Selected ? a8Text : prep.itemsText,\n    ...(a8Selected ? { textVersion: 'a8' } : {}),\n    redemption: prep.redemption, redemptionFp: prep.redemptionFp,\n",
  "was": "     rather than letting the charge side reconstruct a second copy of it. */\n  return { ok: true, canonical: prep.canonical, priced: prep.priced, itemsText: prep.itemsText,\n    redemption: prep.redemption, redemptionFp: prep.redemptionFp,\n"
 }
]);
function unapply(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`a1-inverse: ${file}: an a1 hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const unapplyA1Index = (src) => unapply('index.js', src);
const unapplyA1Module = (file, src) => unapply(file, src);
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))].filter((f) => f !== 'index.js'));
module.exports = { unapplyA1Index, unapplyA1Module, HUNKS, FILES, BASE };
