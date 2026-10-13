#!/usr/bin/env node
'use strict';
// PER-PRODUCT EXTRAS — GATE 0, the BASELINE AUDIT (PLAN rev 2.1 §2, §3, §13). READ-ONLY: it reads a catalog source (a JSON file,
// or a brand's code-seeded source) and reports, in pricing keys, every rule that the per-product checklist must account for
// before any restriction becomes authoritative:
//   • retained LEGACY rules — `deny` by category / key / '*' (they can suppress a FUTURE extra; §2's promise is qualified by
//     them, and any that contradict the intended checklist must be migrated in the baseline publish);
//   • legacy `add` rules (category or key) — part of a product's baseline set;
//   • VARIANT-level overrides — the launcher-canonical rule (§3) changes how they combine; each must be shown before build;
//   • extras_policy:'none' items, and policy disagreements inside a group;
//   • NAMESPACE collisions — an extra key spelled like an extra-category (legal; typed deny_extras never expands it, but a
//     legacy selector with that spelling is ambiguous);
//   • eligibility per item from the one evaluator, and any variant whose set differs from its launcher's.
//
// Usage:  node tools/extras-baseline-audit.js --rid x_pizza                    (the code-seeded source)
//         node tools/extras-baseline-audit.js --rid la_musa --source live.json  (a source exported read-only from the store)
// Prints one JSON report; exits 0. It never writes anything.
const fs = require('fs');
const { projectEligibility, eligibleExtras } = require('../catalog/extras-eligibility');

function audit(source) {
  const proj = projectEligibility(source);
  const ov = (source.structure && source.structure.exposure && source.structure.exposure.item_overrides) || {};
  const cats = new Set(proj.extraCategories);
  const report = { items: Object.keys(proj.items).length, extras: proj.extraKeys.length, legacyDeny: [], legacyAdd: [], typedDeny: [],
    variantOverrides: [], policyNone: [], groupPolicyMismatch: [], keyCategoryCollisions: [], ambiguousLegacySelectors: [], variantSetDiffers: [] };
  for (const [k, o] of Object.entries(ov)) {
    if (!o || typeof o !== 'object') continue;
    if (o.deny !== undefined) report.legacyDeny.push({ item: k, deny: o.deny });
    if (o.add !== undefined) report.legacyAdd.push({ item: k, add: o.add });
    if (o.deny_extras !== undefined) report.typedDeny.push({ item: k, deny_extras: o.deny_extras });
    if (proj.items[k] && proj.items[k].launcherKey) report.variantOverrides.push({ variant: k, launcher: proj.items[k].launcherKey, override: o });
    for (const sel of [...(Array.isArray(o.deny) ? o.deny : []), ...(Array.isArray(o.add) ? o.add : [])]) {
      if (cats.has(String(sel)) && proj.extraKeys.includes(String(sel))) report.ambiguousLegacySelectors.push({ item: k, selector: sel });
    }
  }
  for (const k of proj.extraKeys) if (cats.has(k)) report.keyCategoryCollisions.push(k);
  for (const [k, it] of Object.entries(proj.items)) {
    if (it.policy === 'none') report.policyNone.push(k);
    if (it.launcherKey) {
      const L = proj.items[it.launcherKey];
      if (L && (L.policy || null) !== (it.policy || null)) report.groupPolicyMismatch.push({ variant: k, launcher: it.launcherKey });
      if (JSON.stringify(eligibleExtras(proj, k)) !== JSON.stringify(eligibleExtras(proj, it.launcherKey))) report.variantSetDiffers.push({ variant: k, launcher: it.launcherKey });
    }
  }
  report.eligibility = Object.fromEntries(Object.keys(proj.items).map((k) => [k, eligibleExtras(proj, k)]));
  report.migrationNeeded = report.legacyDeny.filter((d) => (Array.isArray(d.deny) ? d.deny : [d.deny]).includes('*')).map((d) => ({ item: d.item, from: "deny:['*']", to: "extras_policy:'none'" }));
  return report;
}

module.exports = { audit };

if (require.main === module) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
  const rid = arg('--rid'); const file = arg('--source');
  if (!rid && !file) { console.error('usage: node tools/extras-baseline-audit.js --rid <rid> [--source <source.json>]'); process.exit(2); }
  const source = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : require('./seed-source-store').buildSourceFromCode(rid);
  const r = audit(source);
  process.stdout.write(`${JSON.stringify({ rid: rid || null, source: file || 'code-seeded', ...r }, null, 2)}\n`);
}
