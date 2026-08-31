'use strict';
// ---------------------------------------------------------------------------
// Phase 1c-b2 — PURE integrity descriptors for a versioned catalog snapshot.
//
// A published version carries a COMPLETENESS + INTEGRITY descriptor (item_count / extra_count +
// full menu_hash / extras_hash). The PUBLISHER computes it from the input tables; the READER
// recomputes it from the docs it read back and compares BEFORE serving. A mismatch = a torn /
// tampered / incomplete read → the reader THROWS (→ the 1b resolver serves code + alarm).
//
// 🔒 Grill should-fix #4 — the single truncated `tableHash` in tools/seed-catalog.js is a LOG hash
// (12 chars, order-independent), NOT an integrity hash. Two distinct requirements are deliberately
// separated here:
//   (1) FULL, untruncated SHA-256 — a 12-char prefix has a birthday-bound far too weak to gate money.
//   (2) menu and extras hashed SEPARATELY over their OWN canonical pairs — merging the two namespaces
//       would let a menu/extras key collision hide corruption (an item price moving into an extras key
//       of the same name would cancel out in a merged hash). Separate hashes each catch their own side.
// Dependency-free (crypto only) so both the reader (money path) and the publisher share ONE definition
// and can never drift.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

// Canonical, order-independent serialization of a pricing table ({key: price}). Keys sorted so the
// same logical table always yields the same bytes regardless of insertion / Firestore read order.
// Prices are carried verbatim (integers) exactly as buildTablesFromDocs produces them.
function canonicalPairs(table) {
  const t = (table && typeof table === 'object') ? table : {};
  return Object.keys(t).sort().map((k) => [k, t[k]]);
}

// FULL SHA-256 (64 hex chars) over the canonical pairs. Never truncated — this gates money.
function hashTable(table) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalPairs(table))).digest('hex');
}

// The descriptor stored on the version-record and re-verified on read. `menuTable` / `extraTable`
// are the SAME {key: price} shape buildTablesFromDocs returns, so publisher-side (from the input
// tables) and reader-side (from the read-back docs) compute byte-identical values.
function integrityDescriptor(menuTable, extraTable) {
  return {
    item_count: canonicalPairs(menuTable).length,
    extra_count: canonicalPairs(extraTable).length,
    menu_hash: hashTable(menuTable),
    extras_hash: hashTable(extraTable),
  };
}

// Reader-side completeness gate. Throws (never returns false) on ANY divergence so the caller cannot
// accidentally serve a partial read. Counts caught first (a torn read drops docs), then the full
// hashes (a tampered / reordered value). Menu and extras are each checked against their OWN hash so a
// torn menu read and a torn extras read are BOTH caught, independently (the separate-hash requirement).
function assertComplete(record, menuTable, extraTable, where) {
  const got = integrityDescriptor(menuTable, extraTable);
  const rec = record || {};
  const tag = where ? ` (${where})` : '';
  if (got.item_count !== rec.item_count) {
    throw new Error(`catalog_incomplete_item_count${tag}: read ${got.item_count} != record ${rec.item_count}`);
  }
  if (got.extra_count !== rec.extra_count) {
    throw new Error(`catalog_incomplete_extra_count${tag}: read ${got.extra_count} != record ${rec.extra_count}`);
  }
  if (got.menu_hash !== rec.menu_hash) {
    throw new Error(`catalog_incomplete_menu_hash${tag}: read ${got.menu_hash.slice(0, 12)} != record ${String(rec.menu_hash).slice(0, 12)}`);
  }
  if (got.extras_hash !== rec.extras_hash) {
    throw new Error(`catalog_incomplete_extras_hash${tag}: read ${got.extras_hash.slice(0, 12)} != record ${String(rec.extras_hash).slice(0, 12)}`);
  }
  return true;
}

module.exports = { canonicalPairs, hashTable, integrityDescriptor, assertComplete };
