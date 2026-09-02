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

// 2c SERVE-PATH TRIPWIRE. Dropping the parity gate also drops `catalog_parity_mismatch`, which was the
// only thing that noticed a WRONG-BUT-VALID price — the 1a value guard catches zero/negative/non-integer,
// not "299 became 280". Post-flip such a catalog serves silently, because it is authoritative and by
// definition correct. So instead of gating, we make each serve IDENTIFIABLE: a sampled fingerprint of
// what was served — active version, a menu hash, and the key count. During a freeze window an
// unexpected version or hash is then visible and alertable; outside one it is a cheap audit trail of
// which version priced which period. Deliberately observability, NOT a gate.
const FINGERPRINT_MS = 60000;
const _lastFingerprint = new Map();   // restaurantId -> ms
function menuHash(menu) {
  const entries = Object.entries(menu || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return require('crypto').createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 12);
}
function serveFingerprint(restaurantId, cat, nowMs, fire) {
  try {
    // Always emit the FIRST serve for a restaurant, then throttle. Defaulting `last` to 0 would suppress
    // it whenever the clock reads below the window — invisible under a real Date.now(), but it would
    // mean an instance that served once and died left no trace at all, which is the opposite of the
    // point. `has` distinguishes "never emitted" from "emitted at t=0".
    if (_lastFingerprint.has(restaurantId) && (nowMs - _lastFingerprint.get(restaurantId)) < FINGERPRINT_MS) return;
    _lastFingerprint.set(restaurantId, nowMs);
    const detail = { restaurantId, version: (cat && cat.versionId) || null, seq: (cat && cat.seq) != null ? cat.seq : null,
      menu_hash: menuHash(cat && cat.menu), item_count: Object.keys((cat && cat.menu) || {}).length,
      extra_count: Object.keys((cat && cat.extras) || {}).length };
    console.log('catalog_serve_fingerprint', JSON.stringify(detail));
  } catch (_) { /* observability must never break pricing */ }
}

// createPricingResolver({reader, alarm, deadlineMs, ladder}) → { getPricingTables(restaurantId) }
//   reader  — the 1a createCatalogReader wired to FIRESTORE (throws propagate, caches only on success)
//   ladder  — the 2c fallback: last-good, then a version-checked mirror, else fail-closed (no code net)
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

// ═══ Phase 1d Stage 2c — THE FLIP. The catalog is now AUTHORITATIVE. ═══════════════════════════
//
// Before 2c this resolver served the catalog only when it byte-matched the in-code tables, and fell
// back to those tables otherwise. That gate was the right thing while the code tables were the source
// of truth — but it is exactly wrong now: after a portal edit the catalog is SUPPOSED to differ, and a
// parity gate would silently suppress the edit and keep charging the old price. So `tablesEqual`,
// `codeFor` and the `catalog_parity_mismatch` alarm are gone.
//
// What replaces the safety they provided:
//   • the catalog read itself is verified (counts + both hashes + structure) before it serves;
//   • every price is value-guarded (1a) at the calculators;
//   • a read failure falls to the 2b LADDER — last-good, then a version-checked mirror — not to code;
//   • if the ladder cannot vouch for anything, it THROWS and the order is REJECTED. There is no code
//     net any more, and that is deliberate: serving a price nobody can vouch for is worse than
//     refusing the order.
//   • the parity alarm's observability is replaced by a sampled serve fingerprint (below), because a
//     wrong-but-VALID price would otherwise now serve silently.
function createPricingResolver({ reader, alarm, deadlineMs = CATALOG_READ_DEADLINE_MS, now = Date.now, ladder = null }) {
  const fire = (kind, detail) => {                       // an alarm must never break pricing
    try { const r = alarm && alarm(kind, detail); if (r && typeof r.catch === 'function') r.catch(() => {}); }
    catch (_) { /* swallowed: alarming is best-effort, pricing is not */ }
  };
  async function getPricingTables(restaurantId) {
    let cat;
    try {
      const read = reader.getTables(restaurantId);
      // A rejection arriving AFTER we stopped waiting must not become an unhandled rejection. (A late
      // SUCCESS is useful: the reader caches on success, so the next order gets a warm hit.)
      if (read && typeof read.catch === 'function') read.catch(() => {});
      cat = await withDeadline(read, deadlineMs);
      try { if (ladder && cat) ladder.recordActive(restaurantId, cat.versionId, cat.seq); } catch (_) {}
    } catch (e) {
      // Distinguish a HANG from an ERROR so the prod window can tell them apart.
      const kind = (e && e.message === 'catalog_read_timeout') ? 'catalog_read_timeout' : 'catalog_read_failed';
      fire(kind, { restaurantId, error: (e && e.message) ? String(e.message).slice(0, 200) : 'unknown' });
      // 2c: fall to the LADDER, not to code. snapshotFor may THROW (snapshot_fallback_unavailable) —
      // that propagates on purpose and the caller turns it into a clean order reject.
      if (!ladder) throw new Error(`pricing_unavailable: ${restaurantId} — no catalog and no fallback ladder`);
      const snap = await ladder.snapshotFor(restaurantId);
      return { restaurantId, menu: snap.menu, extras: snap.extras };
    }
    // 2c: the catalog serves UNCONDITIONALLY. No parity gate — a portal edit MUST take effect.
    heartbeat(restaurantId, now());
    serveFingerprint(restaurantId, cat, now(), fire);     // replaces catalog_parity_mismatch's visibility
    try { if (ladder) ladder.recordGood(restaurantId, { versionId: cat.versionId, seq: cat.seq, menu: cat.menu, extras: cat.extras }); } catch (_) {}
    return { restaurantId, menu: cat.menu, extras: cat.extras };
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
module.exports = { createPricingResolver, tablesEqual, requireTables, menuHash };   // tablesEqual retained: still used by tests/tools, no longer a serve gate
