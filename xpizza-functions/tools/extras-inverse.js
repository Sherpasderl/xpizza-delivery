'use strict';
// PER-PRODUCT EXTRAS, stage 2 — the test-only INVERSE of its index.js change (PLAN-per-product-extras rev 2.1 §4/§5).
// index.js carries EIGHT delimited, byte-pinned blocks `/* extras:begin <id> */ … /* extras:end <id> */`: seven pure
// insertions and ONE replaced line (the acquire call). unapplyExtrasIndex swaps each back for its original bytes, so
// unapplyExtrasIndex(index.js) === 537bbbc:index.js byte-for-byte (extras-wiring.guard). Every index.js fold guard applies
// it FIRST (this is the newest index.js slice), before the WhatsApp-cancel / D12b blocks.
const crypto = require('crypto');
const BLOCKS = [
  {
    "id": "wiring",
    "sha": "bb1f30a1b79c40939cd7a4fce08c737e6038d469b03f7911e244278cc6c1634f",
    "original": ""
  },
  {
    "id": "cash",
    "sha": "81388e94f13abdd9d8929b7fcaceffc64b68eeedae3214090aa4af461517f862",
    "original": ""
  },
  {
    "id": "card-arm",
    "sha": "88336c6227b7a459f08c72da3ef0b234ae6a7713bdc503cd7e2469acb7b7d978",
    "original": ""
  },
  {
    "id": "card",
    "sha": "b8fa35218856e01a613b16a04128aad373f8919a32a8677ace076a2385250bac",
    "original": ""
  },
  {
    "id": "card-acquire",
    "sha": "80086cfadb619092f15a0ac6bccb167bd9b6486267feb40fb7f0722edadd61e0",
    "original": "    acq = await acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, nowTs, cartBlocked, undefined, undefined, canonicalChargeFp, floorBelow, controlArmed !== null, menuArmed, choiceArmed);   // P-SELFUPDATE \u00a75 (2): refuseFresh; D4-c4: the race guard; add-product A: the menu guard\n"
  },
  {
    "id": "card-map",
    "sha": "b0c2aa9dc1235833f0280c72e642cf892abba41346179e1cd058452fd8a10e64",
    "original": ""
  },
  {
    "id": "quote",
    "sha": "286a3ddb1770cd6d311eb747c804a7243ca2cbf265ff528d19de926907d31f08",
    "original": ""
  },
  {
    "id": "quote-redemption",
    "sha": "f7179d85bd99129e5d746370fac6abc4a730a98a5e580a881eb4893d0377536b",
    "original": ""
  }
];
const rxFor = (id) => new RegExp(`[ \\t]*\\/\\* extras:begin ${id.replace(/[-]/g, '\\-')} \\*\\/\\n[\\s\\S]*?\\/\\* extras:end ${id.replace(/[-]/g, '\\-')} \\*\\/\\n`, 'g');
function unapplyExtrasIndex(src) {
  const begins = (src.match(/\/\* extras:begin /g) || []).length;
  const ends = (src.match(/\/\* extras:end /g) || []).length;
  if (begins !== BLOCKS.length || ends !== BLOCKS.length) throw new Error(`extras-inverse: expected exactly ${BLOCKS.length} extras index.js blocks (begin ${begins}, end ${ends})`);
  let out = src;
  for (const b of BLOCKS) {
    const found = out.match(rxFor(b.id)) || [];
    if (found.length !== 1) throw new Error(`extras-inverse: expected exactly one block ${b.id}, found ${found.length}`);
    if (crypto.createHash('sha256').update(found[0]).digest('hex') !== b.sha) throw new Error(`extras-inverse: block ${b.id} differs from its pinned bytes`);
    out = out.replace(rxFor(b.id), () => b.original);
  }
  return out;
}
module.exports = { unapplyExtrasIndex, BLOCKS };
