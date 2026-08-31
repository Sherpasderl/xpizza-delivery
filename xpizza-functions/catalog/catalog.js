'use strict';
const { buildTablesFromDocs } = require('./catalog-transform');
// Reads a restaurant's pricing tables from the (injected) Firestore doc source, shaped exactly like
// menu-pricing.js's MENU_BY_RESTAURANT[rid]/EXTRAS_BY_RESTAURANT[rid].
//
// 1c-b2 — VERSION-AWARE, BOUNDED cache (replaces the flat 5-min per-restaurant table cache):
//   • The active-version POINTER is read on a SHORT TTL (~pointerTtlMs, default 45s) so a publish
//     propagates in seconds, not minutes. Bounded staleness after a flip = the pointer TTL.
//   • A version's tables are cached keyed by the IMMUTABLE (rid, versionId) — an immutable version can
//     be cached with no TTL and evicted only by a bounded LRU (no unbounded growth across many publishes,
//     grill should-fix #5). A WARM instance serving the active version: one cheap pointer read amortized
//     over the TTL, then a version-cache HIT with NO doc fetch.
//   • The FLAT (un-migrated) layout has no immutable id, so its tables are cached under the SHORT pointer
//     TTL (bounded), never indefinitely — a flip from flat→v1 is picked up within the TTL.
//
// CONTRACT (grill Q5, UNCHANGED): a read failure / not-found PROPAGATES (throws) and is NEVER cached —
// only SUCCESSFUL lookups are cached. So 1b falls back to the code tables on failure instead of caching a
// plausible-empty non-answer.
//
// DI: `getRestaurantDocs(rid)` → { versionId, itemDocs, extraDocs } is the full resolve+read+verify
// primitive (REQUIRED, back-compatible with the 1a/1b wiring). `getActiveVersionId(rid)` → versionId|null
// is an OPTIONAL cheap pointer probe that enables the warm no-fetch path; without it every call does a
// full read (still correct, used by the 1b PIN-E emulator wiring).
function createCatalogReader({ getRestaurantDocs, getActiveVersionId = null, pointerTtlMs = 45000, maxVersions = 64, now = Date.now }) {
  const pointerCache = new Map();   // rid -> { at, versionId(string|null) }   (null = flat) — short TTL
  const versionCache = new Map();   // `${rid}::${versionId}` -> tables         (immutable, LRU-bounded)
  const flatCache = new Map();      // rid -> { at, tables }                    (flat is mutable → short TTL)

  const vkey = (rid, versionId) => `${rid}::${versionId}`;   // per-RESTAURANT key: two brands may share an id string
  function lruGet(key) {
    if (!versionCache.has(key)) return undefined;
    const v = versionCache.get(key); versionCache.delete(key); versionCache.set(key, v);   // touch = most-recent
    return v;
  }
  function lruSet(key, val) {
    versionCache.set(key, val);
    while (versionCache.size > maxVersions) { versionCache.delete(versionCache.keys().next().value); }   // evict oldest
  }

  async function fullRead(rid) {
    const { versionId, itemDocs, extraDocs } = await getRestaurantDocs(rid);   // throw propagates → NOTHING cached
    const tables = buildTablesFromDocs(itemDocs, extraDocs);
    if (versionId == null) flatCache.set(rid, { at: now(), tables });          // flat → short-TTL entry
    else lruSet(vkey(rid, versionId), tables);                                 // version → immutable LRU
    return tables;
  }

  async function getTables(rid) {
    if (getActiveVersionId) {
      let pc = pointerCache.get(rid);
      if (!pc || (now() - pc.at) >= pointerTtlMs) {
        const versionId = await getActiveVersionId(rid);   // cheap pointer read; throw propagates → not cached
        pc = { at: now(), versionId };
        pointerCache.set(rid, pc);
      }
      if (pc.versionId != null) {
        const hit = lruGet(vkey(rid, pc.versionId));
        if (hit !== undefined) return hit;                 // WARM: active version served with NO doc fetch
      } else {
        const fc = flatCache.get(rid);
        if (fc && (now() - fc.at) < pointerTtlMs) return fc.tables;   // flat, bounded by the pointer TTL
      }
    }
    return fullRead(rid);   // cache miss (new version / cold flat) OR no pointer probe → full resolve+read+verify
  }
  return { getTables };
}
module.exports = { createCatalogReader };
