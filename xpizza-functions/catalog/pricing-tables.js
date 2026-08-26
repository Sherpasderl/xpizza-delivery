'use strict';
// ---------------------------------------------------------------------------
// Phase 1b-1 — the GUARDED pricing resolver. This is the money cutover's whole safety story.
//
// Prices come from the Firestore catalog ONLY when it byte-equals the in-code table; on ANY
// divergence, catalog read failure, or malformed shape we serve the CODE table and alarm. We
// migrate the SOURCE, never the VALUES — a customer can never be mispriced by this resolver.
//
// TWO DATASTORES, deliberately injected (never raw handles): the catalog read is FIRESTORE
// (getRestaurantDocs → db.collection) and the alarm is RTDB (paymentAlert → db.ref). Passing one
// `db` for both would fail SILENTLY — an RTDB handle makes the reader throw on every call, the
// fail-safe swallows it, and the cutover never happens while every fake-reader test still passes.
// The DI shape makes that miswiring impossible to express here, and PIN E (the emulator test,
// which uses the REAL reader) is what proves the wiring at the call site.
// ---------------------------------------------------------------------------

// PIN A — STRICT structural equality: identical KEY SETS for menu AND extras, and exact
// integer-value equality per key. No coercion, no reference compare. A differing price, a
// missing key or an extra key → not equal. Never throws: a malformed side is simply not equal.
function tableEqual(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;   // key sets must match exactly
    const av = a[k], bv = b[k];
    if (!Number.isInteger(av) || !Number.isInteger(bv) || av !== bv) return false;  // exact integers only
  }
  return true;
}
function tablesEqual(cat, code) {
  if (!cat || !code) return false;
  return tableEqual(cat.menu, code.menu) && tableEqual(cat.extras, code.extras);
}

// A bounded, alarm-friendly description of HOW the catalog diverged (for the prod-prove window).
function diffSummary(cat, code) {
  const of = (o) => (o && typeof o === 'object') ? o : {};
  const out = {};
  for (const side of ['menu', 'extras']) {
    const c = of(cat && cat[side]), k = of(code && code[side]);
    const keys = new Set([...Object.keys(c), ...Object.keys(k)]);
    const diffs = [];
    for (const key of keys) { if (c[key] !== k[key] && diffs.length < 5) diffs.push({ key, catalog: c[key], code: k[key] }); }
    out[side] = { catalog_count: Object.keys(c).length, code_count: Object.keys(k).length, sample: diffs };
  }
  return out;
}

// createPricingResolver({reader, codeFor, alarm}) → { getPricingTables(restaurantId) }
//   reader  — the 1a createCatalogReader wired to FIRESTORE (throws propagate, caches only on success)
//   codeFor — (rid) => { menu, extras } from the in-code menu-pricing tables (the fallback + the yardstick)
//   alarm   — (kind, detail) => ... wired to RTDB paymentAlert; never allowed to break pricing
// Returns tables TAGGED with the restaurant (PIN B) so a caller can never price one brand's items
// against the other's table (x_pizza keys by NAME, la_musa by ID — disjoint namespaces).
function createPricingResolver({ reader, codeFor, alarm }) {
  const fire = (kind, detail) => {                       // an alarm must never break pricing
    try { const r = alarm && alarm(kind, detail); if (r && typeof r.catch === 'function') r.catch(() => {}); }
    catch (_) { /* swallowed: alarming is best-effort, pricing is not */ }
  };
  async function getPricingTables(restaurantId) {
    let code;
    try { code = codeFor(restaurantId); } catch (_) { code = undefined; }
    const fallback = { restaurantId, menu: code && code.menu, extras: code && code.extras };
    let cat;
    try {
      cat = await reader.getTables(restaurantId);
    } catch (e) {
      fire('catalog_read_failed', { restaurantId, error: (e && e.message) ? String(e.message).slice(0, 200) : 'unknown' });
      return fallback;                                    // fail-safe: the live code table still prices the order
    }
    try {
      if (tablesEqual(cat, code)) return { restaurantId, menu: cat.menu, extras: cat.extras };   // ← the cutover
      fire('catalog_parity_mismatch', { restaurantId, diff: diffSummary(cat, code) });
    } catch (e) {
      fire('catalog_parity_mismatch', { restaurantId, error: (e && e.message) ? String(e.message).slice(0, 200) : 'compare failed' });
    }
    return fallback;
  }
  return { getPricingTables };
}
module.exports = { createPricingResolver, tablesEqual };
