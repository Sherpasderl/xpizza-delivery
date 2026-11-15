'use strict';
// PLAN-5f-marketing-price r0 (APPROVED 2026-11-14) §1.5 / §1.7 — the price path's marketing READS and the `dq` every site threads.
//   withOffer(...) returns the request's envío `dq` with the order's offer on it — `{ ...dq, ctx, offer }` — so the ONE object the quote,
//   both recorded-total sites (DW.withDelivery + offer-price foodBreakdown) and the gate (DW.gateExtra) already pass carries the offer
//   too. No offer ⇒ the SAME `dq` object (OFF / no candidate / a reward / a legacy form ⇒ byte-identical).
// Reads (rule 7):
//   · platform_config/marketing: per-instance cache ≤ 60 s (3a Q9, ruled); an unreadable config ⇒ OFF and NOT cached.
//   · marketing_brand/{brandId}/live/{rid} (3a's ONE brand root, c4538460a): ONE read; quotes cached per instance ≤ 60 s, placement reads
//     FRESH (Q6: a pause is honoured at once). The brand by marketing/brand-of (brand-model brandIdOf — the writer's own rule; cached
//     60 s, quotes and placements alike: a branch's brand does not move); no brand ⇒ no mirror read, no offer (fail closed).
//   · the chosen offer's marketing_usage/{offerId}: ONE fresh point read (only when an offer would apply) — a capped offer is skipped.
//   · a card retry of an EXISTING order reuses the offer frozen on it (orders/{id}/offer, one point read, only when offers are on):
//     the order's economics are fixed at its first placement, never re-priced by a later mirror (promo §10 «frozen economics»).
// Scope (5f ruling, reported): offers apply to SHERPA APP orders only — the legacy order forms are frozen (rule 40) and show no offer.
// A failure anywhere ⇒ no offer (full price, logged with a code only); at placement the gate then answers offer_changed if the quote
// had one — never an order refused by a marketing outage, never a discount on a guess.
const CFG = require('./config');
const OP = require('./offer-price');
const P = require('../delivery/delivery-pricing');
const OU = require('./offer-usage');
const OM_LIVE_MAX = require('./offer-model').LIMITS.live_max;

const TTL_MS = 60000;
let cfgCache = null;                 // { at, v }
const liveCache = new Map();         // `${brandId}/live/${rid}` → { at, v }
const BO = require('./brand-of');
const fresh = (c, nowMs) => !!c && nowMs >= c.at && nowMs - c.at < TTL_MS;
const codeOf = (e) => (e && e.code != null ? String(e.code).slice(0, 40) : 'unknown');

async function configOf(db, nowMs) {
  if (fresh(cfgCache, nowMs)) return cfgCache.v;
  const v = await CFG.readMarketingConfig(db);
  if (v && !v.unavailable) cfgCache = { at: nowMs, v };
  return v;
}
async function mirrorOf(db, rid, nowMs, { cached }) {
  const brand = await BO.brandOf(db, rid, { nowMs, cached: true });
  if (!brand) return null;                                   // an unresolvable brand: no offer (never a guessed key)
  const key = `${brand}/live/${rid}`;
  const c = liveCache.get(key);
  if (cached && fresh(c, nowMs)) return c.v;
  const v = (await db.ref(`marketing_brand/${key}`).once('value')).val();
  liveCache.set(key, { at: nowMs, v });
  return v;
}

// The offer frozen on a stored order → a server offer ctx (the stored record is server-written; its shape is still checked).
function storedOfferOf(o) {
  if (!o || typeof o !== 'object' || o.funded_by !== 'restaurant' || typeof o.offer_id !== 'string' || !OP.TYPES_PRICED.includes(o.type) || typeof o.name !== 'string') return null;
  const ints = ['rev', 'discount_cents', 'waived_envio_cents'].every((k) => Number.isSafeInteger(o[k]) && o[k] >= 0);
  if (!ints || o.rev < 1 || o.discount_cents % 100 !== 0 || (o.discount_cents === 0 && o.waived_envio_cents === 0)) return null;
  return OP.mintStored({ offer_id: o.offer_id, rev: o.rev, type: o.type, name: o.name, discount_cents: o.discount_cents, waived_envio_cents: o.waived_envio_cents });
}

// the envío waiver on the request's ctx — or the ctx already waived (a grandfathered checkout's stored ctx) — or CANNOT (no waiver possible)
const CANNOT = Symbol('cannot');
function waivedCtx(ctx, offer) {
  if (!(offer.waived_envio_cents > 0)) return ctx;
  if (P.isServerDeliveryCtx(ctx) && ctx.delivery_discount_funder === 'restaurant' && ctx.promo_discount_cents === offer.waived_envio_cents) return ctx;
  const w = P.withDeliveryDiscount(ctx, offer.waived_envio_cents, 'restaurant');
  return w !== ctx ? w : CANNOT;
}

async function withOffer({ db, rid, items, tables, baseTotalL, dq, reward = null, app = false, orderId = null, nowMs = Date.now(), placement = false, log = console }) {
  if (reward || !app) return dq;
  if (dq && dq.refusal) return dq;                       // a refused envío answers first, untouched
  try {
    const cfg = await configOf(db, nowMs);
    if (!cfg || cfg.offers_enabled !== true) return dq;
    const ctx = dq && dq.ctx ? dq.ctx : null;
    let offer = null;
    if (placement && orderId) offer = storedOfferOf((await db.ref(`orders/${orderId}/offer`).once('value')).val());
    if (!offer) {
      if (dq && dq.grandfathered) return dq;             // a live issued checkout priced with no offer stays without one
      const live = await mirrorOf(db, rid, nowMs, { cached: !placement });
      // step 2: the chosen offer's usage, read FRESH (one point read, only when an offer would apply); a capped one is skipped and the
      // next best tried — so a quote never keeps offering what the placement's hold must refuse (no offer_changed loop)
      const excluded = new Set();
      for (let i = 0; i <= OM_LIVE_MAX; i += 1) {
        offer = OP.offerFor({ cfg, live, nowMs, items, rid, tables, baseTotalL, deliveryContext: ctx, reward, excluded });
        if (!offer || !OU.capReached((await db.ref(`marketing_usage/${offer.offer_id}`).once('value')).val(), offer, nowMs)) break;
        excluded.add(offer.offer_id); offer = null;
      }
    }
    if (!offer) {
      // a QUOTE with no offer may name the next one (capp Slice A, advisor 11-14): only its minimum unmet, a capped one skipped as above
      if (placement || !dq || typeof dq !== 'object') return dq;
      const live = await mirrorOf(db, rid, nowMs, { cached: true });
      const skip = new Set();
      for (let i = 0; i <= OM_LIVE_MAX; i += 1) {
        const n = OP.nextOfferFor({ cfg, live, nowMs, items, rid, tables, baseTotalL, deliveryContext: ctx, reward, excluded: skip });
        if (!n) return dq;
        if (!OU.capReached((await db.ref(`marketing_usage/${n.offer_id}`).once('value')).val(), n, nowMs)) return { ...dq, offer_next: n.shown };
        skip.add(n.offer_id);
      }
      return dq;
    }
    const c = waivedCtx(ctx, offer);
    if (c === CANNOT) return dq;                         // never half an offer
    return { ...(dq || {}), ctx: c, offer };
  } catch (e) {
    try { log.warn('marketing_offer_unavailable', JSON.stringify({ rid, code: codeOf(e) })); } catch (_) {}
    return dq;
  }
}

const offerOf = (dq) => (dq && OP.isServerOfferCtx(dq.offer) ? dq.offer : null);
const _resetCaches = () => { cfgCache = null; liveCache.clear(); BO._reset(); };   // tests only

module.exports = { withOffer, offerOf, storedOfferOf, TTL_MS, _resetCaches };
