'use strict';
// S2-core (PLAN-structure-S2core-r3 §1.6) — THE ONE canonical review diff. The save (edit-catalog-handler), the owner publish
// (publish-edited-handler) and the manager request (publish-request) all bind their token to reviewDiff(); none folds its own.
//   = catalogDiff (with the photo lines when wired) + the extras consequences (UNGATED; while item_text_edit is ON — prod — this is
//     exactly today's fold, a cell proves it) and, ONLY when an S2 op is present under the extrasCatalog switch:
//       · extras are never paired as renames (an extra cannot be renamed in S2-core: a different key is a different extra)
//       · extras: [{ key, name, group, price, change: 'added' | 'removed' | 'repriced' }]
//       · structure: { extra_categories: { old, new } } when the group order / set changed
//       · fiscal: { added: [{ surface, key, name, price }], repriced: [{ surface, key, name, old, new }] } — the seal, no duplicates
//       · attachments: [{ group, scope: 'category' | 'item', target, change: 'attached' | 'detached' }] — the authored transitions
//       · reach: { [group]: N } — the sellable products (a launcher once) each changed group is offered to in the draft
//   Without an S2 op the diff object is today's, byte for byte, so every token issued before the deploy verifies after it.
// An S2 op is present when an extra is added or removed, the group order / set changed, a category's group list changed, or a dish's
// group add / deny changed (attach / detach). An S1 edit (a dish's unticked extras, «Sin extras») and an ordinary section move are not
// S2 ops: today's edit, today's diff. Pure.
const { catalogDiff } = require('./catalog-edit');
const { withConsequences } = require('./extras-consequences');
const { canonicalize } = require('./source-store');
const { projectEligibility } = require('./extras-eligibility');
const { effectiveGroups } = require('./exposure-transitions');

const same = (a, b) => JSON.stringify(canonicalize(a === undefined ? null : a)) === JSON.stringify(canonicalize(b === undefined ? null : b));

// a dish that left the draft (the live menu has it, the draft has neither the dish nor an override for it): its override's removal is that
// removal's own cleanup (compareToActive judges the removal itself — declared or existing_item_removed), never an attach / detach
const leftWithDish = (k, dov, live, draftBuilt) => !Object.prototype.hasOwnProperty.call(dov, k) && (live.items || []).some((i) => i && i.key === k) && !(draftBuilt.items || []).some((i) => i && i.key === k);

function s2OpPresent({ live, liveExtraRecords, draftBuilt, draftExtraRecords }) {
  const lk = new Set((liveExtraRecords || []).map((e) => e.key)); const dk = new Set((draftExtraRecords || []).map((e) => e.key));
  if (lk.size !== dk.size || [...dk].some((k) => !lk.has(k))) return true;
  const ls = live.structure || {}, ds = draftBuilt.structure || {};
  if (!same(ls.extra_categories, ds.extra_categories)) return true;
  // the Extras page's own exposure writes (Codex build r1 P2-7): category_allow, and a dish's add / deny — never an S1 edit (the per-dish
  // checklist deny_extras, extras_policy) nor an ordinary move of a dish to another section, whose consequences stay today's diff
  const lx = ls.exposure || {}, dx = ds.exposure || {};
  if (!same(lx.category_allow, dx.category_allow)) return true;
  const lo = lx.item_overrides || {}, dov = dx.item_overrides || {};
  for (const k of new Set([...Object.keys(lo), ...Object.keys(dov)])) {
    if (leftWithDish(k, dov, live, draftBuilt)) continue;   // «Quitar del menú» (train/portal-structure): a removed dish's override leaves with it — its cleanup, not an Extras-page op
    for (const f of ['add', 'deny']) if (!same((lo[k] || {})[f], (dov[k] || {})[f])) return true;
  }
  return false;
}

// S4 (PLAN-structure-S4-r4 §4, R2.6, Q9) — the S4 lines ride ON TOP of the S2/S3 diff, ONLY when an S4 op is present (sections switch):
//   sections: { categories: { order: { old, new } }?, added: [{ id, name }], subcats: [{ cat, change: 'added' | 'renamed', old, new }],
//               subcat_order: [{ cat, old, new }], items: [{ key, cat, old_index, new_index }], item_order_sha256,
//               staged: [{ change: 'add' | 'drop' | 'rename' | 'move' | 'promote', … }], staged_sha256 }
// An S4 op: the section order / set or a section's subcats changed (a NAME alone is T1's rename, today's diff), the relative order of the
// dishes both versions carry changed, or the staged list changed. Without one the diff is today's, byte for byte.
function reviewDiff(args) {
  const out = reviewDiffS2S3(args);
  const sections = has(args, 'sections') ? args.sections : require('./platform-structure').structureCapabilities().sections;
  if (!sections || !s4OpPresent(args.live, args.draftBuilt)) return out;
  return { ...out, sections: sectionLines(args.live, args.draftBuilt, appOnlyOf(args.rid)) };
}

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
// §1.6 / Q4: «Solo en la app Sherpa» — the form does NOT draw any served category (renderer contract categoriesGeneric, generated from the
// shipped forms); null when the caller names no restaurant (never guessed). A label only.
const appOnlyOf = (rid) => { if (typeof rid !== 'string' || !rid) return null; try { const t = require('./renderer-contract.generated'); const e = Object.prototype.hasOwnProperty.call(t, rid) ? t[rid] : null; return e && typeof e.categoriesGeneric === 'boolean' ? !e.categoriesGeneric : null; } catch (_) { return null; } };
const catsOf = (b) => ((b && b.structure && Array.isArray(b.structure.categories)) ? b.structure.categories : []);
const stagedOf = (b) => ((b && b.structure && Array.isArray(b.structure.staged_categories)) ? b.structure.staged_categories : []);
const orderOf = (b) => ((b && b.structure && Array.isArray(b.structure.item_order)) ? b.structure.item_order : []);
const subsOf = (c) => (Array.isArray(c && c.subcats) ? c.subcats : []);
function commonOrder(live, draft) {
  const dk = new Set(orderOf(draft)); const lk = new Set(orderOf(live));
  return [orderOf(live).filter((k) => dk.has(k)), orderOf(draft).filter((k) => lk.has(k))];
}
function s4OpPresent(live, draft) {
  const lc = catsOf(live); const dc = catsOf(draft);
  if (!same(lc.map((c) => c.id), dc.map((c) => c.id))) return true;
  if (dc.some((c, i) => !same(subsOf(c), subsOf(lc[i])))) return true;
  if (!same(stagedOf(live), stagedOf(draft))) return true;
  const [a, b] = commonOrder(live, draft);
  return !same(a, b);
}
function sectionLines(live, draft, appOnly) {
  const { sha256 } = require('./catalog-edit');
  const lc = catsOf(live); const dc = catsOf(draft); const lById = new Map(lc.map((c) => [c.id, c]));
  const out = {};
  if (!same(lc.map((c) => c.id), dc.map((c) => c.id))) out.categories = { order: { old: lc.map((c) => c.id), new: dc.map((c) => c.id) }, app_only: appOnly };
  out.added = dc.filter((c) => !lById.has(c.id)).map((c) => ({ id: c.id, name: c.name, app_only: appOnly }));
  const subcats = []; const subcatOrder = [];
  for (const c of dc) {
    const ls = subsOf(lById.get(c.id)); const ds = subsOf(c);
    const renamed = require('./section-compare').subcatRenames(live, draft, c.id, ls, ds);   // the judgment's own pairing (by members)
    const oldOf = new Map([...renamed].map(([o, x]) => [x, o]));
    ds.forEach((x) => {
      if (ls.includes(x)) return;
      if (oldOf.has(x)) subcats.push({ cat: c.id, change: 'renamed', old: oldOf.get(x), new: x }); else subcats.push({ cat: c.id, change: 'added', old: null, new: x });
    });
    const mapped = ls.map((x) => renamed.get(x) || x).filter((x) => ds.includes(x));
    if (!same(mapped, ds.filter((x) => mapped.includes(x)))) subcatOrder.push({ cat: c.id, old: ls, new: ds });
  }
  out.subcats = subcats; out.subcat_order = subcatOrder;
  const catOf = (b) => new Map((b.items || []).map((i) => [i.key, i.display && i.display.cat]));
  const lCat = catOf(live); const dCat = catOf(draft);
  const [a, b] = commonOrder(live, draft);
  const rank = (keys, cats) => { const per = new Map(); const r = new Map(); for (const k of keys) { const c = cats.get(k); const n = per.get(c) || 0; r.set(k, n); per.set(c, n + 1); } return r; };
  const stay = (k) => lCat.get(k) === dCat.get(k);
  const lr = rank(a.filter(stay), lCat); const dr = rank(b.filter(stay), dCat);
  out.items = a.filter(stay).filter((k) => lr.get(k) !== dr.get(k)).map((k) => ({ key: k, cat: dCat.get(k), old_index: lr.get(k), new_index: dr.get(k) }));
  out.item_order_sha256 = sha256(orderOf(draft));
  const ls = stagedOf(live); const ds = stagedOf(draft);
  const rankIn = (list, e) => list.filter((x) => x.after === e.after).indexOf(e);
  const lsById = new Map(ls.map((e) => [e.id, e])); const dsById = new Map(ds.map((e) => [e.id, e]));
  const dIds = dc.map((c) => c.id); const staged = [];
  for (const e of ds) {
    const w = lsById.get(e.id);
    if (!w) { staged.push({ change: 'add', id: e.id, name: e.name, after: e.after }); continue; }
    if (w.name !== e.name) staged.push({ change: 'rename', id: e.id, old: w.name, new: e.name });
    if (w.after !== e.after || rankIn(ls, w) !== rankIn(ds, e)) staged.push({ change: 'move', id: e.id, old_after: w.after, new_after: e.after, old_rank: rankIn(ls, w), new_rank: rankIn(ds, e) });
  }
  for (const w of ls) {
    if (dsById.has(w.id)) continue;
    if (dIds.includes(w.id)) staged.push({ change: 'promote', id: w.id, at: dIds.indexOf(w.id) });
    else staged.push({ change: 'drop', id: w.id });
  }
  out.staged = staged; out.staged_sha256 = sha256(ds);
  return out;
}

function reviewDiffS2S3({ live, liveExtraRecords, draftBuilt, draftExtraRecords, photos = null, extrasCatalog = false, removal = null, choiceEdit = require('./platform-structure').structureCapabilities().choiceEdit }) {   // removal: removalDiffOptions(live, draft) («Quitar del menú» P-R3) or null
  const s2 = !!extrasCatalog && s2OpPresent({ live, liveExtraRecords, draftBuilt, draftExtraRecords });
  const s3 = !!choiceEdit && require('./choice-activation').s3EditPresent({ baseline: live, target: draftBuilt });   // S3 §4: the classifier's touched-group rule (Codex build r1 P2-3)
  const choices = s3 ? require('./choice-activation').choiceRows({ baseline: live, target: draftBuilt }) : [];
  const L = photos ? { ...live, photos: photos.active } : live;
  const D = photos ? { ...draftBuilt, photos: photos.draft } : draftBuilt;
  const diff = withConsequences(catalogDiff(L, D, { pairExtras: !s2, ...(s3 ? { pairItems: false } : {}), ...(removal || {}) }), { live, liveExtraRecords, draftBuilt, draftExtraRecords });
  if (!s2 && !s3) return diff;
  if (!s2) return { ...diff, fiscal: fiscalOf(diff, draftBuilt, new Map((draftExtraRecords || []).map((e) => [e.key, e]))), choices };

  const lx = new Map((liveExtraRecords || []).map((e) => [e.key, e])); const dx = new Map((draftExtraRecords || []).map((e) => [e.key, e]));
  const row = (e, price, change) => ({ key: e.key, name: e.display && e.display.name, group: e.display && e.display.cat, price, change });
  const extras = [];
  for (const [k, e] of lx) if (!dx.has(k)) extras.push(row(e, e.price, 'removed'));
  for (const [k, e] of dx) if (!lx.has(k)) extras.push(row(e, e.price, 'added'));
  for (const [k, e] of dx) if (lx.has(k) && lx.get(k).price !== e.price) extras.push(row(e, e.price, 'repriced'));
  const out = { ...diff, extras };
  const lc = live.structure && live.structure.extra_categories; const dc = draftBuilt.structure && draftBuilt.structure.extra_categories;
  if (!same(lc, dc)) out.structure = { extra_categories: { old: lc === undefined ? null : lc, new: dc === undefined ? null : dc } };

  const nameOf = (surface, key) => { const r = surface === 'extra' ? dx.get(key) : (draftBuilt.items || []).find((i) => i.key === key); return r && r.display ? r.display.name : null; };
  // one row per key: catalogDiff lists each added key once and each price change once (no duplicates by construction)
  const added = diff.added.filter((a) => a.surface === 'item' || a.surface === 'extra').map((a) => ({ surface: a.surface, key: a.key, name: nameOf(a.surface, a.key), price: a.price }));
  const repriced = diff.changed.filter((c) => c.field === 'price' && (c.surface === 'item' || c.surface === 'extra')).map((c) => ({ surface: c.surface, key: c.key, name: nameOf(c.surface, c.key), old: c.old, new: c.new }));
  out.fiscal = { added, repriced };
  // the AUTHORED attachment transitions (S2 UI plan review #3) — token-bound even when no effective extra moves (a group detached from a
  // dish whose extras were all unticked still changes what the forms offer): one row per group entering / leaving a category's list or a
  // dish's add / deny, sorted; and the authoritative reach of every changed group: the sellable products (a launcher once, its options
  // inside it) the draft offers it to — «en N productos»
  const list = (v) => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)]);
  const groupsAll = new Set([...list(lc), ...list(dc)]);
  const lexp = (live.structure && live.structure.exposure) || {}; const dxp = (draftBuilt.structure && draftBuilt.structure.exposure) || {};
  const attachments = [];
  const lca = lexp.category_allow || {}; const dca = dxp.category_allow || {};
  for (const c of new Set([...Object.keys(lca), ...Object.keys(dca)])) {
    for (const g of list(dca[c])) if (!list(lca[c]).includes(g)) attachments.push({ group: g, scope: 'category', target: c, change: 'attached' });
    for (const g of list(lca[c])) if (!list(dca[c]).includes(g)) attachments.push({ group: g, scope: 'category', target: c, change: 'detached' });
  }
  const lov = lexp.item_overrides || {}; const dov = dxp.item_overrides || {};
  for (const k of new Set([...Object.keys(lov), ...Object.keys(dov)])) {
    if (leftWithDish(k, dov, live, draftBuilt)) continue;   // the removed dish's own cleanup is no attachment row
    const a = lov[k] || {}; const d = dov[k] || {};
    for (const g of groupsAll) {
      const was = list(a.add).includes(g) ? 'attached' : list(a.deny).includes(g) ? 'detached' : null;
      const after = list(d.add).includes(g) ? 'attached' : list(d.deny).includes(g) ? 'detached' : null;
      if (was !== after) attachments.push({ group: g, scope: 'item', target: k, change: after || (was === 'attached' ? 'detached' : 'attached') });
    }
  }
  const key = (r) => `${r.group}\u0000${r.scope}\u0000${r.target}`;
  out.attachments = attachments.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  const changedGroups = new Set([...attachments.map((r) => r.group), ...extras.map((r) => r.group)]);
  if (out.structure) for (const g of list(dc)) if (!list(lc).includes(g)) changedGroups.add(g);
  const P = projectEligibility({ items: draftBuilt.items || [], extras: draftExtraRecords || [], structure: draftBuilt.structure || {} });
  const E = effectiveGroups(P);
  const reach = {};
  for (const g of [...changedGroups].sort()) reach[g] = Object.keys(E).filter((k) => !P.items[k].launcherKey && E[k] && E[k].includes(g)).length;
  out.reach = reach;
  if (s3) out.choices = choices;
  return out;
}

// the fiscal seal of an S3-only diff — the S2 rule above, verbatim: one row per added key, one per price change (item / extra)
function fiscalOf(diff, draftBuilt, dx) {
  const nameOf = (surface, key) => { const r = surface === 'extra' ? dx.get(key) : (draftBuilt.items || []).find((i) => i.key === key); return r && r.display ? r.display.name : null; };
  const added = diff.added.filter((a) => a.surface === 'item' || a.surface === 'extra').map((a) => ({ surface: a.surface, key: a.key, name: nameOf(a.surface, a.key), price: a.price }));
  const repriced = diff.changed.filter((c) => c.field === 'price' && (c.surface === 'item' || c.surface === 'extra')).map((c) => ({ surface: c.surface, key: c.key, name: nameOf(c.surface, c.key), old: c.old, new: c.new }));
  return { added, repriced };
}

module.exports = { reviewDiff, s2OpPresent, s4OpPresent };
