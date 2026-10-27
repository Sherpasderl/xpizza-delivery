'use strict';
// S4 C′ (PLAN-capp-S4-r4 §2) — quoteOrder's `schedule_only` mode: the app picker's schedule read, served by the SAME boundary
// (loadSchedule) and the SAME cfg the intake gate enforces. index.js calls handle() ONLY when body.schedule_only === true
// (a one-line, delimited hook after clientIp and BEFORE the quote_ip limiter and any pricing), so an ordinary quote never
// loads this module. Inside:
//   • app-scoped: entry_mode !== 'app' → returns false and the ordinary quote path runs exactly as today;
//   • its OWN limiter bucket `schedule_ip` (bookkeeping writes only) — schedule refreshes never spend quote_ip capacity;
//   • visibility: only a member location of a PUBLISHED public/brands projection; any other rid gets bytes identical to the
//     unknown-restaurant 400 (built by the same resolveRestaurantId message);
//   • no pricing, catalog, quote-token, reward or business write — ever.
// Returns true when it has sent the response.
const SCHED = require('../scheduled-orders');
const { resolveRestaurantId } = require('../restaurant-id');
const { loadSchedule } = require('./load-schedule');

const SCHEDULE_IP_BUCKET = Object.freeze({ windowMs: 10 * 60 * 1000, max: 120 });
const LISTED_TTL_MS = 30 * 1000;
const TZ_OFFSET_MIN = -SCHED.TZ_OFFSET_MS / 60000;   // America/Tegucigalpa (UTC−6) → -360, from the same constant the gate uses

let listedCache = null;   // { at, rids:Set }

// rid → is it a member location of some published /public/brands/{brandId} projection (brand-projection.js)?
async function isPubliclyListed(db, rid, nowMs) {
  if (!listedCache || nowMs - listedCache.at > LISTED_TTL_MS) {
    const all = (await db.ref('public/brands').once('value')).val() || {};
    const rids = new Set();
    for (const b of Object.values(all)) {
      if (b && typeof b === 'object' && b.locations && typeof b.locations === 'object') for (const r of Object.keys(b.locations)) rids.add(r);
    }
    listedCache = { at: nowMs, rids };
  }
  return listedCache.rids.has(rid);
}

// The customer-facing minimum lead for a fulfilment type = max(minLeadMin, that type's release lead), the floor
// validateScheduledFor enforces. The release lead is DERIVED from the exported releaseAtFor (scheduled-orders.js is pinned
// by the order-control guard, so no new export); a test pins this against validateScheduledFor's real accept/refuse edge.
const releaseLeadMin = (orderType, c) => (0 - SCHED.releaseAtFor(0, orderType, c)) / 60000;
const minLeadFor = (orderType, c) => Math.max(c.minLeadMin, releaseLeadMin(orderType, c));

function toPublicSchedule(s) {
  const c = s.cfg;
  return {
    tz_offset_min: TZ_OFFSET_MIN,
    slot_min: c.slotMin,
    lead_min: { pickup: minLeadFor('pickup', c), delivery: minLeadFor('delivery', c) },
    horizon_h: c.maxHorizonHours,
    hours: s.hours,
  };
}

async function handle({ res, body, db, restaurantId, clientIp, checkRateLimit, deps = {} }) {
  if (!body || body.schedule_only !== true || body.entry_mode !== 'app') return false;   // not an app schedule read
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  const { allowed, retryAfterSec } = await checkRateLimit(db, 'schedule_ip', clientIp, SCHEDULE_IP_BUCKET);
  if (!allowed) {
    res.set('Retry-After', String(retryAfterSec));
    res.status(429).json({ ok: false, error: 'rate_limited' });
    return true;
  }
  let listed;
  try { listed = await isPubliclyListed(db, restaurantId, nowMs); } catch (_) { listed = null; }
  if (listed === null) { res.status(503).json({ ok: false, error: 'schedule_unavailable', retryable: true }); return true; }
  if (!listed) {
    // byte-identical to quoteOrder's unknown-restaurant answer: the same 400 shape and the same resolver's message
    res.status(400).json({ ok: false, error: 'bad_request', detail: resolveRestaurantId(restaurantId, new Set()).error });
    return true;
  }
  let s = null;
  try { s = await loadSchedule(db, restaurantId, { getIdentity: deps.getIdentity, now: nowMs }); } catch (_) { s = null; }
  if (!s || !s.valid) { res.status(503).json({ ok: false, error: 'schedule_unavailable', retryable: true }); return true; }
  res.status(200).json({ ok: true, schedule: toPublicSchedule(s) });
  return true;
}

const _resetListedCache = () => { listedCache = null; };   // tests only

module.exports = { handle, isPubliclyListed, toPublicSchedule, minLeadFor, SCHEDULE_IP_BUCKET, _resetListedCache };
