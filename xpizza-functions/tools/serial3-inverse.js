'use strict';
// MENU-ORDERING §3, codex serialization r1 (order-independent content key + the factura's lines in menu order) — the slice's
// test-only INVERSE. index.js carries 7 delimited, byte-pinned blocks `/* serial3:begin <id> */ … /* serial3:end <id> */`
// (pure insertions, plus the createOrder content-stamp read and the two factura heads, which REPLACE one line each);
// unapplySerial3Index swaps each back for its original bytes, so unapplySerial3Index(index.js) === 90fac9e:index.js
// byte-for-byte (serial3-wiring.guard). Every index.js fold guard applies it FIRST (this is the newest index.js slice),
// before the per-product-extras blocks. HUNKS are its exact edits in the PINNED materialize-guard.js (order-control-wiring
// pins it vs e1aeb3f): unapplySerial3Module is applied first there, so any byte outside them still fails the pin.
const crypto = require('crypto');
const BASE = '90fac9e';
const BLOCKS = [
  {
    "id": "require",
    "sha": "9aa3353862511a35a95debc1937387db644206743dd859729d3358be04248b80",
    "original": ""
  },
  {
    "id": "wiring",
    "sha": "4b60b038fc5e1e4b0844f081350edf5fc026a31cf6597bd35746033d90374a4d",
    "original": ""
  },
  {
    "id": "create-stamp",
    "sha": "c31f0ac73d27db1bc3f161d345924cc499791ac8f31138c2120ebe307787ebff",
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
  "now": "const { orderContentKey, readContentStamp } = require('./order-dedup');   // F3 — resolve the SAME content-stamp path createOrder/chargeOnlineOrder write (§3: + the pre-§3 verbatim key, latest wins)\n",
  "was": "const { orderContentKey, rateLimitKey } = require('./order-dedup');   // F3 — resolve the SAME content-stamp path createOrder/chargeOnlineOrder write\n"
 },
 {
  "file": "materialize-guard.js",
  "now": "    const stamp = await readContentStamp(deps.db, { phone: order.customer_phone, itemsText: order.items_text, orderType: order.order_type, scheduledFor: Number.isFinite(sf) ? sf : null });\n",
  "was": "    const stamp = (await deps.db.ref(`recent_order_content/${rateLimitKey(order.customer_phone)}/${ck}`).once('value')).val();\n"
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
