'use strict';
// PLAN-3a-capp-member-reads (1)+(2) — the test-only INVERSE of 3a's index.js additions on train asm9 (base 604e96ab5; rebuilt there from asm8 b6f6b82b1, where index.js is byte-identical): the
// getMyFavorites / setFavorite exports (5a84271f3; asm8 ccdec7d6) the getMyLastTip export (32a4ce6e2; asm8 7e708d3a), PLAN-3a-addr's useMyAddress export (b08f3c30e), and the portal «Marketing» offer exports (78e241bed) + the Anuncio exports (5ea3340e9), all pure insertions inside checkout's
// endpoints block; + reviews v2 S3 (feat/merchant-reviews-v2-3a): the getMerchantReviews + setMyName exports and the
// stampRatingFulfilment event-time line (owner-approved r6.2 build, advisor 11-15); + the 4 customer-push exports (PLAN-3a-capp-push-tokens r0 §2, advisor GO 11-16). Generated from each commit's own `git show -U0 <commit> -- index.js` (added lines only); unapplying both returns
// index.js to 604e96ab5 byte-for-byte (memberreads-wiring.guard). Composed into the index.js fold chains of the wiring guards that pin
// index.js to a fixed train revision (the s2bext / s1srv pattern; advisor ruling 2026-11-13, option 2): inside each s1srv call (as the s1srv layer's
// argument), or at the raw read where no inverse was composed. Any other file passes through untouched.
// (3) dish_stats (5014e1295): catalog/public-menu.js's edits (the 1d.4 marker, the BODY_CONTRACT entry, the decoration call) as exact-text
// hunks generated from `git diff -U1 5014e1295^ 5014e1295 -- catalog/public-menu.js` (each occurs exactly once); unapplying them returns
// public-menu.js to 604e96ab5 byte-for-byte (unchanged between 604e96ab5 and 07a26c194). Composed into the 9 guards that fold it.
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
  "commit": "b08f3c30e",
  "after": ["aaeb8f277", "099c280e4"],
  "label": "(S-ADDR-2) address selection: useMyAddress export",
  "file": "index.js",
  "now": "// PLAN-3a-addr S-ADDR-2: the «en uso» address selection, persisted as default_address — member-only through member-auth, the token in\n// the x-firebase-id-token header; body exactly { id }; ONE parent transaction on user_profiles/{uid} (the sweep fence, never resurrects a purge)\nexports.useMyAddress = onRequest(\n  { region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 },\n  require('./my-address').makeMyAddress({ getDatabase, getAuth, checkRateLimit }).useMyAddress,\n);\n",
  "was": ""
 },
 {
  "commit": "78e241bed",
  "label": "marketing steps 1–2: getMarketing + the three offer write exports",
  "file": "index.js",
  "now": "// PLAN-3a-marketing-server steps 1–2: the portal «Marketing» offer endpoints (marketing/functions.js; dark until platform_config/marketing.offers_enabled)\nexports.getMarketing = require('./marketing/functions').getMarketing; exports.marketingOfferSave = require('./marketing/functions').marketingOfferSave; exports.marketingOfferSetState = require('./marketing/functions').marketingOfferSetState; exports.marketingOfferRepeat = require('./marketing/functions').marketingOfferRepeat;\n",
  "was": ""
 },
 {
  "commit": "5ea3340e9",
  "label": "marketing step 3: the three Anuncio exports",
  "file": "index.js",
  "now": "exports.getAnuncioWeeks = require('./marketing/functions').getAnuncioWeeks; exports.anuncioBook = require('./marketing/functions').anuncioBook; exports.anuncioCancel = require('./marketing/functions').anuncioCancel;   // PLAN-3a-marketing-server step 3: the «Anuncio» (dark until anuncio_enabled)\n",
  "was": ""
 },
 {
  "commit": "5014e1295",
  "label": "(3) dish_stats: catalog/public-menu.js hunk 1/3",
  "file": "catalog/public-menu.js",
  "now": "   dish's `reward_icon`. 7f72757f's photo field and its category-rename validation are kept as they were. */\n/* PLAN-3a-capp-member-reads (3) §3.2: advanced 1d.3 → 1d.4 because the body can now carry `dish_stats` (the C-4 dish badges). The forms\n   keep their own marker and only console.warn menu_representation_changed. */\nconst REPRESENTATION_VERSION = '1d.4';\n\n",
  "was": "   dish's `reward_icon`. 7f72757f's photo field and its category-rename validation are kept as they were. */\nconst REPRESENTATION_VERSION = '1d.3';\n\n"
 },
 {
  "commit": "5014e1295",
  "label": "(3) dish_stats: catalog/public-menu.js hunk 2/3",
  "file": "catalog/public-menu.js",
  "now": "  // required — a decoration omitted on any trouble (catalog/public-photos.js), so its absence is not a half-menu.\n  dish_stats: { type: 'object' },   /* (3): a decoration (catalog/dish-stats-serve.js), omitted on any trouble — never required */\n  photos: { type: 'object' }, avail_identity: { required: true, type: 'object' }, item_keys: { type: 'object' },   /* S1d: { [String(dish.id)]: item_key }, endpoint-only (never the bake's body) */   // PLAN-avail-identity r1: { field } — the restaurant's availability identity, from the server's ONE rule\n",
  "was": "  // required — a decoration omitted on any trouble (catalog/public-photos.js), so its absence is not a half-menu.\n  photos: { type: 'object' }, avail_identity: { required: true, type: 'object' }, item_keys: { type: 'object' },   /* S1d: { [String(dish.id)]: item_key }, endpoint-only (never the bake's body) */   // PLAN-avail-identity r1: { field } — the restaurant's availability identity, from the server's ONE rule\n"
 },
 {
  "commit": "5014e1295",
  "label": "(3) dish_stats: catalog/public-menu.js hunk 3/3",
  "file": "catalog/public-menu.js",
  "now": "\n  /* PLAN-3a-capp-member-reads (3) — DISH_STATS, last, and only where it can be joined: on the endpoint's overlay branch AFTER the\n     overlay applied (the served dishes carry dish_id). Never on the overlayIdentity:false bake / reconciler path (stats move daily: a\n     baked copy would freeze them). withDishStats never throws and never blocks past its own 1.5 s deadline. */\n  if (deps.overlayIdentity !== false && enriched.applied) body = await require('./dish-stats-serve').withDishStats(restaurantId, body, deps.dishStats || {});\n\n  // THE ETAG IS OVER THE REPRESENTATION — this rid, this projection version, this body. Not 1A's\n",
  "was": "\n  // THE ETAG IS OVER THE REPRESENTATION — this rid, this projection version, this body. Not 1A's\n"
 },
 {
  "commit": "d688d8378",
  "label": "capp offers Q1: catalog/public-menu.js hunk 1/2",
  "file": "catalog/public-menu.js",
  "now": "  offers: { type: 'array' },        /* PLAN-3a-capp-offers-read Q1: a decoration (catalog/offers-serve.js), ABSENT when offers are off — never required */\n",
  "was": ""
 },
 {
  "commit": "d688d8378",
  "label": "capp offers Q1: catalog/public-menu.js hunk 2/2",
  "file": "catalog/public-menu.js",
  "now": "  /* PLAN-3a-capp-offers-read Q1 — OFFERS, on the same branch and for the same reason (they move by the minute: a baked copy would freeze\n     them). No representation bump (advisor Q-A): absent when off, so the body and the ETag are unchanged; on, the body moves the ETag. */\n  if (deps.overlayIdentity !== false) body = await require('./offers-serve').withOffers(restaurantId, body, deps.offers || {});\n",
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
 },
 {
  "commit": "capp-push-wiring",
  "after": "aaeb8f277",
  "label": "PLAN-3a-capp-push-tokens r0 §2: the 4 customer-push exports over ONE makeCustomerPush (advisor GO 11-16)",
  "file": "index.js",
  "now": "// PLAN-3a-capp-push-tokens r0 §2 (advisor GO 11-16): the capp's push endpoints — the device registration + the person's push prefs\n// (customer-push.js, built + approved at 4d9d1905c; the capp's api calls these names). Member-only (x-firebase-id-token, member-auth),\n// ?context=platform, rate-limited per uid; server-only nodes customer_push_tokens / customer_push_prefs (rules: server-only)\nconst CUSTOMER_PUSH = require('./customer-push').makeCustomerPush({ getDatabase, getAuth, checkRateLimit });\nexports.registerCustomerPushToken = onRequest(\n  { region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 },\n  CUSTOMER_PUSH.registerCustomerPushToken,\n);\nexports.unregisterCustomerPushToken = onRequest(\n  { region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 },\n  CUSTOMER_PUSH.unregisterCustomerPushToken,\n);\nexports.setCustomerPushPrefs = onRequest(\n  { region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 },\n  CUSTOMER_PUSH.setCustomerPushPrefs,\n);\nexports.getCustomerPushPrefs = onRequest(\n  { region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 },\n  CUSTOMER_PUSH.getCustomerPushPrefs,\n);\n",
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
// ONLY the hunks landed AFTER `base` (marked `after: base`, or a list naming base) — for a guard pinned to a later train revision than BASE
// (mktprice-wiring pins aaeb8f277, asm10 chain step 10; ledgers1-wiring pins 099c280e4, asm11 17): it peels exactly the member-reads
// insertions that revision lacks; every other byte stays strict. S-ADDR-2 (merged forward onto 31f05c8a4) postdates both pins.
function unapplyAfter(file, src, base) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file || ![].concat(h.after || []).includes(base)) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`memberreads-module-inverse: ${file}: a hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
module.exports = { BASE, HUNKS, FILES, unapplyMemberReadsModule, unapplyAfter };
