'use strict';
/* R1c — THE CATALOG CACHE CLOCK: the per-instance catalog caches refill when THE TEST says, never when wall time does.
 *
 * 🔴 WHY. index.js builds its catalog readers as private singletons (pricing pointer + gate pointer, 45 s; context record,
 * 45 s; verifier observation, 60 s; restaurant registry, 5 min), each on the default clock `Date.now`. A trace suite that
 * runs past a TTL under load records a refill in whichever late case crosses it, and its frozen golden (one COLD load per
 * brand, nothing after) then differs: order-control went RED 5/10 under 12 burners with exactly one leading
 * `get`+`getAll restaurants/<rid>/meta/active_version` (R1b evidence, oc-repro/dump.jsonl). makeCacheFill set those
 * refills aside by SHAPE under a wall-time budget — it never proved a refill was due. This replaces it with control.
 *
 * HOW, with no index.js edit. Every one of those factories takes its clock / TTL as an option and index.js passes none.
 * install() wraps the REAL factory exports BEFORE index.js loads (index.js destructures them at load, so it captures the
 * wrapper), and the wrapper only adds options:
 *   · TTL-ONLY clocks get the VIRTUAL clock (frozen; advance(ms) moves it): createCatalogReader `now`, createGateReader
 *     `nowMs`, createRestaurantRegistry `now`. Each uses its clock for nothing but cache age (checked at R1c).
 *   · createContextSource / createCatalogVerifier use their clock for READ DEADLINES too (lateBy, timeoutMs), so they keep
 *     the REAL clock — a frozen one would accept a late completion production rejects. Only their TTL is held for the
 *     run (recordTtlMs / ttlMs = HOLD_MS). They are therefore NOT advanceable: a suite that must see the context refresh
 *     uses a fresh process (or mirror-trace's global Date.now offset, which this hook does not affect).
 * Each wrapper REFUSES a caller that already passes the option it injects (the hook would silently override production
 * wiring) and counts its constructions, so a suite proves the live singletons were built through it (built()).
 *
 * OBSERVED (codex R1c P2): the wrapper also wraps — never replaces — the caller's own data source for the two reads whose
 * occurrence a trace suite must attribute: the pricing reader's FULL load (`getRestaurantDocs(rid)` = the COLD load) and
 * the registry's list (`listIds()`). Each call is appended to loads() as { kind, rid, n }. A suite marks loads().length
 * before a recorded request and reads the slice after it: THAT request cold-loaded those rids — a fact, not a shape.
 */
const path = require('path');

const FN = path.join(__dirname, '..');
const INDEX = require.resolve(path.join(FN, 'index.js'));
const HOLD_MS = 24 * 3600 * 1000;   // longer than any suite: a held TTL never expires inside a run

// [module, factory, { option: 'virtual' | 'hold' }]
const HOOKS = [
  ['catalog/catalog', 'createCatalogReader', { now: 'virtual' }, { getRestaurantDocs: 'cold' }],
  ['catalog/menu-gates', 'createGateReader', { nowMs: 'virtual' }],
  ['catalog/restaurant-registry', 'createRestaurantRegistry', { now: 'virtual' }, { listIds: 'registry' }],
  ['catalog/context-source', 'createContextSource', { recordTtlMs: 'hold' }],
  ['catalog/catalog-verifier', 'createCatalogVerifier', { ttlMs: 'hold' }],
];

let installed = null;

function install({ start = Date.now() } = {}) {
  if (installed) throw new Error('catalog-clock: install() called twice — one clock per process');
  if (require.cache[INDEX]) throw new Error('catalog-clock: index.js is ALREADY loaded — its singletons captured the real factories; install() must run before require(\'../index.js\')');
  let v = start;
  const now = () => v;
  const built = {};
  const log = [];
  for (const [rel, name, inject, observe = {}] of HOOKS) {
    const mod = require(path.join(FN, rel));
    const real = mod[name];
    if (typeof real !== 'function') throw new Error(`catalog-clock: ${rel}.${name} is not a function — the hook list is stale`);
    const add = Object.fromEntries(Object.entries(inject).map(([k, kind]) => [k, kind === 'virtual' ? now : HOLD_MS]));
    mod[name] = function catalogClockHooked(opts = {}) {
      for (const k of Object.keys(add)) {
        if (opts && opts[k] !== undefined) throw new Error(`catalog-clock: ${name} was passed '${k}' by its caller — the hook would override production wiring (re-check R1c)`);
      }
      built[name] = (built[name] || 0) + 1;
      const seen = {};
      for (const [k, kind] of Object.entries(observe)) {
        const src = opts && opts[k];
        if (typeof src !== 'function') continue;   // absent → nothing observed → a suite's cold attribution fails CLOSED
        seen[k] = function observed(...a) { log.push({ kind, rid: kind === 'cold' ? a[0] : null, n: log.length }); return src.apply(this, a); };
      }
      return real.call(this, { ...(opts || {}), ...seen, ...add });
    };
  }
  installed = {
    now,
    advance(ms) { if (!(Number.isFinite(ms) && ms >= 0)) throw new Error(`catalog-clock: advance(${ms})`); v += ms; },
    built: () => ({ ...built }),
    loads: () => log.map((x) => ({ ...x })),
    // the rids whose COLD (full) load ran since `mark` (= loads().length taken before the request)
    coldSince: (mark) => log.slice(mark).filter((x) => x.kind === 'cold').map((x) => x.rid),
    // the singletons a request has used were built THROUGH the hook (else the clock controls nothing)
    assertBuilt(names, label = 'catalog-clock') {
      for (const n of names) {
        if (built[n] !== 1) throw new Error(`🔴 ${label}: ${n} was built ${built[n] || 0}× through the clock hook (want exactly 1 — the index.js singleton)`);
      }
    },
  };
  return installed;
}

module.exports = { install, HOOKS, HOLD_MS };
