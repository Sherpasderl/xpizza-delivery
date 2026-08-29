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

// A catalog read sits in the ORDER REQUEST PATH, so it must be BOUNDED. The fail-safe below catches a
// rejection; it does NOT catch a read that never settles. Unbounded, a slow/hung Firestore would block
// the handler's await until the 30s function timeout and DROP the order — a pricing-cutover-caused
// intake outage. 1500ms is far below the function timeout; warm reads are cache-instant and a cold read
// is sub-second, so a healthy read never approaches this.
const CATALOG_READ_DEADLINE_MS = 1500;
function withDeadline(promise, deadlineMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('catalog_read_timeout')), deadlineMs);
    // Deliberately NOT unref'd: an unref'd deadline is silently defeated whenever nothing else is
    // pending — the event loop drains and the process moves on before the timer can fire, which is
    // exactly the hang case this exists to catch. `clearTimeout` in the finally below is what keeps
    // the timer from outliving the race; the only window it holds the loop open is while we are
    // legitimately waiting for the read.
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// createPricingResolver({reader, codeFor, alarm, deadlineMs}) → { getPricingTables(restaurantId) }
//   reader  — the 1a createCatalogReader wired to FIRESTORE (throws propagate, caches only on success)
//   codeFor — (rid) => { menu, extras } from the in-code menu-pricing tables (the fallback + the yardstick)
//   alarm   — (kind, detail) => ... wired to RTDB paymentAlert; never allowed to break pricing
// Returns tables TAGGED with the restaurant (PIN B) so a caller can never price one brand's items
// against the other's table (x_pizza keys by NAME, la_musa by ID — disjoint namespaces).
// Heartbeat: a durable POSITIVE signal that the catalog actually served. Without it, "zero alarms" is
// ambiguous — it reads the same whether the catalog served every order or the read never ran at all.
// SAMPLED per restaurant (never per order): at most one line per HEARTBEAT_MS, so a busy hour emits a
// handful of lines, not thousands.
const HEARTBEAT_MS = 60000;
const _lastHeartbeat = new Map();   // restaurantId -> ms
function heartbeat(restaurantId, now) {
  const last = _lastHeartbeat.get(restaurantId) || 0;
  if (now - last < HEARTBEAT_MS) return;
  _lastHeartbeat.set(restaurantId, now);
  console.log('pricing_catalog_hit', JSON.stringify({ restaurantId }));
}

function createPricingResolver({ reader, codeFor, alarm, deadlineMs = CATALOG_READ_DEADLINE_MS, now = Date.now }) {
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
      const read = reader.getTables(restaurantId);
      // A rejection arriving AFTER we stopped waiting must not become an unhandled rejection. (A late
      // SUCCESS is useful: the 1a reader caches on success, so the next order gets a warm hit.)
      if (read && typeof read.catch === 'function') read.catch(() => {});
      cat = await withDeadline(read, deadlineMs);
    } catch (e) {
      // Distinguish a HANG from an ERROR so the prod-prove window can tell them apart.
      const kind = (e && e.message === 'catalog_read_timeout') ? 'catalog_read_timeout' : 'catalog_read_failed';
      fire(kind, { restaurantId, error: (e && e.message) ? String(e.message).slice(0, 200) : 'unknown' });
      return fallback;                                    // fail-safe: the live code table still prices the order, fast
    }
    try {
      if (tablesEqual(cat, code)) {
        heartbeat(restaurantId, now());                                                  // sampled "catalog served" signal
        return { restaurantId, menu: cat.menu, extras: cat.extras };                     // ← the cutover
      }
      fire('catalog_parity_mismatch', { restaurantId, diff: diffSummary(cat, code) });
    } catch (e) {
      fire('catalog_parity_mismatch', { restaurantId, error: (e && e.message) ? String(e.message).slice(0, 200) : 'compare failed' });
    }
    return fallback;
  }
  return { getPricingTables };
}
// GRILL-FIX #2 — HARD CONTRACT at production seams. A missed thread must be a LOUD failure, never a
// silent fall back to the code tables: that would reintroduce exactly the split-brain 1b-1b exists to
// eliminate (one half of a redemption priced on catalog, the other on code). Optional `tables` remains
// optional ONLY in the pure calculators, for the legacy unit tests that predate the cutover.
function requireTables(seam, restaurantId, tables) {
  if (tables == null) throw new Error(`pricing_tables_required: ${seam} (restaurantId=${String(restaurantId)})`);
  if (tables.restaurantId !== restaurantId) {
    throw new Error(`pricing_tables_restaurant_mismatch: ${seam} tables=${String(tables.restaurantId)} expected=${String(restaurantId)}`);
  }
  return tables;
}
module.exports = { createPricingResolver, tablesEqual, requireTables };
