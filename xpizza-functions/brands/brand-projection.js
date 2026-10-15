'use strict';
// PLATFORM F1 — the PUBLIC projection /public/brands/{brandId} (PLAN-multi-location §1.2): what the forms, tracker and handheld
// will read instead of /restaurants. PURE. Explicit ALLOWLIST — never spread an identity (phone, WhatsApp instance, version and
// flags must never become public). Members only: a retired location keeps its identity (§3.5) but is not offered to customers.
// Refuses (never publishes a partial brand) unless the brand validates, membership is consistent, and EVERY member is a full branch.
// RTDB drops empty objects, so the builder never emits one: no member → no `locations`; no day → no `hours` (read-back stays equal).
const { validateBrand, validateBranchIdentity, checkMembership } = require('./brand-model');

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function pickHours(h) {
  const out = {};
  for (const d of DAYS) {
    const v = h[d];
    if (!v) continue;
    out[d] = v.open ? { open: true, start: v.start, end: v.end } : { open: false };
  }
  return out;
}

function buildPublicBrand(brandId, brand, identities) {
  const vb = validateBrand(brandId, brand);
  if (!vb.ok) return { ok: false, errors: vb.errors };
  const errors = checkMembership({ [brandId]: brand }, identities)
    .filter((f) => f.brandId === brandId)
    .map((f) => `${f.code}${f.rid ? `:${f.rid}` : ''}`);
  const members = Object.keys(brand.locations).filter((rid) => brand.locations[rid] === 'member').sort();
  const locations = {};
  for (const rid of members) {
    const id = identities[rid];
    const v = validateBranchIdentity(rid, id, brandId);
    if (!v.ok) { errors.push(...v.errors); continue; }
    const row = { location_name: id.location_name, hub: { lat: id.hub_lat, lng: id.hub_lng }, zone: { type: 'circle', radius_km: id.zone.radius_km } };
    const hours = pickHours(id.hours);
    if (Object.keys(hours).length) row.hours = hours;
    row.prep_default_min = id.prep_default_min;
    locations[rid] = row;
  }
  if (errors.length) return { ok: false, errors };
  const projection = { name: brand.name };
  if (Object.keys(locations).length) projection.locations = locations;
  return { ok: true, projection };
}

module.exports = { buildPublicBrand };
