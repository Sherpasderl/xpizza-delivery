'use strict';
// ---------------------------------------------------------------------------
// Merchant STATS — Firestore SINGLE-FIELD INDEX EXEMPTIONS (codex build r1 #4).
//
// Firestore indexes every field of every document by default and REFUSES a write whose document needs
// more than 40,000 index entries. The stats documents carry large, never-queried maps and arrays (a
// customer shard holds thousands of hmac → [dates] entries; a daily doc holds per-customer and per-item
// maps). Stats documents are only ever read BY ID, so none of these fields needs an index.
//
// THIS LIST IS THE SOURCE; every entry MUST be present in firestore.indexes.json `fieldOverrides`
// (stats-guard asserts it). Deploying it — ONLY via `npm run deploy:indexes` (tools/deploy-indexes.js:
// non-interactive, never --force) — is an OWNER STEP THAT MUST PRECEDE THE BACKFILL. The size preflight counts index
// entries UNDER these exemptions, and ALSO reports the count under default indexing, so an undeployed
// exemption shows up as a refused commit (atomic, nothing partial) rather than as a silent certification.
// ---------------------------------------------------------------------------
const EXEMPT = Object.freeze([
  { collectionGroup: 'stats_customers', fieldPath: 'c' },
  { collectionGroup: 'stats_daily', fieldPath: 'customers' },
  { collectionGroup: 'stats_daily', fieldPath: 'items' },
  { collectionGroup: 'stats_daily', fieldPath: 'by_hour' },
  { collectionGroup: 'stats_daily', fieldPath: 'by_type' },
  { collectionGroup: 'stats_daily', fieldPath: 'by_payment' },
  { collectionGroup: 'stats_daily', fieldPath: 'prep' },
  { collectionGroup: 'stats_daily', fieldPath: 'delivery' },
  { collectionGroup: 'stats_meta', fieldPath: 'pending_repair' },
]);

const exemptFor = (collectionGroup) => new Set(EXEMPT.filter((e) => e.collectionGroup === collectionGroup).map((e) => e.fieldPath));

// The firestore.indexes.json shape: an exemption = a fieldOverride whose `indexes` is EMPTY, which
// disables ascending, descending and array-contains for that field AND its subfields. `collectionGroup`
// names the collection id (stats_* exist only under restaurants/{rid}).
const fieldOverrides = () => EXEMPT.map((e) => ({ collectionGroup: e.collectionGroup, fieldPath: e.fieldPath, indexes: [] }));

module.exports = { EXEMPT, exemptFor, fieldOverrides };
