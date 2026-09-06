'use strict';
// ---------------------------------------------------------------------------
// Portal Phase 2a Task 5 — the availability GATES, sourced from the catalog rather than a static Set.
//
// `weekendOnlyViolation` decided which items may be ordered on which days from a hard-coded list of
// item NAMES in menu-pricing.js. After the portal ships, a merchant moving the weekend restriction
// would change the catalog and the gate would keep enforcing yesterday's menu — the silent-drift
// landmine this phase exists to kill. The gate now derives its key set from the catalog's
// `weekend_only_cats` × the dishes' categories.
//
// MONEY-ADJACENT: this is a PRE-CHARGE gate, so its failure modes matter as much as its verdicts.
// Two properties follow from that:
//   • FAIL-SAFE TO TODAY, never open. If the catalog read fails, we fall back to the static code set —
//     which is exactly today's behaviour. Falling back to "no restrictions" would let a weekday order
//     through for a weekend-only item, which is worse than being briefly stale.
//   • BOUNDED. A hung read must never hang an order; the deadline expires into the same fallback.
//
// The cache is keyed by VERSION, not by time: published versions are immutable, so one read serves
// every order on that version and a new version re-reads by construction.
// ---------------------------------------------------------------------------
const { X_PIZZA_WEEKEND_ONLY } = require('../menu-pricing');   // FALLBACK ONLY — never the live authority

const GATE_READ_DEADLINE_MS = 1500;
const MAX_CACHED_VERSIONS = 8;

// Derive the weekend-only KEY set from a built catalog: the gate categories, expanded through the
// dishes that live in them. Categories are the editable unit; keys are what an order line carries.
function weekendOnlyKeysFrom(restaurantId, built) {
  const cats = new Set((built && built.structure && built.structure.weekend_only_cats) || []);
  const keys = new Set();
  if (cats.size === 0) return keys;
  for (const it of (built && built.items) || []) {
    if (it && it.display && cats.has(it.display.cat)) keys.add(it.key);
  }
  return keys;
}

// The same derivation for the pickup-only gate — same shape, same editability.
function pickupOnlyKeysFrom(restaurantId, built) {
  const cats = new Set((built && built.structure && built.structure.pickup_only_cats) || []);
  const keys = new Set();
  if (cats.size === 0) return keys;
  for (const it of (built && built.items) || []) {
    if (it && it.display && cats.has(it.display.cat)) keys.add(it.key);
  }
  return keys;
}

function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// createGateReader({ getMenu, deadlineMs }) — getMenu(rid) returns a BUILT catalog ({items, structure}).
function createGateReader({ getMenu, deadlineMs = GATE_READ_DEADLINE_MS } = {}) {
  const cache = new Map();   // `${rid}::${versionId}` -> { weekend: Set, pickup: Set }

  async function gatesFor(restaurantId, versionId) {
    const key = `${restaurantId}::${versionId == null ? 'flat' : versionId}`;
    const hit = cache.get(key);
    if (hit) return hit;
    let built = null;
    try {
      const p = Promise.resolve(getMenu ? getMenu(restaurantId, versionId) : null);
      if (p && typeof p.catch === 'function') p.catch(() => {});
      built = await withDeadline(p, deadlineMs, 'gate_read');
    } catch (e) {
      // FALLBACK TO TODAY — the static set. Not cached, so the next order retries the catalog.
      console.warn('menu_gates_read_failed', JSON.stringify({ restaurantId, versionId: versionId || null, error: String((e && e.message) || e).slice(0, 160) }));
      return { weekend: staticWeekendFallback(restaurantId), pickup: null, fallback: true };
    }
    if (!built || !built.structure) return { weekend: staticWeekendFallback(restaurantId), pickup: null, fallback: true };
    const gates = { weekend: weekendOnlyKeysFrom(restaurantId, built), pickup: pickupOnlyKeysFrom(restaurantId, built), fallback: false };
    if (cache.size >= MAX_CACHED_VERSIONS) cache.delete(cache.keys().next().value);   // bounded
    cache.set(key, gates);
    return gates;
  }

  return {
    gatesFor,
    getWeekendOnlyKeys: async (rid, versionId) => (await gatesFor(rid, versionId)).weekend,
    getPickupOnlyKeys: async (rid, versionId) => (await gatesFor(rid, versionId)).pickup,
    _cache: cache,
  };
}

// The pre-portal behaviour, preserved exactly: only x_pizza has weekend-only items today.
function staticWeekendFallback(restaurantId) {
  return restaurantId === 'x_pizza' ? new Set(X_PIZZA_WEEKEND_ONLY) : new Set();
}

module.exports = { createGateReader, weekendOnlyKeysFrom, pickupOnlyKeysFrom, staticWeekendFallback, GATE_READ_DEADLINE_MS };
