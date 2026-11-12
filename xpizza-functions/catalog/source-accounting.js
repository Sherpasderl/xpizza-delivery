'use strict';
// S2-core (Codex build r1 P1-3) — the AUTHORED source is accounted on the save BEFORE anything is lost to the build: the builder keeps
// only the fields it knows, so a leaf it drops can never reach compareToActive's accounting. Against the stored draft (what the merchant
// loaded), on every save and whatever the switches say (accounting is platform-wide, ruling R1):
//   · a top-level field outside the source schema that changed ................................... structure_unexplained {field}
//   · an item / extra ROW field outside { key, ref, price, display (, has_photo) } that changed ..... structure_unexplained {items.<k>.<f>}
//   · an authored extras_by_category / extras_by_item that changed and is not EXACTLY what the draft's own records derive (the one
//     projection, catalog/extras-projection.js — today's maps ARE that derivation: catalog/s2core-maps.golden.json) ... structure_unexplained
// Throws AddProductError.
const { AddProductError } = require('./add-product');

const TOP = new Set(['restaurant_id', 'schema_version', 'key_mode', 'items', 'extras', 'structure', 'frozen_keys', 'photos', 'deleted_ids']);
const ROW = { items: new Set(['key', 'ref', 'price', 'display', 'has_photo']), extras: new Set(['key', 'ref', 'price', 'display']) };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const canon = (v) => JSON.stringify(require('./source-store').canonicalize(v === undefined ? null : v));
const residual = (path) => { throw new AddProductError('structure_unexplained', `this change is not one the menu editor can make (${path})`, { field: path }); };

function accountAuthored({ next, stored, draftRecords }) {
  const s0 = isObj(stored) ? stored : {};
  for (const f of new Set([...Object.keys(next || {}), ...Object.keys(s0)])) if (!TOP.has(f) && canon(next[f]) !== canon(s0[f])) residual(f);
  for (const kind of ['items', 'extras']) {
    const prev = new Map((Array.isArray(s0[kind]) ? s0[kind] : []).filter(isObj).map((r) => [r.key !== undefined ? `k:${r.key}` : `r:${r.ref}`, r]));
    for (const r of Array.isArray(next[kind]) ? next[kind] : []) {
      if (!isObj(r)) continue;
      const p = prev.get(r.key !== undefined ? `k:${r.key}` : `r:${r.ref}`) || {};
      for (const f of new Set([...Object.keys(r), ...Object.keys(p)])) if (!ROW[kind].has(f) && canon(r[f]) !== canon(p[f])) residual(`${kind}.${r.key !== undefined ? r.key : r.ref}.${f}`);
    }
  }
  const ns = isObj(next.structure) ? next.structure : {}; const ss = isObj(s0.structure) ? s0.structure : {};
  const changed = ['extras_by_category', 'extras_by_item'].filter((f) => canon(ns[f]) !== canon(ss[f]));
  if (changed.length) {
    const maps = require('./extras-projection').projectExtrasMaps({ items: draftRecords.items, extras: draftRecords.extras, structure: draftRecords.structure });
    const want = { extras_by_category: maps.byCategory, extras_by_item: maps.byItem };
    for (const f of changed) if (canon(ns[f] || {}) !== canon(want[f])) residual(`structure.${f}`);
  }
}

module.exports = { accountAuthored };
