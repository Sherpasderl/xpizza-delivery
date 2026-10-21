'use strict';

// BRAND-AGNOSTIC SERVER X1 (PLAN-brand-agnostic-server r0 §2 + r3 §C/§D/§E) — a restaurant's hub comes from ITS OWN identity
// (restaurants/{rid}/identity hub_lat/hub_lng, when the identity is routing-valid). There is no static per-brand table and no
// X. Pizza fallback: an unknown / null / hub-less restaurant resolves to NO hub, and every caller fails closed on that.
//
//   hubForFresh(db, rid)  → {lat,lng} | null — ONE read, no cache (assignment decisions; a failed read → null)
//   readHubFresh(db, rid) → { ok:true, hub } | { ok:false } — the same read, telling "no hub" apart from "read failed"
//   makeHubPeek(opts)     → hubForPeek(db, rid) — a per-instance cache for the ingest geofence (high frequency)
//   resolveAssignHub(db, order) → { hubLat, hubLng } | { unresolved: 'no_hub' | 'read_failed' }
const { isRoutingValid } = require('./restaurant-config');

const HUB_PEEK_REFRESH_MS = 15 * 1000;   // an entry older than this is re-read on the next peek
const HUB_PEEK_TTL_MS = 60 * 1000;       // a failed re-read serves the last-known-good only within this age of its last SUCCESS
const RID = /^[A-Za-z0-9_-]{1,64}$/;      // never a path: a malformed rid resolves to no hub without a read

const hubOf = (identity) => (isRoutingValid(identity) ? { lat: identity.hub_lat, lng: identity.hub_lng } : null);
const validRid = (rid) => typeof rid === 'string' && RID.test(rid);

async function readHubFresh(db, rid) {
  if (!validRid(rid)) return { ok: true, hub: null };
  try {
    return { ok: true, hub: hubOf((await db.ref(`restaurants/${rid}/identity`).once('value')).val()) };
  } catch (e) {
    console.warn(`assign-hub: identity read failed for ${rid} (${e && (e.code || e.message)})`);
    return { ok: false };
  }
}

async function hubForFresh(db, rid) {
  const r = await readHubFresh(db, rid);
  return r.ok ? r.hub : null;
}

// Per-instance peek cache. A FAILED read never renews an entry's timestamp (so a dead backend cannot keep a hub alive past the
// TTL). Ordering is by a monotonic REQUEST SEQUENCE (codex build r1 P2): an older request completing after a newer one never
// overwrites it, even within the same millisecond; timestamps decide freshness only, and the TTL is enforced on whatever
// entry is returned.
function makeHubPeek({ refreshMs = HUB_PEEK_REFRESH_MS, ttlMs = HUB_PEEK_TTL_MS, now = () => Date.now(), read = readHubFresh } = {}) {
  const cache = new Map();   // rid → { hub, at (when the read that produced it STARTED), seq (its request sequence) }
  let seq = 0;
  const fresh = (e) => !!e && now() - e.at < ttlMs;
  async function hubForPeek(db, rid) {
    if (!validRid(rid)) return null;
    const t0 = now();
    const e = cache.get(rid);
    if (e && t0 - e.at < refreshMs) return e.hub;
    const mine = ++seq;
    const r = await read(db, rid);
    const cur = cache.get(rid);
    if (r.ok && (!cur || cur.seq < mine)) { cache.set(rid, { hub: r.hub, at: t0, seq: mine }); return r.hub; }
    return fresh(cur) ? cur.hub : null;   // a newer request's entry (or, on failure, the last-known-good) — only within the TTL
  }
  hubForPeek._cache = cache;
  return hubForPeek;
}

// The hub auto-assign distance is measured FROM. The order's STAMPED hub (hubSnapshot at intake) when present — byte-identical
// to today for every stamped order; otherwise the order's restaurant identity, read fresh. No hub → { unresolved: 'no_hub' }
// (the order is never auto-assigned; the caller raises the keyed hub_unresolved alert); a failed read → 'read_failed' (skipped
// this pass, retried later).
async function resolveAssignHub(db, order) {
  const o = order || {};
  if (typeof o.hub_lat === 'number' && typeof o.hub_lng === 'number') return { hubLat: o.hub_lat, hubLng: o.hub_lng };
  const r = await readHubFresh(db, o.restaurant_id);
  if (!r.ok) return { unresolved: 'read_failed' };
  return r.hub ? { hubLat: r.hub.lat, hubLng: r.hub.lng } : { unresolved: 'no_hub' };
}

module.exports = { resolveAssignHub, readHubFresh, hubForFresh, makeHubPeek, hubOf, HUB_PEEK_REFRESH_MS, HUB_PEEK_TTL_MS };
