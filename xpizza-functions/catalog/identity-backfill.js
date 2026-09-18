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

/* 🔴 TWO PRODUCERS, TWO SHAPES — and getting this wrong registered NOTHING, silently.
   The catalog READER emits { key, price, display }: the legacy key is already computed and sits at
   `record.key`. The SERVED projection and a cart line carry the display fields instead — name on
   x_pizza, id on la_musa — which is what itemPricingKey reads.
   The first version fed reader records straight to itemPricingKey. There is no top-level name or id
   there, so every key came back null, every record was filtered out, and backfillIdentities returned a
   perfectly healthy report with every count zero: 24 dishes in, 0 registered, no error. Tests passed
   because they fed it cart-shaped fixtures — the shape the function was imagined to take rather than
   the one its real caller produces.
   Both shapes are accepted explicitly, reader first, because the reader's key is authoritative: it is
   the key the version was WRITTEN under. Falling through to itemPricingKey covers the display/cart
   shape. Anything else returns null — and the caller below now treats a wholesale null as a fault
   rather than as an empty day's work. */
function legacyKeyOf(rid, record) {
  if (record && typeof record.key === 'string' && record.key) return record.key;   // reader shape
  const k = itemPricingKey(record, rid);                                            // display / cart shape
  return typeof k === 'string' && k ? k : null;
}

const dishKey = (rid, item) => legacyKeyOf(rid, item);
const extraKey = (rid, extra) => legacyKeyOf(rid, extra);

/* Enumerate what is LIVE, from a menu snapshot in getRestaurantMenu's shape. Deliberately takes the
   snapshot rather than reading it here: the caller decides which read it is willing to make, and this
   stays runnable against a fixture, a version read, or the emulator without knowing the difference. */
function liveKeys(rid, menu) {
  const items = Array.isArray(menu && menu.items) ? menu.items : [];
  const extras = Array.isArray(menu && menu.extras) ? menu.extras : [];
  /* 🔴 PER RECORD, NOT PER BATCH. The first guard here fired only when EVERY record failed to key,
     which catches the shape mismatch that made this whole module a no-op but not the hazard that
     outlives it: a shape that breaks SOME records. Those were dropped by a `.filter(Boolean)` — the
     remainder registered cleanly, the report looked healthy, and the gaps were invisible. That is the
     same defect as the wholesale zero, only quieter and harder to notice, because a partially
     registered catalog serves ids for most dishes and silently id-less for the rest.
     So every live record must yield a key or the backfill fails, loudly, naming the record. "Every
     catalog record gets an id or nobody does" is now a runtime invariant rather than an equality a
     test happens to check, and a future third record shape fails on record #1 instead of leaving
     holes. The error keeps its name: identity_backfill_unkeyable is the same fault, found earlier. */
  const keyed = (kind, records, keyOf) => records.map((rec, i) => {
    const k = keyOf(rid, rec);
    if (!k) {
      const shape = rec && typeof rec === 'object' ? Object.keys(rec).join(',') : typeof rec;
      throw new Error(`identity_backfill_unkeyable: ${rid} ${kind}[${i}] yields no legacy key — fields were {${shape}}`);
    }
    return k;
  });
  const dish = [...new Set(keyed('dish', items, dishKey))];
  const extra = [...new Set(keyed('extra', extras, extraKey))];
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
async function ensureIdentitiesForKeys(db, rid, keysByKind, { now = null, shouldStop = null } = {}) {
  const report = { rid, dish: { total: 0, created: 0, preserved: 0 }, extra: { total: 0, created: 0, preserved: 0 }, stopped: false };
  for (const kind of ['dish', 'extra']) {
    for (const legacyKey of [...new Set((keysByKind[kind] || []).filter((k) => typeof k === 'string' && k))]) {
      /* 🔴 A REAL ABANDONMENT POINT, CHECKED BEFORE EVERY WRITE. The publish hook bounds this with a
         Promise.race, and a race only stops WAITING — the loop underneath went on transacting, so a
         registry that stalled past the deadline still wrote its whole key set minutes later while the
         publish had long since reported the keys unregistered. `shouldStop` is what makes the bound
         mean what the caller says it means: once it turns true, no further transaction is STARTED. At
         most the one already in flight completes, which is bounded by Firestore's own transaction
         limit rather than by nothing at all. */
      if (typeof shouldStop === 'function' && shouldStop()) { report.stopped = true; return report; }
      const r = await ensureIdentity(db, { rid, kind, legacyKey, now });
      report[kind].total += 1;
      report[kind][r.created ? 'created' : 'preserved'] += 1;
    }
  }
  return report;
}

module.exports = { backfillIdentities, ensureIdentitiesForKeys, liveKeys, dishKey, extraKey, legacyKeyOf };
