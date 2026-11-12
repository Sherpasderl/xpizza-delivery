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
    for (const f of ['add', 'deny']) if (!same((lo[k] || {})[f], (dov[k] || {})[f])) return true;
  }
  return false;
}

function reviewDiff({ live, liveExtraRecords, draftBuilt, draftExtraRecords, photos = null, extrasCatalog = false, choiceEdit = require('./platform-structure').structureCapabilities().choiceEdit }) {
  const s2 = !!extrasCatalog && s2OpPresent({ live, liveExtraRecords, draftBuilt, draftExtraRecords });
  const choices = choiceEdit ? require('./choice-activation').choiceRows({ baseline: live, target: draftBuilt }) : [];   // S3 §4: an S3 edit is present iff a group row exists
  const s3 = choices.length > 0;
  const L = photos ? { ...live, photos: photos.active } : live;
  const D = photos ? { ...draftBuilt, photos: photos.draft } : draftBuilt;
  const diff = withConsequences(catalogDiff(L, D, { pairExtras: !s2, ...(s3 ? { pairItems: false } : {}) }), { live, liveExtraRecords, draftBuilt, draftExtraRecords });
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

module.exports = { reviewDiff, s2OpPresent };
