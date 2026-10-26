'use strict';
// ORCHESTRATION O1a (PLAN-multi-location-orchestration r3.1 §2.1, §4, §5) — the PURE branch-lifecycle planners. No I/O: the
// writers (branch-store) read the current state, call a planner, and apply its result atomically with the op record (§2.2).
// Owner rulings bound here: location (pin = hub, address) and zone are SHERPA-admin writes only (planMaterialize / planSetLocation);
// the pin / address move only while the branch is OFF (inactive ≥ 10 min, zero non-terminal orders); a radius-only change is
// allowed while active; hours are SAME-DAY, all 7 days; a branch is created inactive; «Desactivar» is reversible active:false.
const { isBrandId, validateBranchIdentity, validateZone } = require('../brands/brand-model');

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const NAME_MAX = 60;
const ADDRESS_MAX = 120;
const DEFAULT_ZONE_KM = 5;
const MOVE_QUIET_MS = 10 * 60 * 1000;   // longer than any intake request (function timeouts ≤ 120 s)

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max && v.trim() === v;
const isPrep = (v) => Number.isInteger(v) && v >= 5 && v <= 120;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// all 7 days, each {open:false} or {open:true, start, end} same-day (start < end), no other keys
function hours7Errors(hours) {
  if (!isObj(hours)) return ['hours must be an object of 7 days'];
  const e = [];
  for (const k of Object.keys(hours)) if (!DAYS.includes(k)) e.push(`unknown day ${k}`);
  for (const d of DAYS) {
    const h = hours[d];
    if (!isObj(h) || typeof h.open !== 'boolean') { e.push(`${d}: {open} required`); continue; }
    if (Object.keys(h).some((k) => !['open', 'start', 'end'].includes(k))) e.push(`${d}: unknown key`);
    if (!h.open) { if ('start' in h || 'end' in h) e.push(`${d}: closed day has times`); continue; }
    // O1b T3d (Codex r1 #7): string times FIRST — an array / object / number never reaches the regex or the comparison
    if (typeof h.start !== 'string' || typeof h.end !== 'string' || !HHMM.test(h.start) || !HHMM.test(h.end) || !(h.start < h.end)) e.push(`${d}: open day needs HH:MM start < end (same day)`);
  }
  return e;
}

function draftErrors(d) {
  const e = [];
  if (!isObj(d)) return ['bad_draft'];
  if (!isBrandId(d.brand_id)) e.push('bad_brand');
  if (!isText(d.location_name, NAME_MAX)) e.push('bad_name');
  if (typeof d.phone !== 'string' || !PHONE.test(d.phone)) e.push('bad_phone');
  if (!isPrep(d.prep_default_min)) e.push('bad_prep');
  if (hours7Errors(d.hours).length) e.push('bad_hours');
  return e;
}

const hubErrors = (hub) => (isObj(hub) && Number.isFinite(hub.lat) && Number.isFinite(hub.lng) && Math.abs(hub.lat) <= 90 && Math.abs(hub.lng) <= 180 ? [] : ['bad_hub']);
function boundsErrors(hub, bounds) {
  if (!isObj(bounds) || ![bounds.min_lat, bounds.max_lat, bounds.min_lng, bounds.max_lng].every(Number.isFinite)) return ['service_bounds_unset'];
  return hub.lat >= bounds.min_lat && hub.lat <= bounds.max_lat && hub.lng >= bounds.min_lng && hub.lng <= bounds.max_lng ? [] : ['out_of_bounds'];
}
const addressErrors = (line, ref, lineRequired) => {
  const e = [];
  if ((lineRequired || line !== undefined) && !isText(line, ADDRESS_MAX)) e.push('bad_address');
  if (ref !== undefined && !(ref === null || (typeof ref === 'string' && ref.length <= ADDRESS_MAX && ref.trim() === ref))) e.push('bad_address');
  return e;
};
const zoneErrors = (km) => (validateZone({ type: 'circle', radius_km: km }).length ? ['bad_zone'] : []);

// Sherpa admin: a draft + the location Sherpa sets → the full, routing-valid identity (inactive, version 1)
function planMaterialize({ draft, location, brandName, bounds, now }) {
  const loc = isObj(location) ? location : {};
  const km = loc.zone_radius_km === undefined ? DEFAULT_ZONE_KM : loc.zone_radius_km;
  const errors = [...draftErrors(draft), ...hubErrors(loc.hub), ...addressErrors(loc.address_line, loc.address_reference, true), ...zoneErrors(km)];
  if (!errors.includes('bad_hub')) errors.push(...boundsErrors(loc.hub, bounds));
  if (!isText(brandName, 80)) errors.push('bad_brand_name');
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  const identity = {
    name: brandName, brand_id: draft.brand_id, location_name: draft.location_name, phone: draft.phone, hours: draft.hours,
    prep_default_min: draft.prep_default_min, hub_lat: loc.hub.lat, hub_lng: loc.hub.lng, address_line: loc.address_line,
    zone: { type: 'circle', radius_km: km }, delivery_radius_km: km, whatsapp_instance: '', whatsapp_enabled: false,   // WhatsApp sender is per BRAND (R8)
    active: false, active_changed_at: now, version: 1,
  };
  if (typeof loc.address_reference === 'string' && loc.address_reference) identity.address_reference = loc.address_reference;
  return { ok: true, identity };
}

// Sherpa admin: move the pin / address (only while OFF and drained) or change the radius (any time)
function planSetLocation({ identity, input, bounds, liveOrders, now, expectedVersion }) {
  const id = identity || {}; const inp = isObj(input) ? input : {};
  const errors = [];
  if (id.version !== expectedVersion) errors.push('stale_branch');
  const patch = {};
  let moves = false;
  if (inp.hub !== undefined) {
    const he = hubErrors(inp.hub); errors.push(...he);
    if (!he.length) {
      errors.push(...boundsErrors(inp.hub, bounds));
      if (inp.hub.lat !== id.hub_lat || inp.hub.lng !== id.hub_lng) { patch.hub_lat = inp.hub.lat; patch.hub_lng = inp.hub.lng; moves = true; }
    }
  }
  errors.push(...addressErrors(inp.address_line, inp.address_reference, false));
  if (inp.address_line !== undefined && inp.address_line !== id.address_line) { patch.address_line = inp.address_line; moves = true; }
  if (inp.address_reference !== undefined && (inp.address_reference || null) !== (id.address_reference || null)) { patch.address_reference = inp.address_reference || null; moves = true; }
  if (inp.zone_radius_km !== undefined) {
    errors.push(...zoneErrors(inp.zone_radius_km));
    if (!(id.zone && id.zone.radius_km === inp.zone_radius_km && id.delivery_radius_km === inp.zone_radius_km)) {
      patch.zone = { type: 'circle', radius_km: inp.zone_radius_km }; patch.delivery_radius_km = inp.zone_radius_km;
    }
  }
  if (moves) {
    if (id.active !== false) errors.push('branch_active');
    else if (!Number.isFinite(id.active_changed_at) || now - id.active_changed_at < MOVE_QUIET_MS) errors.push('branch_recently_active');
    if (liveOrders !== 0) errors.push('branch_has_live_orders');
  }
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  if (!Object.keys(patch).length) return { ok: false, errors: ['noop'] };
  return { ok: true, patch: { ...patch, version: id.version + 1 } };
}

// name / phone (owner: 'profile'), hours ('hours'), prep ('prep') — never hub / address / zone / active / anything else
const GROUP_OF = { location_name: 'profile', phone: 'profile', hours: 'hours', prep_default_min: 'prep' };
const GROUP_ORDER = ['profile', 'hours', 'prep'];
function planProfilePatch({ current, patch, expectedVersion }) {
  const cur = current || {}; const p = isObj(patch) ? patch : {};
  const errors = [];
  if (Object.keys(p).some((k) => !(k in GROUP_OF))) errors.push('forbidden_field');
  if (cur.version !== expectedVersion) errors.push('stale_branch');
  if ('location_name' in p && !isText(p.location_name, NAME_MAX)) errors.push('bad_name');
  if ('phone' in p && (typeof p.phone !== 'string' || !PHONE.test(p.phone))) errors.push('bad_phone');
  if ('hours' in p && hours7Errors(p.hours).length) errors.push('bad_hours');
  if ('prep_default_min' in p && !isPrep(p.prep_default_min)) errors.push('bad_prep');
  if (errors.length) return { ok: false, errors };
  const out = {};
  for (const [k, v] of Object.entries(p)) if (!same(cur[k], v)) out[k] = v;
  if (!Object.keys(out).length) return { ok: false, errors: ['noop'] };
  const groups = GROUP_ORDER.filter((g) => Object.keys(out).some((k) => GROUP_OF[k] === g));
  return { ok: true, patch: { ...out, version: cur.version + 1 }, groups };
}

// O1b T6 (plan r3.2 §5, Codex r1 #8) — the PUBLISHED readiness vocabulary (exactly six codes, in check order) and the
// identity_gaps sub-reasons of identity_invalid (a closed, ordered set). readinessOf validates the RAW stored identity — nothing
// masked (a malformed `active` is an integrity gap): location / zone / hours / prep each by its own predicate; `integrity` =
// anything else validateBranchIdentity rejects once those four are replaced by valid stand-ins. Address is never a gap.
const READINESS_CODES = Object.freeze(['identity_invalid', 'not_a_branch', 'brand_not_on', 'no_handheld_online', 'no_owner_or_manager', 'menu_not_published']);
const IDENTITY_GAPS = Object.freeze(['location', 'zone', 'hours', 'prep', 'integrity']);
const STAND_IN_HOURS = Object.fromEntries(DAYS.map((d) => [d, { open: false }]));
function readinessOf(identity, brandId) {   // brandId: the brand the branch belongs to (default: its own brand_id)
  const id = isObj(identity) ? identity : {};
  const gaps = [];
  if (!(Number.isFinite(id.hub_lat) && Number.isFinite(id.hub_lng) && Math.abs(id.hub_lat) <= 90 && Math.abs(id.hub_lng) <= 180)) gaps.push('location');
  if (validateZone(id.zone).length || !Number.isFinite(id.delivery_radius_km) || id.zone.radius_km !== id.delivery_radius_km) gaps.push('zone');
  if (hours7Errors(id.hours).length) gaps.push('hours');
  if (!isPrep(id.prep_default_min)) gaps.push('prep');
  const standIn = { ...id, hub_lat: 0, hub_lng: 0, delivery_radius_km: DEFAULT_ZONE_KM, zone: { type: 'circle', radius_km: DEFAULT_ZONE_KM }, hours: STAND_IN_HOURS, prep_default_min: 20 };
  if (!isObj(identity) || !validateBranchIdentity('branch', standIn, brandId === undefined ? id.brand_id : brandId).ok) gaps.push('integrity');
  return { gaps };
}

// activate (readiness) / deactivate (always) — facts are read by the writer
function planSetActive({ identity, active, facts, now, expectedVersion }) {
  const id = identity || {}; const f = facts || {};
  if (id.version !== expectedVersion) return { ok: false, error: 'stale_branch' };
  if ((id.active === true) === (active === true)) return { ok: false, error: 'noop' };
  const patch = { active: active === true, active_changed_at: now, version: id.version + 1 };
  if (active !== true) return { ok: true, patch, membershipTo: null };
  const unmet = [];
  const { gaps } = readinessOf(identity, f.brandId);   // O1b T6: the RAW identity — no { ...id, active: true } masking
  if (gaps.length) unmet.push('identity_invalid');
  if (f.membership !== 'staged' && f.membership !== 'member') unmet.push('not_a_branch');
  if (f.brandState !== 'on') unmet.push('brand_not_on');
  if (f.handheldSeen !== true) unmet.push('no_handheld_online');
  if (!(f.teamCount >= 1)) unmet.push('no_owner_or_manager');
  if (f.menuPublished !== true) unmet.push('menu_not_published');
  if (unmet.length) return gaps.length ? { ok: false, error: 'not_ready', unmet, identity_gaps: gaps } : { ok: false, error: 'not_ready', unmet };
  return { ok: true, patch, membershipTo: f.membership === 'staged' ? 'member' : null };
}

// Sherpa admin, before a legacy brand's cutover: ADDITIVE branch fields on the legacy branch's own identity
function planEnrichLegacy({ rid, identity, brand, input, expectedVersion }) {
  const id = identity || {}; const b = brand || {}; const inp = isObj(input) ? input : {};
  const errors = [];
  if (!(b.activation && b.activation.state === 'legacy')) errors.push('brand_not_legacy');
  if (!(isObj(b.locations) && b.locations[rid] === 'member')) errors.push('not_the_legacy_branch');
  if (id.brand_id !== undefined) errors.push('already_enriched');
  if (id.version !== expectedVersion) errors.push('stale_branch');
  if (!isText(inp.location_name, NAME_MAX)) errors.push('bad_name');
  if (!isPrep(inp.prep_default_min)) errors.push('bad_prep');
  errors.push(...addressErrors(inp.address_line, inp.address_reference, false));
  if (!Number.isFinite(id.delivery_radius_km) || zoneErrors(id.delivery_radius_km).length) errors.push('bad_zone');
  if (errors.length) return { ok: false, errors };
  const patch = { brand_id: rid, location_name: inp.location_name, zone: { type: 'circle', radius_km: id.delivery_radius_km }, prep_default_min: inp.prep_default_min };
  if (inp.address_line !== undefined) patch.address_line = inp.address_line;
  if (typeof inp.address_reference === 'string' && inp.address_reference) patch.address_reference = inp.address_reference;
  return { ok: true, patch: { ...patch, version: id.version + 1 } };
}

module.exports = { READINESS_CODES, IDENTITY_GAPS, readinessOf, draftErrors, hours7Errors, planMaterialize, planSetLocation, planProfilePatch, planSetActive, planEnrichLegacy,
  MOVE_QUIET_MS, DEFAULT_ZONE_KM, DAYS };
