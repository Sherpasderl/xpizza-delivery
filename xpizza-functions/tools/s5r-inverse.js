'use strict';
// S5 ratings writer (Customer App) — the test-only INVERSE of the slice's ONE index.js hunk (hot-file invariant, see memory
// index-js-inverse-fold-invariant): a same-line append to the RATE_LIMIT_BUCKETS export that re-exports rateOrder from
// ratings/rate-order.js (a direct require chain, so contract/discovery classifies it). Put back to its 5f2e1ef7 text, so
// every *-wiring.guard fold chain reconstructs its frozen base. Proof (i): unapplyS5rIndex(index.js) === 5f2e1ef7:index.js
// byte-for-byte (s5r-wiring.guard). The hunk must occur EXACTLY once. GENERATED from `git diff 5f2e1ef7 -- index.js`.

const HUNKS = [
  [
    "module.exports.RATE_LIMIT_BUCKETS = RATE_LIMIT_BUCKETS; exports.rateOrder = require('./ratings/rate-order').rateOrder;   // S5 ratings writer (ratings/; tools/s5r-inverse.js)\n",
    "module.exports.RATE_LIMIT_BUCKETS = RATE_LIMIT_BUCKETS;\n"
  ]
];

function unapplyS5rIndex(src) {
  let out = src;
  for (const [now, was] of HUNKS) {
    const i = out.indexOf(now);
    if (i < 0 || out.indexOf(now, i + 1) !== -1) throw new Error(`s5r-inverse: hunk not found exactly once: ${now.slice(0, 80)}`);
    out = out.slice(0, i) + was + out.slice(i + now.length);
  }
  return out;
}

module.exports = { unapplyS5rIndex, HUNKS };
