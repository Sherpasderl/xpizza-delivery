'use strict';
// PER-PRODUCT EXTRAS, stage 2 — the slice's INVERSE for the MODULES older slices pin byte-for-byte
// (catalog/identity-integrity-guards: catalog-publish.js and source-store.js by sha; catalog/context-guards: catalog-publish.js
// minus its delimited c2a / pb1 blocks; catalog/identity-record-guards: menu-pricing.js — the shared extraPricingKey resolver). Those guards apply unapplyExtrasModule FIRST (newest first), so any byte outside these
// exact hunks still fails them. extras-wiring.guard.test.js proves this inverse reproduces 537bbbc for each file byte-for-byte.
// Generated from `git diff -U1 537bbbc` (portal-choices/stage2/gen-module-inverse.py, CTX=1 — one context line keeps every hunk
// free of a flipPointer call, which catalog/publish-paths forbids outside catalog-publish.js); each `now` occurs exactly once.
const HUNKS = Object.freeze([
 {
  "file": "catalog/catalog-publish.js",
  "now": "const { readVersionDocs } = require('./catalog-firestore');\nconst { buildEligibilityDoc } = require('./extras-eligibility-store');   // per-product extras: the version's eligibility doc\nconst { contentHash } = require('./content-hash');\n",
  "was": "const { readVersionDocs } = require('./catalog-firestore');\nconst { contentHash } = require('./content-hash');\n"
 },
 {
  "file": "catalog/catalog-publish.js",
  "now": "  ops.push((b) => b.create(vref.collection('meta').doc('menu_structure'), structure));\n  // per-product extras (PLAN rev 2.1 §4/§7): the version's ELIGIBILITY document, from the very docs written above, in the\n  // same commit. Derived data — not part of content_hash; a structurally impossible source fails the publish here.\n  const eligibilityDoc = buildEligibilityDoc({\n    items: itemDocs.map((d) => ({ key: d.key, price: d.price, display: d.display })),\n    extras: extraDocs.map((d) => ({ key: d.key, price: d.price, display: d.display })),\n    structure,\n  });\n  ops.push((b) => b.create(vref.collection('meta').doc('extras_eligibility'), eligibilityDoc));\n  await commitOps(db, ops);\n",
  "was": "  ops.push((b) => b.create(vref.collection('meta').doc('menu_structure'), structure));\n  await commitOps(db, ops);\n"
 },
 {
  "file": "catalog/catalog-publish.js",
  "now": "// ROLLBACK — a single atomic pointer flip to a RETAINED prior version. Verify it exists + verifies first.\nasync function rollbackVersion(db, rid, targetVersionId, { mirror, alarm, expected, readExtrasMode } = {}) {\n  const token = await acquireLease(db, rid);\n",
  "was": "// ROLLBACK — a single atomic pointer flip to a RETAINED prior version. Verify it exists + verifies first.\nasync function rollbackVersion(db, rid, targetVersionId, { mirror, alarm, expected } = {}) {\n  const token = await acquireLease(db, rid);\n"
 },
 {
  "file": "catalog/catalog-publish.js",
  "now": "    await verifyVersionStructure(db, rid, targetVersionId);\n    // per-product extras §4: never a pre-baseline target while non-off — judged only once the target is known to EXIST and\n    // verify (a missing / torn target keeps its own refusal), and before the pointer moves\n    await require('./extras-rollback').assertRollbackTargetEligible(db, rid, targetVersionId, readExtrasMode);\n    const snapshot = snapshotOf(rid, targetVersionId, seq, menuTable, extraTable);\n",
  "was": "    await verifyVersionStructure(db, rid, targetVersionId);\n    const snapshot = snapshotOf(rid, targetVersionId, seq, menuTable, extraTable);\n"
 },
 {
  "file": "catalog/catalog-publish.js",
  "now": "  ops.push((b) => b.delete(vref.collection('meta').doc('menu_structure')));\n  ops.push((b) => b.delete(vref.collection('meta').doc('extras_eligibility')));   // per-product extras: deleted with its version\n  ops.push((b) => b.delete(vref));\n",
  "was": "  ops.push((b) => b.delete(vref.collection('meta').doc('menu_structure')));\n  ops.push((b) => b.delete(vref));\n"
 },
 {
  "file": "catalog/source-store.js",
  "now": "const { ALL: EXPOSURE_ALL } = require('./extras-exposure');\nconst EXPOSURE_OVERRIDE_FIELDS = new Set(['deny', 'add', 'deny_extras']);   // per-product extras: + the typed, key-only exclusions\n\n",
  "was": "const { ALL: EXPOSURE_ALL } = require('./extras-exposure');\n\n"
 },
 {
  "file": "catalog/source-store.js",
  "now": "    }\n    // per-product extras (PLAN rev 2.1 §2/§3): a VARIANT never carries its own typed exclusions — its launcher's list governs\n    // the whole group — so the variant keys are known before the overrides are read\n    const variantKeys = new Set(source.items.filter((it) => it && it.display && it.display.variantOf !== undefined && it.display.variantOf !== null).map((it) => it.key));\n    for (const [key, ov] of Object.entries(exposure.item_overrides || {})) {\n",
  "was": "    }\n    for (const [key, ov] of Object.entries(exposure.item_overrides || {})) {\n"
 },
 {
  "file": "catalog/source-store.js",
  "now": "      if (ov && typeof ov === 'object' && !Array.isArray(ov)\n        && !Object.prototype.hasOwnProperty.call(ov, 'deny') && !Object.prototype.hasOwnProperty.call(ov, 'add')\n        && !Object.prototype.hasOwnProperty.call(ov, 'deny_extras')) {\n        fail(`${rid}/${key} — an exposure override must deny, add or deny_extras something`);\n      }\n      // the override's fields are exactly these three: an unknown one is an instruction nothing carries out\n      if (ov && typeof ov === 'object' && !Array.isArray(ov)) {\n        for (const f of Object.keys(ov)) if (!EXPOSURE_OVERRIDE_FIELDS.has(f)) fail(`${rid}/${key} — exposure override has an unknown field ${f}`);\n      }\n      // TYPED, KEY-ONLY exclusions (§2, codex r3 P2-2): entries resolve EXCLUSIVELY as existing extra keys — category\n      // selectors and the '*' sentinel are unsupported; a key spelled like a category is still a key and never expands\n      const typed = ov && ov.deny_extras;\n      if (typed !== undefined) {\n        checkField(typed, { required: true, type: 'string_array', unique: true, nonEmpty: true }, `${rid}/${key}`, 'exposure deny_extras');\n        for (const v of typed) {\n          if (!extraKeys.has(v)) fail(`${rid}/${key} — deny_extras references ${v}, which is not an existing extra key (category selectors and ${EXPOSURE_ALL} are not supported here)`);\n        }\n        if (variantKeys.has(key)) fail(`${rid}/${key} — deny_extras on a variant: its launcher's list governs the whole group`);\n      }\n",
  "was": "      if (ov && typeof ov === 'object' && !Array.isArray(ov)\n        && !Object.prototype.hasOwnProperty.call(ov, 'deny') && !Object.prototype.hasOwnProperty.call(ov, 'add')) {\n        fail(`${rid}/${key} — an exposure override must deny or add something`);\n      }\n"
 },
 {
  "file": "catalog/source-store.js",
  "now": "          }\n          // per-product extras (§2): a legacy entry naming BOTH an extra-category and an extra key is ambiguous — it would\n          // reach the whole category while reading like one extra (none exist today; the gate-0 audit found none). The typed\n          // deny_extras says \"this extra\" unambiguously.\n          if (extraCatSet.has(v) && extraKeys.has(v)) {\n            fail(`${rid}/${key} — exposure ${side} ${v} names both an extra-category and an extra key (ambiguous); use deny_extras for the one extra`);\n          }\n        }\n",
  "was": "          }\n        }\n"
 },
 {
  "file": "menu-pricing.js",
  "now": "\n// The extra-side twin of itemPricingKey — the SINGLE source of truth for which key an order line's extra is priced by\n// (x_pizza → extra.name, la_musa → extra.id; the line's other field is IGNORED). computeServerTotal and summaryLines read\n// the extra's key THROUGH this, and so does the per-product extras eligibility check (catalog/extras-intake.js): an extra\n// is judged by exactly the key it is charged by, so a forged id beside a real name can never be judged as one extra and\n// charged as another.\nfunction extraPricingKey(ex, restaurantId) {\n  return restaurantId === 'la_musa' ? (ex && ex.id) : (ex && ex.name);\n}\n\n// Phase 1b-1 — resolve WHICH price tables price this order. Omitting `tables` keeps today's exact\n",
  "was": "\n// Phase 1b-1 — resolve WHICH price tables price this order. Omitting `tables` keeps today's exact\n"
 },
 {
  "file": "menu-pricing.js",
  "now": "      if (byId) {  // la_musa — id-keyed, qty-aware, standalone (independent of dish qty)\n        const eid = extraPricingKey(ex, restaurantId);\n        if (!eid || !Object.prototype.hasOwnProperty.call(extraPrices, eid)) {\n",
  "was": "      if (byId) {  // la_musa — id-keyed, qty-aware, standalone (independent of dish qty)\n        const eid = ex && ex.id;\n        if (!eid || !Object.prototype.hasOwnProperty.call(extraPrices, eid)) {\n"
 },
 {
  "file": "menu-pricing.js",
  "now": "      } else {  // x_pizza — original name-keyed / count-once logic, verbatim\n        const ename = extraPricingKey(ex, restaurantId);\n        if (!ename || !Object.prototype.hasOwnProperty.call(extraPrices, ename)) {\n",
  "was": "      } else {  // x_pizza — original name-keyed / count-once logic, verbatim\n        const ename = ex && ex.name;\n        if (!ename || !Object.prototype.hasOwnProperty.call(extraPrices, ename)) {\n"
 },
 {
  "file": "menu-pricing.js",
  "now": "      if (byId) {\n        const eid = extraPricingKey(ex, restaurantId);\n        if (!eid || !Object.prototype.hasOwnProperty.call(extraPrices, eid)) return null;\n",
  "was": "      if (byId) {\n        const eid = ex && ex.id;\n        if (!eid || !Object.prototype.hasOwnProperty.call(extraPrices, eid)) return null;\n"
 },
 {
  "file": "menu-pricing.js",
  "now": "      } else {\n        const ename = extraPricingKey(ex, restaurantId);\n        if (!ename || !Object.prototype.hasOwnProperty.call(extraPrices, ename)) return null;\n",
  "was": "      } else {\n        const ename = ex && ex.name;\n        if (!ename || !Object.prototype.hasOwnProperty.call(extraPrices, ename)) return null;\n"
 },
 {
  "file": "menu-pricing.js",
  "now": "module.exports = { PRICING_KEY_STAMP,\n  MENU_BY_RESTAURANT, EXTRA_PRICES, EXTRAS_BY_RESTAURANT, computeServerTotal, itemPricingKey, extraPricingKey, summaryLines,\n  resolvePriceTables,   // 1b-1b: the shared PIN-B-asserting table resolver, reused across the redemption graph\n",
  "was": "module.exports = { PRICING_KEY_STAMP,\n  MENU_BY_RESTAURANT, EXTRA_PRICES, EXTRAS_BY_RESTAURANT, computeServerTotal, itemPricingKey, summaryLines,\n  resolvePriceTables,   // 1b-1b: the shared PIN-B-asserting table resolver, reused across the redemption graph\n"
 }
]);

function unapplyExtrasModule(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`extras-module-inverse: ${file}: an extras hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
module.exports = { HUNKS, FILES, unapplyExtrasModule };
