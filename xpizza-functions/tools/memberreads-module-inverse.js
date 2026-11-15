'use strict';
// PLAN-3a-capp-member-reads (1)+(2) — the test-only INVERSE of 3a's index.js additions on train asm9 (base 604e96ab5; rebuilt there from asm8 b6f6b82b1, where index.js is byte-identical): the
// getMyFavorites / setFavorite exports (5a84271f3; asm8 ccdec7d6) and the getMyLastTip export (32a4ce6e2; asm8 7e708d3a), both pure insertions inside checkout's
// endpoints block; + reviews v2 S3 (feat/merchant-reviews-v2-s3-3a): the getMerchantReviews + setMyName exports and the
// stampRatingFulfilment event-time line (owner-approved r6.2 build, advisor 11-15). Generated from each commit's own `git show -U0 <commit> -- index.js` (added lines only); unapplying both returns
// index.js to 604e96ab5 byte-for-byte (memberreads-wiring.guard). Composed into the index.js fold chains of the wiring guards that pin
// index.js to a fixed train revision (the s2bext / s1srv pattern; advisor ruling 2026-11-13, option 2): inside each s1srv call (as the s1srv layer's
// argument), or at the raw read where no inverse was composed. Any other file passes through untouched.
const BASE = '604e96ab5';
const HUNKS = Object.freeze([
 {
  "commit": "5a84271f3",
  "label": "(1) favorites: getMyFavorites + setFavorite exports",
  "file": "index.js",
  "now": "// PLAN-3a-capp-member-reads (1): the member's favorites + recent restaurants (getMyFavorites) and the heart (setFavorite) — member-only\n// through member-auth, the token in the x-firebase-id-token header; server-only writes as ONE parent transaction (the deletion fence,\n// the exact cap, cold-cache safe); ONE bounded favorites query + ONE bounded history query (≤ 10 rows)\nconst MY_FAVORITES = require('./my-favorites').makeMyFavorites({ getDatabase, getAuth, checkRateLimit });\nexports.getMyFavorites = onRequest(\n  { region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 },\n  MY_FAVORITES.getMyFavorites,\n);\nexports.setFavorite = onRequest(\n  { region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 },\n  MY_FAVORITES.setFavorite,\n);\n",
  "was": ""
 },
 {
  "commit": "32a4ce6e2",
  "label": "(2) last tip: getMyLastTip export",
  "file": "index.js",
  "now": "// PLAN-3a-capp-member-reads (2): the member's last tip with the token in the x-firebase-id-token HEADER — replaces the capp's RTDB REST\n// `?auth=<ID token>` read (rule 20); member-only through member-auth; ONE leaf read; the capp's lastTip() swaps to it in the same release\nexports.getMyLastTip = onRequest(\n  { region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 },\n  require('./my-last-tip').makeMyLastTip({ getDatabase, getAuth, checkRateLimit }).getMyLastTip,\n);\n",
  "was": ""
 },
 {
  "commit": "reviews-v2-S3",
  "label": "reviews v2 S3: the stampRatingFulfilment trigger passes the EVENT's time (r3 §4)",
  "file": "index.js",
  "now": "    // r3 §4 (reviews v2): the stamp's clock is the EVENT's time (identical across retries), never this instance's wall clock\n    try { await require('./ratings/rating-fulfilment').stampRatingFulfilment(getDatabase(), { orderId: event.params.orderId, status: event.data.after.val(), eventTime: Date.parse(event.time) }); }\n",
  "was": "    try { await require('./ratings/rating-fulfilment').stampRatingFulfilment(getDatabase(), { orderId: event.params.orderId, status: event.data.after.val(), now: Date.now() }); }\n"
 },
 {
  "commit": "reviews-v2-S3",
  "label": "reviews v2 S3: getMerchantReviews + setMyName exports",
  "file": "index.js",
  "now": "// reviews v2 S3 (PLAN-3a-merchant-reviews-v2 r1/r2/r3/r4.2/r5): getMerchantReviews — the portal's NAMED reviews list (disclosed ratings\n// only, every rid re-authorized, a k-way merge over rating_index under one read budget); dish names through the ONE resolver; the\n// sealed cursor and the avatar tone keyed from OTP_SALT under their own HKDF labels\nexports.getMerchantReviews = onRequest(\n  { region: 'us-central1', cors: PORTAL_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10, secrets: [OTP_SALT_SECRET] },\n  require('./ratings/merchant-reviews').makeMerchantReviews({ getDatabase, getAuth, checkRateLimit, resolveContext: async (rid) => contextOfTables(await resolvePricingTables(rid)) }).getMerchantReviews,\n);\n// reviews v2 (PLAN-3a-merchant-reviews-v2 r3 §3): setMyName — the later edit of the STRUCTURED name (given_name + family_name), written\n// only in the fenced user_private transaction (signup-core.setMyName); the signup family's handler + options, kept OUT of the signup\n// blocks (signup-inverse pins them byte-for-byte)\nexports.setMyName = onRequest(SIGNUP_OPTS, SIGNUP_H.setMyName);\n",
  "was": ""
 }
]);
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
function unapplyMemberReadsModule(file, src) {
  if (!FILES.includes(file)) return src;
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`memberreads-module-inverse: ${file}: a hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
module.exports = { BASE, HUNKS, FILES, unapplyMemberReadsModule };
