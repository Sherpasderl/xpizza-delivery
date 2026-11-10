'use strict';
// S3b PixelPay return routing (Customer App) — the test-only INVERSE of the S3b slice's index.js hunks (hot-file invariant, see
// memory index-js-inverse-fold-invariant). Every hunk is SAME-LINE: the resolver import; the fresh path's identity captured
// for the return site; resolveReturnBaseForCharge (brand-aware, platform/sites.json data); the poll token on the cancel URL.
// Put back to their 3b6e9fc8 text, so every *-wiring.guard fold chain reconstructs its frozen base. Proof (i):
// unapplyS3bIndex(index.js) === 3b6e9fc8:index.js byte-for-byte (s3b-wiring.guard). Each hunk must occur EXACTLY once.
// GENERATED from `git diff 3b6e9fc8 -- index.js` (context grown until unique); JSON-quoted strings.

const HUNKS = [
  [
    "const { resolveReturnBase, resolveReturnBaseForCharge } = require('./pixelpay-return-url');   // S3b: routing as data (platform/sites.json)\n",
    "const { resolveReturnBase } = require('./pixelpay-return-url');\n"
  ],
  [
    "  let s3bIdentity = null; if (!probeOrder) {   // S3b: the identity a fresh order reads also selects its return site\n",
    "  if (!probeOrder) {\n"
  ],
  [
    "      id = await getRestaurantIdentity(db, restaurantId); s3bIdentity = id;\n",
    "      id = await getRestaurantIdentity(db, restaurantId);\n"
  ],
  [
    "  const returnBase = await resolveReturnBaseForCharge(restaurantId, process.env, { identity: s3bIdentity, entryMode: body.entry_mode, readBrandId: () => db.ref(`restaurants/${restaurantId}/identity/brand_id`).get().then((s) => s.val()) });\n",
    "  const returnBase = resolveReturnBase(restaurantId, process.env);\n"
  ],
  [
    "  const cancelUrl = `${siteBase}/?pay=cancel&order=${encodeURIComponent(orderId)}&t=${encodeURIComponent(pollToken)}`;   // S3b: the poll token, so a paid order landing on cancel verifies even with the stash cleared\n",
    "  const cancelUrl = `${siteBase}/?pay=cancel&order=${encodeURIComponent(orderId)}`;\n"
  ]
];

function unapplyS3bIndex(src) {
  let out = src;
  for (const [now, was] of HUNKS) {
    const i = out.indexOf(now);
    if (i < 0 || out.indexOf(now, i + 1) !== -1) throw new Error(`s3b-inverse: hunk not found exactly once: ${now.slice(0, 80)}`);
    out = out.slice(0, i) + was + out.slice(i + now.length);
  }
  return out;
}

module.exports = { unapplyS3bIndex, HUNKS };
