// Customer app S1 (PLAN-capp-S1.FINAL §1, §2, §4) — the MENU ADAPTER: the served getPublicMenu envelope
// { rid, representation_version, menu: { dishes, extras, categories, variant_items?, extras_by_category?, extras_by_item?,
//   extras_eligibility?, pickup_only_cats?, weekend_only_cats?, … } } → the renderer's model. Pure, UMD, brand-agnostic: every
// difference between restaurants is DATA (no restaurant id or name in this file — guarded).
//
// A dish is keyed by its served dish_id (else its own served id). Its legacy pricing fields (`id`, `name`) are kept verbatim so
// the serializer can send BOTH and the server's own rule picks (menu-pricing.js itemPricingKey). An extra is SUPPORTED only when
// it carries no quantity semantics (S1 is toggles only); an unsupported extra is never offered.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappMenu = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const QTY_FIELDS = ['max_qty', 'qty', 'step', 'min'];
  // an extra label carrying a grammar / reader delimiter (',' driver, '|' groups, '+' extras, '[' ']' brackets) would make two
  // different configurations read — and content-key — the same; such an extra is never offered (capp-serialize refuses it too)
  const LABEL_UNSAFE = /[,|+[\]]/;
  // S1 = toggles only: `max` absent or exactly 1, and none of the other quantity fields
  function extraSupported(ex) {
    if (!ex || typeof ex !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(ex, 'max') && ex.max !== 1) return false;
    return !QTY_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(ex, f));
  }
  const keyOf = (rec) => (rec && rec.dish_id != null && rec.dish_id !== '' ? String(rec.dish_id) : String(rec && rec.id));
  const extraKeyOf = (rec) => (rec && rec.extra_id != null && rec.extra_id !== '' ? String(rec.extra_id) : String(rec && rec.id));
  const list = (v) => (Array.isArray(v) ? v : []);
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

  function adaptMenu(envelope) {
    if (!envelope || typeof envelope !== 'object' || !envelope.menu || typeof envelope.menu !== 'object') throw new Error('capp-menu: no menu in the envelope');
    const m = envelope.menu;
    const extras = list(m.extras).map((e) => Object.freeze({ key: extraKeyOf(e), id: e.id, name: String(e.name || ''), extra_id: e.extra_id, price: Number(e.price),
      cat: e.cat, supported: extraSupported(e) && !LABEL_UNSAFE.test(String(e.name || '')) }));
    const extraByKey = new Map(extras.map((e) => [e.key, e]));
    const variants = obj(m.variant_items);
    const choiceOf = new Map();
    for (const [launcherId, g] of Object.entries(variants)) for (const vid of list(g && g.variantIds)) choiceOf.set(String(vid), String(launcherId));
    const dishes = list(m.dishes).map((d) => {
      const isLauncher = Object.prototype.hasOwnProperty.call(variants, String(d.id));
      return Object.freeze({ key: keyOf(d), id: d.id, name: String(d.name || ''), dish_id: d.dish_id, price: Number(d.price), cat: d.cat, desc: d.desc || '',
        img: d.img || null, tags: list(d.tags), launcher: isLauncher, variantOf: d.variantOf != null ? String(d.variantOf) : (choiceOf.get(String(d.id)) || null),
        choice: d.choice || null });
    });
    const dishByKey = new Map(dishes.map((d) => [d.key, d]));
    const dishById = new Map(dishes.map((d) => [String(d.id), d]));
    const byCat = obj(m.extras_by_category); const byItem = obj(m.extras_by_item);
    const deny = obj(obj(m.extras_eligibility).deny);
    // the extras a dish may carry: its category's extra categories UNIONED with its per-item ones (category first — the shipped
    // forms' extrasCatsForItem), minus the version's eligibility deny list. The deny list is keyed by the brand's legacy keys,
    // so BOTH of the dish's legacy fields and BOTH of each extra's are matched.
    function extrasFor(dishKey) {
      const d = dishByKey.get(String(dishKey));
      if (!d) return [];
      const fromCat = list(byCat[String(d.cat)]); const seen = new Set(fromCat);
      const cats = [...fromCat, ...list(byItem[String(d.id)]).filter((c) => !seen.has(c))];
      const denied = new Set([...list(deny[String(d.id)]), ...list(deny[d.name])].map(String));
      return extras.filter((e) => cats.includes(e.cat) && !denied.has(String(e.id)) && !denied.has(e.name));
    }
    const groups = {};
    for (const [launcherId, g] of Object.entries(variants)) {
      const launcher = dishById.get(String(launcherId));
      if (!launcher) continue;
      groups[launcher.key] = Object.freeze({ label: String((g && g.label) || ''), basePrice: Number(g && g.basePrice),
        choices: list(g && g.variantIds).map((v) => dishById.get(String(v))).filter(Boolean).map((c) => c.key) });
    }
    return Object.freeze({
      rid: envelope.rid, representation_version: envelope.representation_version,
      dishes, extras, categories: list(m.categories).map((c) => Object.freeze({ id: c.id, name: c.name != null ? String(c.name) : null })),
      dish: (k) => dishByKey.get(String(k)) || null, extra: (k) => extraByKey.get(String(k)) || null, extrasFor,
      groups: Object.freeze(groups), pickupOnlyCats: new Set(list(m.pickup_only_cats).map(String)), weekendOnlyCats: new Set(list(m.weekend_only_cats).map(String)),
      badges: obj(m.badges), hasPhoto: new Set(list(m.has_photo).map(String)),
    });
  }

  return { adaptMenu, extraSupported, LABEL_UNSAFE };
});
