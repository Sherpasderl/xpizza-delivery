'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D1 — THE ONE-TIME, IDEMPOTENT BACKFILL.
//
// Walks the LIVE catalog and ensures every dish and every extra has a registry entry. Run it twice and
// the second run mints nothing: ensureIdentity is conditional on the key row, so a re-run reads and
// preserves. That property is the whole point — a backfill that re-mints is a backfill that hands the
// same object two identities, and every record written between the runs then points at the wrong one.
//
// 🔴 THE LEGACY KEY COMES FROM THE PRICING RESOLVER, NOT FROM A SECOND COPY OF ITS RULE. x_pizza keys
// by name and la_musa by id, and that asymmetry is already stated once, in itemPricingKey — which
// pricing AND the 86 gate both resolve through precisely so the two can never drift. If this module
// re-implemented "name or id" it would become a third opinion, correct today and silently wrong the
// first time the rule moves. Extras follow their brand's dish rule (checked in menu-pricing's own
// extras branches: byId for la_musa, by name for x_pizza), so they key through the same resolver.
//
// This module READS the catalog and WRITES only the registry. It never touches a version payload, a
// numeric price table, or a business selector.
// ---------------------------------------------------------------------------
const { ensureIdentity } = require('./identity-registry');
const { itemPricingKey } = require('../menu-pricing');

/* The legacy key for a DISH — literally the pricing resolver. */
function dishKey(rid, item) {
  const k = itemPricingKey(item, rid);
  return typeof k === 'string' && k ? k : null;
}

/* …and for an EXTRA, which keys the way its brand's dishes do. Expressed by handing the extra to the
   SAME resolver rather than re-deriving the brand rule: an extra record carries `id` and `name` in the
   same shape an item does, so the resolver answers correctly for it, and there is still exactly one
   place that knows how a brand keys. */
function extraKey(rid, extra) {
  const k = itemPricingKey(extra, rid);
  return typeof k === 'string' && k ? k : null;
}

/* Enumerate what is LIVE, from a menu snapshot in getRestaurantMenu's shape. Deliberately takes the
   snapshot rather than reading it here: the caller decides which read it is willing to make, and this
   stays runnable against a fixture, a version read, or the emulator without knowing the difference. */
function liveKeys(rid, menu) {
  const items = Array.isArray(menu && menu.items) ? menu.items : [];
  const extras = Array.isArray(menu && menu.extras) ? menu.extras : [];
  const dish = [...new Set(items.map((i) => dishKey(rid, i)).filter(Boolean))];
  const extra = [...new Set(extras.map((e) => extraKey(rid, e)).filter(Boolean))];
  return { dish, extra };
}

/* Ensure identities for every live object. Returns a report rather than logging: the caller is a tool
   in D1 and a test in §7, and both want the counts.
   SEQUENTIAL per key, not Promise.all: each ensureIdentity is a transaction, and firing hundreds
   concurrently against the same collection turns ordinary contention into retry storms for no gain —
   this is a one-time migration, not a serving path. */
async function backfillIdentities(db, rid, menu, { now = null } = {}) {
  const keys = liveKeys(rid, menu);
  const report = { rid, dish: { total: 0, created: 0, preserved: 0 }, extra: { total: 0, created: 0, preserved: 0 }, ids: { dish: {}, extra: {} } };
  for (const kind of ['dish', 'extra']) {
    for (const legacyKey of keys[kind]) {
      const r = await ensureIdentity(db, { rid, kind, legacyKey, now });
      report[kind].total += 1;
      report[kind][r.created ? 'created' : 'preserved'] += 1;
      report.ids[kind][legacyKey] = r.canonical_id;
    }
  }
  return report;
}

/* Ensure identities for an explicit key set — what a WRITE path has, as opposed to a menu snapshot.
   Same engine as the backfill and the same idempotence: an existing key is read and preserved, only a
   genuinely new one mints. Kept beside the backfill rather than in the registry because it is the same
   operation the backfill performs, and two functions that must agree about "ensure this set" are one
   function. */
async function ensureIdentitiesForKeys(db, rid, keysByKind, { now = null } = {}) {
  const report = { rid, dish: { total: 0, created: 0, preserved: 0 }, extra: { total: 0, created: 0, preserved: 0 } };
  for (const kind of ['dish', 'extra']) {
    for (const legacyKey of [...new Set((keysByKind[kind] || []).filter((k) => typeof k === 'string' && k))]) {
      const r = await ensureIdentity(db, { rid, kind, legacyKey, now });
      report[kind].total += 1;
      report[kind][r.created ? 'created' : 'preserved'] += 1;
    }
  }
  return report;
}

module.exports = { backfillIdentities, ensureIdentitiesForKeys, liveKeys, dishKey, extraKey };
