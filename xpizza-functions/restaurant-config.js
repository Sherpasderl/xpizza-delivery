'use strict';

/**
 * Config-plane reader (ADR-0002): source -> warm-instance cache (30s TTL + version) -> fail-closed.
 *
 * INERT until Step 3b wires it into the order-creation paths. Routing-critical fields (hub_lat/lng,
 * active) are never fabricated: past TTL or when freshness can't be proven, reads FAIL CLOSED
 * (retryable 503) rather than guess a hub or accept an order for a deactivated Restaurant.
 *
 * Conservative simplification vs ADR-0002 (#3): we fail closed on the WHOLE identity past TTL,
 * stricter than the ADR (which permits stale non-critical phone/hours). Safer; revisit if a use
 * case needs longer-lived non-critical reads.
 */

const TTL_MS = 30_000;
const cache = new Map(); // rid -> { identity, fetched_at, version }

// Defense-in-depth routing-critical shape check. The seed self-validates and the RTDB .validate
// guards writes, but a reader on a fail-closed hot path must never trust/cache malformed data.
function isRoutingValid(id) {
  return id && typeof id === 'object' &&
    typeof id.hub_lat === 'number' && typeof id.hub_lng === 'number' &&
    typeof id.active === 'boolean' && typeof id.version === 'number';
}

/**
 * Resolve a Restaurant's identity from /restaurants/{rid}/identity, serving last-known-good from
 * a warm-instance cache for <= TTL_MS. Caller gates on `active === true` (#7). `now` is injectable
 * for deterministic testing.
 * @returns identity object plus { _source: 'fresh'|'cache', _fetched_at }
 * @throws  Error with { retryable:true, statusCode:503 } when no fresh and no warm-enough cache.
 */
async function getIdentity(db, rid, now = Date.now()) {
  const path = `restaurants/${rid}/identity`;
  let fresh = null;
  let reason = null;

  try {
    const snap = await db.ref(path).once('value');
    if (snap.exists()) fresh = snap.val();
    else reason = 'missing';
  } catch (e) {
    reason = `read_error:${e && e.name}/${e && e.code}:${e && e.message}`;
  }

  if (fresh !== null) {
    if (isRoutingValid(fresh)) {
      cache.set(rid, { identity: fresh, fetched_at: now, version: fresh.version }); // good data only
      return { ...fresh, _source: 'fresh', _fetched_at: now };
    }
    reason = 'malformed_fresh'; // #4: do NOT cache — no poison; fall through to last-known-good
  }

  const c = cache.get(rid);
  const age = c ? now - c.fetched_at : null;
  if (c && age <= TTL_MS) {
    console.warn(`restaurant-config: serving cache rid=${rid} reason=${reason} age_ms=${age}`);
    return { ...c.identity, _source: 'cache', _fetched_at: c.fetched_at };
  }

  console.warn(`restaurant-config: FAIL-CLOSED rid=${rid} reason=${reason} cache=${c ? `stale(${age}ms)` : 'cold'}`);
  const err = new Error(`restaurant-config: ${rid} identity unavailable — fail-closed`);
  err.retryable = true;
  err.statusCode = 503;
  throw err;
}

module.exports = { getIdentity, TTL_MS, _cache: cache };
