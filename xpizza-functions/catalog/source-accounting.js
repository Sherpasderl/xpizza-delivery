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

const TOP = new Set(['restaurant_id', 'schema_version', 'key_mode', 'items', 'extras', 'structure', 'frozen_keys', 'photos', 'deleted_ids', 'frozen_extra_keys']);
const ROW = { items: new Set(['key', 'ref', 'price', 'display', 'has_photo']), extras: new Set(['key', 'ref', 'price', 'display']) };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const canon = (v) => JSON.stringify(require('./source-store').canonicalize(v === undefined ? null : v));
const residual = (path) => { throw new AddProductError('structure_unexplained', `this change is not one the menu editor can make (${path})`, { field: path }); };

// a leaf CHANGED when its presence differs or its value does — an added `x: null` is not absence (Codex build r2 #3)
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const differs = (a, b, f) => own(a, f) !== own(b, f) || canon(a[f]) !== canon(b[f]);

// the LEAVES alone — run on the INCOMING source before the allocator rewrites a fresh row (its unknown fields would vanish there), and
// again on the stored-to-be source; throws AddProductError structure_unexplained {path}
function accountLeaves({ next, stored }) {
  const n0 = isObj(next) ? next : {}; const s0 = isObj(stored) ? stored : {};
  for (const f of new Set([...Object.keys(n0), ...Object.keys(s0)])) if (!TOP.has(f) && differs(n0, s0, f)) residual(f);
  for (const kind of ['items', 'extras']) {
    const prev = new Map((Array.isArray(s0[kind]) ? s0[kind] : []).filter(isObj).map((r) => [r.key !== undefined ? `k:${r.key}` : `r:${r.ref}`, r]));
    for (const r of Array.isArray(n0[kind]) ? n0[kind] : []) {
      if (!isObj(r)) continue;
      const p = prev.get(r.key !== undefined ? `k:${r.key}` : `r:${r.ref}`) || {};
      for (const f of new Set([...Object.keys(r), ...Object.keys(p)])) if (!ROW[kind].has(f) && differs(r, p, f)) residual(`${kind}.${r.key !== undefined ? r.key : r.ref}.${f}`);
    }
  }
}

function accountAuthored({ next, stored, draftRecords }) {
  const s0 = isObj(stored) ? stored : {};
  accountLeaves({ next, stored });
  const ns = isObj(next.structure) ? next.structure : {}; const ss = isObj(s0.structure) ? s0.structure : {};
  const changed = ['extras_by_category', 'extras_by_item'].filter((f) => differs(ns, ss, f));
  if (changed.length) {
    const maps = require('./extras-projection').projectExtrasMaps({ items: draftRecords.items, extras: draftRecords.extras, structure: draftRecords.structure });
    const want = { extras_by_category: maps.byCategory, extras_by_item: maps.byItem };
    for (const f of changed) if (canon(ns[f] || {}) !== canon(want[f])) residual(`structure.${f}`);
  }
}

module.exports = { accountAuthored, accountLeaves };
