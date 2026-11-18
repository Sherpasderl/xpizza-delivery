'use strict';
// PLAN-5f-marketing-price r0 (APPROVED 2026-11-14) — offerFor: the ONE best restaurant offer for an order, PURE.
//   Input: the marketing config (marketing/config readMarketingConfig), this branch's live mirror (3a's marketing_brand/{brandId}/live/{rid}, read by the
//   caller), the cart, its GROSS food total (computeServerTotal's lempiras) and the server envío ctx. Output: null, or a SERVER offer ctx
//   { offer_id, rev, type, name, discount_cents, waived_envio_cents } — recognised by identity (isServerOfferCtx), so a request body can
//   never mint one (the delivery ctx precedent, delivery-pricing.js mint).
// Rules (advisor rulings Q1–Q9, DECISIONS 4747 / 4757):
//   · OFF (`offers_enabled !== true`) ⇒ null before the mirror is touched; a redemption on the order ⇒ null (no stacking).
//   · Every amount is a WHOLE lempira (Q1): a pct discount is floored to whole lempiras, and an entry whose cents fields are not
//     multiples of 100 is malformed. `max_cents` absent = no max; 0 or anything non-positive is malformed (Q2: no sentinel 0).
//   · Audiences (offer-audience PLAN r4.1 §1, BRIEF §1): 'all' prices for everyone; 'new' / 'returning' (and the `nuevos` type, always
//     'new') price ONLY while the audience program is ON (config audienceEnabled — 3a's one test) AND the customer's KIND (decided at the
//     quote by marketing/audience, signed, honoured at placement) equals the offer's audience. kind 'none' (guest / unresolved / any read
//     failure) never gets one. OFF ⇒ an audience projection still in the mirror is skipped (rollback = OFF, 3a never sweeps it).
//   · envío: delivery mode, a fee, food ≥ min, and Sherpa's own promo NOT applied (ruling 4757: they never combine) ⇒ the whole fee.
//   · bogo (Q4): the eligible units (dish table price; extras are paid) dearest first, every 2nd unit free, ≤ free_per_order — priced
//     per line by computeServerTotal itself and asserted to sum to the base total (a mismatch ⇒ no offer, never a 2nd price source).
//   · Best = the largest customer saving (discount + waived envío); a tie ⇒ the smallest offer id. A malformed entry is skipped.
//   The mirror outlives an offer's end (no job removes it): the schedule is evaluated HERE, in HN (UTC−6, no DST).
// Brand-agnostic: no rid / brand literal. No PII.
const OM = require('./offer-model');
const OR = require('./offer-rules');
const CFG = require('./config');   // the ONE offer rules, shared with the capp (bogoSaving, inWindow)
const { computeServerTotal, resolvePriceTables, itemPricingKey, keyModeOfTables } = require('../menu-pricing');
const { isServerDeliveryCtx } = require('../delivery/delivery-pricing');

const L = 100;   // one lempira in centavos
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const whole = (v, lo = 1) => Number.isSafeInteger(v) && v >= lo && v <= OM.LIMITS.cents_max && v % L === 0;   // whole lempiras (Q1b)
const floorL = (cents) => Math.floor(cents / L) * L;

// One mirror entry → a normalized candidate, or null (malformed ⇒ never applied). Strict on every field the price reads.
function entryOf(id, e) {
  if (!OM.OFFER_ID_RE.test(id) || !isObj(e)) return null;
  if (!Number.isSafeInteger(e.rev) || e.rev < 1 || !OM.TYPES.includes(e.type) || typeof e.name !== 'string' || !e.name) return null;
  if (e.type === 'envio') return null;   // v1 (owner 11-15): «envío gratis» is held until the payout ledger — never priced, never waived (v2 reverts this)
  // RTDB never stores an empty object: a STORED «sin mínimo» envío reads back params-less — {} (the same rule as offer-model paramsOf(…, stored=true));
  // every other type still needs its params
  const s = e.schedule, p = e.type === 'envio' && e.params == null ? {} : e.params;
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
    // exactly one of off_cents (whole lempiras) or pct (pct_min..pct_max, step pct_step); no minimum (3a offer-model paramsOf)
    const hasOff = 'off_cents' in p, hasPct = 'pct' in p;
    if (hasOff !== hasPct && Object.keys(p).length === 1) {
      if (hasOff && whole(p.off_cents)) params = { off_cents: p.off_cents };
      else if (hasPct && Number.isInteger(p.pct) && p.pct >= OM.LIMITS.pct_min && p.pct <= OM.LIMITS.pct_max && p.pct % OM.LIMITS.pct_step === 0) params = { pct: p.pct };
    }
  }
  if (!params) return null;
  if (!OM.AUDIENCES.includes(e.audience) || (e.type === 'nuevos' && e.audience !== 'new')) return null;   // a stored audience only; nuevos is always 'new'
  // offers v1 (owner 11-15, limits = A): no caps — 3a's v1 projection carries none, and a legacy entry's `caps` is ignored, never read
  return { id, rev: e.rev, type: e.type, name: e.name, audience: e.audience, params, schedule: { start, end, days: s.days, window } };
}

// Is the offer live at `nowMs` (HN)? The ONE in-window rule, shared with the capp (marketing/offer-rules.js inWindow).
function liveAt(c, nowMs) {
  return OR.inWindow(c.schedule, nowMs);
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
  if (c.audience !== 'all' && !(f.audienceOn && f.kind === c.audience)) return null;   // an audience offer: program ON and the customer's kind
  let d = 0, w = 0;
  if (c.type === 'pct') { d = Math.floor((f.food * c.params.pct) / (100 * L)) * L; if (c.params.max_cents !== null) d = Math.min(d, c.params.max_cents); }
  else if (c.type === 'lps') { d = f.food >= c.params.min_cents ? c.params.off_cents : 0; }
  else if (c.type === 'bogo') {
    const units = f.units();
    if (!units) return null;
    d = OR.bogoSaving(units.filter((u) => c.params.items.has(u.key)).map((u) => u.unit), c.params.free_per_order);   // the ONE pairing rule (offer-rules.js)
  } else if (c.type === 'nuevos') {
    d = 'pct' in c.params ? Math.floor((f.food * c.params.pct) / (100 * L)) * L : c.params.off_cents;   // no max; floored + capped below
  } else if (c.type === 'envio') {
    const ctx = f.delivery;
    if (ctx && ctx.mode === 'delivery' && Number.isSafeInteger(ctx.delivery_cents) && ctx.delivery_cents > 0 && ctx.promo_discount_cents === 0 && f.food >= c.params.min_cents) w = ctx.delivery_cents;
  } else return null;
  d = Math.max(0, Math.min(floorL(d), f.food));
  return d > 0 || w > 0 ? { discount_cents: d, waived_envio_cents: w } : null;
}

const AUD_KINDS = Object.freeze(['new', 'returning']);   // a customer's kind; anything else is 'none'
const SERVER_OFFER = new WeakSet();
const isServerOfferCtx = (o) => !!o && typeof o === 'object' && SERVER_OFFER.has(o);
const mint = (o) => { SERVER_OFFER.add(Object.freeze(o)); return o; };

// The cart offerFor AND nextOfferFor price against — ONE setup: the OFF switch, no stacking on a reward, whole lempiras or nothing.
function cartOf({ cfg, live, items, rid, tables = null, baseTotalL, deliveryContext = null, reward = null, kind = 'none' }) {
  if (!cfg || cfg.offers_enabled !== true) return null;
  if (reward) return null;
  if (!isObj(live) || !Array.isArray(items) || !items.length) return null;
  const food = Math.round(Number(baseTotalL) * L);
  if (!Number.isSafeInteger(food) || food <= 0 || food % L !== 0 || food !== Number(baseTotalL) * L) return null;   // whole lempiras or nothing
  let units;
  return { food, audienceOn: CFG.audienceEnabled(cfg), kind: AUD_KINDS.includes(kind) ? kind : 'none', delivery: isServerDeliveryCtx(deliveryContext) ? deliveryContext : null, units: () => (units === undefined ? (units = dishUnitsOf(items, rid, tables, baseTotalL)) : units) };
}

function offerFor(args) {
  const { live, nowMs } = args;
  const f = cartOf(args);
  if (!f) return null;
  let best = null;
  for (const id of Object.keys(live).sort()) {
    const c = entryOf(id, live[id]);
    if (!c || !liveAt(c, nowMs)) continue;
    const s = savingOf(c, f);
    if (!s) continue;
    const total = s.discount_cents + s.waived_envio_cents;
    if (!best || total > best.total) best = { c, s, total };   // ids ascending: a tie keeps the smallest
  }
  if (!best) return null;
  return mint({ offer_id: best.c.id, rev: best.c.rev, type: best.c.type, name: best.c.name, discount_cents: best.s.discount_cents, waived_envio_cents: best.s.waived_envio_cents,
    ...(Number.isInteger(best.c.params.pct) ? { pct: best.c.params.pct } : {}), ...(best.c.type !== 'envio' && Number.isSafeInteger(best.c.params.min_cents) && best.c.params.min_cents > 0 ? { min_cents: best.c.params.min_cents } : {}),   // the quote's label facts (advisor 11-14)
    ...audienceOf(best.c.audience, f.kind) });
}

/* offer_next (capp offers Slice A, advisor 11-14): the best live offer whose ONLY unmet condition is its minimum — every other condition
   decided by the SAME savingOf, evaluated as if the food were exactly at that minimum. remaining_cents = minimum − food. Best = the
   largest saving; a tie ⇒ the smaller remaining, then the smaller id. → { offer_id, discount_cents, waived_envio_cents, shown } | null
   (none, offers off, a reward, not whole lempiras). */
function nextOfferFor(args) {
  const { live, nowMs } = args;
  const f = cartOf(args);
  if (!f) return null;
  let best = null;
  for (const id of Object.keys(live).sort()) {
    const c = entryOf(id, live[id]);
    if (!c || !liveAt(c, nowMs)) continue;
    const min = Number.isSafeInteger(c.params.min_cents) ? c.params.min_cents : null;
    if (!(min > f.food)) continue;                          // no minimum, or already met (then offerFor decides)
    const s = savingOf(c, { ...f, food: min });
    if (!s) continue;
    const value = s.discount_cents + s.waived_envio_cents; const remaining = min - f.food;
    if (!best || value > best.value || (value === best.value && remaining < best.remaining)) best = { c, s, value, remaining };
  }
  if (!best) return null;
  // `shown` is what a quote exposes
  return { offer_id: best.c.id, discount_cents: best.s.discount_cents, waived_envio_cents: best.s.waived_envio_cents,
    shown: { type: best.c.type, remaining_cents: best.remaining, ...(best.s.discount_cents > 0 ? { off_cents: best.s.discount_cents } : {}), ...(best.s.waived_envio_cents > 0 ? { waived_envio_cents: best.s.waived_envio_cents } : {}) } };
}

// an audience offer's facts (only priced when kind === audience); an 'all' offer carries none, so every pre-audience ctx is byte-identical
const audienceOf = (audience, kind) => (audience === 'new' || audience === 'returning' ? { audience, audience_kind: kind } : {});

// The quote's offer (capp Slice A, advisor 11-14): the label facts only — never the name, the id, the rev (minimal data, as the poll).
function quoteOfferOf(o) {
  return { type: o.type, ...(Number.isInteger(o.pct) ? { pct: o.pct } : {}), ...(Number.isSafeInteger(o.min_cents) ? { min_cents: o.min_cents } : {}), discount_cents: o.discount_cents, waived_envio_cents: o.waived_envio_cents };
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
// Offers v1 (owner 11-15): no usage hold, so no usage fields.
const frozenOf = (offer) => ({ offer_id: offer.offer_id, rev: offer.rev, type: offer.type, name: offer.name, discount_cents: offer.discount_cents,
  waived_envio_cents: offer.waived_envio_cents, funded_by: 'restaurant', ...audienceOf(offer.audience, offer.audience_kind) });

// A STORED order's frozen offer re-entered as a server ctx (offer-wire storedOfferOf validates the record first) — the card retry path.
const TYPES_PRICED = Object.freeze(['pct', 'lps', 'bogo', 'nuevos']);   // v1: no envío (owner 11-15); nuevos behind the audience program (BRIEF §1)
const mintStored = (o) => mint({ offer_id: o.offer_id, rev: o.rev, type: o.type, name: o.name, discount_cents: o.discount_cents, waived_envio_cents: o.waived_envio_cents, ...audienceOf(o.audience, o.audience_kind) });

// The customer's poll (paymentStatus) shows the STORED offer as what was saved, never how it is tracked: no offer id / rev / usage /
// funder (plan §1.9, Q9) and no merchant name (advisor 11-14: the capp derives its label from the type and amounts — minimal data).
// A malformed record shows nothing (the order screen then simply has no «Descuento» line).
const cents = (v) => Number.isSafeInteger(v) && v >= 0;
const pollOfferOf = (o) => (o && typeof o === 'object' && TYPES_PRICED.includes(o.type) && cents(o.discount_cents) && cents(o.waived_envio_cents)
  ? { type: o.type, discount_cents: o.discount_cents, waived_envio_cents: o.waived_envio_cents } : null);

/* offerFunder (PLAN r4.1 §4, census-pinned): WHO funds an order's discount — the ONE reader for any payout / statement / stats writer.
   An audience-'new' offer (incl. nuevos) ⇒ the fulfilment writer's create-if-absent decision orders/{id}/offer_reconcile.funded_by;
   absent or malformed ⇒ 'sherpa' (absence never means the restaurant: Sherpa absorbs uncertainty). Any other offer ⇒ its frozen
   funded_by. The frozen offer is never edited. No offer ⇒ null. */
const FUNDERS = Object.freeze(['restaurant', 'sherpa']);
function offerFunder(order) {
  const o = order && order.offer;
  if (!o || typeof o !== 'object') return null;
  if (o.audience !== 'new') return o.funded_by;
  const r = order.offer_reconcile;
  return r && typeof r === 'object' && FUNDERS.includes(r.funded_by) ? r.funded_by : 'sherpa';
}

module.exports = { offerFunder, offerFor, nextOfferFor, quoteOfferOf, isServerOfferCtx, entryOf, liveAt, dishUnitsOf, discountOf, foodLempiras, foodBreakdown, frozenOf, mintStored, pollOfferOf, TYPES_PRICED };
