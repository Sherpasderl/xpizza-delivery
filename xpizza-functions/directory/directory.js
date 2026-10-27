'use strict';
// S7a-1 RESTAURANT DIRECTORY (BRIEF-5f-capp-directory r0 + r1/r2/r3; PLAN-capp-S7a r1 §1.2, r2 §1.2, r3 §3-5).
// ONE response schema, built FIELD BY FIELD from an explicit allowlist; a dependency matrix that tells "confirmed absent"
// from "read failed"; a full-body ETag ONLY when complete; a partial or failed build never answers 304.
//
// Every value has ONE server reader, injected (so this module holds no I/O of its own and is testable with fakes):
//   readRegistry()           → restaurantRegistry().readNow()  {ok, ids}            (failure ⇒ 503)
//   readPlatform()           → platform_config/customer_app (allowlisted) | null     (throw ⇒ 503)
//   activity(rid)            → catalog/public-menu.activityWithSource  {active, source, identity}  (throw ⇒ unavailable[])
//   loadSchedule(rid)        → schedule/load-schedule (S4 C′)  {valid, hours, cfg, source}  (throw ⇒ schedule unavailable)
//   readPresentation(rid)    → restaurants/{rid}/presentation | null                  (throw ⇒ degraded, partial)
//   pricingView(rid, id)     → the Sherpa delivery readers (wired later, on a base with the delivery modules):
//                              { fee:{state:'priced',from_cents}|{state:'none'|'invalid'}, promo:{free_delivery,label}|null,
//                                coverage_km:number|null }                           (throw ⇒ fee unavailable, partial)
// house ids are served UNFILTERED (no catalog dependency; the client MenuCache drops ids its loaded menu lacks).
const crypto = require('crypto');
const { FIELD_NAMES, pickPresentation } = require('./presentation-shape');
const { toPublicSchedule } = require('../schedule/schedule-only');   // the SAME public schedule shape schedule_only serves

const REPRESENTATION_VERSION = 'directory-1';
// the per-restaurant allowlist, in output order
const ENTRY_FIELDS = Object.freeze(['restaurant_id', 'name', 'kicker', 'unit', 'cuisines', 'logo_url', 'logo_wide', 'hero_url', 'asset_base',
  'branch', 'pickup_addr', 'coverage_km', 'hub_lat', 'hub_lng', 'eta_delivery_min', 'eta_pickup_min', 'payments', 'pickup',
  'schedule', 'schedule_state', 'fee', 'promo', 'order_id_prefix', 'house', 'meals', 'degraded']);
const BODY_FIELDS = Object.freeze(['representation_version', 'complete', 'platform', 'restaurants', 'unavailable']);
const FEE_STATES = new Set(['priced', 'none', 'invalid', 'unavailable']);

const isStr = (v) => typeof v === 'string' && v.length > 0;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// the identity-sourced presentation (existing identity fields only; never the raw identity)
function identityFields(id) {
  return {
    name: isStr(id && id.display_name) ? id.display_name : (isStr(id && id.name) ? id.name : null),
    branch: isStr(id && id.location_name) ? id.location_name : null,
    pickup_addr: isStr(id && id.address_line) ? id.address_line : null,
    hub_lat: num(id && id.hub_lat),
    hub_lng: num(id && id.hub_lng),
  };
}
function feeOf(f) {
  if (!f || !FEE_STATES.has(f.state)) return { state: 'invalid' };
  if (f.state === 'priced') return Number.isInteger(f.from_cents) && f.from_cents >= 0 ? { state: 'priced', from_cents: f.from_cents } : { state: 'invalid' };
  return { state: f.state };
}
function promoOf(p) {
  if (!p || typeof p !== 'object') return null;
  return { free_delivery: p.free_delivery === true, label: typeof p.label === 'string' && p.label.length ? p.label : null };
}

async function buildEntry(rid, identity, deps) {
  let partial = false;
  const degraded = [];
  const row = { restaurant_id: rid, ...identityFields(identity) };
  for (const k of ['name', 'branch', 'pickup_addr', 'hub_lat', 'hub_lng']) if (row[k] === null) degraded.push(k);

  let pres = { fields: {}, invalid: [] };
  try { pres = pickPresentation(await deps.readPresentation(rid)); }
  catch (_) { partial = true; }
  for (const k of FIELD_NAMES) {
    if (pres.fields[k] !== undefined) row[k] = pres.fields[k];
    else { row[k] = null; degraded.push(k); }
  }

  try {
    const s = await deps.loadSchedule(rid);
    if (s && s.valid) { row.schedule = toPublicSchedule(s); row.schedule_state = 'ok'; }
    else { row.schedule = null; row.schedule_state = 'unavailable'; }
    if (!s || s.source !== 'fresh') partial = true;      // a cache-sourced (or unknown-source) schedule ⇒ partial
  } catch (_) { row.schedule = null; row.schedule_state = 'unavailable'; partial = true; }

  try {
    const pv = await deps.pricingView(rid, identity);
    row.fee = feeOf(pv && pv.fee);
    row.promo = promoOf(pv && pv.promo);
    row.coverage_km = num(pv && pv.coverage_km);
    if (row.fee.state === 'unavailable') partial = true;
  } catch (_) { row.fee = { state: 'unavailable' }; row.promo = null; row.coverage_km = null; partial = true; }

  row.degraded = [...new Set(degraded)].sort();
  const out = {};
  for (const k of ENTRY_FIELDS) out[k] = row[k] === undefined ? null : row[k];   // ONE schema: every allowlisted key, nothing else
  return { row: out, partial };
}

// → { status: 200, body } | { status: 503 }
async function buildDirectory(deps) {
  let reg;
  try { reg = await deps.readRegistry(); } catch (_) { reg = null; }
  if (!reg || reg.ok !== true || !Array.isArray(reg.ids)) return { status: 503 };
  let platform;
  try { platform = await deps.readPlatform(); } catch (_) { return { status: 503 }; }
  let complete = true;
  const restaurants = []; const unavailable = [];
  for (const rid of reg.ids) {
    let act;
    try { act = await deps.activity(rid); } catch (_) { unavailable.push(rid); complete = false; continue; }
    if (!act || act.active !== true) continue;                 // inactive (or cannot tell) ⇒ never listed
    if (act.source !== 'fresh') complete = false;              // a cache-served identity ⇒ partial
    const { row, partial } = await buildEntry(rid, act.identity, deps);
    if (partial) complete = false;
    restaurants.push(row);
  }
  const body = { representation_version: REPRESENTATION_VERSION, complete, platform: platform === undefined ? null : platform, restaurants, unavailable };
  return { status: 200, body };
}

function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const etagOf = (body) => `"${crypto.createHash('sha256').update(`${REPRESENTATION_VERSION} ${canonicalJson(body)}`).digest('hex')}"`;
function matchesEtag(header, etag) {   // the same semantics as index.js's getPublicMenu matcher (strong/weak, list, *)
  if (!header) return false;
  const c = String(header).split(',').map((s) => s.trim()).filter(Boolean);
  if (c.includes('*')) return true;
  const bare = (v) => v.replace(/^W\//, '');
  return c.some((x) => bare(x) === bare(etag));
}
// raw JSON write: res.end bypasses Express's automatic ETag, so a partial / failed body can never carry a validator
const sendJson = (res, status, obj) => { res.status(status); res.set('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };

async function handleDirectory(req, res, deps) {
  res.set('Access-Control-Expose-Headers', 'ETag');
  if (req.method !== 'GET') { res.set('Cache-Control', 'no-store'); return sendJson(res, 405, { ok: false, error: 'method_not_allowed' }); }
  let r;
  try { r = await buildDirectory(deps); } catch (_) { r = { status: 503 }; }
  if (r.status !== 200) { res.set('Cache-Control', 'no-store'); return sendJson(res, 503, { ok: false, error: 'directory_unavailable', retryable: true }); }
  if (!r.body.complete) { res.set('Cache-Control', 'no-store'); return sendJson(res, 200, r.body); }   // partial: no ETag, never 304
  const etag = etagOf(r.body);
  res.set('ETag', etag);
  res.set('Cache-Control', 'public, max-age=30');
  if (matchesEtag(req.get && req.get('If-None-Match'), etag)) return res.status(304).end();
  return sendJson(res, 200, r.body);
}

module.exports = { buildDirectory, handleDirectory, ENTRY_FIELDS, BODY_FIELDS, REPRESENTATION_VERSION, etagOf, canonicalJson };
