'use strict';
// PLAN-5f-marketing-price r0 (APPROVED 2026-11-14) — offerFor: the ONE best restaurant offer for an order, PURE.
//   Input: the marketing config (marketing/config readMarketingConfig), this branch's live mirror (3a's marketing_live/{rid}, read by the
//   caller), the cart, its GROSS food total (computeServerTotal's lempiras) and the server envío ctx. Output: null, or a SERVER offer ctx
//   { offer_id, rev, type, name, discount_cents, waived_envio_cents } — recognised by identity (isServerOfferCtx), so a request body can
//   never mint one (the delivery ctx precedent, delivery-pricing.js mint).
// Rules (advisor rulings Q1–Q9, DECISIONS 4747 / 4757):
//   · OFF (`offers_enabled !== true`) ⇒ null before the mirror is touched; a redemption on the order ⇒ null (no stacking).
//   · Every amount is a WHOLE lempira (Q1): a pct discount is floored to whole lempiras, and an entry whose cents fields are not
//     multiples of 100 is malformed. `max_cents` absent = no max; 0 or anything non-positive is malformed (Q2: no sentinel 0).
//   · Phase 1 applies audience 'all' only; 'new' / 'returning' / nuevos fail closed (Q5: no admission-safe «new customer» fact yet).
//   · envío: delivery mode, a fee, food ≥ min, and Sherpa's own promo NOT applied (ruling 4757: they never combine) ⇒ the whole fee.
//   · bogo (Q4): the eligible units (dish table price; extras are paid) dearest first, every 2nd unit free, ≤ free_per_order — priced
//     per line by computeServerTotal itself and asserted to sum to the base total (a mismatch ⇒ no offer, never a 2nd price source).
//   · Best = the largest customer saving (discount + waived envío); a tie ⇒ the smallest offer id. A malformed entry is skipped.
//   The mirror outlives an offer's end (no job removes it): the schedule is evaluated HERE, in HN (UTC−6, no DST).
// Brand-agnostic: no rid / brand literal. No PII.
const OM = require('./offer-model');
const { computeServerTotal, resolvePriceTables, itemPricingKey, keyModeOfTables } = require('../menu-pricing');
const { isServerDeliveryCtx } = require('../delivery/delivery-pricing');

const L = 100;   // one lempira in centavos
const DAY_MS = 86400000;
const HN_OFFSET_MS = 6 * 3600000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const whole = (v, lo = 1) => Number.isSafeInteger(v) && v >= lo && v <= OM.LIMITS.cents_max && v % L === 0;   // whole lempiras (Q1b)
const floorL = (cents) => Math.floor(cents / L) * L;

// One mirror entry → a normalized candidate, or null (malformed ⇒ never applied). Strict on every field the price reads.
function entryOf(id, e) {
  if (!OM.OFFER_ID_RE.test(id) || !isObj(e)) return null;
  if (!Number.isSafeInteger(e.rev) || e.rev < 1 || !OM.TYPES.includes(e.type) || typeof e.name !== 'string' || !e.name) return null;
  const s = e.schedule, p = e.params;
  if (!isObj(s) || !isObj(p)) return null;
  const start = s.start, end = s.end == null ? null : s.end;
  if (!Number.isSafeInteger(start) || (end !== null && !(Number.isSafeInteger(end) && end > start))) return null;
  if (!Array.isArray(s.days) || !s.days.length || !s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  let window = null;
  if (s.window != null) {
    const w = s.window;
    if (!isObj(w) || !Number.isInteger(w.from) || !Number.isInteger(w.to) || w.from < 0 || w.from > 1439 || w.to < 0 || w.to > 1439 || w.from === w.to) return null;
    window = { from: w.from, to: w.to };
  }
  let params = null;
  if (e.type === 'pct') {
    if (Number.isInteger(p.pct) && p.pct >= OM.LIMITS.pct_min && p.pct <= OM.LIMITS.pct_max && (p.max_cents == null || whole(p.max_cents))) params = { pct: p.pct, max_cents: p.max_cents == null ? null : p.max_cents };
  } else if (e.type === 'lps') {
    if (whole(p.off_cents) && whole(p.min_cents, 0) && p.min_cents >= p.off_cents) params = { off_cents: p.off_cents, min_cents: p.min_cents };
  } else if (e.type === 'bogo') {
    if (Array.isArray(p.items) && p.items.length && p.items.every((k) => typeof k === 'string' && k) && Number.isInteger(p.free_per_order) && p.free_per_order >= 1 && p.free_per_order <= OM.LIMITS.free_per_order_max) params = { items: new Set(p.items), free_per_order: p.free_per_order };
  } else if (e.type === 'envio') {
    if (p.min_cents == null || whole(p.min_cents, 0)) params = { min_cents: p.min_cents == null ? 0 : p.min_cents };
  } else if (e.type === 'nuevos') {
    params = { never: true };   // phase 1: audience 'new' only, and no admission-safe «new customer» fact exists (Q5)
  }
  if (!params) return null;
  const cp = e.caps, capOk = (v, hi) => v == null || (Number.isSafeInteger(v) && v >= 1 && v <= hi);
  if (!isObj(cp) || typeof cp.weekly !== 'boolean' || !capOk(cp.redemptions, 1e6) || !capOk(cp.spend_cents, OM.LIMITS.cents_max)) return null;   // the caps the usage hold enforces (step 2)
  const caps = Object.freeze({ redemptions: cp.redemptions == null ? null : cp.redemptions, spend_cents: cp.spend_cents == null ? null : cp.spend_cents, weekly: cp.weekly });
  return { id, rev: e.rev, type: e.type, name: e.name, audience: e.audience, params, caps, schedule: { start, end, days: s.days, window } };
}

// Is the offer live at `nowMs` (HN)? start ≤ now < end, and the HN minute-of-week inside one of its weekly intervals.
function liveAt(c, nowMs) {
  if (nowMs < c.schedule.start || (c.schedule.end !== null && nowMs >= c.schedule.end)) return false;
  const local = nowMs - HN_OFFSET_MS;
  const minuteOfDay = Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / 60000);
  const m = OM.hnDow(nowMs) * 1440 + minuteOfDay;
  return OM.weeklyIntervals(c.schedule).some(([a, b]) => m >= a && m < b);
}

// The cart's eligible dish units for a bogo: each line priced by computeServerTotal ITSELF (its sum must equal the base total, else
// null), the unit value = the dish's table price (extras excluded — they stay paid). Lazily built once per order.
function dishUnitsOf(items, rid, tables, baseTotalL) {
  let sum = 0;
  for (const it of items) { const t = computeServerTotal([it], rid, tables); if (t.error || !Number.isFinite(t.total)) return null; sum += t.total; }
  if (sum !== baseTotalL) return null;
  const { menu } = resolvePriceTables(rid, tables);
  const keyMode = tables ? keyModeOfTables(tables) : undefined;
  const units = [];
  for (const it of items) {
    const key = itemPricingKey(it, rid, keyMode);
    const unit = menu[key] * L;
    if (!Number.isSafeInteger(unit) || unit <= 0) return null;
    for (let q = 0; q < Number(it.qty); q += 1) units.push({ key, unit });
  }
  return units;
}

// One candidate's saving for this order → { discount_cents, waived_envio_cents } or null (not eligible / zero).
function savingOf(c, f) {
  if (c.audience !== 'all') return null;
  let d = 0, w = 0;
  if (c.type === 'pct') { d = Math.floor((f.food * c.params.pct) / (100 * L)) * L; if (c.params.max_cents !== null) d = Math.min(d, c.params.max_cents); }
  else if (c.type === 'lps') { d = f.food >= c.params.min_cents ? c.params.off_cents : 0; }
  else if (c.type === 'bogo') {
    const units = f.units();
    if (!units) return null;
    const el = units.filter((u) => c.params.items.has(u.key)).map((u) => u.unit).sort((a, b) => b - a);
    for (let i = 1, k = 0; i < el.length && k < c.params.free_per_order; i += 2, k += 1) d += el[i];
  } else if (c.type === 'envio') {
    const ctx = f.delivery;
    if (ctx && ctx.mode === 'delivery' && Number.isSafeInteger(ctx.delivery_cents) && ctx.delivery_cents > 0 && ctx.promo_discount_cents === 0 && f.food >= c.params.min_cents) w = ctx.delivery_cents;
  } else return null;
  d = Math.max(0, Math.min(floorL(d), f.food));
  return d > 0 || w > 0 ? { discount_cents: d, waived_envio_cents: w } : null;
}

const SERVER_OFFER = new WeakSet();
const isServerOfferCtx = (o) => !!o && typeof o === 'object' && SERVER_OFFER.has(o);
const mint = (o) => { SERVER_OFFER.add(Object.freeze(o)); return o; };

function offerFor({ cfg, live, nowMs, items, rid, tables = null, baseTotalL, deliveryContext = null, reward = null, excluded = null }) {
  if (!cfg || cfg.offers_enabled !== true) return null;
  if (reward) return null;
  if (!isObj(live) || !Array.isArray(items) || !items.length) return null;
  const food = Math.round(Number(baseTotalL) * L);
  if (!Number.isSafeInteger(food) || food <= 0 || food % L !== 0 || food !== Number(baseTotalL) * L) return null;   // whole lempiras or nothing
  let units;
  const f = { food, delivery: isServerDeliveryCtx(deliveryContext) ? deliveryContext : null, units: () => (units === undefined ? (units = dishUnitsOf(items, rid, tables, baseTotalL)) : units) };
  let best = null;
  for (const id of Object.keys(live).sort()) {
    if (excluded && excluded.has(id)) continue;   // step 2: an offer whose cap is reached (offer-wire reads its usage) is not a candidate
    const c = entryOf(id, live[id]);
    if (!c || !liveAt(c, nowMs)) continue;
    const s = savingOf(c, f);
    if (!s) continue;
    const total = s.discount_cents + s.waived_envio_cents;
    if (!best || total > best.total) best = { c, s, total };   // ids ascending: a tie keeps the smallest
  }
  if (!best) return null;
  return mint({ offer_id: best.c.id, rev: best.c.rev, type: best.c.type, name: best.c.name, discount_cents: best.s.discount_cents, waived_envio_cents: best.s.waived_envio_cents, caps: best.c.caps });
}

// ── the ONE food breakdown with an offer (the core, both recorded-total sites and the factura read it) ───────────────────────────
// No offer (or a zero discount) ⇒ EXACTLY orderBreakdownCents(total, rid) — the same call, so OFF is byte-identical. An offer ⇒ the ISV
// split of what the customer PAYS (tax-inclusive, the same function) and, for a platform-factura restaurant only (rule 19), the fiscal
// rebaja = gross subtotal − paid subtotal (the reward precedent, rewards-redeem-pricing.js: FULL net − PAID net).
const discountOf = (offer) => (isServerOfferCtx(offer) && offer.discount_cents > 0 ? offer.discount_cents : 0);
const foodLempiras = (totalL, offer) => totalL - discountOf(offer) / L;
function foodBreakdown(totalL, rid, offer) {
  const { orderBreakdownCents } = require('../order-money');
  const d = discountOf(offer);
  if (!d) return orderBreakdownCents(totalL, rid);
  const paid = orderBreakdownCents(totalL - d / L, rid);
  if (!require('../factura/eligibility').usesPlatformFactura(rid)) return paid;
  const gross = orderBreakdownCents(totalL, rid);
  return { ...paid, desc_rebaja_cents: gross.subtotal_cents - paid.subtotal_cents };
}
// The order's frozen fact (PLAN §1.9): what applied, by whom funded — never the mirror's params.
const frozenOf = (offer, held = null) => ({ offer_id: offer.offer_id, rev: offer.rev, type: offer.type, name: offer.name, discount_cents: offer.discount_cents,
  waived_envio_cents: offer.waived_envio_cents, funded_by: 'restaurant', ...(held ? { usage: 'held', usage_week: held.week, usage_sales_cents: held.salesCents } : {}) });   // step 2: the usage the order holds (cash: written WITH the order)

// A STORED order's frozen offer re-entered as a server ctx (offer-wire storedOfferOf validates the record first) — the card retry path.
const TYPES_PRICED = Object.freeze(['pct', 'lps', 'bogo', 'envio']);
const mintStored = (o) => mint({ offer_id: o.offer_id, rev: o.rev, type: o.type, name: o.name, discount_cents: o.discount_cents, waived_envio_cents: o.waived_envio_cents });

// The customer's poll (paymentStatus) shows the STORED offer as what was saved, never how it is tracked: no offer id / rev / usage /
// funder (plan §1.9, Q9) and no merchant name (advisor 11-14: the capp derives its label from the type and amounts — minimal data).
// A malformed record shows nothing (the order screen then simply has no «Descuento» line).
const cents = (v) => Number.isSafeInteger(v) && v >= 0;
const pollOfferOf = (o) => (o && typeof o === 'object' && TYPES_PRICED.includes(o.type) && cents(o.discount_cents) && cents(o.waived_envio_cents)
  ? { type: o.type, discount_cents: o.discount_cents, waived_envio_cents: o.waived_envio_cents } : null);

module.exports = { offerFor, isServerOfferCtx, entryOf, liveAt, dishUnitsOf, discountOf, foodLempiras, foodBreakdown, frozenOf, mintStored, pollOfferOf, TYPES_PRICED };
