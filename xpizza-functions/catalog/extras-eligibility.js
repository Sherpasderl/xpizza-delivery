'use strict';
// PER-PRODUCT EXTRAS — THE ONE ELIGIBILITY EVALUATOR (PLAN-per-product-extras rev 2.1, codex-approved).
//
// Which extras a customer may add to an item, in PRICING KEYS end to end (§1): the item's `key` and the extra's `key`
// (x_pizza: names; la_musa: id slugs). Display ids (x_pizza `e1`, numeric dish ids; `display.variantOf`) are translated
// to pricing keys HERE, once, and appear nowhere in the result. catalog/extras-exposure.js `resolveExposure` (display-id
// preferring, display-only by its own header) is NOT this; nothing that decides eligibility may call it.
//
//   eligibleExtras(item) = ( extras whose category is in categoryAllow[item.cat] ∪ legacy add.cats,
//                            ∪ legacy add.keys )
//                          − legacy deny (keys and categories, as today; '*' = nothing)
//                          − deny_extras of the item's POLICY OWNER   (typed, key-only — §2)
//                          = ∅ when the policy owner's extras_policy is 'none'
//   policy owner (§3, launcher-canonical): a variant's launcher, else the item itself. A variant's own deny_extras /
//   extras_policy are never read (save/publish refuse them when they differ). LEGACY overrides keep today's rule: an
//   item's own, or — for a variant with none — its launcher's.
//
// The PUBLIC map is the complement of this, DENSE (§7, codex r3 P2-1): an entry for EVERY item, `[]` when unrestricted:
//   publicDeny[item] = allExtraKeys − eligibleExtras(item)
//
// Pure; same bytes run anywhere Node runs. Nothing here reads a price: eligibility is never arithmetic.

const ALL = '*';
const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const asArray = (v) => (Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]));

// source -> the normalized, pricing-keyed projection. Throws on a structurally impossible reference (a variantOf that
// names no item) — eligibility must never be computed against a guess.
function projectEligibility(source) {
  const items = Array.isArray(source && source.items) ? source.items : [];
  const extras = Array.isArray(source && source.extras) ? source.extras : [];
  const structure = (source && source.structure) || {};
  const exposure = structure.exposure || {};
  const extraCategories = Array.isArray(structure.extra_categories) ? structure.extra_categories.map(String) : [...new Set(extras.map((e) => String(e.display && e.display.cat)))];

  // item display id -> item key (variantOf names the launcher by DISPLAY id)
  const keyByItemDisplayId = new Map();
  for (const it of items) if (it && it.display && it.display.id !== undefined && typeof it.key === 'string') keyByItemDisplayId.set(String(it.display.id), it.key);
  // extra display id -> extra key, so a legacy rule written in either spelling resolves to the pricing key
  const extraKeys = [];
  const extraCat = {};
  const extraKeyByDisplayId = new Map();
  for (const e of extras) {
    if (!e || typeof e.key !== 'string') continue;
    extraKeys.push(e.key);
    extraCat[e.key] = String(e.display && e.display.cat);
    if (e.display && e.display.id !== undefined) extraKeyByDisplayId.set(String(e.display.id), e.key);
  }
  const extraKeySet = new Set(extraKeys);
  const catSet = new Set(extraCategories);
  // a legacy selector: a category (checked FIRST, as resolveExposure does for `add`), an extra key, or an extra display id
  const legacySel = (v, out) => {
    const s = String(v);
    if (s === ALL) { out.all = true; return; }
    if (catSet.has(s)) out.cats.push(s);
    if (extraKeySet.has(s)) out.keys.push(s);
    else if (extraKeyByDisplayId.has(s)) out.keys.push(extraKeyByDisplayId.get(s));
  };

  const projItems = {};
  for (const it of items) {
    if (!it || typeof it.key !== 'string') continue;
    const d = it.display || {};
    let launcherKey = null;
    if (own(d, 'variantOf') && d.variantOf !== null && d.variantOf !== undefined) {
      launcherKey = keyByItemDisplayId.get(String(d.variantOf)) || null;
      if (!launcherKey) throw new Error(`extras-eligibility: ${it.key} names launcher ${String(d.variantOf)}, which is no item`);
    }
    projItems[it.key] = { cat: String(d.cat), policy: d.extras_policy === 'none' ? 'none' : null, launcherKey };
  }

  const add = {};
  const denyLegacy = {};
  const denyExtras = {};
  const overrides = (exposure && exposure.item_overrides) || {};
  for (const [itemKey, ov] of Object.entries(overrides)) {
    if (!ov || typeof ov !== 'object') continue;
    // legacy ADD resolves exactly as resolveExposure's: a category if it names one, otherwise a single extra
    if (own(ov, 'add')) {
      const a = { cats: [], keys: [] };
      for (const v of asArray(ov.add)) {
        const sv = String(v);
        if (catSet.has(sv)) a.cats.push(sv);
        else if (extraKeySet.has(sv)) a.keys.push(sv);
        else if (extraKeyByDisplayId.has(sv)) a.keys.push(extraKeyByDisplayId.get(sv));
      }
      add[itemKey] = a;
    }
    if (own(ov, 'deny')) { const dn = { cats: [], keys: [], all: false }; asArray(ov.deny).forEach((v) => legacySel(v, dn)); denyLegacy[itemKey] = dn; }
    // §2: TYPED, key-only — an entry resolves EXCLUSIVELY as an existing extra key; never a category, never '*'
    if (own(ov, 'deny_extras')) denyExtras[itemKey] = asArray(ov.deny_extras).map(String).filter((k) => extraKeySet.has(k));
  }
  const categoryAllow = {};
  for (const [cat, allow] of Object.entries((exposure && exposure.category_allow) || {})) categoryAllow[cat] = asArray(allow).map(String);

  return { version: 1, items: projItems, extraKeys, extraCat, extraCategories, categoryAllow, add, denyLegacy, denyExtras };
}

// projection, itemKey -> ordered array of eligible extra keys (extra-category order, then extras order).
function eligibleExtras(proj, itemKey) {
  const it = proj.items[itemKey];
  if (!it) return [];
  const owner = it.launcherKey && proj.items[it.launcherKey] ? it.launcherKey : itemKey;
  if (proj.items[owner].policy === 'none') return [];
  // legacy overrides: the item's own, or — for a variant that declares none — its launcher's (today's rule)
  const hasOwn = own(proj.add, itemKey) || own(proj.denyLegacy, itemKey);
  const legacyKey = hasOwn ? itemKey : (it.launcherKey || itemKey);
  const dn = proj.denyLegacy[legacyKey] || { cats: [], keys: [], all: false };
  if (dn.all) return [];
  const ad = proj.add[legacyKey] || { cats: [], keys: [] };
  const allowedCats = new Set([...(proj.categoryAllow[it.cat] || []), ...ad.cats]);
  const allowedKeys = new Set(ad.keys);
  const typed = new Set(proj.denyExtras[owner] || []);
  const out = [];
  for (const cat of proj.extraCategories) {
    for (const k of proj.extraKeys) {
      if (proj.extraCat[k] !== cat) continue;
      if (!(allowedCats.has(cat) || allowedKeys.has(k))) continue;
      if (dn.keys.includes(k) || dn.cats.includes(cat)) continue;   // legacy deny: key AND category, as today
      if (typed.has(k)) continue;                                   // typed deny_extras: the KEY only
      out.push(k);
    }
  }
  return out;
}

// The public, DENSE complement: { itemKey: [extraKey…] } for EVERY item, `[]` when unrestricted (§7).
function publicDeny(proj) {
  const out = {};
  for (const itemKey of Object.keys(proj.items)) {
    const ok = new Set(eligibleExtras(proj, itemKey));
    out[itemKey] = proj.extraKeys.filter((k) => !ok.has(k));
  }
  return out;
}

module.exports = { projectEligibility, eligibleExtras, publicDeny, ALL };
