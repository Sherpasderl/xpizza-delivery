'use strict';
// S2-srv-tip (Customer App S2, PLAN-capp-S2-r4 §3/§4.1) — the test-only INVERSE of the slice's index.js hunks (hot-file
// invariant, see memory index-js-inverse-fold-invariant). Every hunk is SAME-LINE (no line inserted, so no R3 region line
// shifts): the tip.js / payer-email.js requires; the early tip refusal in createOrder and chargeOnlineOrder; the tip threaded
// into the cash classifier + incoming fingerprints, the reward reservation extra, deliveryFor, the stored-fp fallbacks, the
// card pre-classification + authoritative fingerprints, classifyHostedAttempt and acquireHostedAttempt; the P-C payer-email
// checks (pre-reserve, the acquire conflict mapping, the env-only fallback). Put back to their 276ed944 text, so every
// *-wiring.guard fold chain reconstructs its frozen base. Proof (i): unapplyS2tipIndex(index.js) === 276ed944:index.js
// byte-for-byte (s2tip-wiring.guard). Each hunk must occur EXACTLY once, else this throws. GENERATED from
// `git diff 276ed944 -- index.js` (context grown until unique); JSON-quoted strings.

const HUNKS = [
  [
    "const { getIdentity: getRestaurantIdentity, hubSnapshot } = require('./restaurant-config'); const DW = require('./delivery/delivery-wire'); const TIP = require('./tip'); const PE = require('./payer-email');   // S2-srv-tip (tip.js, payer-email.js; tools/s2tip-inverse.js) · S3a envío (delivery/; tools/s3a-inverse.js)\n",
    "const { getIdentity: getRestaurantIdentity, hubSnapshot } = require('./restaurant-config'); const DW = require('./delivery/delivery-wire');   // S3a envío (delivery/; tools/s3a-inverse.js)\n"
  ],
  [
    "  if (!ridDefaulted) console.log(`createOrder: restaurant_id=${restaurantId}`);\n  const db = getDatabase(); const dpP = DW.loadPricing(db, restaurantId); if (TIP.refuse(res, body)) return;   // S2: a malformed tip / tip + reward → refused before any read, reserve or write · 1b-1: hoisted above validation (the RTDB alarm sink); S3a: the envío config read starts NOW, in parallel with the first reads\n",
    "  if (!ridDefaulted) console.log(`createOrder: restaurant_id=${restaurantId}`);\n  const db = getDatabase(); const dpP = DW.loadPricing(db, restaurantId);   // 1b-1: hoisted above validation (the RTDB alarm sink); S3a: the envío config read starts NOW, in parallel with the first reads\n"
  ],
  [
    "    { orderId, restaurantId, total, itemsText: fields.items_text, items: body.items, redeem: body.redeem,\n      customerUid: customer_uid, scheduledForRaw: scheduledForRawEarly, orderType, tipCents: TIP.ofBody(body) },\n",
    "    { orderId, restaurantId, total, itemsText: fields.items_text, items: body.items, redeem: body.redeem,\n      customerUid: customer_uid, scheduledForRaw: scheduledForRawEarly, orderType },\n"
  ],
  [
    "          { orderId, restaurantId, total, itemsText: fields.items_text, items: body.items, redeem: body.redeem,\n            customerUid: customer_uid, scheduledForRaw: scheduledForRawEarly, orderType, tipCents: TIP.ofBody(body) },\n",
    "          { orderId, restaurantId, total, itemsText: fields.items_text, items: body.items, redeem: body.redeem,\n            customerUid: customer_uid, scheduledForRaw: scheduledForRawEarly, orderType },\n"
  ],
  [
    "          { orderId, restaurantId, total, itemsText: paidTextFull, items: body.items, redeem: body.redeem,\n            customerUid: customer_uid, scheduledForRaw: scheduledForRawEarly, orderType, tipCents: TIP.ofBody(body) },\n",
    "          { orderId, restaurantId, total, itemsText: paidTextFull, items: body.items, redeem: body.redeem,\n            customerUid: customer_uid, scheduledForRaw: scheduledForRawEarly, orderType },\n"
  ],
  [
    "        { paymentMethod: fields.payment_method, restaurantMatches: sameRestaurant(ev.restaurant_id, restaurantId), incomingTip: TIP.ofBody(body) },\n",
    "        { paymentMethod: fields.payment_method, restaurantMatches: sameRestaurant(ev.restaurant_id, restaurantId) },\n"
  ],
  [
    "      customerUid: customer_uid, itemsText: fields.items_text, totalLempiras: total, schedExtra: TIP.extraOf(body), now: Date.now(),\n",
    "      customerUid: customer_uid, itemsText: fields.items_text, totalLempiras: total, schedExtra: '', now: Date.now(),\n"
  ],
  [
    "  const dq = await DW.deliveryFor(db, { rid: restaurantId, mode: orderType, pin: DW.orderPin(body), customerUid: customer_uid, getIdentity: getRestaurantIdentity, pricingP: dpP, tip: body.tip_cents }); const priceBreakdown = DW.withDelivery(dq, redemptionPriced\n",
    "  const dq = await DW.deliveryFor(db, { rid: restaurantId, mode: orderType, pin: DW.orderPin(body), customerUid: customer_uid, getIdentity: getRestaurantIdentity, pricingP: dpP }); const priceBreakdown = DW.withDelivery(dq, redemptionPriced\n"
  ],
  [
    "        [_schedExtra, `rf:${redemptionFingerprint(redemptionCanonical)}`, TIP.extraOf(body)].filter(Boolean).join('|'));\n",
    "        [_schedExtra, `rf:${redemptionFingerprint(redemptionCanonical)}`].filter(Boolean).join('|'));\n"
  ],
  [
    "    storeFp = orderFingerprint(orderId, redemptionPriced.total_cents, fields.items_text, [_schedExtraA8, `rf:${redemptionFingerprint(redemptionCanonical)}`, TIP.extraOf(body)].filter(Boolean).join('|'));\n",
    "    storeFp = orderFingerprint(orderId, redemptionPriced.total_cents, fields.items_text, [_schedExtraA8, `rf:${redemptionFingerprint(redemptionCanonical)}`].filter(Boolean).join('|'));\n"
  ],
  [
    "  if (!ridDefaulted) console.log(`chargeOnlineOrder: restaurant_id=${restaurantId}`);\n  const db = getDatabase(); const dpP = DW.loadPricing(db, restaurantId); if (TIP.refuse(res, body)) return;   // S2: a malformed tip / tip + reward → refused before any read, reserve or write · 1b-1: hoisted above validation (the RTDB alarm sink); S3a: the envío config read starts NOW, in parallel with the first reads\n",
    "  if (!ridDefaulted) console.log(`chargeOnlineOrder: restaurant_id=${restaurantId}`);\n  const db = getDatabase(); const dpP = DW.loadPricing(db, restaurantId);   // 1b-1: hoisted above validation (the RTDB alarm sink); S3a: the envío config read starts NOW, in parallel with the first reads\n"
  ],
  [
    "  const dq = await DW.chargeContext(db, orderId, await DW.deliveryFor(db, { rid: restaurantId, mode: orderType, pin: DW.orderPin(body), customerUid: customer_uid, getIdentity: getRestaurantIdentity, pricingP: dpP, tip: body.tip_cents }), body, Date.now()); if (dq && dq.refusal) return res.status(dq.httpStatus).json({ error: dq.refusal, ...(dq.httpStatus === 503 ? { retryable: true } : {}), order_id: orderId }); const effBreakdown = DW.withDelivery(dq, redemptionPriced\n",
    "  const dq = await DW.chargeContext(db, orderId, await DW.deliveryFor(db, { rid: restaurantId, mode: orderType, pin: DW.orderPin(body), customerUid: customer_uid, getIdentity: getRestaurantIdentity, pricingP: dpP }), body, Date.now()); if (dq && dq.refusal) return res.status(dq.httpStatus).json({ error: dq.refusal, ...(dq.httpStatus === 503 ? { retryable: true } : {}), order_id: orderId }); const effBreakdown = DW.withDelivery(dq, redemptionPriced\n"
  ],
  [
    "    const fingerprintG = orderFingerprint(orderId, totalCentsG, fields.items_text, [isScheduledG ? SCHED.fingerprintExtra({ scheduled_for: schedForRawG, order_type: orderType }) : '', redemptionFp ? `rf:${redemptionFp}` : '', TIP.extraOf(body)].filter(Boolean).join('|'));   // v2: bind the redeemed SET into payment_fingerprint (design-gate #2)\n",
    "    const fingerprintG = orderFingerprint(orderId, totalCentsG, fields.items_text, [isScheduledG ? SCHED.fingerprintExtra({ scheduled_for: schedForRawG, order_type: orderType }) : '', redemptionFp ? `rf:${redemptionFp}` : ''].filter(Boolean).join('|'));   // v2: bind the redeemed SET into payment_fingerprint (design-gate #2)\n"
  ],
  [
    "      schedExtra: [isScheduledG ? SCHED.fingerprintExtra({ scheduled_for: schedForRawG, order_type: orderType }) : '', TIP.extraOf(body)].filter(Boolean).join('|') }));\n",
    "      schedExtra: isScheduledG ? SCHED.fingerprintExtra({ scheduled_for: schedForRawG, order_type: orderType }) : '' }));\n"
  ],
  [
    "      const a8FpG = () => orderFingerprint(orderId, totalCentsG, `${paidTextFullC}${fields.items_text.slice(legacyPaidTextC.length)}`, [isScheduledG ? SCHED.fingerprintExtra({ scheduled_for: schedForRawG, order_type: orderType }) : '', redemptionFp ? `rf:${redemptionFp}` : '', TIP.extraOf(body)].filter(Boolean).join('|'));\n",
    "      const a8FpG = () => orderFingerprint(orderId, totalCentsG, `${paidTextFullC}${fields.items_text.slice(legacyPaidTextC.length)}`, [isScheduledG ? SCHED.fingerprintExtra({ scheduled_for: schedForRawG, order_type: orderType }) : '', redemptionFp ? `rf:${redemptionFp}` : ''].filter(Boolean).join('|'));\n"
  ],
  [
    "      clsG = await classifyHostedAttempt(db, orderId, fingerprintG, nowTs, canonicalFpG, a8FpG, TIP.ofBody(body));\n",
    "      clsG = await classifyHostedAttempt(db, orderId, fingerprintG, nowTs, canonicalFpG, a8FpG);\n"
  ],
  [
    "  const fingerprint = orderFingerprint(orderId, total_cents, fields.items_text, [isScheduled ? SCHED.fingerprintExtra({ scheduled_for: scheduledForRaw, order_type: orderType }) : '', redemptionFp ? `rf:${redemptionFp}` : '', TIP.extraOf(body)].filter(Boolean).join('|'));   // v2: + redeemed-SET hash (design-gate #2)\n",
    "  const fingerprint = orderFingerprint(orderId, total_cents, fields.items_text, [isScheduled ? SCHED.fingerprintExtra({ scheduled_for: scheduledForRaw, order_type: orderType }) : '', redemptionFp ? `rf:${redemptionFp}` : ''].filter(Boolean).join('|'));   // v2: + redeemed-SET hash (design-gate #2)\n"
  ],
  [
    "  const a8FingerprintC = orderFingerprint(orderId, total_cents, a8TextC, [isScheduled ? SCHED.fingerprintExtra({ scheduled_for: scheduledForRaw, order_type: orderType }) : '', redemptionFp ? `rf:${redemptionFp}` : '', TIP.extraOf(body)].filter(Boolean).join('|'));\n",
    "  const a8FingerprintC = orderFingerprint(orderId, total_cents, a8TextC, [isScheduled ? SCHED.fingerprintExtra({ scheduled_for: scheduledForRaw, order_type: orderType }) : '', redemptionFp ? `rf:${redemptionFp}` : ''].filter(Boolean).join('|'));\n"
  ],
  [
    "    schedExtra: [isScheduled ? SCHED.fingerprintExtra({ scheduled_for: scheduledForRaw, order_type: orderType }) : '', TIP.extraOf(body)].filter(Boolean).join('|') }));\n",
    "    schedExtra: isScheduled ? SCHED.fingerprintExtra({ scheduled_for: scheduledForRaw, order_type: orderType }) : '' }));\n"
  ],
  [
    "  let redemptionOwnsHold = false; if (await PE.refusesFresh(clsForMenu, body, process.env, () => classifyHostedAttempt(db, orderId, fingerprint, nowTs, canonicalChargeFp, () => a8FingerprintC, TIP.ofBody(body)))) return PE.refuse(res, orderId);   // S2 P-C: a FRESH checkout with no payer email → refused before the reserve and the acquire (recovery is never refused)\n",
    "  let redemptionOwnsHold = false;\n"
  ],
  [
    "      { a8Fp: () => a8FingerprintC, fresh: cardTextVersion }, TIP.ofBody(body), PE.unconfigured(body, process.env),   // PLAN-A A8a: the a8 candidate (compared only against an 'a8' record) + this request's fresh version\n",
    "      { a8Fp: () => a8FingerprintC, fresh: cardTextVersion },   // PLAN-A A8a: the a8 candidate (compared only against an 'a8' record) + this request's fresh version\n"
  ],
  [
    "    console.warn(`chargeOnlineOrder: ${orderId} — ${acq.reason === 'payer_email_unconfigured' ? '503 payer_email_unconfigured' : '409 order_exists'} (acquire conflict${acq.reason ? `: ${acq.reason}` : ''})`);   // S2 P-C: the log names the status actually sent\n",
    "    console.warn(`chargeOnlineOrder: ${orderId} — 409 order_exists (acquire conflict${acq.reason ? `: ${acq.reason}` : ''})`);\n"
  ],
  [
    "    return acq.reason === 'payer_email_unconfigured' ? PE.refuse(res, orderId) : res.status(409).json(OE.orderExistsBody(acq.reason || 'conflict', orderId));   // S2 P-C: the acquire's fresh-issuance payer check (no attempt written; the hold was released above)\n",
    "    return res.status(409).json(OE.orderExistsBody(acq.reason || 'conflict', orderId));\n"
  ],
  [
    "  const fallbackEmail = PE.validEmail(process.env.PIXELPAY_MERCHANT_EMAIL);   // S2 P-C: the env ONLY, fail-closed (no brand literal; a fresh checkout without it was refused before the reserve)\n",
    "  const fallbackEmail = process.env.PIXELPAY_MERCHANT_EMAIL || 'pedidos@lamusa.hn';   // both deliverable (MX-valid)\n"
  ]
];

function unapplyS2tipIndex(src) {
  let out = src;
  for (const [now, was] of HUNKS) {
    const i = out.indexOf(now);
    if (i < 0 || out.indexOf(now, i + 1) !== -1) throw new Error(`s2tip-inverse: hunk not found exactly once: ${now.slice(0, 80)}`);
    out = out.slice(0, i) + was + out.slice(i + now.length);
  }
  return out;
}

module.exports = { unapplyS2tipIndex, HUNKS, BASE: '276ed944' };
