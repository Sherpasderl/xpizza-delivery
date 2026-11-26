'use strict';
// PLAN-3a-order-owner (advisor GO Option 1, 2026-11-18; rule 6c: ONE place) — THE POST-ASM11 LAYERS HOOK. Every index.js fold guard
// peels the newer layers at its own raw read, newest innermost; ledgers1 (asm11 17) is the newest such layer and is composed at every
// raw-read site. Instead of adding one more per-site layer to ~83 guards, a lane landing AFTER the asm11 tip (BASE) appends its
// exact-text hunks HERE, and ledgers1-module-inverse's unapplyLedgerS1Module calls stripPostAsm11 FIRST — so every guard that peels
// ledgers1 peels these too, innermost, on the raw read.
//   HUNKS        landing order (oldest → newest); each { layer, label, file, now, was }, generated from `git diff -U0 BASE`
//   stripPostAsm11(file, src)   peels them NEWEST FIRST; each hunk must occur EXACTLY once (else it throws: tamper / duplicate);
//                               a file no hunk owns passes through unchanged
// post-asm11-layers.guard.test.js pins: the peeled index.js === BASE:index.js byte-for-byte; every hunk once; tamper + duplicate
// refused; the order. Assembly rule (PLAN-3a-order-owner §9): a held branch that still ships a PER-SITE layer keeps it; this hook
// always peels first (innermost of all), so per-site layers see a raw read minus only the post-asm11 hunks.
const BASE = '31f05c8a40c35fe0c442be8839593954c3afc8b1';
// the LANDING order of the layers (oldest → newest): a new lane APPENDS its name here and its hunks at the end of HUNKS
const ORDER = Object.freeze(['order-owner', 'uid-path', 'rtdb-gate', 'staff-push-s2']);
const HUNKS = Object.freeze([
 {
  "layer": "order-owner",
  "label": "createOrder: ownerOf on the existing order, non_owner ⇒ the constant 409 (before every recompute + the classifier)",
  "file": "index.js",
  "now": "      const own = require('./order-owner').ownerOf(ev, customer_uid); if (own === 'non_owner') return res.status(409).json(OE.orderExistsBody(require('./order-owner').NON_OWNER_REASON, orderId));   // PLAN-3a-order-owner: a DIFFERENT verified identity learns nothing (owner §5 = A)\n",
  "was": ""
 },
 {
  "layer": "order-owner",
  "label": "createOrder: the idempotent 200's tracking_token for the OWNER only",
  "file": "index.js",
  "now": "      return res.status(200).json({ ok: true, idempotent: true, order_id: orderId, tracking_token: own === 'owner' ? (ev.tracking_token || null) : null });\n",
  "was": "      return res.status(200).json({ ok: true, idempotent: true, order_id: orderId, tracking_token: ev.tracking_token || null });\n"
 },
 {
  "layer": "order-owner",
  "label": "chargeOnlineOrder r1 (Codex #172 P1-a): the ONE probe read + the cross-restaurant guard + ownerOf, hoisted to the first point the verified uid is known (before every admission + bookkeeping write) + chargeOnlineOrder r1b (advisor ruling (b)): the malformed binding tag decided on the hoisted probe's snapshot, with classify's precedence (one order read, as before r1)",
  "file": "index.js",
  "now": "  // Read-only reuse probe (#3): config is read ONLY when creating a fresh pending order, so a\n  // customer reusing a live hosted checkout during a config outage is NOT failed closed. The CAS\n  // in acquireHostedAttempt stays authoritative; on a probe-fresh/CAS-reuse race the only cost is\n  // one wasted config read.\n  // PLAN-3a-order-owner r1 (Codex #172 P1-a): the SAME single read, at the first point the verified uid is known — ownership is\n  // decided BEFORE every order-dependent admission (bound reuse, the redemption prepare, the delivery context, classify) and every\n  // bookkeeping write (content stamp / prune, rate limits, the audience stamp); acquireHostedAttempt re-applies it to the records it observes\n  let probeOrder;\n  try {\n    probeOrder = (await db.ref(`orders/${orderId}`).once('value')).val();\n  } catch (e) {\n    console.error(`chargeOnlineOrder: order probe failed for ${orderId}`, e.message);\n    return res.status(500).json({ error: 'Database error', detail: e.message });\n  }\n  // Cross-restaurant reuse guard (legacy-normalized): a charge must not attach to an existing\n  // order_id owned by a different restaurant. Runs before the CAS/fingerprint in acquireHostedAttempt.\n  if (probeOrder && !sameRestaurant(probeOrder.restaurant_id, restaurantId)) {\n    console.warn(`chargeOnlineOrder: ${orderId} exists for a different restaurant — conflict`);\n    return res.status(409).json(OE.orderExistsBody('conflict', orderId));   // D4-c5 P1: no disclosure of the other restaurant\n  }\n  if (probeOrder && require('./order-owner').ownerOf(probeOrder, customer_uid) === 'non_owner') return res.status(409).json(OE.orderExistsBody(require('./order-owner').NON_OWNER_REASON, orderId));   // PLAN-3a-order-owner: before every admission, bookkeeping write, reserve and acquire\n  // PLAN-3a-order-owner r1b (advisor ruling (b)): a malformed binding tag is decided HERE, on this request's own probe snapshot\n  // (read above, before any write), with classify's precedence (pixelpay-hosted-charge.js malformedBindingOf) — so the refusal\n  // reads the order ONCE, as before r1, and writes nothing; classify's binding_format_invalid branch below stays the race backstop\n  if (require('./pixelpay-hosted-charge').malformedBindingOf(probeOrder, TIP.ofBody(body))) return res.status(409).json(OE.orderExistsBody('binding_format_invalid', orderId));\n",
  "was": ""
 },
 {
  "layer": "order-owner",
  "label": "chargeOnlineOrder r2 (Codex #174 P2): bound reuse consumes the hoisted probe's snapshot (no second read)",
  "file": "index.js",
  "now": "    const boundAcq = await BR.probeBoundReuse(db, { orderId, uid: customer_uid, rid: restaurantId, body, now: Date.now(), probed: { order: probeOrder } });   // r2: the hoisted probe's snapshot (no second read)\n",
  "was": "    const boundAcq = await BR.probeBoundReuse(db, { orderId, uid: customer_uid, rid: restaurantId, body, now: Date.now() });\n"
 },
 {
  "layer": "order-owner",
  "label": "chargeOnlineOrder r1: the probe block's former place (after the audience stamp) — a pointer comment",
  "file": "index.js",
  "now": "  // (probeOrder — the read-only order probe — is read ABOVE, where ownership is decided: PLAN-3a-order-owner r1, Codex #172 P1-a)\n",
  "was": "  // Read-only reuse probe (#3): config is read ONLY when creating a fresh pending order, so a\n  // customer reusing a live hosted checkout during a config outage is NOT failed closed. The CAS\n  // in acquireHostedAttempt stays authoritative; on a probe-fresh/CAS-reuse race the only cost is\n  // one wasted config read.\n  let probeOrder;\n  try {\n    probeOrder = (await db.ref(`orders/${orderId}`).once('value')).val();\n  } catch (e) {\n    console.error(`chargeOnlineOrder: order probe failed for ${orderId}`, e.message);\n    return res.status(500).json({ error: 'Database error', detail: e.message });\n  }\n  // Cross-restaurant reuse guard (legacy-normalized): a charge must not attach to an existing\n  // order_id owned by a different restaurant. Runs before the CAS/fingerprint in acquireHostedAttempt.\n  if (probeOrder && !sameRestaurant(probeOrder.restaurant_id, restaurantId)) {\n    console.warn(`chargeOnlineOrder: ${orderId} exists for a different restaurant — conflict`);\n    return res.status(409).json(OE.orderExistsBody('conflict', orderId));   // D4-c5 P1: no disclosure of the other restaurant\n  }\n"
 },
 {
  "layer": "order-owner",
  "label": "r1b: the text-version module for malformedBindingOf",
  "file": "pixelpay-hosted-charge.js",
  "now": "const TV = require('./catalog/text-version');   // r1b: malformedBindingOf's text-version marker check\n",
  "was": ""
 },
 {
  "layer": "order-owner",
  "label": "acquire r1 (Codex #172 P1-b): memberForeign — the handler's ownerOf on every record the acquire observes",
  "file": "pixelpay-hosted-charge.js",
  "now": "/* PLAN-3a-order-owner r1 (Codex #172 P1-b): the handler's ONE ownership predicate, on EVERY order record this acquire observes — the\n   pre-read, inside the CAS, the authoritative record after it — so the probe→acquire race (B's probe saw no order; A created it) never\n   hands a different verified member A's checkout_url / poll_token, nor installs / recovers / rotates A's attempt. The request's verified\n   uid is the pending record's customer_uid (absent ⇒ unverifiable ⇒ every existing path unchanged). Answered as the handler's constant 409. */\nconst OWN = require('./order-owner');\nconst memberForeign = (order, pending) => OWN.ownerOf(order, pending && pending.customer_uid) === 'non_owner';\n",
  "was": ""
 },
 {
  "layer": "order-owner",
  "label": "acquire r1: the pre-read refuses a foreign member before ANY answer",
  "file": "pixelpay-hosted-charge.js",
  "now": "    if (order && memberForeign(order, pendingOrderRecord)) return { outcome: 'conflict', reason: OWN.NON_OWNER_REASON };   // r1: before ANY answer about it\n",
  "was": ""
 },
 {
  "layer": "order-owner",
  "label": "acquire r1: inside the CAS — a foreign member never mutates the order",
  "file": "pixelpay-hosted-charge.js",
  "now": "      if (memberForeign(c, pendingOrderRecord)) return c;                   // r1: nor a foreign member (the authoritative re-check below refuses)\n",
  "was": ""
 },
 {
  "layer": "order-owner",
  "label": "acquire r1: the authoritative record after the CAS — refused before every claim / recovery write",
  "file": "pixelpay-hosted-charge.js",
  "now": "    if (memberForeign(committed, pendingOrderRecord)) return { outcome: 'conflict', reason: OWN.NON_OWNER_REASON };   // r1: before every claim / recovery write\n",
  "was": ""
 },
 {
  "layer": "order-owner",
  "label": "r1b: malformedBindingOf — classifyFromOrder's precedence on an order snapshot alone",
  "file": "pixelpay-hosted-charge.js",
  "now": "// PLAN-3a-order-owner r1b (advisor ruling (b)): does the order SNAPSHOT alone classify as a malformed binding tag? —\n// classifyFromOrder's own precedence (already_paid, then a changed tip, decide first; then paymentBindingConflict's first two\n// checks: the fp_format tag, the text-version marker). The charge handler applies it to the hoisted probe's snapshot so that\n// refusal reads the order ONCE; classify's own binding_format_invalid branch stays the race backstop. Parity with\n// classifyHostedAttempt: hosted-classify-parity.test.js (MALFORMED-PARITY).\nfunction malformedBindingOf(order, incomingTip = 0) {\n  if (!order || order.payment_status === 'confirmed' || tipBindingConflict(order, incomingTip)) return false;\n  return !formatOf(order, 'fp_format').ok || !TV.textVersionOf(order, TV.ORDER_FIELD).ok;\n}\n",
  "was": ""
 },
 {
  "layer": "order-owner",
  "label": "r1b: malformedBindingOf exported",
  "file": "pixelpay-hosted-charge.js",
  "now": "module.exports = { freshIssueRefusal, guestForeign, acquireHostedAttempt, classifyHostedAttempt, malformedBindingOf, genPollToken, HOSTED_TTL_MS, genAttemptId, orderFingerprint, centsToLempiras };\n",
  "was": "module.exports = { freshIssueRefusal, guestForeign, acquireHostedAttempt, classifyHostedAttempt, genPollToken, HOSTED_TTL_MS, genAttemptId, orderFingerprint, centsToLempiras };\n"
 },
 {
  "layer": "uid-path",
  "label": "setDeliveryPricing / getDeliveryPricing admission: the ONE path-safe uid rule (access/membership isPathUid) before platform_admins/{uid} (Codex C 11-23)",
  "file": "delivery/pricing-admin-core.js",
  "now": "  if (!require('../access/membership').isPathUid(uid)) return { fail: reply(403, { error: 'not_authorized' }) };   // Codex C 11-23: the ONE path-safe uid rule — a '/'-bearing verified uid aliased platform_admins/<admin>\n",
  "was": "  if (!uidOk(uid)) return { fail: reply(403, { error: 'not_authorized' }) };\n"
 }
]);
// INNER (advisor ruling (A), 11-25): the NEWEST layer's exact-line swaps that interleave with, or sit inside, the HUNKS above (one
// file's HUNKS must stay in diff order AND grouped by layer, so a scattered newer layer cannot be appended to them). Peeled FIRST,
// newest-first, each exactly once (else it throws: tamper / duplicate); the HUNKS are then the diff of (file − INNER) vs BASE.
// Each swap is framed '\n<line>\n', so a less-indented twin line never matches inside a longer one.
const INNER = Object.freeze([
 {
  "layer": "rtdb-gate",
  "label": "index.js:1511 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "index.js",
  "now": "\n      verifyIdToken: (t) => getAuth().verifyIdToken(t), isTombstoned: async (uid) => (await require('./lib/rtdb-gate').gatedGet(getDatabase().ref('deleted_uids/' + uid))).exists(),\n",
  "was": "\n      verifyIdToken: (t) => getAuth().verifyIdToken(t), isTombstoned: async (uid) => (await getDatabase().ref('deleted_uids/' + uid).get()).exists(),\n"
 },
 {
  "layer": "rtdb-gate",
  "label": "index.js:1624 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "index.js",
  "now": "\n            const tomb = await require('./lib/rtdb-gate').gatedGet(getDatabase().ref('deleted_uids/' + dec.uid));\n",
  "was": "\n            const tomb = await getDatabase().ref('deleted_uids/' + dec.uid).get();\n"
 },
 {
  "layer": "rtdb-gate",
  "label": "index.js:1682 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "index.js",
  "now": "\n    probeOrder = (await require('./lib/rtdb-gate').afterGets(db.ref(`orders/${orderId}`), (r) => r.once('value'))).val();\n",
  "was": "\n    probeOrder = (await db.ref(`orders/${orderId}`).once('value')).val();\n"
 },
 {
  "layer": "rtdb-gate",
  "label": "index.js:2132 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "index.js",
  "now": "\n    returnBase = await resolveReturnBaseForCharge(restaurantId, process.env, { identity: s3bIdentity, entryMode: body.entry_mode, requestOrigin: req.get('origin'), readBrandId: () => require('./lib/rtdb-gate').gatedGet(db.ref(`restaurants/${restaurantId}/identity/brand_id`)).then((s) => s.val()) });\n",
  "was": "\n    returnBase = await resolveReturnBaseForCharge(restaurantId, process.env, { identity: s3bIdentity, entryMode: body.entry_mode, requestOrigin: req.get('origin'), readBrandId: () => db.ref(`restaurants/${restaurantId}/identity/brand_id`).get().then((s) => s.val()) });\n"
 },
 {
  "layer": "staff-push-s2",
  "label": "index.js sendStaffPush — S2 / Codex #414: the failed-send log carries no uid / order id",
  "file": "index.js",
  "now": "\n    console.error(`sendStaffPush: failed status=${res.statusCode} (${String(payload.tag).split(':')[0]})`);   // S2 / Codex #414: no uid, no order id\n",
  "was": "\n    console.error(`sendStaffPush: ${uid} status=${res.statusCode} (${payload.tag})`);\n"
 },
 {
  "layer": "staff-push-s2",
  "label": "index.js fanoutStaffPush — S2: CURRENT dispatchers only; confirmed non-dispatchers pruned (PLAN-brand-agnostic-convergence r9, #334-4)",
  "file": "index.js",
  "now": "\n  const settled = await Promise.allSettled((await require('./staff-push').staffRecipients(db, all)).map((uid) => sendStaffPush(db, uid, payload)));   // S2: CURRENT dispatchers only; confirmed non-dispatchers pruned\n",
  "was": "\n  const settled = await Promise.allSettled(Object.keys(all).map((uid) => sendStaffPush(db, uid, payload)));\n"
 },
 {
  "layer": "staff-push-s2",
  "label": "index.js fanoutStaffPush — S2 / Codex #414: the success log carries the tag category only",
  "file": "index.js",
  "now": "\n  console.log(`fanoutStaffPush: ${sent}/${settled.length} sent (${String(payload.tag).split(':')[0]})`);   // S2 / Codex #414: the tag's category only (no order id)\n",
  "was": "\n  console.log(`fanoutStaffPush: ${sent}/${settled.length} sent (${payload.tag})`);\n"
 },
 {
  "layer": "rtdb-gate",
  "label": "index.js:7325 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "index.js",
  "now": "\n      const prof = (await require('./lib/rtdb-gate').gatedGet(profRef)).val();\n",
  "was": "\n      const prof = (await profRef.get()).val();\n"
 },
 {
  "layer": "rtdb-gate",
  "label": "pixelpay-hosted-charge.js:104 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "pixelpay-hosted-charge.js",
  "now": "\n    const order = (await require('./lib/rtdb-gate').afterGets(orderRef, (r) => r.once('value'))).val();\n",
  "was": "\n    const order = (await orderRef.once('value')).val();\n"
 },
 {
  "layer": "rtdb-gate",
  "label": "pixelpay-hosted-charge.js:126 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "pixelpay-hosted-charge.js",
  "now": "\n      const att = (await require('./lib/rtdb-gate').afterGets(db.ref(`payment_attempts/${order.active_attempt_id}`), (r) => r.once('value'))).val();\n",
  "was": "\n      const att = (await db.ref(`payment_attempts/${order.active_attempt_id}`).once('value')).val();\n"
 },
 {
  "layer": "rtdb-gate",
  "label": "pixelpay-hosted-charge.js:252 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "pixelpay-hosted-charge.js",
  "now": "\n  const order = (await require('./lib/rtdb-gate').afterGets(db.ref(`orders/${orderId}`), (r) => r.once('value'))).val();\n",
  "was": "\n  const order = (await db.ref(`orders/${orderId}`).once('value')).val();\n"
 },
 {
  "layer": "rtdb-gate",
  "label": "pixelpay-hosted-charge.js:285 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "pixelpay-hosted-charge.js",
  "now": "\n  const att = (await require('./lib/rtdb-gate').afterGets(db.ref(`payment_attempts/${order.active_attempt_id}`), (r) => r.once('value'))).val();\n",
  "was": "\n  const att = (await db.ref(`payment_attempts/${order.active_attempt_id}`).once('value')).val();\n"
 },
 {
  "layer": "rtdb-gate",
  "label": "delivery/delivery-wire.js:57 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "delivery/delivery-wire.js",
  "now": "\n  const order = (await require('../lib/rtdb-gate').gatedGet(db.ref(`orders/${orderId}`))).val();\n",
  "was": "\n  const order = (await db.ref(`orders/${orderId}`).get()).val();\n"
 },
 {
  "layer": "rtdb-gate",
  "label": "delivery/delivery-wire.js:61 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "delivery/delivery-wire.js",
  "now": "\n    at = (await require('../lib/rtdb-gate').gatedGet(db.ref(`payment_attempts/${order.active_attempt_id}`))).val();\n",
  "was": "\n    at = (await db.ref(`payment_attempts/${order.active_attempt_id}`).get()).val();\n"
 },
 {
  "layer": "rtdb-gate",
  "label": "delivery/delivery-wire.js:146 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "delivery/delivery-wire.js",
  "now": "\n        if (dec && dec.customer === true && dec.uid) uid = attributionUid(dec, (await require('../lib/rtdb-gate').gatedGet(db.ref('deleted_uids/' + dec.uid))).exists());\n",
  "was": "\n        if (dec && dec.customer === true && dec.uid) uid = attributionUid(dec, (await db.ref('deleted_uids/' + dec.uid).get()).exists());\n"
 },
 {
  "layer": "rtdb-gate",
  "label": "rewards-reserve.js:59 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "rewards-reserve.js",
  "now": "\n    const rec = (await require('./lib/rtdb-gate').gatedGet(db.ref(`user_rewards/${uid}/${rid}/reservations/${orderId}`))).val();\n",
  "was": "\n    const rec = (await db.ref(`user_rewards/${uid}/${rid}/reservations/${orderId}`).get()).val();\n"
 },
 {
  "layer": "rtdb-gate",
  "label": "rewards-reserve.js:532 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "rewards-reserve.js",
  "now": "\n          const order = (await require('./lib/rtdb-gate').gatedGet(db.ref(`orders/${orderId}`))).val();\n",
  "was": "\n          const order = (await db.ref(`orders/${orderId}`).get()).val();\n"
 },
 {
  "layer": "rtdb-gate",
  "label": "pixelpay-confirm.js:238 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "pixelpay-confirm.js",
  "now": "\n  const preOrder = (await require('./lib/rtdb-gate').afterGets(orderRef, (r) => r.once('value'))).val();\n",
  "was": "\n  const preOrder = (await orderRef.once('value')).val();\n"
 },
 {
  "layer": "rtdb-gate",
  "label": "delivery/zone-resume.js:40 — the RTDB in-flight-get gate wrap (PLAN-rtdb-get-once-race r9, lib/rtdb-gate)",
  "file": "delivery/zone-resume.js",
  "now": "\n  return deliveryResumeRefusal(db, (await require('../lib/rtdb-gate').gatedGet(db.ref(`orders/${orderId}`))).val(), pricingP);\n",
  "was": "\n  return deliveryResumeRefusal(db, (await db.ref(`orders/${orderId}`).get()).val(), pricingP);\n"
 }
]);
// the files the HUNKS own (=== BASE after the peel) and the files INNER touches (a file outside FILES gets ONLY its INNER swaps peeled:
// the r9 wraps that sit in no hunk of any peel layer, e.g. delivery-wire.js, so every guard reading through the hook sees eb177fe58's text)
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
const INNER_FILES = Object.freeze([...new Set(INNER.map((h) => h.file))]);
function stripInner(file, src) {
  let out = src;
  for (let i = INNER.length - 1; i >= 0; i--) {
    const h = INNER[i];
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`post-asm11-layers: ${file}: the ${h.layer} inner swap «${h.label}» occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
function stripHunks(file, src) {
  let out = src;
  for (let i = HUNKS.length - 1; i >= 0; i--) {
    const h = HUNKS[i];
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`post-asm11-layers: ${file}: the ${h.layer} hunk «${h.label}» occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
// THE hook: INNER first (newest), then the HUNKS newest-first
function stripPostAsm11(file, src) {
  if (!FILES.includes(file) && !INNER_FILES.includes(file)) return src;
  const inner = INNER_FILES.includes(file) ? stripInner(file, src) : src;
  return FILES.includes(file) ? stripHunks(file, inner) : inner;
}
module.exports = { BASE, ORDER, HUNKS, INNER, FILES, INNER_FILES, stripInner, stripHunks, stripPostAsm11 };
