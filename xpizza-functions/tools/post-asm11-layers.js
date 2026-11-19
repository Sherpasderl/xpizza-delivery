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
const ORDER = Object.freeze(['order-owner']);
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
  "label": "chargeOnlineOrder r1 (Codex #172 P1-a): the ONE probe read + the cross-restaurant guard + ownerOf, hoisted to the first point the verified uid is known (before every admission + bookkeeping write)",
  "file": "index.js",
  "now": "  // Read-only reuse probe (#3): config is read ONLY when creating a fresh pending order, so a\n  // customer reusing a live hosted checkout during a config outage is NOT failed closed. The CAS\n  // in acquireHostedAttempt stays authoritative; on a probe-fresh/CAS-reuse race the only cost is\n  // one wasted config read.\n  // PLAN-3a-order-owner r1 (Codex #172 P1-a): the SAME single read, at the first point the verified uid is known — ownership is\n  // decided BEFORE every order-dependent admission (bound reuse, the redemption prepare, the delivery context, classify) and every\n  // bookkeeping write (content stamp / prune, rate limits, the audience stamp); acquireHostedAttempt re-applies it to the records it observes\n  let probeOrder;\n  try {\n    probeOrder = (await db.ref(`orders/${orderId}`).once('value')).val();\n  } catch (e) {\n    console.error(`chargeOnlineOrder: order probe failed for ${orderId}`, e.message);\n    return res.status(500).json({ error: 'Database error', detail: e.message });\n  }\n  // Cross-restaurant reuse guard (legacy-normalized): a charge must not attach to an existing\n  // order_id owned by a different restaurant. Runs before the CAS/fingerprint in acquireHostedAttempt.\n  if (probeOrder && !sameRestaurant(probeOrder.restaurant_id, restaurantId)) {\n    console.warn(`chargeOnlineOrder: ${orderId} exists for a different restaurant — conflict`);\n    return res.status(409).json(OE.orderExistsBody('conflict', orderId));   // D4-c5 P1: no disclosure of the other restaurant\n  }\n  if (probeOrder && require('./order-owner').ownerOf(probeOrder, customer_uid) === 'non_owner') return res.status(409).json(OE.orderExistsBody(require('./order-owner').NON_OWNER_REASON, orderId));   // PLAN-3a-order-owner: before every admission, bookkeeping write, reserve and acquire\n",
  "was": ""
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
 }
]);
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
function stripPostAsm11(file, src) {
  if (!FILES.includes(file)) return src;
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
module.exports = { BASE, ORDER, HUNKS, FILES, stripPostAsm11 };
