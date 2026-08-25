'use strict';
// PURE, dependency-free. Lossless encode/decode between a pricing TABLE ({key: price}) and Firestore
// DOCS ([{key, price}]). Key-agnostic: the key is whatever the table uses (x_pizza NAME / la_musa ID),
// carried verbatim. Price value is carried as-is (never unit-converted — whole lempiras stay whole).
//
// NOTE (grill Q2): these two are mutual inverses, so their in-memory round-trip is an IDENTITY — it
// passes even on an all-zero or entirely wrong menu. It is a transform-correctness guard, NOT a money
// proof. The proof that the CATALOG reproduces live prices is the emulator round-trip in
// test/catalog-parity.emulator.test.js (seed a real Firestore → read via the real adapter → byte-compare).
function buildTablesFromDocs(itemDocs, extraDocs) {
  const toTable = (docs) => {
    const t = {};
    for (const d of (docs || [])) { if (d && typeof d.key === 'string') t[d.key] = d.price; }
    return t;
  };
  return { menu: toTable(itemDocs), extras: toTable(extraDocs) };
}
function codeTablesToCatalogDocs(menuTable, extraTable) {
  const toDocs = (table) => Object.entries(table || {}).map(([key, price]) => ({ key, price }));
  return { itemDocs: toDocs(menuTable), extraDocs: toDocs(extraTable) };
}
module.exports = { buildTablesFromDocs, codeTablesToCatalogDocs };
