'use strict';
// S2-core (PLAN-structure-S2core-r3 §2.2) — THE consumer projection of the extras exposure: one effective, ordered list of extras
// GROUPS per sellable dish, expressed in the two legacy maps so BOTH readers render it exactly:
//   forms  (form-group-picker.js offeredExtraGroups): byCategory[cat] THEN byItem[String(id)] || byItem[name], first appearance wins
//   capp   (capp-menu.js extrasFor):                  byCategory[cat] THEN byItem[String(id)] (display id only), groups only
// Per category: one common list on the category (when non-empty) and, per dish, only what follows it in the one group order; a
// category whose dishes cannot be written that way carries no category entry and every dish its COMPLETE list. A dish whose
// extras_policy is 'none' renders empty in both readers already (forms noExtras; capp via the eligibility deny) and takes no part.
// Keys are display ids (both readers try them first); values are group names. Typed per-extra denies stay in the eligibility doc.
// PURE.
const { projectEligibility } = require('./extras-eligibility');

const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

// itemKey → the ordered list of groups it is offered, or null when it is offered nothing by policy (the eligibleExtras group level)
function effectiveGroups(proj) {
  const out = {};
  for (const [k, it] of Object.entries(proj.items)) {
    const owner = it.launcherKey && proj.items[it.launcherKey] ? it.launcherKey : k;
    if (proj.items[owner].policy === 'none') { out[k] = null; continue; }
    const legacyKey = (own(proj.add, k) || own(proj.denyLegacy, k)) ? k : (it.launcherKey || k);
    const dn = proj.denyLegacy[legacyKey] || { cats: [], keys: [], all: false };
    if (dn.all) { out[k] = null; continue; }
    const ad = proj.add[legacyKey] || { cats: [], keys: [] };
    const allowed = new Set([...(proj.categoryAllow[it.cat] || []), ...ad.cats]);
    out[k] = proj.extraCategories.filter((c) => allowed.has(c) && !dn.cats.includes(c));
  }
  return out;
}

function projectExtrasMaps({ items, extras, structure }) {
  const proj = projectEligibility({ items, extras, structure });
  const E = effectiveGroups(proj);
  const idOf = new Map(items.map((i) => [i.key, String(i.display && i.display.id)]));
  const rank = new Map(proj.extraCategories.map((c, i) => [c, i]));
  // categories in today's order: the authored category_allow keys first, then any other category a dish carries
  const cats = [...Object.keys(proj.categoryAllow)];
  const members = new Map();
  for (const [k, it] of Object.entries(proj.items)) {
    if (E[k] === null) continue;
    if (!members.has(it.cat)) members.set(it.cat, []);
    members.get(it.cat).push(k);
    if (!cats.includes(it.cat)) cats.push(it.cat);
  }
  const byCategory = {}; const byItem = {};
  for (const cat of cats) {
    const ks = members.get(cat) || [];
    if (!ks.length) continue;
    const lists = ks.map((k) => E[k]);
    let common = lists[0].slice();
    for (const l of lists) { let i = 0; while (i < common.length && i < l.length && common[i] === l[i]) i++; common = common.slice(0, i); }
    const last = common.length ? rank.get(common[common.length - 1]) : -1;
    const suffixOk = lists.every((l) => l.slice(common.length).every((g) => rank.get(g) > last));
    if (suffixOk) {
      if (common.length) byCategory[cat] = common;
      for (const k of ks) { const rest = E[k].slice(common.length); if (rest.length) byItem[idOf.get(k)] = rest; }
    } else {
      for (const k of ks) if (E[k].length) byItem[idOf.get(k)] = E[k].slice();
    }
  }
  // byItem in the menu's item order (today's object order)
  const order = (structure && structure.item_order) || items.map((i) => i.key);
  const sorted = {};
  for (const k of order) { const id = idOf.get(k); if (id !== undefined && own(byItem, id)) sorted[id] = byItem[id]; }
  for (const id of Object.keys(byItem)) if (!own(sorted, id)) sorted[id] = byItem[id];
  return { byCategory, byItem: sorted };
}

// §2.3 — the ONE group order: extra_order group-major in extra_categories order (stable: each group's extras keep their relative order;
// an extra whose group is not listed keeps its place after the listed groups). On today's sources it is today's extra_order.
function groupMajorOrder(order, extras, groups) {
  if (!Array.isArray(order) || !Array.isArray(groups)) return order;
  const catOf = new Map((extras || []).map((e) => [e.key, e && e.display && e.display.cat]));
  const rank = new Map(groups.map((g, i) => [g, i]));
  const r = (k) => (rank.has(catOf.get(k)) ? rank.get(catOf.get(k)) : groups.length);
  return order.map((k, i) => [k, i]).sort((a, b) => r(a[0]) - r(b[0]) || a[1] - b[1]).map(([k]) => k);
}

module.exports = { projectExtrasMaps, effectiveGroups, groupMajorOrder };
