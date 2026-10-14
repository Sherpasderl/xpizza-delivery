'use strict';
// MENU-ORDERING §3, codex serialization r1 (order-independent content key + the factura's lines in menu order) — the slice's
// test-only INVERSE. index.js carries 10 delimited, byte-pinned blocks `/* serial3:begin <id> */ … /* serial3:end <id> */`
// (pure insertions, plus the createOrder content-stamp read and the two factura heads, which REPLACE one line each);
// unapplySerial3Index swaps each back for its original bytes, so unapplySerial3Index(index.js) === f4e7815:index.js
// byte-for-byte (serial3-wiring.guard). Every index.js fold guard applies it FIRST (this is the newest index.js slice),
// before the per-product-extras blocks. HUNKS are its exact edits in the PINNED materialize-guard.js (order-control-wiring
// pins it vs e1aeb3f): unapplySerial3Module is applied first there, so any byte outside them still fails the pin.
const crypto = require('crypto');
const BASE = 'f4e7815';
const BLOCKS = [
  {
    "id": "require",
    "sha": "c18aad5a350c276d303c2e1a041250dbdbc68e3a0d4471b90643bd015ad3af46",
    "original": ""
  },
  {
    "id": "wiring",
    "sha": "6d39871cb1d160692bceed51722fa0eb0766f1db39d3db3a044d3e193c71083c",
    "original": ""
  },
  {
    "id": "create-stamp",
    "sha": "2f00d72660be284e637709da30bef84ccbb7b99eec0c098873db805f3da95d70",
    "original": "      const rec = (await cbase.child(ck).once('value')).val();\n"
  },
  {
    "id": "factura-cash-head",
    "sha": "4b548a8b69742dcc5f81c67dd3c1693c27aba8b8aca77d5f3a7278741188b321",
    "original": "  const facturaPriced = redemptionPriced\n"
  },
  {
    "id": "factura-cash-order",
    "sha": "fe62186f8be8cef655558bf09427622b41ab94b75bb3db9b3e2c33cf355cb855",
    "original": ""
  },
  {
    "id": "factura-card-head",
    "sha": "5ba4793adff8381ebf047ab2ee3e563c0acd6a580e1939769c5fe6ef20bf6f59",
    "original": "  const facturaPriced = redemptionPriced\n"
  },
  {
    "id": "factura-card-order",
    "sha": "4b45539a8ae87189c471d9efdb2c384493d6a44b34588b42e22aff81d61aaf96",
    "original": ""
  },
  {
    "id": "card-content-keys",
    "sha": "c7bca4d63314905bfb5459e68f7aed11a0f9760753aa0348bbdbd8064707731e",
    "original": ""
  },
  {
    "id": "cash-reward-provenance-held",
    "sha": "63adbed4fe88de776db3e372e6d84918ff171b5b37ccb42104c314d20fefb145",
    "original": ""
  },
  {
    "id": "cash-reward-provenance",
    "sha": "a3d4841a350a15f060a4a9042da941b1852f93605348966cbafe2a3368170d27",
    "original": ""
  }
];
const rxFor = (id) => new RegExp(`[ \\t]*\\/\\* serial3:begin ${id.replace(/[-]/g, '\\-')} \\*\\/\\n[\\s\\S]*?\\/\\* serial3:end ${id.replace(/[-]/g, '\\-')} \\*\\/\\n`, 'g');
function unapplySerial3Index(src) {
  const begins = (src.match(/\/\* serial3:begin /g) || []).length;
  const ends = (src.match(/\/\* serial3:end /g) || []).length;
  if (begins !== BLOCKS.length || ends !== BLOCKS.length) throw new Error(`serial3-inverse: expected exactly ${BLOCKS.length} serial3 index.js blocks (begin ${begins}, end ${ends})`);
  let out = src;
  for (const b of BLOCKS) {
    const found = out.match(rxFor(b.id)) || [];
    if (found.length !== 1) throw new Error(`serial3-inverse: expected exactly one block ${b.id}, found ${found.length}`);
    if (crypto.createHash('sha256').update(found[0]).digest('hex') !== b.sha) throw new Error(`serial3-inverse: block ${b.id} differs from its pinned bytes`);
    out = out.replace(rxFor(b.id), () => b.original);
  }
  return out;
}
const HUNKS = Object.freeze([
 {
  "file": "materialize-guard.js",
  "now": "const { orderContentKey, orderContentKeyVerbatim, readContentStampByKeys, legacyKeyByOrder, clientTextOf, rateLimitKey } = require('./order-dedup');   // F3 — resolve the SAME content-stamp path createOrder/chargeOnlineOrder write (§3: + the pre-§3 verbatim key, latest wins)\n",
  "was": "const { orderContentKey, rateLimitKey } = require('./order-dedup');   // F3 — resolve the SAME content-stamp path createOrder/chargeOnlineOrder write\n"
 },
 {
  "file": "materialize-guard.js",
  "now": "// §3 r6 (codex r6, the structural ruling): hold(X) = MAIN_PATH(X) OR NEW_PATH(X) — two independent lookups, OR-ed, so the\n// guard is a provable SUPERSET of main (207170e) with every extra hold verified.\n//\n// The sibling's CLIENT content, by PROVENANCE only (§3 r5): createOrder stamps a cash order from its text BEFORE appending\n// a reward's lines and records exactly what it appended (reward_text_appended). Known when it has no redemption (nothing\n// appended) or its text ends with the recorded suffix; otherwise UNKNOWN (an order written before this deploy, or text\n// that no longer ends with what was appended).\nfunction siblingClientText(sib) {\n  if (!sib || typeof sib.items_text !== 'string') return { known: false, reason: 'no_sibling_text' };\n  const suffix = typeof sib.reward_text_appended === 'string' && sib.reward_text_appended ? sib.reward_text_appended : null;\n  if (suffix) { const t = clientTextOf(sib.items_text, suffix); return t == null ? { known: false, reason: 'provenance_not_suffix' } : { known: true, text: t }; }\n  if (sib.redemption) return { known: false, reason: 'no_reward_provenance' };\n  return { known: true, text: sib.items_text };\n}\nconst sameCart = (sib, text, ck) => {\n  const ssf = SCHED.normalizeScheduledFor(sib.scheduled_for);\n  return orderContentKey({ phone: sib.customer_phone, itemsText: text, orderType: sib.order_type, scheduledFor: Number.isFinite(ssf) ? ssf : null }) === ck;\n};\nconst logRefused = (orderId, siblingId, path, reason) => { try { console.warn('duplicate_sibling_not_verified', JSON.stringify({ order_id: String(orderId), sibling_id: String(siblingId), path, reason })); } catch (_) {} };\n\n// MAIN_PATH — 207170e's lookup, kept as it was: the ONE stamp under the incoming order's VERBATIM key (its full text, as\n// stamped), main's fast-outs, main's liveness decision. It holds whenever main holds, with ONE exception: provenance\n// PROVES the sibling is another cart (its client content is known and differs) → refused, logged. Unknown = main.\nasync function mainPathSibling(deps, orderId, order, args) {\n    const ck = orderContentKeyVerbatim(args);\n    if (!ck) return null;\n    const stamp = (await deps.db.ref(`recent_order_content/${rateLimitKey(order.customer_phone)}/${ck}`).once('value')).val();\n    // fast-out before the sibling point-read (no stamp / self / non-cash → not our collision)\n    if (!stamp || !stamp.order_id || stamp.order_id === orderId || stamp.payment_method !== 'cash') return null;\n    const siblingOrder = (await deps.db.ref(`orders/${stamp.order_id}`).once('value')).val();\n    const dec = duplicateSiblingDecision(orderId, stamp, siblingOrder, 'cash');   // PIN 1: no 2-min gate — liveness of Y decides\n    if (!dec.collision) return null;\n    const c = siblingClientText(siblingOrder);\n    if (c.known && !sameCart(siblingOrder, c.text, orderContentKey(args))) { logRefused(orderId, stamp.order_id, 'main', 'sibling_content_mismatch'); return null; }\n    return dec;\n}\n\n// NEW_PATH — what §3 adds: the order-independent key and the rebuilt pre-§3 legacy key, EACH evaluated on its own (no\n// cross-key \"latest wins\" can hide another lookup's hit). It holds ONLY on a VERIFIED same cart: the sibling's client\n// content is known (no redemption, or provenance stripped exactly) and keys as this order's full text. Unknown or a\n// mismatch → no hold, logged.\nasync function newPathSibling(deps, orderId, order, args) {\n  const ck = orderContentKey(args);\n  if (!ck) return null;\n  // the keys the card checkout's intake PERSISTED (warm snapshot) — trusted only when the persisted key is THIS content's;\n  // the legacy key is REBUILT from this order's own text, its own reward provenance and the persisted permutation\n  const persisted = typeof order.content_key === 'string' && order.content_key === ck;\n  const ownSuffix = typeof order.reward_text_appended === 'string' && order.reward_text_appended ? order.reward_text_appended : null;\n  let legacyKey = null, fallback = persisted ? null : (order.content_key ? 'stale_persisted_keys' : 'no_persisted_keys');\n  if (persisted && order.content_legacy_order != null) { legacyKey = legacyKeyByOrder(args, order.content_legacy_order, ownSuffix); if (!legacyKey) fallback = 'invalid_legacy_order'; }\n  else if (persisted) fallback = typeof order.content_key_legacy_reason === 'string' ? `intake_${order.content_key_legacy_reason}` : 'legacy_order_absent';   // r5 P2: never a silent fallback\n  if (fallback) { try { console.warn('content_key_legacy_unavailable', JSON.stringify({ order_id: String(orderId), reason: fallback })); } catch (_) {} }\n  const mainKey = orderContentKeyVerbatim(args);   // already MAIN_PATH's — not evaluated twice\n  for (const key of [...new Set([ck, legacyKey].filter((k) => typeof k === 'string' && k && k !== mainKey))]) {\n    const stamp = await readContentStampByKeys(deps.db, order.customer_phone, [key]);\n    if (!stamp || !stamp.order_id || stamp.order_id === orderId || stamp.payment_method !== 'cash') continue;\n    const siblingOrder = (await deps.db.ref(`orders/${stamp.order_id}`).once('value')).val();\n    const dec = duplicateSiblingDecision(orderId, stamp, siblingOrder, 'cash');\n    if (!dec.collision) continue;\n    const c = siblingClientText(siblingOrder);\n    if (!c.known) { logRefused(orderId, stamp.order_id, 'new', c.reason); continue; }\n    if (!sameCart(siblingOrder, c.text, ck)) { logRefused(orderId, stamp.order_id, 'new', 'sibling_content_mismatch'); continue; }\n    return dec;\n  }\n  return null;\n}\n\nasync function holdIfDuplicateSibling(deps, orderId, order, now) {\n  try {\n    if (!deps || !deps.db || !order || !order.customer_phone) return false;\n    // Already resolved (materialized returns earlier in the caller; defensive) → let the normal flow handle it.\n    if (order.status === 'cancelled' || order.materialized_at || order.payment_status === 'manual_reconciliation') return false;\n    const sf = SCHED.normalizeScheduledFor(order.scheduled_for);\n    const args = { phone: order.customer_phone, itemsText: order.items_text, orderType: order.order_type, scheduledFor: Number.isFinite(sf) ? sf : null };\n    // hold(X) = MAIN_PATH(X) OR NEW_PATH(X)\n    const dec = (await mainPathSibling(deps, orderId, order, args)) || (await newPathSibling(deps, orderId, order, args));\n    if (!dec) return false;\n",
  "was": "async function holdIfDuplicateSibling(deps, orderId, order, now) {\n  try {\n    if (!deps || !deps.db || !order || !order.customer_phone) return false;\n    // Already resolved (materialized returns earlier in the caller; defensive) → let the normal flow handle it.\n    if (order.status === 'cancelled' || order.materialized_at || order.payment_status === 'manual_reconciliation') return false;\n    const sf = SCHED.normalizeScheduledFor(order.scheduled_for);\n    const ck = orderContentKey({ phone: order.customer_phone, itemsText: order.items_text, orderType: order.order_type, scheduledFor: Number.isFinite(sf) ? sf : null });\n    if (!ck) return false;\n    const stamp = (await deps.db.ref(`recent_order_content/${rateLimitKey(order.customer_phone)}/${ck}`).once('value')).val();\n    // fast-out before the sibling point-read (no stamp / self / non-cash → not our collision)\n    if (!stamp || !stamp.order_id || stamp.order_id === orderId || stamp.payment_method !== 'cash') return false;\n    const siblingOrder = (await deps.db.ref(`orders/${stamp.order_id}`).once('value')).val();\n    const dec = duplicateSiblingDecision(orderId, stamp, siblingOrder, 'cash');   // PIN 1: no 2-min gate — liveness of Y decides\n    if (!dec.collision) return false;\n"
 }
]);
function unapplySerial3Module(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`serial3-inverse: ${file}: a serial3 hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
module.exports = { unapplySerial3Index, unapplySerial3Module, BLOCKS, HUNKS, FILES, BASE };
