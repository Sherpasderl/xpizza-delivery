'use strict';
// S7a directory (PLAN-capp-S7a-r2 §0) — the ONE shape of a restaurant's public PRESENTATION node
// (restaurants/{rid}/presentation), shared by its writer (tools/seed-presentation.js, later the portal) and its reader (the
// directory). Every field is optional; a present field must be valid. Public presentation only — never transport or secrets.
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const isStr = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max && v.trim() === v;
const isHttpsUrl = (v) => isStr(v, 400) && /^https:\/\/[^\s"'<>]+$/.test(v);
const isRange = (v) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 1 && n <= 240) && v[0] <= v[1];
const isIdList = (v, max) => Array.isArray(v) && v.length >= 1 && v.length <= max && v.every((x) => typeof x === 'string' && ID.test(x)) && new Set(v).size === v.length;
// house holds CANONICAL dish ids — the identity registry's own shape rule (validIdShape: x_pizza mints uppercase opaque
// tokens like ABERVHPJ1C, la_musa grandfathers slugs like dimsum_01). Case is preserved; nothing is normalized.
const { validIdShape } = require('../catalog/identity-registry');
const isDishIdList = (v, max) => Array.isArray(v) && v.length >= 1 && v.length <= max && v.every((x) => validIdShape(x)) && new Set(v).size === v.length;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// field → validator (the allowlist: nothing else is read or served)
const FIELDS = Object.freeze({
  kicker: (v) => isStr(v, 80),
  unit: (v) => Array.isArray(v) && v.length === 2 && v.every((x) => isStr(x, 24)),
  cuisines: (v) => isIdList(v, 8),
  logo_url: isHttpsUrl,
  logo_wide: (v) => typeof v === 'boolean',
  hero_url: isHttpsUrl,
  asset_base: isHttpsUrl,
  eta_delivery_min: isRange,
  eta_pickup_min: isRange,
  payments: (v) => Array.isArray(v) && v.length >= 1 && v.every((x) => x === 'online' || x === 'cash') && new Set(v).size === v.length,
  pickup: (v) => typeof v === 'boolean',
  order_id_prefix: (v) => typeof v === 'string' && /^[A-Z]{2,5}$/.test(v),
  house: (v) => isDishIdList(v, 12),
  // RTDB DROPS empty arrays/objects, so «no recommendations» is persisted as house_hidden:true (Codex directory r1 P2-3);
  // the reader serves it as house:[] (hidden), distinct from absent (the client's catalog fallback).
  house_hidden: (v) => v === true,
  meals: (v) => isObj(v) && Object.keys(v).length >= 1 && Object.keys(v).length <= 40 && Object.entries(v).every(([k, m]) => ID.test(k) && typeof m === 'string' && ID.test(m)),
});
const FIELD_NAMES = Object.freeze(Object.keys(FIELDS));
// the SERVED presentation fields (house_hidden is a storage representation, served as house:[])
const SERVED_FIELDS = Object.freeze(FIELD_NAMES.filter((k) => k !== 'house_hidden'));

// → [error…] (empty = valid). Unknown keys are errors for a WRITER.
function presentationErrors(p) {
  if (!isObj(p)) return ['presentation must be an object'];
  const e = [];
  for (const k of Object.keys(p)) if (!Object.prototype.hasOwnProperty.call(FIELDS, k)) e.push(`unknown field ${k}`);
  for (const k of FIELD_NAMES) if (p[k] !== undefined && !FIELDS[k](p[k])) e.push(`invalid ${k}`);
  if (p.house !== undefined && p.house_hidden !== undefined) e.push('house and house_hidden are exclusive');
  return e;
}
function assertPresentationShape(rid, p) {
  const e = presentationErrors(p);
  if (e.length) throw new Error(`${rid}: presentation ${e[0]}`);
}
// READER: the valid allowlisted fields only (an invalid stored field is withheld and reported, never served raw)
function pickPresentation(p) {
  const out = {}; const invalid = [];
  if (!isObj(p)) return { fields: out, invalid };
  for (const k of FIELD_NAMES) {
    if (p[k] === undefined) continue;
    if (FIELDS[k](p[k])) out[k] = JSON.parse(JSON.stringify(p[k])); else invalid.push(k);
  }
  if (out.house !== undefined && out.house_hidden === true) { delete out.house; delete out.house_hidden; invalid.push('house'); }   // contradictory → withheld
  else if (out.house_hidden === true) { delete out.house_hidden; out.house = []; }   // explicitly EMPTY (hidden), not absent
  return { fields: out, invalid };
}

module.exports = { FIELD_NAMES, SERVED_FIELDS, presentationErrors, assertPresentationShape, pickPresentation };
