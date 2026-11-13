'use strict';
// S2-core (PLAN-structure-S2core-r3 §3.2, §3.3) — THE Extras-page writer. Every group / extra op is a transition on the
// EFFECTIVE exposure — eff(d), the groups dish d is offered (the eligibleExtras group level; an option's owner is its launcher) —
// that writes the minimal source change and then normalizes. The portal sends the draft this produces; the server never
// auto-edits (a residual reference refuses at save: validateSource). Pure; never mutates its input.
//   attach.item(d, G)  G leaves d's deny (and every single-extra deny of G's extras); if G is still not offered, d's add gains G;
//                      d's deny_extras loses G's extras — an attached group starts ALL CHECKED (detach → reattach restores it)
//   detach.item(d, G)  G (and every single-extra add of G's extras) leaves d's add; if G is still offered, d's deny gains G;
//                      d's deny_extras loses G's extras (moot while detached; reattach starts all checked)
//   attach.cat(C, G)   category_allow[C] gains G; every dish of C loses G from its deny and G's extras from its deny_extras
//   group.create       { group, extras: [{ ref, name, price }…] (≥ 1), attach: { mode: 'cat', cat } | { mode: 'items', items } |
//                      { mode: 'none' } } — appended to the one group order; the extras go in as the allocator's input
//   group.order        { order } — a permutation of extra_categories; extra_order (when authored) re-derived group-major (§2.3)
//   extra.add          { group, ref, name, price }
//   extra.rename       { key, name } — S2b: the display name only (the key kept); judged server-side (the name rules, the dark switch)
//   extra.remove       { key } | { ref } — the row, its extra_order entry, every exposure reference, its redeem_eligible_extras
//                      entry; returns its identity for the reviewed deletion claim (none for a never-published addition)
// Normalization (touched entries only — untouched legacy data stays byte for byte): empty add / deny / deny_extras arrays go;
// an override left with none of them and nothing else goes (source-store :456); lists follow the one group order. Options never
// get overrides of their own; an existing option-level override (legacy) blocks S2 ops on its launcher: exposure_option_override.
// UMD-lite (the extras-eligibility.js pattern): CommonJS here, a global in the portal's classic script — the SAME bytes write the
// draft in the portal and are proven here (tools/sync-client.js writes the copy). Its own function scope: classic scripts share
// one global lexical scope, and extras-eligibility.js (loaded first) already declares `own`.

(function (root) {
  const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
  const EE = () => (typeof module !== 'undefined' && module.exports ? require('./extras-eligibility') : globalThis.ExtrasEligibility);
  const fail = (code, message, detail) => { throw Object.assign(new Error(message), { code, detail: detail || {} }); };
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

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

  // §2.3 — the ONE group order: extra_order group-major in extra_categories order (stable: each group's extras keep their relative order;
  // an extra whose group is not listed keeps its place after the listed groups). On today's sources it is today's extra_order.
  function groupMajorOrder(order, extras, groups) {
    if (!Array.isArray(order) || !Array.isArray(groups)) return order;
    const catOf = new Map((extras || []).map((e) => [e.key, e && e.display && e.display.cat]));
    const rank = new Map(groups.map((g, i) => [g, i]));
    const r = (k) => (rank.has(catOf.get(k)) ? rank.get(catOf.get(k)) : groups.length);
    return order.map((k, i) => [k, i]).sort((a, b) => r(a[0]) - r(b[0]) || a[1] - b[1]).map(([k]) => k);
  }

  function apply(input, op) {
    const s = JSON.parse(JSON.stringify(input));
    if (!isObj(op)) fail('unknown_op', 'no op');
    s.structure = s.structure || {};
    const st = s.structure;
    s.extras = Array.isArray(s.extras) ? s.extras : [];
    const groups = () => (Array.isArray(st.extra_categories) ? st.extra_categories : []);
    const exposure = () => { st.exposure = st.exposure || {}; return st.exposure; };
    const hadOverrides = own(st.exposure, 'item_overrides');
    const overrides = () => { const x = exposure(); x.item_overrides = x.item_overrides || {}; return x.item_overrides; };
    const touched = new Set(); const touchedCats = new Set();
    const proj = () => EE().projectEligibility(s);
    const groupOfEntry = (v) => { const sv = String(v); if (groups().includes(sv)) return sv; const e = s.extras.find((x) => x.key === sv || (x.display && String(x.display.id) === sv)); return e ? String(e.display.cat) : null; };
    const extrasOf = (G) => s.extras.filter((e) => e.display && e.display.cat === G);
    const isExtraOf = (v, G) => !groups().includes(String(v)) && extrasOf(G).some((e) => e.key === String(v) || String(e.display.id) === String(v));
    const needGroup = (G) => { if (typeof G !== 'string' || !groups().includes(G)) fail('unknown_group', `no extras group ${JSON.stringify(G)}`, { group: G }); };
    // the exposure owner of an item: its launcher (options never carry overrides of their own)
    const ownerOf = (k) => {
      const p = proj();
      if (!own(p.items, k)) fail('unknown_item', `no product ${JSON.stringify(k)}`, { item: k });
      const o = p.items[k].launcherKey || k;
      const ovs = (st.exposure && st.exposure.item_overrides) || {};
      const optionWithOwn = Object.keys(p.items).find((x) => p.items[x].launcherKey === o && own(ovs, x));
      if (optionWithOwn) fail('exposure_option_override', `the option ${optionWithOwn} carries its own extras rule; edit it before changing this product's groups`, { item: optionWithOwn });
      return o;
    };
    const editOv = (k, fn) => { const ovs = overrides(); const o = isObj(ovs[k]) ? ovs[k] : {}; ovs[k] = o; fn(o); touched.add(k); };
    const dropFrom = (o, field, pred) => { if (Array.isArray(o[field])) o[field] = o[field].filter((v) => !pred(v)); };

    const attachItem = (k, G) => {
      const d = ownerOf(k);
      if (effectiveGroups(proj())[d] === null) fail('exposure_dish_no_extras', `${d} offers no extras («Sin extras»)`, { item: d });
      editOv(d, (o) => { dropFrom(o, 'deny', (v) => String(v) === G || isExtraOf(v, G)); dropFrom(o, 'deny_extras', (v) => isExtraOf(v, G)); });
      if (!effectiveGroups(proj())[d].includes(G)) editOv(d, (o) => { o.add = [...(Array.isArray(o.add) ? o.add : o.add != null ? [o.add] : []), G]; });
    };
    const detachItem = (k, G) => {
      const d = ownerOf(k);
      editOv(d, (o) => { dropFrom(o, 'add', (v) => String(v) === G || isExtraOf(v, G)); dropFrom(o, 'deny_extras', (v) => isExtraOf(v, G)); });
      const g = effectiveGroups(proj())[d];
      if (g && g.includes(G)) editOv(d, (o) => { o.deny = [...(Array.isArray(o.deny) ? o.deny : o.deny != null ? [o.deny] : []), G]; });
    };
    const attachCat = (C, G) => {
      const p = proj();
      const dishes = Object.keys(p.items).filter((k) => p.items[k].cat === String(C));
      if (!dishes.length) fail('unknown_category', `no product category ${JSON.stringify(C)}`, { cat: C });
      for (const k of dishes) if (!p.items[k].launcherKey) ownerOf(k);
      const ex = exposure(); ex.category_allow = ex.category_allow || {}; const ca = ex.category_allow;
      const cur = Array.isArray(ca[C]) ? ca[C] : [];
      if (!cur.includes(G)) ca[C] = [...cur, G];
      touchedCats.add(C);
      const ovs = (st.exposure && st.exposure.item_overrides) || {};
      for (const k of dishes) if (own(ovs, k)) editOv(k, (o) => { dropFrom(o, 'deny', (v) => String(v) === G || isExtraOf(v, G)); dropFrom(o, 'deny_extras', (v) => isExtraOf(v, G)); });
    };
    const newExtra = (G, e) => {
      if (!isObj(e)) fail('addition_malformed', 'a new extra needs a temporary reference, a name and a price', { field: 'extras' });
      return { ref: e.ref, price: e.price, display: { name: e.name, cat: G, price: e.price } };
    };

    let deletedIds = [];
    switch (op.op) {
      case 'attach.item': needGroup(op.group); attachItem(op.item, op.group); break;
      case 'detach.item': needGroup(op.group); detachItem(op.item, op.group); break;
      case 'attach.cat': needGroup(op.group); attachCat(op.cat, op.group); break;
      case 'group.create': {
        const G = op.group;
        if (typeof G !== 'string' || !G.trim()) fail('addition_malformed', 'a new group needs a name', { field: 'group' });
        if (groups().includes(G)) fail('group_name_taken', `«${G}» is already a group`, { field: 'group' });
        if (!Array.isArray(op.extras) || !op.extras.length) fail('extras_group_empty', 'a new group needs at least one option', { field: 'extras' });
        st.extra_categories = [...groups(), G];
        for (const e of op.extras) s.extras.push(newExtra(G, e));
        const a = op.attach || {};
        if (a.mode === 'cat') attachCat(a.cat, G);
        else if (a.mode === 'items') { if (!Array.isArray(a.items) || !a.items.length) fail('addition_malformed', 'choose at least one product', { field: 'attach' }); for (const k of a.items) attachItem(k, G); }
        else if (a.mode !== 'none') fail('addition_malformed', 'choose where the group is offered', { field: 'attach' });
        break;
      }
      case 'group.order': {
        const cur = groups();
        if (!Array.isArray(op.order) || op.order.length !== cur.length || [...op.order].sort().join('\u0000') !== [...cur].sort().join('\u0000')) fail('structure_changed', 'the group order must list every group once', { field: 'extra_categories' });
        st.extra_categories = op.order.slice();
        if (Array.isArray(st.extra_order)) st.extra_order = groupMajorOrder(st.extra_order, s.extras, st.extra_categories);
        break;
      }
      case 'extra.add': needGroup(op.group); s.extras.push(newExtra(op.group, op)); break;
      case 'extra.rename': {   // S2b (PLAN-structure-S2b-r3 §0): the display name only — the key, the display id, the group and the price are kept
        const x = s.extras.find((e) => e.key === op.key);
        if (!x) fail('unknown_extra', `no option ${JSON.stringify(op.key)}`, { key: op.key });
        if (typeof op.name !== 'string' || !op.name.trim()) fail('addition_malformed', 'an option needs a name', { key: op.key, field: 'name' });
        x.display = { ...x.display, name: op.name };
        break;
      }
      case 'extra.remove': {
        const i = s.extras.findIndex((e) => (op.key !== undefined ? e.key === op.key : (typeof e.key !== 'string' && e.ref === op.ref)));
        if (i < 0) fail('unknown_extra', `no option ${JSON.stringify(op.key !== undefined ? op.key : op.ref)}`, { key: op.key, ref: op.ref });
        const x = s.extras[i];
        const G = x.display && x.display.cat;
        if (extrasOf(G).length === 1) fail('extras_group_empty', `the group ${JSON.stringify(G)} would be left with no options`, { field: 'extras' });
        if (typeof x.key === 'string') {
          const id = x.display && x.display.id !== undefined ? String(x.display.id) : null;
          const refers = (v) => String(v) === x.key || (id !== null && String(v) === id);
          const ovs = (st.exposure && st.exposure.item_overrides) || {};
          for (const k of Object.keys(ovs)) {
            const o = ovs[k];
            if (!isObj(o)) continue;
            if (['add', 'deny', 'deny_extras'].some((f) => Array.isArray(o[f]) && o[f].some(refers))) editOv(k, (oo) => { dropFrom(oo, 'add', refers); dropFrom(oo, 'deny', refers); dropFrom(oo, 'deny_extras', (v) => String(v) === x.key); });
          }
          if (Array.isArray(st.extra_order)) st.extra_order = st.extra_order.filter((k) => k !== x.key);
          if (Array.isArray(st.redeem_eligible_extras)) st.redeem_eligible_extras = st.redeem_eligible_extras.filter((k) => k !== x.key);
          if (x.display && x.display.identity_id) deletedIds = [x.display.identity_id];
        }
        s.extras.splice(i, 1);
        break;
      }
      default: fail('unknown_op', `unknown op ${JSON.stringify(op.op)}`);
    }

    // normalization — touched entries only
    const rank = (v) => { const g = groupOfEntry(v); const i = g === null ? -1 : groups().indexOf(g); return i < 0 ? groups().length : i; };
    const byRank = (arr) => arr.map((v, i) => [v, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([v]) => v);
    const extraIdx = new Map(s.extras.map((e, i) => [e.key, i]));
    for (const C of touchedCats) st.exposure.category_allow[C] = byRank(st.exposure.category_allow[C]);
    const ovs = (st.exposure && st.exposure.item_overrides) || {};
    for (const k of touched) {
      const o = ovs[k];
      for (const f of ['add', 'deny']) if (Array.isArray(o[f])) { o[f] = byRank(o[f]); if (!o[f].length) delete o[f]; }
      if (Array.isArray(o.deny_extras)) { o.deny_extras = o.deny_extras.slice().sort((a, b) => (extraIdx.get(a) ?? 1e9) - (extraIdx.get(b) ?? 1e9)); if (!o.deny_extras.length) delete o.deny_extras; }
      if (!Object.keys(o).length) delete ovs[k];
    }
    if (st.exposure && own(st.exposure, 'item_overrides') && !hadOverrides && !Object.keys(st.exposure.item_overrides).length) delete st.exposure.item_overrides;
    return { source: s, deletedIds };
  }

  const api = { apply, effectiveGroups, groupMajorOrder };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ExposureTransitions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
