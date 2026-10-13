'use strict';
// PER-PRODUCT EXTRAS, stage 2 — the slice's INVERSE for the MODULES older slices pin byte-for-byte
// (catalog/identity-integrity-guards: catalog-publish.js and source-store.js by sha; catalog/context-guards: catalog-publish.js
// minus its delimited c2a / pb1 blocks; catalog/identity-record-guards: menu-pricing.js — the shared extraPricingKey resolver). Those guards apply unapplyExtrasModule FIRST (newest first), so any byte outside these
// exact hunks still fails them. extras-wiring.guard.test.js proves this inverse reproduces 537bbbc for each file byte-for-byte.
// Generated from `git diff -U3 537bbbc` (portal-choices/stage2/gen-module-inverse.py); each `now` occurs exactly once.
const HUNKS = Object.freeze([
 {
  "file": "catalog/catalog-publish.js",
  "now": "/* pb1-key-overlap:begin */ const { docId: overlapDocId } = require('./seed-catalog-core'); /* pb1-key-overlap:end */\nconst { integrityDescriptor } = require('./catalog-integrity');\nconst { readVersionDocs } = require('./catalog-firestore');\nconst { buildEligibilityDoc } = require('./extras-eligibility-store');   // per-product extras: the version's eligibility doc\nconst { contentHash } = require('./content-hash');\nconst { readVersionMenu } = require('./catalog-menu');\nconst { ensureIdentitiesForKeys } = require('./identity-backfill');\n",
  "was": "/* pb1-key-overlap:begin */ const { docId: overlapDocId } = require('./seed-catalog-core'); /* pb1-key-overlap:end */\nconst { integrityDescriptor } = require('./catalog-integrity');\nconst { readVersionDocs } = require('./catalog-firestore');\nconst { contentHash } = require('./content-hash');\nconst { readVersionMenu } = require('./catalog-menu');\nconst { ensureIdentitiesForKeys } = require('./identity-backfill');\n"
 },
 {
  "file": "catalog/catalog-publish.js",
  "now": "    ...(d.has_photo !== undefined ? { has_photo: d.has_photo } : {}),\n  }));\n  ops.push((b) => b.create(vref.collection('meta').doc('menu_structure'), structure));\n  // per-product extras (PLAN rev 2.1 §4/§7): the version's ELIGIBILITY document, from the very docs written above, in the\n  // same commit. Derived data — not part of content_hash; a structurally impossible source fails the publish here.\n  const eligibilityDoc = buildEligibilityDoc({\n    items: itemDocs.map((d) => ({ key: d.key, price: d.price, display: d.display })),\n    extras: extraDocs.map((d) => ({ key: d.key, price: d.price, display: d.display })),\n    structure,\n  });\n  ops.push((b) => b.create(vref.collection('meta').doc('extras_eligibility'), eligibilityDoc));\n  await commitOps(db, ops);\n  // 🔴 HASHED OVER WHAT WAS WRITTEN, IN SERVED ORDER — not over the caller's inputs. The reader\n  // recomputes this from the docs it reads BACK, so the two only agree if what landed in Firestore is\n",
  "was": "    ...(d.has_photo !== undefined ? { has_photo: d.has_photo } : {}),\n  }));\n  ops.push((b) => b.create(vref.collection('meta').doc('menu_structure'), structure));\n  await commitOps(db, ops);\n  // 🔴 HASHED OVER WHAT WAS WRITTEN, IN SERVED ORDER — not over the caller's inputs. The reader\n  // recomputes this from the docs it reads BACK, so the two only agree if what landed in Firestore is\n"
 },
 {
  "file": "catalog/catalog-publish.js",
  "now": "}\n\n// ROLLBACK — a single atomic pointer flip to a RETAINED prior version. Verify it exists + verifies first.\nasync function rollbackVersion(db, rid, targetVersionId, { mirror, alarm, expected, readExtrasMode } = {}) {\n  const token = await acquireLease(db, rid);\n  try {\n    await require('./extras-rollback').assertRollbackTargetEligible(db, rid, targetVersionId, readExtrasMode);   // per-product extras §4: never a pre-baseline target while non-off\n    // 1b: reuse the verify read's tables to re-emit the snapshot + mirror. A rollback that moved the\n    // pointer without re-emitting would leave the fallback describing the version we just rolled AWAY\n    // from — the fallback must always describe whatever is actually live.\n",
  "was": "}\n\n// ROLLBACK — a single atomic pointer flip to a RETAINED prior version. Verify it exists + verifies first.\nasync function rollbackVersion(db, rid, targetVersionId, { mirror, alarm, expected } = {}) {\n  const token = await acquireLease(db, rid);\n  try {\n    // 1b: reuse the verify read's tables to re-emit the snapshot + mirror. A rollback that moved the\n    // pointer without re-emitting would leave the fallback describing the version we just rolled AWAY\n    // from — the fallback must always describe whatever is actually live.\n"
 },
 {
  "file": "catalog/catalog-publish.js",
  "now": "  items.forEach((d) => ops.push((b) => b.delete(d.ref)));\n  extras.forEach((d) => ops.push((b) => b.delete(d.ref)));\n  ops.push((b) => b.delete(vref.collection('meta').doc('menu_structure')));\n  ops.push((b) => b.delete(vref.collection('meta').doc('extras_eligibility')));   // per-product extras: deleted with its version\n  ops.push((b) => b.delete(vref));\n  await commitOps(db, ops);\n}\n",
  "was": "  items.forEach((d) => ops.push((b) => b.delete(d.ref)));\n  extras.forEach((d) => ops.push((b) => b.delete(d.ref)));\n  ops.push((b) => b.delete(vref.collection('meta').doc('menu_structure')));\n  ops.push((b) => b.delete(vref));\n  await commitOps(db, ops);\n}\n"
 },
 {
  "file": "catalog/source-store.js",
  "now": "// importer keeps working and there is still exactly one definition.\nconst { extrasKeyOf } = require('./form-menu-source');\nconst { ALL: EXPOSURE_ALL } = require('./extras-exposure');\nconst EXPOSURE_OVERRIDE_FIELDS = new Set(['deny', 'add', 'deny_extras']);   // per-product extras: + the typed, key-only exclusions\n\n// The code-path literals this schema covers. The completeness test asserts every literal the code\n// path reads appears here — so a future code-only field cannot silently become uneditable in 2b.\n",
  "was": "// importer keeps working and there is still exactly one definition.\nconst { extrasKeyOf } = require('./form-menu-source');\nconst { ALL: EXPOSURE_ALL } = require('./extras-exposure');\n\n// The code-path literals this schema covers. The completeness test asserts every literal the code\n// path reads appears here — so a future code-only field cannot silently become uneditable in 2b.\n"
 },
 {
  "file": "catalog/source-store.js",
  "now": "        if (!extraCatSet.has(v)) fail(`${rid} — structure.exposure.category_allow.${cat} references ${v}, which is not a declared extra-category`);\n      }\n    }\n    // per-product extras (PLAN rev 2.1 §2/§3): a VARIANT never carries its own typed exclusions — its launcher's list governs\n    // the whole group — so the variant keys are known before the overrides are read\n    const variantKeys = new Set(source.items.filter((it) => it && it.display && it.display.variantOf !== undefined && it.display.variantOf !== null).map((it) => it.key));\n    for (const [key, ov] of Object.entries(exposure.item_overrides || {})) {\n      if (!seen.has(key)) fail(`${rid} — structure.exposure.item_overrides references unknown item ${key}`);\n      checkField(ov, { required: true, type: 'object' }, `${rid}/${key}`, 'exposure override');\n      // An override that says nothing is a no-op someone believed was doing something.\n      if (ov && typeof ov === 'object' && !Array.isArray(ov)\n        && !Object.prototype.hasOwnProperty.call(ov, 'deny') && !Object.prototype.hasOwnProperty.call(ov, 'add')\n        && !Object.prototype.hasOwnProperty.call(ov, 'deny_extras')) {\n        fail(`${rid}/${key} — an exposure override must deny, add or deny_extras something`);\n      }\n      // the override's fields are exactly these three: an unknown one is an instruction nothing carries out\n      if (ov && typeof ov === 'object' && !Array.isArray(ov)) {\n        for (const f of Object.keys(ov)) if (!EXPOSURE_OVERRIDE_FIELDS.has(f)) fail(`${rid}/${key} — exposure override has an unknown field ${f}`);\n      }\n      // TYPED, KEY-ONLY exclusions (§2, codex r3 P2-2): entries resolve EXCLUSIVELY as existing extra keys — category\n      // selectors and the '*' sentinel are unsupported; a key spelled like a category is still a key and never expands\n      const typed = ov && ov.deny_extras;\n      if (typed !== undefined) {\n        checkField(typed, { required: true, type: 'string_array', unique: true, nonEmpty: true }, `${rid}/${key}`, 'exposure deny_extras');\n        for (const v of typed) {\n          if (!extraKeys.has(v)) fail(`${rid}/${key} — deny_extras references ${v}, which is not an existing extra key (category selectors and ${EXPOSURE_ALL} are not supported here)`);\n        }\n        if (variantKeys.has(key)) fail(`${rid}/${key} — deny_extras on a variant: its launcher's list governs the whole group`);\n      }\n      for (const side of ['deny', 'add']) {\n        const list = ov && ov[side];\n",
  "was": "        if (!extraCatSet.has(v)) fail(`${rid} — structure.exposure.category_allow.${cat} references ${v}, which is not a declared extra-category`);\n      }\n    }\n    for (const [key, ov] of Object.entries(exposure.item_overrides || {})) {\n      if (!seen.has(key)) fail(`${rid} — structure.exposure.item_overrides references unknown item ${key}`);\n      checkField(ov, { required: true, type: 'object' }, `${rid}/${key}`, 'exposure override');\n      // An override that says nothing is a no-op someone believed was doing something.\n      if (ov && typeof ov === 'object' && !Array.isArray(ov)\n        && !Object.prototype.hasOwnProperty.call(ov, 'deny') && !Object.prototype.hasOwnProperty.call(ov, 'add')) {\n        fail(`${rid}/${key} — an exposure override must deny or add something`);\n      }\n      for (const side of ['deny', 'add']) {\n        const list = ov && ov[side];\n"
 },
 {
  "file": "catalog/source-store.js",
  "now": "          if (!extraCatSet.has(v) && !extraKeys.has(v)) {\n            fail(`${rid}/${key} — exposure ${side} references ${v}, which is neither a declared extra-category nor a known extra`);\n          }\n          // per-product extras (§2): a legacy entry naming BOTH an extra-category and an extra key is ambiguous — it would\n          // reach the whole category while reading like one extra (none exist today; the gate-0 audit found none). The typed\n          // deny_extras says \"this extra\" unambiguously.\n          if (extraCatSet.has(v) && extraKeys.has(v)) {\n            fail(`${rid}/${key} — exposure ${side} ${v} names both an extra-category and an extra key (ambiguous); use deny_extras for the one extra`);\n          }\n        }\n      }\n    }\n",
  "was": "          if (!extraCatSet.has(v) && !extraKeys.has(v)) {\n            fail(`${rid}/${key} — exposure ${side} references ${v}, which is neither a declared extra-category nor a known extra`);\n          }\n        }\n      }\n    }\n"
 },
 {
  "file": "menu-pricing.js",
  "now": "  return raw;\n}\n\n// The extra-side twin of itemPricingKey — the SINGLE source of truth for which key an order line's extra is priced by\n// (x_pizza → extra.name, la_musa → extra.id; the line's other field is IGNORED). computeServerTotal and summaryLines read\n// the extra's key THROUGH this, and so does the per-product extras eligibility check (catalog/extras-intake.js): an extra\n// is judged by exactly the key it is charged by, so a forged id beside a real name can never be judged as one extra and\n// charged as another.\nfunction extraPricingKey(ex, restaurantId) {\n  return restaurantId === 'la_musa' ? (ex && ex.id) : (ex && ex.name);\n}\n\n// Phase 1b-1 — resolve WHICH price tables price this order. Omitting `tables` keeps today's exact\n// behaviour (the in-code tables — the frozen fallback ONLY). Post-2a EVERY money caller passes the\n// SAME guarded catalog tables: the order total, the redemption cluster (1b-1b), AND the fiscal\n",
  "was": "  return raw;\n}\n\n// Phase 1b-1 — resolve WHICH price tables price this order. Omitting `tables` keeps today's exact\n// behaviour (the in-code tables — the frozen fallback ONLY). Post-2a EVERY money caller passes the\n// SAME guarded catalog tables: the order total, the redemption cluster (1b-1b), AND the fiscal\n"
 },
 {
  "file": "menu-pricing.js",
  "now": "    const seenExtraIds = byId ? new Set() : null;\n    for (const ex of extras) {\n      if (byId) {  // la_musa — id-keyed, qty-aware, standalone (independent of dish qty)\n        const eid = extraPricingKey(ex, restaurantId);\n        if (!eid || !Object.prototype.hasOwnProperty.call(extraPrices, eid)) {\n          return { total: NaN, error: `unknown extra: ${String(eid).slice(0, 40)}` };\n        }\n",
  "was": "    const seenExtraIds = byId ? new Set() : null;\n    for (const ex of extras) {\n      if (byId) {  // la_musa — id-keyed, qty-aware, standalone (independent of dish qty)\n        const eid = ex && ex.id;\n        if (!eid || !Object.prototype.hasOwnProperty.call(extraPrices, eid)) {\n          return { total: NaN, error: `unknown extra: ${String(eid).slice(0, 40)}` };\n        }\n"
 },
 {
  "file": "menu-pricing.js",
  "now": "        }\n        total += eprice * eqty;            // server table only — client ex.price ignored\n      } else {  // x_pizza — original name-keyed / count-once logic, verbatim\n        const ename = extraPricingKey(ex, restaurantId);\n        if (!ename || !Object.prototype.hasOwnProperty.call(extraPrices, ename)) {\n          return { total: NaN, error: `unknown extra: ${String(ename).slice(0, 40)}` };\n        }\n",
  "was": "        }\n        total += eprice * eqty;            // server table only — client ex.price ignored\n      } else {  // x_pizza — original name-keyed / count-once logic, verbatim\n        const ename = ex && ex.name;\n        if (!ename || !Object.prototype.hasOwnProperty.call(extraPrices, ename)) {\n          return { total: NaN, error: `unknown extra: ${String(ename).slice(0, 40)}` };\n        }\n"
 },
 {
  "file": "menu-pricing.js",
  "now": "    const seen = byId ? new Set() : null;\n    for (const ex of extras) {\n      if (byId) {\n        const eid = extraPricingKey(ex, restaurantId);\n        if (!eid || !Object.prototype.hasOwnProperty.call(extraPrices, eid)) return null;\n        if (seen.has(eid)) return null; seen.add(eid);\n        const eqty = Number(ex && ex.qty);\n",
  "was": "    const seen = byId ? new Set() : null;\n    for (const ex of extras) {\n      if (byId) {\n        const eid = ex && ex.id;\n        if (!eid || !Object.prototype.hasOwnProperty.call(extraPrices, eid)) return null;\n        if (seen.has(eid)) return null; seen.add(eid);\n        const eqty = Number(ex && ex.qty);\n"
 },
 {
  "file": "menu-pricing.js",
  "now": "        if (!isValidPrice(extraPrices[eid])) return null;                 // 1d-1a: same rule, null convention\n        lineL += extraPrices[eid] * eqty;\n      } else {\n        const ename = extraPricingKey(ex, restaurantId);\n        if (!ename || !Object.prototype.hasOwnProperty.call(extraPrices, ename)) return null;\n        if (!isValidPrice(extraPrices[ename])) return null;               // 1d-1a: same rule, null convention\n        lineL += extraPrices[ename];\n",
  "was": "        if (!isValidPrice(extraPrices[eid])) return null;                 // 1d-1a: same rule, null convention\n        lineL += extraPrices[eid] * eqty;\n      } else {\n        const ename = ex && ex.name;\n        if (!ename || !Object.prototype.hasOwnProperty.call(extraPrices, ename)) return null;\n        if (!isValidPrice(extraPrices[ename])) return null;               // 1d-1a: same rule, null convention\n        lineL += extraPrices[ename];\n"
 },
 {
  "file": "menu-pricing.js",
  "now": "}\n\nmodule.exports = { PRICING_KEY_STAMP,\n  MENU_BY_RESTAURANT, EXTRA_PRICES, EXTRAS_BY_RESTAURANT, computeServerTotal, itemPricingKey, extraPricingKey, summaryLines,\n  resolvePriceTables,   // 1b-1b: the shared PIN-B-asserting table resolver, reused across the redemption graph\n  X_PIZZA_WEEKEND_ONLY, hnDayFromMs, weekendOnlyViolation,\n};\n",
  "was": "}\n\nmodule.exports = { PRICING_KEY_STAMP,\n  MENU_BY_RESTAURANT, EXTRA_PRICES, EXTRAS_BY_RESTAURANT, computeServerTotal, itemPricingKey, summaryLines,\n  resolvePriceTables,   // 1b-1b: the shared PIN-B-asserting table resolver, reused across the redemption graph\n  X_PIZZA_WEEKEND_ONLY, hnDayFromMs, weekendOnlyViolation,\n};\n"
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
