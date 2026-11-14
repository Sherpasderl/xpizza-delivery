'use strict';
// PLAN-3a-capp-offers-read r0 Q1 (advisor APPROVED 2026-11-14) — the served `offers` decoration of the PUBLIC MENU, and the directory's
// offer flag (offerFlagOf → { offers: [{ type, pct?, off_cents?, min_cents? }] }, wired by the directory's owner). Only when platform_config/marketing.offers_enabled is on (its ONE reader);
// off, or on any trouble, the key is ABSENT — the body, and so the ETag (public-menu.js: sha256 over rid + representation + the
// canonical body), are byte-identical to before.
//   SOURCE: marketing_live/{rid} — the price path's own mirror (present only while an offer is active, ≤ LIMITS.live_max). The PRICE
//   PATH stays the authority: a served offer is a hint; a paused / ended one is refused at the quote (offer_changed).
//   SERVED: [{ type, params, schedule }] for audience 'all' offers whose schedule has not ended — public params only (pct { pct,
//   max_cents? } · lps { off_cents, min_cents } · envio { min_cents? } · bogo { items | cats, free_per_order }; a category offer
//   serves its cats, never the ≤ 100 resolved keys), the schedule as stored (window in minutes after HN midnight). Never the name,
//   the caps, the rev, the brand or the offer id; never nuevos / returning offers.
//   NON-BLOCKING: catalog/serve-memo (the dish_stats memo): OK 60 s (an owner's pause leaves the menu within ~3.5 min with the
//   menu's own max-age 30 / s-maxage 120 — advisor 11-14, accepted), failure 30 s, a stale success kept ≤ 5 min through failed
//   refreshes, a 1.5 s read deadline. BOUND: ≤ OFFERS_MAX entries within OFFERS_BYTES of canonical JSON — the latest-starting
//   entries drop first (deterministic).
const CFG = require('../marketing/config');
const OM = require('../marketing/offer-model');
const OR = require('../marketing/offer-rules');

const OFFERS_TIMEOUT_MS = 1500;
const OK_TTL_MS = 60 * 1000;
const FAIL_TTL_MS = 30 * 1000;
const STALE_MAX_MS = 5 * 60 * 1000;
const OFFERS_MAX = OM.LIMITS.live_max;
const OFFERS_BYTES = 8192;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nul = (v) => (v === undefined ? null : v);
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// the read behind the memo: the switch, then (only when on) the rid's mirror → { on, live }. A config outage THROWS (a failed read:
// nothing served), never a guessed «on».
async function readOffers(rid, deps) {
  const db = deps.rtdb || require('firebase-admin/database').getDatabase();
  const cfg = await CFG.readMarketingConfig(db);
  if (cfg.unavailable) throw new Error('offers_config_unavailable');
  if (cfg.offers_enabled !== true) return { on: false, live: null };
  const live = (await db.ref(`marketing_live/${rid}`).once('value')).val();
  return { on: true, live };
}
const SM = require('./serve-memo').createServeMemo({ okTtlMs: OK_TTL_MS, failTtlMs: FAIL_TTL_MS, staleMaxMs: STALE_MAX_MS, timeoutMs: OFFERS_TIMEOUT_MS,
  timeoutError: 'offers_timeout', absentLog: 'public_menu_offers_absent', defaultRead: readOffers });

// ONE mirror entry → its public shape, or null (never served: another audience, malformed, ended)
function publicOffer(e, nowMs) {
  if (!isObj(e) || e.audience !== 'all' || !OM.TYPES.includes(e.type) || e.type === 'nuevos') return null;
  const params = OM.paramsOf(e.type, e.params, true);
  const s = isObj(e.schedule) ? OM.scheduleOf({ days: e.schedule.days, start: nul(e.schedule.start), end: nul(e.schedule.end), window: nul(e.schedule.window) }) : null;
  if (!params || !s || s.start === null) return null;
  if (s.end !== null && nowMs >= s.end) return null;
  const pub = e.type === 'bogo' ? (Array.isArray(params.cats) ? { cats: params.cats, free_per_order: params.free_per_order } : { items: params.items, free_per_order: params.free_per_order }) : params;
  return { type: e.type, params: pub, schedule: OM.stripNulls(s) };
}

// the WHOLE served field from a read → an array, or null (omit)
function selectOffers(raw, nowMs) {
  if (!isObj(raw) || raw.on !== true || !isObj(raw.live)) return null;
  let rows = Object.entries(raw.live).filter(([id]) => OM.OFFER_ID_RE.test(id)).map(([, e]) => publicOffer(e, nowMs)).filter(Boolean)
    .sort((a, b) => (a.schedule.start - b.schedule.start) || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || (canonicalJson(a) < canonicalJson(b) ? -1 : 1))
    .slice(0, OFFERS_MAX);
  while (rows.length && Buffer.byteLength(canonicalJson(rows)) > OFFERS_BYTES) rows = rows.slice(0, -1);   // the latest-starting drop first
  return rows.length ? rows : null;
}

// buildPublicMenu's hook: the body with `offers` when the memo holds served offers, else the body unchanged. Never throws, never awaits.
async function withOffers(rid, body, deps = {}) {
  try {
    const m = SM.memoFor(rid, deps);
    if (!m) return body;
    const offers = selectOffers(m.raw, deps.now ? deps.now() : Date.now());
    return offers ? { ...body, offers } : body;
  } catch (e) {
    console.warn('public_menu_offers_absent', JSON.stringify({ rid, reason: 'error' }));
    return body;
  }
}

// the directory's flag (Q-B; shape set by capp, advisor 11-14): { offers: [{ type, pct?, off_cents?, min_cents? }] } (≤ OFFERS_MAX) or
// null — the PUBLIC AMOUNTS of the live audience-'all' offers INSIDE their schedule window right now (a home chip must be honest on its
// own: «Envío gratis» carries its minimum, rule 10). Never a name, items, caps, schedule or id; a bogo carries no amount. The window
// is the offer model's own weekly rule (weeklyIntervals: a window past midnight belongs to the day it starts), in HN time.
const FLAG_FIELDS = Object.freeze(['pct', 'off_cents', 'min_cents']);
function inWindowNow(schedule, nowMs) {
  return OR.inWindow(schedule, nowMs);   // the ONE in-window rule, shared with the capp (marketing/offer-rules.js; advisor 11-14)
}
function flagOf(raw, nowMs) {
  if (!isObj(raw) || raw.on !== true || !isObj(raw.live)) return null;
  const rows = Object.entries(raw.live).filter(([id]) => OM.OFFER_ID_RE.test(id)).map(([, e]) => publicOffer(e, nowMs))
    .filter((o) => o && inWindowNow(o.schedule, nowMs))
    .map((o) => ({ type: o.type, ...Object.fromEntries(FLAG_FIELDS.filter((k) => Number.isSafeInteger(o.params[k])).map((k) => [k, o.params[k]])) }))
    .sort((a, b) => (canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0))
    .slice(0, OFFERS_MAX);
  return rows.length ? { offers: rows } : null;
}
function offerFlagOf(rid, deps = {}) {
  try {
    const m = SM.memoFor(rid, deps);
    return m ? flagOf(m.raw, deps.now ? deps.now() : Date.now()) : null;
  } catch (_) { return null; }
}

module.exports = { withOffers, offerFlagOf, flagOf, inWindowNow, selectOffers, publicOffer, OFFERS_MAX, OFFERS_BYTES, OFFERS_TIMEOUT_MS, OK_TTL_MS, FAIL_TTL_MS, STALE_MAX_MS, _state: SM.state };
