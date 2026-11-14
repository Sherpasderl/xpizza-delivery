'use strict';
// PLAN-3a-capp-member-reads (1)+(2) — the test-only INVERSE of 3a's index.js additions on train asm9 (base 604e96ab5; rebuilt there from asm8 b6f6b82b1, where index.js is byte-identical): the
// getMyFavorites / setFavorite exports (5a84271f3; asm8 ccdec7d6) and the getMyLastTip export (32a4ce6e2; asm8 7e708d3a), and the portal «Marketing» offer exports (78e241bed) + the Anuncio exports (5ea3340e9), all pure insertions inside checkout's
// endpoints block. Generated from each commit's own `git show -U0 <commit> -- index.js` (added lines only); unapplying both returns
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
