'use strict';
// MENU-ORDERING §3, codex serialization r1 (order-independent content key + the factura's lines in menu order) — the slice's
// test-only INVERSE. index.js carries 10 delimited, byte-pinned blocks `/* serial3:begin <id> */ … /* serial3:end <id> */`
// (pure insertions, plus the createOrder content-stamp read and the two factura heads, which REPLACE one line each);
// unapplySerial3Index swaps each back for its original bytes, so unapplySerial3Index(index.js) === 207170e:index.js
// byte-for-byte (serial3-wiring.guard). Every index.js fold guard applies it FIRST (this is the newest index.js slice),
// before the per-product-extras blocks. HUNKS are its exact edits in the PINNED materialize-guard.js (order-control-wiring
// pins it vs e1aeb3f): unapplySerial3Module is applied first there, so any byte outside them still fails the pin.
const crypto = require('crypto');
const BASE = '207170e';
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
  "now": "const { orderContentKey, orderContentKeyVerbatim, readContentStampByKeys, legacyKeyByOrder, clientTextOf } = require('./order-dedup');   // F3 — resolve the SAME content-stamp path createOrder/chargeOnlineOrder write (§3: + the pre-§3 verbatim key, latest wins)\n",
  "was": "const { orderContentKey, rateLimitKey } = require('./order-dedup');   // F3 — resolve the SAME content-stamp path createOrder/chargeOnlineOrder write\n"
 },
 {
  "file": "materialize-guard.js",
  "now": "    const args = { phone: order.customer_phone, itemsText: order.items_text, orderType: order.order_type, scheduledFor: Number.isFinite(sf) ? sf : null };\n    const ck = orderContentKey(args);\n    if (!ck) return false;\n    // §3 r3/r4 (codex r3 P1, r4 P1): what the card checkout's intake PERSISTED, where the catalog snapshot is warm — this\n    // handler runs in another instance with a cold cache and never computes from menu names. The persisted key is trusted\n    // only when it is THIS content's key; the legacy key is never stored, it is REBUILT from this order's own items_text and\n    // the persisted menu-order permutation, which must be a true permutation of its lines. No keys (an order written\n    // before the deploy), stale keys or an invalid permutation → today's behaviour (the order-independent key + the\n    // incoming verbatim key), LOGGED with the order_id.\n    const persisted = typeof order.content_key === 'string' && order.content_key === ck;\n    // r5: this order's own server-appended text (its reward lines) is known by PROVENANCE — reward_text_appended — never by pattern\n    const ownSuffix = typeof order.reward_text_appended === 'string' && order.reward_text_appended ? order.reward_text_appended : null;\n    let legacyKey = null, fallback = persisted ? null : (order.content_key ? 'stale_persisted_keys' : 'no_persisted_keys');\n    if (persisted && order.content_legacy_order != null) { legacyKey = legacyKeyByOrder(args, order.content_legacy_order, ownSuffix); if (!legacyKey) fallback = 'invalid_legacy_order'; }\n    else if (persisted) fallback = typeof order.content_key_legacy_reason === 'string' ? `intake_${order.content_key_legacy_reason}` : 'legacy_order_absent';   // r5 P2: never a silent fallback\n    if (fallback) { try { console.warn('content_key_legacy_unavailable', JSON.stringify({ order_id: String(orderId), reason: fallback })); } catch (_) {} }\n    const stamp = await readContentStampByKeys(deps.db, order.customer_phone, [ck, legacyKey || orderContentKeyVerbatim(args)]);\n",
  "was": "    const ck = orderContentKey({ phone: order.customer_phone, itemsText: order.items_text, orderType: order.order_type, scheduledFor: Number.isFinite(sf) ? sf : null });\n    if (!ck) return false;\n    const stamp = (await deps.db.ref(`recent_order_content/${rateLimitKey(order.customer_phone)}/${ck}`).once('value')).val();\n"
 },
 {
  "file": "materialize-guard.js",
  "now": "    // §3 r4/r5 (codex r4 P1, r5 P1-A/B): a paid order is held only on a VERIFIED sibling — whichever key found its stamp, the\n    // sibling's own content must be the content this order's stamp lookup asked for. That is TODAY's (207170e) hold condition\n    // made explicit: createOrder stamps a cash order from its text BEFORE appending a reward's lines, and this order's key is\n    // its FULL text — so the sibling's CLIENT text (its items_text minus EXACTLY what its server appended, by provenance:\n    // reward_text_appended) must key as this order's full text. No reward → nothing to strip. A reward the server recorded\n    // no provenance for (an order written before this deploy) cannot be verified → today's behaviour (the stamp decides),\n    // LOGGED. A mismatch → no hold, LOGGED.\n    const sib = siblingOrder || {};\n    const sibSuffix = typeof sib.reward_text_appended === 'string' && sib.reward_text_appended ? sib.reward_text_appended : null;\n    let sibText = null, unverifiable = null;\n    if (typeof sib.items_text !== 'string') unverifiable = 'no_sibling_text';\n    else if (sibSuffix) sibText = clientTextOf(sib.items_text, sibSuffix);   // null: the text no longer ends with what was appended\n    else if (sib.redemption) unverifiable = 'no_reward_provenance';\n    else sibText = sib.items_text;\n    if (!unverifiable) {\n      const ssf = SCHED.normalizeScheduledFor(sib.scheduled_for);\n      const sibKey = sibText == null ? null : orderContentKey({ phone: sib.customer_phone, itemsText: sibText, orderType: sib.order_type, scheduledFor: Number.isFinite(ssf) ? ssf : null });\n      if (!sibKey || sibKey !== ck) {\n        try { console.warn('duplicate_sibling_not_verified', JSON.stringify({ order_id: String(orderId), sibling_id: String(stamp.order_id), reason: 'sibling_content_mismatch' })); } catch (_) {}\n        return false;\n      }\n    } else { try { console.warn('duplicate_sibling_unverifiable', JSON.stringify({ order_id: String(orderId), sibling_id: String(stamp.order_id), reason: unverifiable })); } catch (_) {} }\n",
  "was": ""
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
