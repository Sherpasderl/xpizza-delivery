'use strict';
// PLATFORM F1 — the brand / location model (PLAN-multi-location §1.2, §3.4, §3.5). PURE: no I/O, no clock, no brand literal.
//   /brands/{brandId}            { name, active, locations: {rid: 'member'|'retired'}, activation: {state, since} }   (C1 extends)
//   /restaurants/{rid}/identity  + brand_id, location_name, zone {type:'circle', radius_km}, prep_default_min
// brandIdOf is NOT pickup-label.js's brandOf (that one resolves a display name). 'unknown' is a value AND a reserved id.
const { isRoutingValid } = require('../restaurant-config');

const UNKNOWN = 'unknown';
const ZONE_MAX_KM = 50;
const ID = /^[a-z0-9_]{1,40}$/;
const STATES = new Set(['legacy', 'off', 'on']);
const LOC_STATES = new Set(['member', 'retired']);
const BRAND_KEYS = ['activation', 'active', 'locations', 'name'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max && v.trim() === v;
const isBrandId = (s) => typeof s === 'string' && ID.test(s) && s !== UNKNOWN;
const isTime = (v) => typeof v === 'string' && HHMM.test(v);   // the type FIRST: a regex coerces an array to a string
const res = (errors) => (errors.length ? { ok: false, errors } : { ok: true });

function validateBrand(brandId, rec) {
  const e = [];
  if (!isBrandId(brandId)) e.push(`bad brand id ${JSON.stringify(brandId)}`);
  if (!isObj(rec)) return res(e.concat('brand record is not an object'));
  const extra = Object.keys(rec).filter((k) => !BRAND_KEYS.includes(k));
  if (extra.length) e.push(`unknown keys: ${extra.sort().join(', ')}`);
  if (!isText(rec.name, 80)) e.push('name must be 1–80 chars, unpadded');
  if (typeof rec.active !== 'boolean') e.push('active must be boolean');
  const locs = rec.locations;
  if (!isObj(locs) || !Object.keys(locs).length) e.push('locations must be a non-empty object');
  else for (const [rid, st] of Object.entries(locs)) {
    if (!isBrandId(rid)) e.push(`bad location id ${JSON.stringify(rid)}`);
    if (!LOC_STATES.has(st)) e.push(`location ${rid}: state must be member|retired`);
  }
  const a = rec.activation;
  if (!isObj(a) || Object.keys(a).some((k) => k !== 'state' && k !== 'since')) e.push('activation must be exactly {state, since}');
  else {
    if (!STATES.has(a.state)) e.push('activation.state must be legacy|off|on');
    if (!Number.isFinite(a.since)) e.push('activation.since must be a finite number');
    if (a.state === 'legacy' && isObj(locs) && !(Object.keys(locs).length === 1 && locs[brandId] === 'member')) e.push('legacy requires locations === {brandId: member}');
  }
  return res(e);
}

function validateZone(z) {
  if (!isObj(z)) return ['zone must be an object'];
  const e = [];
  if (Object.keys(z).some((k) => k !== 'type' && k !== 'radius_km')) e.push('zone must be exactly {type, radius_km}');
  if (z.type !== 'circle') e.push('zone.type must be circle');
  if (!(typeof z.radius_km === 'number' && Number.isFinite(z.radius_km) && z.radius_km > 0 && z.radius_km <= ZONE_MAX_KM)) e.push(`zone.radius_km must be in (0, ${ZONE_MAX_KM}]`);
  return e;
}

// Same-day intervals only (no overnight machinery): an open day has string HH:MM start < end.
function hoursErrors(h) {
  if (!isObj(h)) return ['hours must be an object'];
  const e = [];
  for (const d of DAYS) {
    if (h[d] === undefined) continue;
    const v = h[d];
    if (!isObj(v) || typeof v.open !== 'boolean') { e.push(`hours.${d}.open must be boolean`); continue; }
    if (v.open && !(isTime(v.start) && isTime(v.end) && v.start < v.end)) e.push(`hours.${d}: start < end, both HH:MM strings`);
  }
  return e;
}

function validateBranchIdentity(rid, id, brandId) {
  if (!isRoutingValid(id)) return res([`${rid}: identity is not routing-valid`]);
  const e = [];
  if (!isBrandId(brandId)) e.push(`bad brand id ${JSON.stringify(brandId)}`);
  if (!(id.hub_lat >= -90 && id.hub_lat <= 90)) e.push('hub_lat out of range');
  if (!(id.hub_lng >= -180 && id.hub_lng <= 180)) e.push('hub_lng out of range');
  if (id.brand_id !== brandId) e.push(`brand_id ${JSON.stringify(id.brand_id)} ≠ ${JSON.stringify(brandId)}`);
  if (!isText(id.location_name, 60)) e.push('location_name must be 1–60 chars, unpadded');
  const ze = validateZone(id.zone);
  e.push(...ze);
  if (!ze.length && id.zone.radius_km !== id.delivery_radius_km) e.push('zone.radius_km must equal delivery_radius_km');
  if (!(Number.isInteger(id.prep_default_min) && id.prep_default_min >= 5 && id.prep_default_min <= 120)) e.push('prep_default_min must be an integer 5–120');
  e.push(...hoursErrors(id.hours));
  return res(e.map((m) => `${rid}: ${m}`));
}

// The routing brand of a location: an explicit (well-formed) identity.brand_id, else the rid itself ONLY when /brands/{rid} is a
// VALID legacy singleton, else 'unknown'. An explicit id is not checked against its brand record here — the router does that.
function brandIdOf(rid, identity, brands) {
  if (identity && identity.brand_id !== undefined) return isBrandId(identity.brand_id) ? identity.brand_id : UNKNOWN;
  const b = isObj(brands) ? brands[rid] : undefined;
  if (b && validateBrand(rid, b).ok && b.activation.state === 'legacy') return rid;
  return UNKNOWN;
}

// Both directions: listed (member OR retired) ⇒ identity.brand_id === brand (a legacy brand also accepts an absent one);
// identity.brand_id ⇒ that brand exists and lists the rid. An invalid brand is one finding.
function checkMembership(brands, identities) {
  const out = [];
  const B = isObj(brands) ? brands : {};
  const I = isObj(identities) ? identities : {};
  for (const [b, rec] of Object.entries(B)) {
    const v = validateBrand(b, rec);
    if (!v.ok) { out.push({ code: 'brand_invalid', brandId: b, errors: v.errors }); continue; }
    for (const rid of Object.keys(rec.locations)) {
      const id = I[rid];
      if (!isObj(id)) { out.push({ code: 'identity_missing', brandId: b, rid }); continue; }
      const legacyOk = rec.activation.state === 'legacy' && id.brand_id === undefined;
      if (!legacyOk && id.brand_id !== b) out.push({ code: 'brand_id_mismatch', brandId: b, rid });
    }
  }
  for (const [rid, id] of Object.entries(I)) {
    if (!isObj(id) || id.brand_id === undefined) continue;
    const rec = B[id.brand_id];
    if (!isObj(rec)) out.push({ code: 'brand_missing', brandId: String(id.brand_id), rid });
    else if (!(isObj(rec.locations) && rec.locations[rid])) out.push({ code: 'not_listed', brandId: id.brand_id, rid });
  }
  const key = (f) => `${f.code}\u0000${f.brandId || ''}\u0000${f.rid || ''}`;
  return out.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
}

module.exports = { UNKNOWN, ZONE_MAX_KM, isBrandId, validateBrand, validateZone, validateBranchIdentity, brandIdOf, checkMembership };
