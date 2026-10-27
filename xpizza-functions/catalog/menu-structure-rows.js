'use strict';
// PLAN 4 GATED (advisor ruling G1) — the in-repo BOOTSTRAP takes the post-migration data from ONE source: the reviewed data
// file tools/migrations/2026-10-26-menu-structure.json (the same rows tools/migrate-menu-structure.js writes to the store).
// The bootstrap readers — buildCatalogV2's text path and seed-source-store — apply these rows ADDITIVELY to the records they
// build from the form literals, so the committed forms, the seed and the published menu after the migration all carry the same
// reward_icon / extras_policy / badge_priority, and no form literal duplicates them.
// Additive exactly like the migration: a field the literal already carries is left alone (a different value would be a
// conflict the migration reports, not one this silently resolves) — and a row naming a record the bootstrap lacks is an
// error, because the reviewed file and the bootstrap disagreeing is drift.
const DATA = require('../tools/migrations/2026-10-26-menu-structure.json');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const rowsFor = (rid) => (DATA.restaurants && DATA.restaurants[rid]) || null;

// items / extras: [{ key, display }] (mutated in place). → the structure fields the rows author (badge_priority, …).
function applyBootstrapRows(rid, { items, extras }) {
  const rows = rowsFor(rid);
  if (!rows) return {};
  for (const [coll, list] of [['items', items], ['extras', extras]]) {
    for (const [key, row] of Object.entries(rows[coll] || {})) {
      const rec = (list || []).find((x) => x && x.key === key);
      if (!rec || !isObj(rec.display)) throw new Error(`bootstrap_rows_drift: ${rid}/${coll}[${key}] — the reviewed data names a record the bootstrap does not have`);
      for (const [field, value] of Object.entries((row && row.display) || {})) {
        if (!Object.prototype.hasOwnProperty.call(rec.display, field)) rec.display[field] = value;
      }
    }
  }
  return isObj(rows.structure) ? JSON.parse(JSON.stringify(rows.structure)) : {};
}

// The bootstrap's RECORD SET for literal-parity pins: the form's MENU / EXTRAS literal records with the reviewed rows applied
// (deep copies; the literals are not touched). Keys through the one keying convention (lazy: form-menu-source requires this file).
function withBootstrapRows(rid, { dishes = [], extras = [] } = {}) {
  const { pricingKeyOf, extrasKeyOf } = require('./form-menu-source');
  const d = JSON.parse(JSON.stringify(dishes)); const e = JSON.parse(JSON.stringify(extras));
  applyBootstrapRows(rid, { items: d.map((x) => ({ key: pricingKeyOf(rid, x), display: x })), extras: e.map((x) => ({ key: extrasKeyOf(rid, x), display: x })) });
  return { dishes: d, extras: e };
}

module.exports = { applyBootstrapRows, withBootstrapRows };
