'use strict';
// PER-PRODUCT EXTRAS, stage 2 — the slice's INVERSE for the MODULES older slices pin byte-for-byte
// (catalog/identity-integrity-guards: catalog-publish.js and source-store.js by sha; catalog/context-guards: catalog-publish.js
// minus its delimited c2a / pb1 blocks). Those guards apply unapplyExtrasModule FIRST (newest first), so any byte outside these
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
