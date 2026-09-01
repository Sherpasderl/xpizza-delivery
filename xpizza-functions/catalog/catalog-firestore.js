'use strict';
// Real Firestore read adapter for the catalog (the PRICING reader — MONEY). Returns the
// {itemDocs, extraDocs} shape the pure buildTablesFromDocs (catalog-transform.js) consumes. Wired into
// createCatalogReader → the 1b guarded resolver.
//
// 1c-b2 — VERSIONED PUBLISH: the reader no longer reads the flat `restaurants/{rid}/menu_items` layout
// directly. It resolves the `restaurants/{rid}/meta/active_version` POINTER, then reads the pointed
// IMMUTABLE version's docs and VERIFIES completeness (count + full menu_hash/extras_hash) BEFORE
// returning. The atomic flip of that pointer is the whole cutover; a mid-publish reader sees the OLD
// version until the flip.
//
// 🔒 POINTER-ABSENT vs ERROR — TWO DISTINCT STATES, never conflated (grill blocker #3):
//   • CLEAN pointer not-found (the doc does not exist — an un-migrated restaurant) → fall back to the
//     FLAT layout (zero-window migration). If the flat layout is ALSO absent → throw restaurant_not_found.
//   • MALFORMED pointer / read error / version missing / completeness (count/hash) mismatch → THROW.
//     The 1b resolver fail-safes the throw → code tables + alarm, never a drop, never a plausible-empty.
// The reader distinguishes a clean doc-absent (snap.exists === false) from a read ERROR (a thrown
// rejection propagates). Fail-safe: if it cannot tell, the throw wins.
//
// The TRUST BOUNDARY (Codex) is UNCHANGED from 1a/1b: malformed data must NEVER read back as a
// plausible success. Every doc is validated — non-string/missing key, duplicate key, and any price that
// isn't a POSITIVE INTEGER are rejected (a non-integer price would reach `total += menu[key]*qty` in
// 1b → {total:NaN, error:null}).
//
// Phase 1d Stage 1a tightened `>= 0` to `> 0`: a zero price is not a free item, it is a corrupt or
// fat-fingered one. Because this validation is shared by the flat layout AND a version's docs, and
// readVersionDocs runs inside publishVersion's pre-flip verify, the rule ALSO blocks the version
// pointer from ever flipping to a version containing a zero price — the guard reaches publish time
// with no separate publish-side change.
const { buildTablesFromDocs } = require('./catalog-transform');
const { assertComplete } = require('./catalog-integrity');

// Shared per-doc validation → [{key, price}]. Identical rules for the flat layout AND a version's docs.
function mapDocs(snap, where) {
  const seen = new Set();
  return snap.docs.map((d) => {
    const v = d.data() || {};
    if (typeof v.key !== 'string' || !v.key) throw new Error(`catalog_bad_doc: ${where}/${d.id} — missing/non-string key`);
    if (!Number.isInteger(v.price) || v.price <= 0) throw new Error(`catalog_bad_doc: ${where}/${v.key} — price not a positive integer`);
    if (seen.has(v.key)) throw new Error(`catalog_dup_key: ${where}/${v.key}`);
    seen.add(v.key);
    return { key: v.key, price: v.price };
  });
}

// ── The active-version POINTER (cheap read) ─────────────────────────────────────────────────────
// Returns the versionId string, or null for a CLEAN pointer-absent (→ flat fallback). Throws on a
// MALFORMED pointer. A Firestore read error rejects and propagates (never masked as "absent").
async function getActiveVersionId(db, restaurantId) {
  const snap = await db.collection('restaurants').doc(restaurantId).collection('meta').doc('active_version').get();
  if (!snap.exists) return null;                                   // CLEAN absent → the caller falls back to flat
  const d = snap.data() || {};
  if (typeof d.version !== 'string' || !d.version) {
    throw new Error(`active_version_malformed: ${restaurantId}`);  // pointer exists but unusable → fault, NOT flat
  }
  return d.version;
}

// ── Read a specific IMMUTABLE version's pricing docs + VERIFY completeness ───────────────────────
async function readVersionDocs(db, restaurantId, versionId) {
  const vref = db.collection('restaurants').doc(restaurantId).collection('versions').doc(versionId);
  const [recSnap, items, extras] = await Promise.all([vref.get(), vref.collection('menu_items').get(), vref.collection('extras').get()]);
  if (!recSnap.exists) throw new Error(`version_missing: ${restaurantId}/${versionId}`);
  const record = recSnap.data() || {};
  const where = `${restaurantId}/versions/${versionId}`;
  const itemDocs = mapDocs(items, where);
  const extraDocs = mapDocs(extras, where);
  // Completeness-on-read (money PIN): the read set MUST match the version-record's counts AND both full
  // hashes, or the read was torn/tampered → THROW (never serve partial). buildTablesFromDocs is the SAME
  // pure transform the pricing path uses, so the reader-side hashes are computed exactly as the publisher's.
  const { menu, extras: extraTable } = buildTablesFromDocs(itemDocs, extraDocs);
  assertComplete(record, menu, extraTable, where);
  // 2b-pre: surface the record's SEQ — the monotonic ordinal. Rollback builds its snapshot/mirror
  // payload from here, and without it a rollback would emit an ordinal-less fallback on exactly the
  // path where a coherent fallback matters most. Read-side (2b) treats an ABSENT seq as too-stale,
  // never as distance-zero, so a pre-ordinal mirror can never read as perfectly fresh.
  return { itemDocs, extraDocs, seq: record.seq };
}

// ── The FLAT layout (un-migrated restaurant) — byte-identical to the pre-1c-b2 reader ────────────
async function readFlatDocs(db, restaurantId) {
  const rref = db.collection('restaurants').doc(restaurantId);
  const [profile, items, extras] = await Promise.all([rref.get(), rref.collection('menu_items').get(), rref.collection('extras').get()]);
  if (!profile.exists) throw new Error(`restaurant_not_found: ${restaurantId}`);   // not-found ≠ empty
  if (items.empty) throw new Error(`catalog_empty: ${restaurantId}`);              // known restaurant, no menu items
  return { itemDocs: mapDocs(items, restaurantId), extraDocs: mapDocs(extras, restaurantId) };
}

// The pricing reader. Resolves the pointer, then reads+verifies the pointed version; falls back to the
// flat layout ONLY on a clean pointer-absent. Returns { versionId, itemDocs, extraDocs } — versionId is
// the immutable id served (or null when the flat layout served). Downstream (buildTablesFromDocs → the
// 1b resolver → the guard) is BYTE-UNCHANGED and ignores versionId.
async function getRestaurantDocs(db, restaurantId) {
  const versionId = await getActiveVersionId(db, restaurantId);   // throws on malformed / read error
  if (versionId == null) {
    const flat = await readFlatDocs(db, restaurantId);            // clean-absent → flat (throws if flat also absent)
    return { versionId: null, itemDocs: flat.itemDocs, extraDocs: flat.extraDocs };
  }
  const { itemDocs, extraDocs } = await readVersionDocs(db, restaurantId, versionId);   // throws on version-missing / completeness fail
  return { versionId, itemDocs, extraDocs };
}

module.exports = { getRestaurantDocs, getActiveVersionId, readVersionDocs, readFlatDocs, mapDocs };
