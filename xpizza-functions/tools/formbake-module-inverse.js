'use strict';
// PLAN 4 (bake from published, r3) — the slice's INVERSE for the MODULES older slices pin byte-for-byte
// (catalog/identity-integrity-guards: source-store.js by sha; extras-wiring.guard.test.js: source-store.js against 537bbbc; and
// every other fold that reads these modules). Every fold site applies unapplyFormbakeModule INNERMOST (newest first), then
// the older inverses (public-menu-display, extras), so any byte outside these exact hunks still fails them.
// formbake-module-wiring.guard.test.js proves this inverse reproduces 486f71aa for each file byte-for-byte.
// Generated from the diff against 486f71aa (one context line, widened until unique); each `now` occurs exactly once.
const HUNKS = Object.freeze([
 {
  "file": "catalog/source-store.js",
  "now": "const { assertDisplaySafe, checkValue: assertFieldSafe } = require('./display-safety');\nconst { REWARD_ICONS } = require('./reward-icons');\n\n",
  "was": "const { assertDisplaySafe, checkValue: assertFieldSafe } = require('./display-safety');\n\n"
 },
 {
  "file": "catalog/source-store.js",
  "now": "  'pickup_only_cats', 'weekend_only_cats',\n  'badge_priority',\n  'redeem_eligible_cats', 'redeem_eligible_items', 'redeem_eligible_extras',\n",
  "was": "  'pickup_only_cats', 'weekend_only_cats',\n  'redeem_eligible_cats', 'redeem_eligible_items', 'redeem_eligible_extras',\n"
 },
 {
  "file": "catalog/source-store.js",
  "now": "    extras_policy: { required: false, type: 'string', enum: ['none'] },\n    // PLAN 4 r3 §8.1 (OWNER RULING (a)): the reward-picker icon, from the closed set the shipped sprite draws.\n    reward_icon: { required: false, type: 'string', enum: REWARD_ICONS },\n  };\n",
  "was": "    extras_policy: { required: false, type: 'string', enum: ['none'] },\n  };\n"
 },
 {
  "file": "catalog/source-store.js",
  "now": "      price: { required: true, type: 'int_positive' },\n      // PLAN 4 r3 §8.1 (advisor ruling, flag 2): an extra the reward picker offers carries its icon too\n      reward_icon: { required: false, type: 'string', enum: REWARD_ICONS },\n    };\n",
  "was": "      price: { required: true, type: 'int_positive' },\n    };\n"
 },
 {
  "file": "catalog/source-store.js",
  "now": "  }\n  // PLAN 4 r3 §8.1 — the ORDER badges are chosen in. Every entry names a badge THIS document declares, once: a priority\n  // entry naming no definition would be chosen and then render nothing.\n  if (st.badge_priority !== undefined) {\n    checkField(st.badge_priority, { required: false, type: 'string_array', unique: true }, `${rid}`, 'structure.badge_priority');\n    for (const k of st.badge_priority) {\n      if (!st.badges || !Object.prototype.hasOwnProperty.call(st.badges, k)) fail(`${rid} — badge_priority names ${k}, which this document declares no badge for`);\n    }\n  }\n  // ALWAYS the contract's set — never the source's own keys. A brand with no badge renderer has an\n",
  "was": "  }\n  // ALWAYS the contract's set — never the source's own keys. A brand with no badge renderer has an\n"
 },
 {
  "file": "catalog/source-store.js",
  "now": "  // catalog built from a source could not group its options or render a badge.\n  for (const f of ['variant_items', 'pickup_only_cats', 'weekend_only_cats', 'extras_by_category', 'extras_by_item', 'exposure', 'extra_categories', 'badges', 'badge_priority', 'redeem_eligible_cats', 'redeem_eligible_items', 'redeem_eligible_extras']) {\n    if (source.structure[f] !== undefined) formData[f] = source.structure[f];\n",
  "was": "  // catalog built from a source could not group its options or render a badge.\n  for (const f of ['variant_items', 'pickup_only_cats', 'weekend_only_cats', 'extras_by_category', 'extras_by_item', 'exposure', 'extra_categories', 'badges', 'redeem_eligible_cats', 'redeem_eligible_items', 'redeem_eligible_extras']) {\n    if (source.structure[f] !== undefined) formData[f] = source.structure[f];\n"
 },
 {
  "file": "catalog/form-menu-source.js",
  "now": "  carryStructure('badges', () => readLiteral(src, 'TAG_BADGES', '{', '}'));\n  // PLAN 4 r3 §8.1 — the ORDER badges are chosen in: STORE-ONLY. It reaches the store through the additive migration\n  // (§8.2), never the bootstrap text, so the text path stays byte-identical (and so do the goldens it feeds).\n  carryStructure('badge_priority', () => undefined);\n  // 🔴 THE STORE WINS ONCE IT HAS AUTHORED ONE. This read `structure.extra_categories === undefined`\n",
  "was": "  carryStructure('badges', () => readLiteral(src, 'TAG_BADGES', '{', '}'));\n  // 🔴 THE STORE WINS ONCE IT HAS AUTHORED ONE. This read `structure.extra_categories === undefined`\n"
 },
 {
  "file": "catalog/public-menu.js",
  "now": "const { photosFor } = require('./public-photos');\nconst { REWARD_ICONS } = require('./reward-icons');\n\n",
  "was": "const { photosFor } = require('./public-photos');\n\n"
 },
 {
  "file": "catalog/public-menu.js",
  "now": "   '1d.1' marker (they stay byte-identical) and log menu_representation_changed on a mismatch — a console warning only. */\n/* PLAN 4 r3 §8.1 (version collision ruled): advanced 1d.2 → 1d.3 because the body can now carry `badge_priority` and a\n   dish's `reward_icon`. 7f72757f's photo field and its category-rename validation are kept as they were. */\nconst REPRESENTATION_VERSION = '1d.3';\n\n",
  "was": "   '1d.1' marker (they stay byte-identical) and log menu_representation_changed on a mismatch — a console warning only. */\nconst REPRESENTATION_VERSION = '1d.2';\n\n"
 },
 {
  "file": "catalog/public-menu.js",
  "now": "  badges: { type: 'object', fromSource: (menu) => menu.structure.badges !== undefined },\n  // PLAN 4 r3 §8.1: the ORDER badges are chosen in — badge keys only (assertWholeBody checks each names a served badge)\n  badge_priority: { type: 'array', fromSource: (menu) => menu.structure.badge_priority !== undefined },\n  // per-product extras (PLAN rev 2.1 §7): the DENSE public complement { version, deny: { itemKey: [extraKey…] } } of the\n",
  "was": "  badges: { type: 'object', fromSource: (menu) => menu.structure.badges !== undefined },\n  // per-product extras (PLAN rev 2.1 §7): the DENSE public complement { version, deny: { itemKey: [extraKey…] } } of the\n"
 },
 {
  "file": "catalog/public-menu.js",
  "now": "  for (const f of undeclared) problems.push(`${f} is served but undeclared`);\n  // PLAN 4 r3 §8.1 — the two new display facts, checked against what renders them: a priority entry must name a served\n  // badge, and a dish's reward_icon must be one the reward picker's sprite draws.\n  if (Array.isArray(body.badge_priority)) {\n    const served = isType(body.badges, 'object') ? body.badges : {};\n    const bad = body.badge_priority.filter((k) => typeof k !== 'string' || !Object.prototype.hasOwnProperty.call(served, k));\n    if (bad.length) problems.push(`badge_priority names ${bad.length} key(s) that are not served badges`);\n  }\n  for (const coll of ['dishes', 'extras']) {\n    if (!Array.isArray(body[coll])) continue;\n    const badIcon = body[coll].filter((d) => d && d.reward_icon !== undefined && !REWARD_ICONS.includes(d.reward_icon));\n    if (badIcon.length) problems.push(`${badIcon.length} ${coll} record(s) carry a reward_icon outside the closed set`);\n  }\n  if (problems.length) {\n",
  "was": "  for (const f of undeclared) problems.push(`${f} is served but undeclared`);\n  if (problems.length) {\n"
 },
 {
  "file": "catalog/public-menu.js",
  "now": "// diff by eye, and an operator comparing two responses is a real thing that happens).\nconst CARRIED_FROM_STRUCTURE = Object.freeze(['extras_by_category', 'extras_by_item', 'badges', 'badge_priority']);\n\n// PLAN 4 r3 gap resolution (A, advisor 2026-10-26) — THE ONE COMPOSER of a menu's catalog fields: the generator's bundle +\n// the fields CARRIED from the structure. buildPublicMenu serves it (then adds eligibility, photos and identity), and the\n// committed form bundle is composed by it too (generate-form-bundle.mjs, tools/splice-form-bundle.js, the 1c gates) — so the\n// bundle a form carries before a bake has exactly the shape the bake writes, and there is no second projection.\nfunction composeServedMenu(restaurantId, menu, generate = generateFormBundle) {\n  const body = generate(restaurantId, menu);\n  for (const f of CARRIED_FROM_STRUCTURE) {\n    if (menu.structure[f] !== undefined) body[f] = menu.structure[f];\n  }\n  return body;\n}\n\n",
  "was": "// diff by eye, and an operator comparing two responses is a real thing that happens).\nconst CARRIED_FROM_STRUCTURE = Object.freeze(['extras_by_category', 'extras_by_item', 'badges']);\n\n"
 },
 {
  "file": "catalog/public-menu.js",
  "now": "  try {\n    body = composeServedMenu(restaurantId, menu, generate);\n    if (menu.eligibility) body.extras_eligibility = menu.eligibility;\n",
  "was": "  try {\n    body = generate(restaurantId, menu);\n    for (const f of CARRIED_FROM_STRUCTURE) {\n      if (menu.structure[f] !== undefined) body[f] = menu.structure[f];\n    }\n    if (menu.eligibility) body.extras_eligibility = menu.eligibility;\n"
 },
 {
  "file": "catalog/public-menu.js",
  "now": "     exactly the menu served today, because in D1 nothing reads them. */\n  // PLAN 4 r3 §4: the reconciler compares the DEPLOYED bundle (baked, overlay-free) with the published menu read with\n  // `overlayIdentity: false` — the same body minus the overlay. Every other caller (the endpoint) gets the overlay, unchanged.\n  const enriched = deps.overlayIdentity === false ? { body, applied: true } : await applyIdentityToServedBody(db, restaurantId, body);\n  body = enriched.body;\n",
  "was": "     exactly the menu served today, because in D1 nothing reads them. */\n  const enriched = await applyIdentityToServedBody(db, restaurantId, body);\n  body = enriched.body;\n"
 },
 {
  "file": "catalog/public-menu.js",
  "now": "\nmodule.exports = { buildPublicMenu, composeServedMenu, CARRIED_FROM_STRUCTURE, defaultIsActive, assertWholeBody, publicMenuErrorResponse, REPRESENTATION_VERSION, PUBLIC_MENU_BODY_FIELDS, BODY_CONTRACT };\n",
  "was": "\nmodule.exports = { buildPublicMenu, defaultIsActive, assertWholeBody, publicMenuErrorResponse, REPRESENTATION_VERSION, PUBLIC_MENU_BODY_FIELDS, BODY_CONTRACT };\n"
 }
]);

function unapplyFormbakeModule(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`formbake-module-inverse: ${file}: a plan-4 hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
module.exports = { HUNKS, FILES, unapplyFormbakeModule };
