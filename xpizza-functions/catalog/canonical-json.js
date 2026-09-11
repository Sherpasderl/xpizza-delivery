'use strict';
// ---------------------------------------------------------------------------
// Portal 1A Task 5/6 — ONE canonical serialization, used wherever bytes have to agree across
// processes: the source-store's draft hashing, and the version CONTENT HASH the reader, the
// publisher and the generator all compute.
//
// Two rules, and the asymmetry between them is the whole point:
//   • OBJECT KEYS ARE SORTED. Firestore hands a document's fields back in an order nobody chose, so
//     key order carries no information and must not change the bytes.
//   • ARRAY ORDER IS LEFT ALONE. Here it is CONTENT — item_order, extra_order, categories, variant
//     lists — and sorting an array would silently rewrite the menu it describes.
//
// Dependency-free on purpose: every module that hashes has to reach exactly this definition, and a
// second copy is a hash that agrees until the day it doesn't.
// ---------------------------------------------------------------------------
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonicalize(value));

module.exports = { canonicalize, canonicalJson };
