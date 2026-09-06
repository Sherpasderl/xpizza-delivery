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
const POINTER_TTL_MS = 45000;   // matches the pricing reader's pointer TTL — a publish propagates in seconds

// Derive the weekend-only KEY set from a built catalog: the gate categories, expanded through the
// dishes that live in them. Categories are the editable unit; keys are what an order line carries.
// AUTHORED vs ABSENT is the difference between "no restrictions" and "we don't know". A version whose
// menu_structure predates the field would derive an EMPTY set, which reads as "release everything" — a
// fail-OPEN on a pre-charge gate. Only an explicit array (including []) counts as authored; anything else
// sends the reader to the static fallback.
function gateAuthored(built, field) {
  return Array.isArray(built && built.structure && built.structure[field]);
}

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

// ── Portal 2a Task 6 — REDEMPTION ELIGIBILITY, derived from the same built catalog ─────────────
// Returns a restaurant-TAGGED { restaurantId, allow:Set } (PIN B — an untagged set could be applied to
// the wrong brand, and x_pizza keys are NAMES while la_musa keys are IDS, so a cross-brand mix-up is
// silent). `allow` is the set of keys eligible WITHOUT a menu lookup, mirroring exactly what the two
// code constants do today: for x_pizza it is the complete answer; for la_musa it is the acompanamiento
// allowlist, with the non-alcohol MENU half still coming from the guarded pricing tables.
function redeemEligibleFrom(restaurantId, built) {
  const st = (built && built.structure) || {};
  const allow = new Set();
  if (restaurantId === 'la_musa') {
    for (const k of st.redeem_eligible_extras || []) allow.add(k);
  } else {
    const cats = new Set(st.redeem_eligible_cats || []);
    if (cats.size > 0) for (const it of (built && built.items) || []) {
      if (it && it.display && cats.has(it.display.cat)) allow.add(it.key);
    }
  }
  return { restaurantId, allow };
}

// Which structure field carries this brand's authored eligibility. Absent ⇒ UNAUTHORED ⇒ static.
const REDEEM_FIELD = (rid) => (rid === 'la_musa' ? 'redeem_eligible_extras' : 'redeem_eligible_cats');

function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// createGateReader({ getMenu, deadlineMs }) — getMenu(rid) returns a BUILT catalog ({items, structure}).
function createGateReader({ getMenu, getVersionId = null, deadlineMs = GATE_READ_DEADLINE_MS, pointerTtlMs = POINTER_TTL_MS, nowMs = Date.now } = {}) {
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
      return { weekend: staticWeekendFallback(restaurantId), pickup: null, redeem: null, fallback: true };
    }
    if (!built || !built.structure) return { weekend: staticWeekendFallback(restaurantId), pickup: null, redeem: null, fallback: true };
    if (!gateAuthored(built, 'weekend_only_cats')) {
      // Structure read fine but the gate is UNAUTHORED (a pre-2a version). Unknown → today's behaviour.
      console.warn('menu_gates_unauthored', JSON.stringify({ restaurantId, versionId: versionId || null, field: 'weekend_only_cats' }));
      return { weekend: staticWeekendFallback(restaurantId), pickup: null, redeem: null, fallback: true };
    }
    const gates = {
      weekend: weekendOnlyKeysFrom(restaurantId, built),
      pickup: pickupOnlyKeysFrom(restaurantId, built),
      // UNAUTHORED ⇒ null ⇒ the caller falls back to the static allowlist. Never an empty set: on the
      // redemption gate an empty set means "nothing is redeemable", which wrongly REJECTS every
      // legitimate redemption — the opposite error from the weekend gate but just as wrong.
      redeem: gateAuthored(built, REDEEM_FIELD(restaurantId)) ? redeemEligibleFrom(restaurantId, built) : null,
      fallback: false,
    };
    if (cache.size >= MAX_CACHED_VERSIONS) cache.delete(cache.keys().next().value);   // bounded
    cache.set(key, gates);
    return gates;
  }

  // ── The PRODUCTION entry point ────────────────────────────────────────────────────────────────
  // The gate needs the version id to key its cache, but the serving path deliberately carries only
  // {menu, extras} and the resolver is money-path-frozen. Rather than widen it, the gate probes the
  // active_version pointer itself on the same short TTL the pricing reader uses — one small read per
  // TTL window per instance, then a version-cache hit. A pointer failure is just another fallback.
  const pointer = new Map();   // rid -> { at, versionId }
  async function activeVersionOf(restaurantId) {
    const hit = pointer.get(restaurantId);
    if (hit && (nowMs() - hit.at) < pointerTtlMs) return hit.versionId;
    const p = Promise.resolve(getVersionId(restaurantId));
    if (p && typeof p.catch === 'function') p.catch(() => {});
    const versionId = await withDeadline(p, deadlineMs, 'gate_pointer');
    pointer.set(restaurantId, { at: nowMs(), versionId });
    return versionId;
  }

  // NEVER THROWS. Every failure path lands on the static set = today's behaviour.
  async function weekendOnlyKeysFor(restaurantId) {
    if (!getVersionId) return staticWeekendFallback(restaurantId);
    let versionId;
    try {
      versionId = await activeVersionOf(restaurantId);
    } catch (e) {
      console.warn('menu_gates_pointer_failed', JSON.stringify({ restaurantId, error: String((e && e.message) || e).slice(0, 160) }));
      return staticWeekendFallback(restaurantId);
    }
    if (versionId == null) return staticWeekendFallback(restaurantId);   // flat layout — no published version
    try { return (await gatesFor(restaurantId, versionId)).weekend; }
    catch (e) {   // defence in depth: gatesFor already catches, so reaching here is a bug, not an outage
      console.error('menu_gates_unexpected', JSON.stringify({ restaurantId, error: String((e && e.message) || e).slice(0, 160) }));
      return staticWeekendFallback(restaurantId);
    }
  }

  return {
    gatesFor,
    weekendOnlyKeysFor,
    getWeekendOnlyKeys: async (rid, versionId) => (await gatesFor(rid, versionId)).weekend,
    // NEVER THROWS. null ⇒ "use the static allowlist" — today's exact answer, which is neither
    // over-permissive (no free NY pie) nor over-restrictive (no refused legitimate redemption).
    redeemEligibleFor: async (restaurantId) => {
      if (!getVersionId) return null;
      try {
        const versionId = await activeVersionOf(restaurantId);
        if (versionId == null) return null;                     // flat / un-migrated → static
        return (await gatesFor(restaurantId, versionId)).redeem;
      } catch (e) {
        console.warn('redeem_eligibility_read_failed', JSON.stringify({ restaurantId, error: String((e && e.message) || e).slice(0, 160) }));
        return null;                                            // static allowlist = today
      }
    },
    getPickupOnlyKeys: async (rid, versionId) => (await gatesFor(rid, versionId)).pickup,
    _cache: cache,
  };
}

// The pre-portal behaviour, preserved exactly: only x_pizza has weekend-only items today.
function staticWeekendFallback(restaurantId) {
  return restaurantId === 'x_pizza' ? new Set(X_PIZZA_WEEKEND_ONLY) : new Set();
}

module.exports = { createGateReader, weekendOnlyKeysFrom, pickupOnlyKeysFrom, redeemEligibleFrom, gateAuthored, staticWeekendFallback, GATE_READ_DEADLINE_MS, POINTER_TTL_MS };
