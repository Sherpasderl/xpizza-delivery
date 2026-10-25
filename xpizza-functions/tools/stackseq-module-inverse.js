'use strict';
// STACKED-DELIVERY SEQUENCING (BUILD-stacked-seq-server r5 T8/T9) — the test-only INVERSE of this slice's footprint in the PINNED
// module cancel-order-core.js: the flag-gated cancel promotion's two lines at the top of cleanupTasksAndDriver (OFF = the
// base body verbatim). unapplyStackseqModule('cancel-order-core.js', src) === acf32fc8:cancel-order-core.js byte-for-byte; any
// other file passes through unchanged. Newest layer → applied INNERMOST wherever that module is pinned:
// unapplyBrandServerModule(f, unapplyStackseqModule(f, <source>)).
const FILES = ['cancel-order-core.js'];
const HUNKS = [
 {
  "file": "cancel-order-core.js",
  "now": "  const SEQ_CANCEL = require('./sequencing/cancel-promotion');   // stacked-seq r5 T8 (D11 a): the flag-gated cancel promotion; OFF = the body below, verbatim\n  if (order && order.order_type === 'delivery' && await SEQ_CANCEL.readSeqFlagSafe(db)) return SEQ_CANCEL.cleanupWithPromotion(db, orderId);\n",
  "was": ""
 }
];

function unapplyStackseqModule(file, src) {
  if (!FILES.includes(file)) return src;
  let out = src;
  for (const h of HUNKS.filter((x) => x.file === file)) {
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`stackseq-module-inverse: ${file}: a hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}

module.exports = { unapplyStackseqModule, FILES, HUNKS };
