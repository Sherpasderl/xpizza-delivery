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
  "label": "chargeOnlineOrder: ownerOf on the probe snapshot, non_owner ⇒ the constant 409 (before every reserve + acquire)",
  "file": "index.js",
  "now": "  if (probeOrder && require('./order-owner').ownerOf(probeOrder, customer_uid) === 'non_owner') return res.status(409).json(OE.orderExistsBody(require('./order-owner').NON_OWNER_REASON, orderId));   // PLAN-3a-order-owner: before every reserve / acquire\n",
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
