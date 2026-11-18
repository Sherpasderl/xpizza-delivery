'use strict';
// The BRAND of a branch, for the offer readers (advisor 11-14 ruling, rule 4 — one source): the live mirror is keyed
// marketing_brand/{brandId}/live/{rid} (3a's ONE brand root), and the readers must resolve the brand EXACTLY as the writer's authorization does — the pure
// brands/brand-model.js brandIdOf (identity.brand_id first; absent ⇒ a VALID legacy singleton record brands/{rid} ⇒ the rid; else
// unknown). This module is only its I/O: least privilege (the brand_id LEAF, never the identity node — it carries the hub, phone and
// WhatsApp instance), brands/{rid} read only when the leaf is absent, and a per-instance cache with the mirror's TTL.
// → brandId | null. A failed read ⇒ null, never cached (fail closed: no brand ⇒ no offer).
const F1 = require('../brands/brand-model');

const TTL_MS = 60000;                // = offer-wire's mirror TTL
const cache = new Map();             // rid → { at, v }

async function resolve(db, rid) {
  const leaf = (await db.ref(`restaurants/${rid}/identity/brand_id`).once('value')).val();
  if (leaf !== null) return F1.brandIdOf(rid, { brand_id: leaf }, {});
  const own = (await db.ref(`brands/${rid}`).once('value')).val();
  return F1.brandIdOf(rid, {}, own === null ? {} : { [rid]: own });
}

async function brandOf(db, rid, { nowMs, cached = true } = {}) {   // nowMs: the caller's clock (no clock site here)
  if (!Number.isFinite(nowMs)) return null;
  const c = cache.get(rid);
  if (cached && c && nowMs >= c.at && nowMs - c.at < TTL_MS) return c.v;
  let b;
  try { b = await resolve(db, rid); } catch (_) { return null; }
  const v = b === F1.UNKNOWN ? null : b;
  cache.set(rid, { at: nowMs, v });
  return v;
}

module.exports = { brandOf, TTL_MS, _reset: () => cache.clear() };
