'use strict';
// PLAN-3a-marketing-server r0 §2.1 / §3.3 (advisor APPROVED 2026-11-14) — the restaurant OFFER, pure: its one shape rule, the
// live-edit allowlist, the weekly overlap rule and the compact record the price path reads (marketing_brand/{brandId}/live/{rid}/{offerId}).
// Restaurant-funded (owner 11-12): no field here can express a Sherpa subsidy. Dish identity is by KEY only; never a price copy.
// Brand-agnostic: no rid / brand literal. No PII.
//
// Stored states: draft | active | paused_owner | ended. «Programada» / «Activa» / «Terminada» (by schedule) are DERIVED from an
// active offer's schedule at read time (statusOf) — no job flips a state, and the price path evaluates the schedule itself.
// RTDB drops nulls: an absent end / window / cap / start IS null (the parsers read it back that way).

const TYPES = Object.freeze(['pct', 'lps', 'bogo', 'envio', 'nuevos']);   // every type a STORED record may carry
// the types v1 may author, activate and project (owner 11-15): «envío gratis» waits for the payout ledger (nothing can deduct the waived
// fee from the restaurant yet) — an old envío record still READS (it can be listed and ended), never goes live.
const V1_TYPES = Object.freeze(['pct', 'lps', 'bogo', 'nuevos']);
const typeSupported = (type) => V1_TYPES.includes(type);
const AUDIENCES = Object.freeze(['all', 'new', 'returning']);
const STATES = Object.freeze(['draft', 'active', 'paused_owner', 'ended']);   // (r3: a refused program is never a record — its claim carries the refusal)
const LIMITS = Object.freeze({
  name_max: 40, branches_max: 10, items_max: 10, cats_max: 2, free_per_order_max: 3,
  cat_items_max: 100,                                // a category offer's RESOLVED dish keys (frozen at save / publish)
  pct_min: 5, pct_max: 50, pct_step: 5,              // Q2 (advisor): 50 % is a typo guard, not a business rule
  cents_max: 10_000_000,                             // L 100,000 — a sanity bound on any money field (centavos)
  live_max: 10, offers_max: 100,                     // per branch (scheduled + live) · per brand (every state)
  ended_retain_ms: 180 * 86400000,                   // Q4 (advisor): ended offers pruned after 180 days
  start_skew_ms: 60000,
});
const OFFER_ID_RE = /^o_[a-z2-7]{12}$/;
const KEY_MAX = 200;
const HN_OFFSET_MS = 6 * 3600000;   // Honduras: UTC−6, no DST (lib/hn-date.js)

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const fail = (field, reason) => ({ ok: false, field, reason });
const exactKeys = (o, req, opt = []) => isObj(o) && req.every((k) => k in o) && Object.keys(o).every((k) => req.includes(k) || opt.includes(k));
const nul = (v) => (v === undefined ? null : v);
const keyOk = (k) => typeof k === 'string' && k.length >= 1 && k.length <= KEY_MAX;
const uniq = (a) => new Set(a).size === a.length;

// the offer's NAME as the merchant typed it: trimmed, 1..40, no control characters
function nameOf(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= LIMITS.name_max && !/[\u0000-\u001f\u007f]/.test(s) ? s : null;
}

function paramsOf(type, p, stored = false) {
  // EVERY money field (advisor 11-14, 5f's price-plan review): whole lempiras (a multiple of 100 centavos), positive; an absent field
  // means «none» — never a 0 sentinel on a money field
  const c = (v) => isInt(v, 100, LIMITS.cents_max) && v % 100 === 0;
  if (type === 'pct') {
    if (!exactKeys(p, ['pct'], ['max_cents'])) return null;
    if (!isInt(p.pct, LIMITS.pct_min, LIMITS.pct_max) || p.pct % LIMITS.pct_step !== 0) return null;
    const max = nul(p.max_cents);   // absent / null = no maximum
    if (max !== null && !c(max)) return null;
    return { pct: p.pct, ...(max !== null ? { max_cents: max } : {}) };
  }
  if (type === 'lps') {
    if (!exactKeys(p, ['off_cents', 'min_cents'])) return null;
    // a lempira discount can never exceed the order it applies to: min ≥ off (never a money decision — a typo guard)
    return c(p.off_cents) && c(p.min_cents) && p.min_cents >= p.off_cents ? { off_cents: p.off_cents, min_cents: p.min_cents } : null;
  }
  if (type === 'bogo') {
    // AUTHORED (the builder): items XOR cats. STORED: a category offer also carries `items`, its dishes RESOLVED from each branch's
    // active catalog version at save / publish (advisor 11-14: frozen at publish; a dish added to the category later is covered only
    // after a re-save). The price path and the overlap rule read `items` only.
    const hasItems = isObj(p) && 'items' in p, hasCats = isObj(p) && 'cats' in p;
    if (stored ? !(hasItems || hasCats) || (hasCats && !hasItems) : hasItems === hasCats) return null;
    if (!exactKeys(p, ['free_per_order'], ['items', 'cats'])) return null;
    if (!isInt(p.free_per_order, 1, LIMITS.free_per_order_max)) return null;
    const listOk = (list, max) => Array.isArray(list) && list.length >= 1 && list.length <= max && list.every(keyOk) && uniq(list);
    if (hasCats) {
      if (!listOk(p.cats, LIMITS.cats_max)) return null;
      if (hasItems && !listOk(p.items, LIMITS.cat_items_max)) return null;
      return { cats: [...p.cats], ...(hasItems ? { items: [...p.items] } : {}), free_per_order: p.free_per_order };
    }
    if (!listOk(p.items, LIMITS.items_max)) return null;
    return { items: [...p.items], free_per_order: p.free_per_order };
  }
  if (type === 'envio') {
    if (stored && (p === undefined || p === null)) p = {};   // RTDB never stores an empty object: a STORED «sin mínimo» envío reads back params-less
    if (!exactKeys(p, [], ['min_cents'])) return null;
    const min = nul(p.min_cents);   // absent / null = no minimum order
    if (min !== null && !c(min)) return null;
    return min !== null ? { min_cents: min } : {};
  }
  if (type === 'nuevos') {
    const hasOff = isObj(p) && 'off_cents' in p, hasPct = isObj(p) && 'pct' in p;
    if (hasOff === hasPct || !exactKeys(p, [], ['off_cents', 'pct'])) return null;
    if (hasOff) return c(p.off_cents) ? { off_cents: p.off_cents } : null;
    return isInt(p.pct, LIMITS.pct_min, LIMITS.pct_max) && p.pct % LIMITS.pct_step === 0 ? { pct: p.pct } : null;
  }
  return null;
}

// schedule { start: ms|null (null only in a draft), end: ms|null, days: [0..6] (0 = Sunday, HN), window: {from,to}|null }, the
// window in MINUTES after HN midnight (0..1439): stored as numbers so no reader parses a clock string (the portal formats it)
function scheduleOf(s) {
  if (!exactKeys(s, ['days'], ['start', 'end', 'window'])) return null;
  const start = nul(s.start), end = nul(s.end), window = nul(s.window);
  if (start !== null && !isInt(start, 0, 8.64e15)) return null;
  if (end !== null && !(isInt(end, 0, 8.64e15) && (start === null || end > start))) return null;
  if (!Array.isArray(s.days) || s.days.length < 1 || !s.days.every((d) => isInt(d, 0, 6)) || !uniq(s.days)) return null;
  let win = null;
  if (window !== null) {
    if (!exactKeys(window, ['from', 'to']) || !isInt(window.from, 0, 1439) || !isInt(window.to, 0, 1439) || window.from === window.to) return null;
    win = { from: window.from, to: window.to };
  }
  return { start, end, days: [...s.days].sort((a, b) => a - b), window: win };
}

// The AUTHORED fields of an offer (what the builder sends) → { ok, value } | { ok:false, field, reason }. `isRid` is the location-id
// rule (brands/brand-model isBrandId), injected so this module stays pure.
// v1 has NO caps (owner 11-15: spend caps come in v2, on the payout ledger): an authored `caps` other than absent / null is REFUSED
// (never stored, never half-enforced); a STORED record from before carries it harmlessly — ignored on read, dropped on the next save.
const AUTHORED = Object.freeze(['name', 'type', 'params', 'audience', 'branches', 'schedule']);
function validateAuthored(input, { isRid, stored = false }) {
  if (!exactKeys(input, AUTHORED, ['caps'])) return fail('offer', 'bad_shape');
  if (!stored && input.caps !== undefined && input.caps !== null) return fail('caps', 'caps_not_supported');
  const name = nameOf(input.name);
  if (name === null) return fail('name', 'bad_name');
  if (!TYPES.includes(input.type)) return fail('type', 'bad_type');
  if (!stored && !typeSupported(input.type)) return fail('type', 'type_not_supported');
  const params = paramsOf(input.type, input.params, stored);
  if (params === null) return fail('params', 'bad_params');
  if (!AUDIENCES.includes(input.audience)) return fail('audience', 'bad_audience');
  if (input.type === 'nuevos' && input.audience !== 'new') return fail('audience', 'nuevos_is_new');   // «Para clientes nuevos»
  const b = input.branches;
  if (!Array.isArray(b) || b.length < 1 || b.length > LIMITS.branches_max || !b.every((r) => isRid(r)) || !uniq(b)) return fail('branches', 'bad_branches');
  const schedule = scheduleOf(input.schedule);
  if (schedule === null) return fail('schedule', 'bad_schedule');
  return { ok: true, value: { name, type: input.type, params, audience: input.audience, branches: [...b].sort(), schedule } };
}

// publish-time rules on top of the shape: a start, not in the past (one minute of clock skew)
function validatePublishable(value, nowMs) {
  if (value.schedule.start === null) return fail('schedule', 'start_required');
  if (value.schedule.start < nowMs - LIMITS.start_skew_ms) return fail('schedule', 'start_past');
  if (value.schedule.end !== null && value.schedule.end <= nowMs) return fail('schedule', 'end_past');
  return { ok: true };
}

// A STORED record → the same normalized authored value (nulls restored), or null when it is off-shape (never repaired).
function authoredOf(rec, { isRid }) {
  if (!isObj(rec)) return null;
  const pick = {};
  for (const k of AUTHORED) pick[k] = rec[k];
  if (isObj(pick.schedule)) pick.schedule = { days: pick.schedule.days, start: nul(pick.schedule.start), end: nul(pick.schedule.end), window: nul(pick.schedule.window) };
  const v = validateAuthored(pick, { isRid, stored: true });
  return v.ok ? v.value : null;
}
const recordOk = (rec, opts) => isObj(rec) && rec.v === 1 && isInt(rec.rev, 1, 1e15) && STATES.includes(rec.state) && authoredOf(rec, opts) !== null;

// RTDB form: nulls dropped (an absent field IS null)
function stripNulls(v) {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (!isObj(v)) return v;
  const o = {};
  for (const [k, x] of Object.entries(v)) if (x !== null && x !== undefined) o[k] = stripNulls(x);
  return o;
}

// The LIVE-EDIT allowlist: on an active / paused offer, the end moved LATER (or removed), plus v5's days / window. Anything else →
// the field that changed. (v1 has no caps — the «caps up only» rule returns with v2's caps.)
function liveEditProblem(prev, next) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const k of ['name', 'type', 'audience', 'branches']) if (!same(prev[k], next[k])) return k;
  if (!same(paramsKey(prev), paramsKey(next))) return 'params';   // a category offer's resolved dishes may move (a re-save / publish re-resolves)
  const ps = prev.schedule, ns = next.schedule;
  // owner-approved v5 «Editar oferta activa»: the days and the window MAY change on a live offer — the save re-judges the overlap (the
  // pre-check + mirrorActive inside each branch's transaction, tombstone-aware) and the mirror re-projects; the START stays locked
  if (ps.start !== ns.start) return 'schedule';
  if (!(ns.end === null || (ps.end !== null && ns.end >= ps.end))) return 'schedule';
  return null;
}

const paramsKey = (v) => (usesCats(v) ? { cats: v.params.cats, free_per_order: v.params.free_per_order } : v.params);

// A category offer's dishes on ONE branch, from its ACTIVE catalog version (catalog-menu getRestaurantMenu: items carry display.cat;
// structure.categories lists the ids) → { ok, items } | { ok:false, reason: 'unknown_category'|'empty_category', cat }. Pure.
function resolveCats(menu, cats) {
  const known = new Set((isObj(menu) && isObj(menu.structure) && Array.isArray(menu.structure.categories) ? menu.structure.categories : []).filter(isObj).map((c) => c.id));
  const items = isObj(menu) && Array.isArray(menu.items) ? menu.items : [];
  const out = [];
  for (const cat of cats) {
    if (!known.has(cat)) return { ok: false, reason: 'unknown_category', cat };
    const keys = items.filter((it) => isObj(it) && isObj(it.display) && it.display.cat === cat && keyOk(it.key)).map((it) => it.key);
    if (!keys.length) return { ok: false, reason: 'empty_category', cat };
    out.push(...keys);
  }
  return { ok: true, items: [...new Set(out)].sort() };
}

// The compact record the PRICE PATH reads — present only while state === 'active'. `name` rides for the overlap refusal's wording.
const liveProjection = (rec, brandId) => (!typeSupported(rec.type) ? null : stripNulls({ rev: rec.rev, brand_id: brandId, name: rec.name, type: rec.type, params: rec.params, audience: rec.audience, schedule: rec.schedule }));

// ── the weekly overlap rule (mockup 3 «1 con cruce») ────────────────────────────────────────────────────────────────────────────
// An offer's weekly minutes — the ONE definition now lives in marketing/offer-rules.js (shared with the capp; advisor 11-14, 5f moved it
// unchanged — OR-PARITY pins it to this file's b62765981 implementation); re-exported here so every existing caller is untouched.
const { weeklyIntervals } = require('./offer-rules');
const datesMeet = (a, b) => (a.end === null || b.start === null || b.start < a.end) && (b.end === null || a.start === null || a.start < b.end);
function schedulesOverlap(a, b) {
  if (!datesMeet(a, b)) return false;
  const A = weeklyIntervals(a), B = weeklyIntervals(b);
  return A.some(([s1, e1]) => B.some(([s2, e2]) => s1 < e2 && s2 < e1));
}
// the dish keys an item-offer covers (a category offer: its RESOLVED items). Whole-order types: none.
function dishesOf(rec) {
  if (rec.type !== 'bogo') return [];
  if (Array.isArray(rec.params.items)) return rec.params.items;
  return [];   // a category offer without its resolved items covers nothing (never guessed)
}
const usesCats = (rec) => rec.type === 'bogo' && Array.isArray(rec.params.cats);

// The status the portal shows, derived (no job): an active offer before its start is «scheduled», after its end «ended».
function statusOf(rec, nowMs) {
  if (rec.state !== 'active') return rec.state;
  const s = rec.schedule || {};
  if (Number.isSafeInteger(s.end) && nowMs >= s.end) return 'ended';
  if (Number.isSafeInteger(s.start) && nowMs < s.start) return 'scheduled';
  return 'live';
}
// HN day of week (0 = Sunday) — the schedule's own calendar
const hnDow = (ms) => new Date(ms - HN_OFFSET_MS).getUTCDay();

module.exports = {
  TYPES, AUDIENCES, STATES, LIMITS, OFFER_ID_RE, AUTHORED,
  V1_TYPES, typeSupported, validateAuthored, validatePublishable, authoredOf, recordOk, stripNulls, liveEditProblem, liveProjection,
  weeklyIntervals, schedulesOverlap, dishesOf, usesCats, resolveCats, statusOf, hnDow,
  paramsOf, scheduleOf,   // the ONE params / schedule rule, for the public offers read (catalog/offers-serve.js)
};
