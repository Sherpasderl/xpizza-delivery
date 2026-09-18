'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D1 — THE SERVED OVERLAY.
//
// The served menu is read from an immutable version whose hash is verified on the way out. Ids are NOT
// in that version — rewriting immutable history is D4 — so they are applied AFTERWARDS, to the
// customer-serving projection only, by looking each record's legacy key up in the registry.
//
// 🔴 THE ORDERING IS THE SAFETY ARGUMENT. The hash is verified before this runs, so identity cannot
// corrupt a hash it is applied after; the numeric price tables are never touched, so the money
// descriptor is unmoved; and the gate read takes a different path entirely, so no amount of trouble
// here can flip authored weekend or reward eligibility to a static fallback.
//
// 🔴 THIS FUNCTION MUST NOT BE ABLE TO FAIL A SERVE. Everything it does is additive decoration on a
// body that is already complete and already correct. So it cannot throw, cannot hang, and cannot
// return a body worse than the one it was given: on ANY trouble — a registry read error, a timeout, a
// shape it did not expect — it returns the ORIGINAL body and the customer gets a menu with no ids,
// which in D1 is inert because nothing reads them. An enrichment that can take down a menu is worse
// than no enrichment, and the whole point of D1 being shadow is that this trade is free.
// ---------------------------------------------------------------------------
const { lookupByLegacyKeys } = require('./identity-registry');
const { itemPricingKey } = require('../menu-pricing');

// Bounded on its own clock, deliberately unrelated to the pricing reader's deadline. The pricing read
// has a budget because a slow price is a broken order; this has one because a slow decoration must
// never become a slow menu. They are different concerns and share no timer.
const OVERLAY_TIMEOUT_MS = 1500;

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`identity_overlay_timeout: ${label}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/* The legacy key of a SERVED record — through the pricing resolver, so the overlay and the money path
   agree by construction about which object this is.
   Worth stating because it looks wrong at a glance: x_pizza's served `id` is a NUMERIC UI HANDLE (2),
   not its key — its key is the name. la_musa's served `id` IS its key. Reading `record.id` directly
   would silently key x_pizza by a UI handle and resolve nothing, and "resolved nothing" looks exactly
   like "not backfilled yet". */
const keyOf = (rid, record) => {
  const k = itemPricingKey(record, rid);
  return typeof k === 'string' && k ? k : null;
};

/* Decorate one array of served display records. Returns a NEW array; the input is never mutated,
   because the caller's body may be shared with something that has already been hashed. */
function decorate(records, rid, map, field) {
  return records.map((rec) => {
    if (!rec || typeof rec !== 'object') return rec;
    const k = keyOf(rid, rec);
    const id = k === null ? undefined : map.get(k);
    return id ? { ...rec, [field]: id } : rec;      // unresolved → served exactly as it was
  });
}

/* Apply identity to a served bundle body. Never throws. Returns { body, applied, reason } — the
   caller serves `body` whatever happens, and `applied` exists for a diagnostic, not a decision. */
async function applyIdentityToServedBody(db, rid, body, { timeoutMs = OVERLAY_TIMEOUT_MS } = {}) {
  try {
    if (!body || typeof body !== 'object') return { body, applied: false, reason: 'no_body' };
    const dishes = Array.isArray(body.dishes) ? body.dishes : null;
    const extras = Array.isArray(body.extras) ? body.extras : null;
    if (!dishes && !extras) return { body, applied: false, reason: 'nothing_to_enrich' };

    const dishKeys = dishes ? dishes.map((r) => keyOf(rid, r)).filter(Boolean) : [];
    const extraKeys = extras ? extras.map((r) => keyOf(rid, r)).filter(Boolean) : [];

    const [dishMap, extraMap] = await withTimeout(Promise.all([
      dishKeys.length ? lookupByLegacyKeys(db, { rid, kind: 'dish', legacyKeys: dishKeys }) : Promise.resolve(new Map()),
      extraKeys.length ? lookupByLegacyKeys(db, { rid, kind: 'extra', legacyKeys: extraKeys }) : Promise.resolve(new Map()),
    ]), timeoutMs, rid);

    const next = { ...body };
    if (dishes) next.dishes = decorate(dishes, rid, dishMap, 'dish_id');
    if (extras) next.extras = decorate(extras, rid, extraMap, 'extra_id');
    const resolved = dishMap.size + extraMap.size;
    return { body: next, applied: resolved > 0, reason: resolved > 0 ? 'ok' : 'no_identities' };
  } catch (e) {
    /* 🔴 ID-ABSENT CONTINUATION. Swallowed on purpose and reported upward as a value, so a registry
       outage degrades to "a menu without ids" — which in D1 is the menu we serve today — rather than
       to "no menu". The reason travels for a log line; nothing branches on it. */
    return { body, applied: false, reason: `error:${String((e && e.message) || e).slice(0, 120)}` };
  }
}

module.exports = { applyIdentityToServedBody, keyOf, OVERLAY_TIMEOUT_MS };
