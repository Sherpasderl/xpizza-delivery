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
    "sha": "0cdb9ce6f5a17b6e30f712c5033ebe0129b1ecc14f855c97edb1b92e890062cb",
    "original": ""
  },
  {
    "id": "card-arm",
    "sha": "14de1af3673a2f0ebb5f4bcada2300c138bea56bccbdeef326ad84d209afa3d3",
    "original": ""
  },
  {
    "id": "card",
    "sha": "230db9d0b5ecb34ae0e73d16213a892bfa4479a64bbe6fdcf13978f7ad3f853f",
    "original": ""
  },
  {
    "id": "card-acquire",
    "sha": "80086cfadb619092f15a0ac6bccb167bd9b6486267feb40fb7f0722edadd61e0",
    "original": "    acq = await acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, nowTs, cartBlocked, undefined, undefined, canonicalChargeFp, floorBelow, controlArmed !== null, menuArmed, choiceArmed);   // P-SELFUPDATE \u00a75 (2): refuseFresh; D4-c4: the race guard; add-product A: the menu guard\n"
  },
  {
    "id": "card-map",
    "sha": "928ea92f2fd0e9a290282cf9e731ea9246890c3269deb9e77c053c19cdb1486b",
    "original": ""
  },
  {
    "id": "quote",
    "sha": "1741753fd56ec59c9674a08cf4a93f6203d2ad6b022d68a525cf99f277574765",
    "original": ""
  },
  {
    "id": "quote-redemption",
    "sha": "9a54803db5516da109c98377894e43157207a8c69f50c5519b5da18ff06a7044",
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
