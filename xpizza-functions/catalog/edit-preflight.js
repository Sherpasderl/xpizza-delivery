'use strict';
// S2-1/2/3 (D4c-grill/item-s1/S2-DESIGN.md §1.2 + §2 r1 E/F; advisor rulings 2026-11-10) — THE EDIT PREFLIGHT. One ordered pass
// over a draft against the LIVE version, run with the item_text_edit switch ON by the save (before validateSource) and by the
// publish (before ITS validateSource), so both answer the same FIRST refusal, field-tagged for the drawer:
//   1 a name in the minted-key syntax            name_previously_used
//   2 empty name · length · unsafe text          name_required · name_too_long / option_name_too_long / desc_too_long · text_unsafe
//   3 another product's or option's name         name_taken
//   4 a frozen / registry / reserved key          name_previously_used
//   5 a section's subsection coverage            subcat_invalid
//   6 a section / subsection left empty          section_emptied · subsection_emptied
//   7 a section the order page does not show     category_not_renderable
// Only values that DIFFER from the live version are judged (unchanged ones are grandfathered); lengths are Unicode code
// points. Text safety is the validator's own per-field rule (catalog/display-safety.js): the ATTRIBUTE rule for names (no
// quotes, no angle brackets, literal or encoded), the BODY rule for descriptions. Coverage and emptiness are catalog/move-rules.js
// (held equal to validateSource by its parity guard). EVERY refusal is attributed the same way: `key` = the product the drawer
// edits — an option's LAUNCHER — with `option_key` = the option when the value is a derived option name; `field` = the drawer field.
// (Placed in its own module, not catalog/add-product.js, which may require nothing; the safety rule is required here directly.)
const AP = require('./add-product');
const RK = require('./reserved-keys');
const FK = require('./frozen-keys');
const MR = require('./move-rules');
const { checkValue, FIELD_SINKS } = require('./display-safety');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);

// the attribution every producer shares
function attributor(draft) {
  const items = (draft && Array.isArray(draft.items) ? draft.items : []).filter((it) => isObj(it) && isObj(it.display));
  const byId = new Map(items.filter((it) => it.display.id != null).map((it) => [String(it.display.id), it]));
  const byKey = new Map(items.filter((it) => typeof it.key === 'string').map((it) => [it.key, it]));
  const idOf = (it) => (own(it, 'ref') ? it.ref : it.key);
  return (keyOrItem, field, error, extra = {}) => {
    const it = isObj(keyOrItem) ? keyOrItem : byKey.get(keyOrItem) || items.find((x) => x.ref === keyOrItem);
    const launcher = it && AP.isGroupVariant(it) ? byId.get(String(it.display.variantOf)) : null;
    const textField = field === 'choice' ? 'name' : field;
    if (launcher) return { error, key: idOf(launcher), field: textField, option_key: idOf(it), ...extra };
    return { error, key: it ? idOf(it) : keyOrItem, field: textField, ...extra };
  };
}

/* editPreflight({ draft, live, reservedSet, registryTaken, mint, renderedCategories }) → null | { status, body }
   draft: the source being saved or published (options already re-derived); live: the ACTIVE built version ({ items, structure });
   reservedSet: the restaurant's reserved-key Map (reserved-keys.reservedKeySet); registryTaken: the Set of renamed labels the
   identity registry already holds (the caller reads it); mint: the minting switch. Pure. */
function editPreflight({ draft, live, reservedSet = new Map(), registryTaken = new Set(), mint = false, renderedCategories = [] }) {
  const at = attributor(draft);
  const liveItems = (live && Array.isArray(live.items) ? live.items : []).filter((it) => isObj(it) && isObj(it.display));
  const liveByKey = new Map(liveItems.map((it) => [it.key, it]));
  const items = (draft && Array.isArray(draft.items) ? draft.items : []).filter((it) => isObj(it) && isObj(it.display));
  const wasOf = (it) => (typeof it.key === 'string' && !own(it, 'ref') ? liveByKey.get(it.key) : null);
  const bad = (status, body) => ({ status, body });

  // 1 · the minted-key syntax (additions and renames, own key included)
  { const op = RK.opaqueNameProblems({ items, activeItems: liveItems })[0]; if (op) return bad(400, at(op.key || op.ref, 'name', 'name_previously_used')); }

  // 2 · empty name, length, unsafe text — newly authored values only
  const caps = AP.textCapProblems({ draft, live: { items: liveItems }, mint });
  for (const it of items) {
    const was = wasOf(it); const d = it.display;
    if (typeof d.name === 'string' && (!was || was.display.name !== d.name)) {
      if (!AP.tidyName(d.name)) return bad(400, at(it, 'name', 'name_required'));
      const cap = caps.find((c) => (c.key === it.key || c.key === it.ref) && (c.code === 'name_too_long' || c.code === 'option_name_too_long'));
      if (cap) return bad(400, at(it, 'name', cap.code));
      if (checkValue(AP.tidyName(d.name), FIELD_SINKS.item.name)) return bad(400, at(it, 'name', 'text_unsafe'));
    }
    if (typeof d.desc === 'string' && (!was || was.display.desc !== d.desc)) {
      if (caps.find((c) => (c.key === it.key || c.key === it.ref) && c.code === 'desc_too_long')) return bad(400, at(it, 'desc', 'desc_too_long'));
      if (checkValue(d.desc, FIELD_SINKS.item.desc)) return bad(400, at(it, 'desc', 'text_unsafe'));
    }
  }
  // 3 · another product's or option's name
  { const t = caps.find((c) => c.code === 'name_taken'); if (t) return bad(400, at(t.key, t.field, 'name_taken')); }
  // 4 · a frozen, registry or reserved key (each record's OWN key exempt, normalized)
  { const f = caps.find((c) => c.code === 'name_previously_used'); if (f) return bad(400, at(f.key, f.field, 'name_previously_used')); }
  { const hit = FK.renamedLabels({ draft, live: { items: liveItems } }).find((x) => registryTaken.has(x.name) && AP.normalizeName(x.key) !== AP.normalizeName(x.name)); if (hit) return bad(400, at(hit.key, 'name', 'name_previously_used')); }
  { const rc = RK.renameConflicts({ items, activeItems: liveItems, reserved: reservedSet })[0]; if (rc) return bad(400, at(rc.key, 'name', 'name_previously_used')); }

  // 5 · subsection coverage of every product whose section or subsection changed
  const cats = draft && draft.structure && draft.structure.categories;
  const moved = items.filter((it) => { const was = wasOf(it); return !was || was.display.cat !== it.display.cat || (was.display.subcat == null ? null : was.display.subcat) !== (it.display.subcat == null ? null : it.display.subcat); });
  for (const it of moved) if (MR.coverageProblem(cats, it)) return bad(400, at(it, 'subcat', 'subcat_invalid'));

  // 6 · a section or subsection the live version filled and the draft leaves empty
  const liveCats = new Set(liveItems.map((it) => it.display.cat));
  const liveSubs = new Set(liveItems.map((it) => `${it.display.cat}\u0000${it.display.subcat}`));
  for (const e of MR.emptinessProblems(cats, items)) {
    if (e.reason === 'section_empty' && liveCats.has(e.cat)) {
      const mover = items.find((it) => { const was = wasOf(it); return was && was.display.cat === e.cat; });
      return bad(400, at(mover || e.cat, 'cat', 'section_emptied'));
    }
    if (e.reason === 'subsection_empty' && liveSubs.has(`${e.cat}\u0000${e.sub}`)) {
      const mover = items.find((it) => { const was = wasOf(it); return was && was.display.cat === e.cat && was.display.subcat === e.sub; });
      return bad(400, at(mover || e.cat, mover && mover.display.cat === e.cat ? 'subcat' : 'cat', 'subsection_emptied'));
    }
  }

  // 7 · a section the order page does not show (a changed section only)
  for (const it of moved) {
    const was = wasOf(it);
    if (was && was.display.cat !== it.display.cat && !(renderedCategories || []).includes(it.display.cat)) return bad(400, at(it, 'cat', 'category_not_renderable'));
  }
  return null;
}

/* The I/O wrapper both handlers call: reads the identity registry for the renamed labels and the reserved-key set through the
   add-product io, then runs the pure pass. A read error is a retryable 503, never a pass. */
async function runEditPreflight({ rid, draft, live, addProduct, mint, renderedCategories }) {
  const rn = FK.renamedLabels({ draft, live });
  let registryTaken = new Set(); let reservedSet = new Map();
  if (rn.length) {
    if (!addProduct) return { status: 503, body: { error: 'add_product_unavailable', retryable: false } };
    try { registryTaken = await addProduct.registryKeysTaken(rid, rn.map((x) => x.name), 'name'); } catch (_) { return { status: 503, body: { error: 'store_unavailable', retryable: true } }; }
    try { reservedSet = await addProduct.readReservedKeys(rid); } catch (_) { return { status: 503, body: { error: 'store_unavailable', retryable: true } }; }
  }
  return editPreflight({ draft, live, reservedSet, registryTaken, mint, renderedCategories });
}

module.exports = { editPreflight, runEditPreflight, attributor };
