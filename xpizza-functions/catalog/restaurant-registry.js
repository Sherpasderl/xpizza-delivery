'use strict';
// ---------------------------------------------------------------------------
// Portal Phase 2a Task 8 — WHICH RESTAURANTS EXIST, as data instead of as a compiled-in constant.
//
// `KNOWN_RESTAURANTS = Object.keys(MENU_BY_RESTAURANT)` meant a restaurant existed because it had a
// price table in the deploy. That was the last hard block on merchant #3: however complete their
// catalog was, accepting one order for them required a code change and a deploy.
//
// Two constraints shape this, and they pull against each other:
//
//   THE FLOOR IS ABSOLUTE. The registry may only ADD. If a registry read could REMOVE a restaurant,
//   then a Firestore hiccup would make x_pizza unknown and 400 every order — a total outage caused by
//   a lookup that changes a few times a year. So the answer is always (code floor ∪ last-good ∪ fresh),
//   and every failure path is simply "no addition". De-listing is not this gate's job: it is the first
//   of two gates, and getRestaurantIdentity's `active` check already rejects a known-but-closed
//   restaurant — which is exactly how la_musa stayed dark before launch.
//
//   NO PER-ORDER READ. This set changes when a merchant is ONBOARDED, not when an order is placed.
//   One bounded read per instance warms it; a TTL refresh happens in the background, never on the
//   caller's critical path. 200 orders inside the TTL cost one read.
//
// `ready()` exists for the cold-instance case: without it the very first request on a fresh instance
// would see the floor only and 400 a legitimately-registered merchant. It awaits the first read (once,
// bounded) and is a no-op forever after.
// ---------------------------------------------------------------------------
const { KNOWN_RESTAURANTS } = require('../restaurant-id');

const REGISTRY_TTL_MS = 300000;        // 5 min — onboarding cadence, not order cadence
const REGISTRY_DEADLINE_MS = 1500;
const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;   // ids the platform will accept from the registry

function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Only well-formed ids may enter the set. A malformed registry payload must not be able to invent a
// restaurant id, and a blank/absurd entry must never become something `resolveRestaurantId` accepts.
function sanitize(ids) {
  const out = [];
  if (!Array.isArray(ids)) return out;
  for (const raw of ids) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (RID_RE.test(id)) out.push(id);
  }
  return out;
}

function createRestaurantRegistry({ listIds, ttlMs = REGISTRY_TTL_MS, deadlineMs = REGISTRY_DEADLINE_MS, now = Date.now, floor = KNOWN_RESTAURANTS } = {}) {
  const base = [...floor];
  let learned = [];          // LAST-GOOD additions — kept across a later failure so an outage cannot un-onboard
  let at = -Infinity;
  let inflight = null;

  // Union, always. There is no code path that returns less than the floor.
  const known = () => {
    if (listIds && (now() - at) >= ttlMs) { void refresh(); }   // background; never blocks this caller
    return new Set([...base, ...learned]);
  };

  // NEVER throws, NEVER rejects. A failure means "no addition this time", nothing more.
  function refresh() {
    if (inflight) return inflight;                              // one in-flight read; no cold-start stampede
    if (!listIds) return Promise.resolve();
    inflight = (async () => {
      try {
        const p = Promise.resolve(listIds());
        if (p && typeof p.catch === 'function') p.catch(() => {});
        const ids = await withDeadline(p, deadlineMs, 'registry_read');
        const clean = sanitize(ids);
        // A read that returns NOTHING is treated as no news, not as "everyone was de-listed".
        if (clean.length) learned = clean;
        at = now();
      } catch (e) {
        console.warn('restaurant_registry_read_failed', JSON.stringify({ error: String((e && e.message) || e).slice(0, 160) }));
        at = now();                                             // back off; the floor + last-good stand
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  // Cold-start warm. Awaits the FIRST read only; a no-op once the registry has ever answered.
  const ready = () => ((at === -Infinity && listIds) ? refresh() : Promise.resolve());

  return { known, ready, refresh, _state: () => ({ learned: [...learned], at }) };
}

// The production reader: the ids of the `restaurants` collection's documents. listDocuments() returns
// references only — no document bodies — so this stays a cheap metadata call rather than a scan.
// A restaurant doc with no published catalog still fails CLOSED further down: the pricing resolver
// finds nothing and the order is rejected as pricing_unavailable rather than mispriced.
function makeFirestoreRegistryReader(db) {
  return async () => (await db.collection('restaurants').listDocuments()).map((ref) => ref.id);
}

module.exports = { createRestaurantRegistry, makeFirestoreRegistryReader, sanitize, REGISTRY_TTL_MS, REGISTRY_DEADLINE_MS };
