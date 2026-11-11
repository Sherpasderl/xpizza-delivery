'use strict';
// S2-core (PLAN-structure-S2core-r3 §1.6) — THE ONE canonical review diff. The save (edit-catalog-handler), the owner publish
// (publish-edited-handler) and the manager request (publish-request) all bind their token to reviewDiff(); none folds its own.
//   = catalogDiff (with the photo lines when wired) + the extras consequences (UNGATED; while item_text_edit is ON — prod — this is
//     exactly today's fold, a cell proves it) and, ONLY when an S2 op is present under the extrasCatalog switch:
//       · extras are never paired as renames (an extra cannot be renamed in S2-core: a different key is a different extra)
//       · extras: [{ key, name, group, price, change: 'added' | 'removed' | 'repriced' }]
//       · structure: { extra_categories: { old, new } } when the group order / set changed
//       · fiscal: { added: [{ surface, key, name, price }], repriced: [{ surface, key, name, old, new }] } — the seal, no duplicates
//   Without an S2 op the diff object is today's, byte for byte, so every token issued before the deploy verifies after it.
// An S2 op is present when an extra is added or removed, the group order / set changed, or any dish's offered GROUPS changed
// (attach / detach). A per-dish unticked extra (S1 deny_extras) changes no group: today's edit, today's diff. Pure.
const { catalogDiff } = require('./catalog-edit');
const { withConsequences } = require('./extras-consequences');
const { projectEligibility } = require('./extras-eligibility');
const { effectiveGroups } = require('./exposure-transitions');
const { canonicalize } = require('./source-store');

const same = (a, b) => JSON.stringify(canonicalize(a === undefined ? null : a)) === JSON.stringify(canonicalize(b === undefined ? null : b));
const recs = (built, records) => ({ items: (built && built.items) || [], extras: records || [], structure: (built && built.structure) || {} });

function s2OpPresent({ live, liveExtraRecords, draftBuilt, draftExtraRecords }) {
  const lk = new Set((liveExtraRecords || []).map((e) => e.key)); const dk = new Set((draftExtraRecords || []).map((e) => e.key));
  if (lk.size !== dk.size || [...dk].some((k) => !lk.has(k))) return true;
  if (!same(live.structure && live.structure.extra_categories, draftBuilt.structure && draftBuilt.structure.extra_categories)) return true;
  const gL = effectiveGroups(projectEligibility(recs(live, liveExtraRecords)));
  const gD = effectiveGroups(projectEligibility(recs(draftBuilt, draftExtraRecords)));
  return Object.keys(gD).some((k) => Object.prototype.hasOwnProperty.call(gL, k) && !same(gL[k], gD[k]));
}

function reviewDiff({ live, liveExtraRecords, draftBuilt, draftExtraRecords, photos = null, extrasCatalog = false }) {
  const s2 = !!extrasCatalog && s2OpPresent({ live, liveExtraRecords, draftBuilt, draftExtraRecords });
  const L = photos ? { ...live, photos: photos.active } : live;
  const D = photos ? { ...draftBuilt, photos: photos.draft } : draftBuilt;
  const diff = withConsequences(catalogDiff(L, D, { pairExtras: !s2 }), { live, liveExtraRecords, draftBuilt, draftExtraRecords });
  if (!s2) return diff;

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
  const seen = new Set(); const once = (r) => { const id = `${r.surface}:${r.key}`; if (seen.has(id)) return false; seen.add(id); return true; };
  const added = diff.added.filter((a) => a.surface === 'item' || a.surface === 'extra').map((a) => ({ surface: a.surface, key: a.key, name: nameOf(a.surface, a.key), price: a.price })).filter(once);
  const repriced = diff.changed.filter((c) => c.field === 'price' && (c.surface === 'item' || c.surface === 'extra')).map((c) => ({ surface: c.surface, key: c.key, name: nameOf(c.surface, c.key), old: c.old, new: c.new })).filter(once);
  out.fiscal = { added, repriced };
  return out;
}

module.exports = { reviewDiff, s2OpPresent };
