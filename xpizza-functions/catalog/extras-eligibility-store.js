'use strict';
// PER-PRODUCT EXTRAS — the per-version ELIGIBILITY document (PLAN rev 2.1 §4/§7). Written by the publisher beside the
// version's other docs (`restaurants/{rid}/versions/{versionId}/meta/extras_eligibility`), immutable like them, and read
// back for EXACTLY the version a request's pricing tables were built from.
//
//   { version: 1, projection: <projectEligibility(...)>, public_deny: <publicDeny(...)> }
//
// A version published before this feature has NO such document. That absence is never "unrestricted": under a
// shadow/enforce mode it is `unavailable` (§4); the public body simply carries no `extras_eligibility` field for it.
const { projectEligibility, publicDeny } = require('./extras-eligibility');

const DOC_VERSION = 1;
const eligibilityRefOf = (db, rid, versionId) => db.collection('restaurants').doc(rid).collection('versions').doc(versionId).collection('meta').doc('extras_eligibility');

// what the publisher writes, from the SAME items/extras/structure the version's docs carry (pricing keys; display ids
// translated by the evaluator). Throws on a structurally impossible source (a dangling variantOf): never a guess.
function buildEligibilityDoc({ items, extras, structure }) {
  const projection = projectEligibility({ items, extras, structure });
  return { version: DOC_VERSION, projection, public_deny: publicDeny(projection) };
}

// one read per (rid, versionId) per instance — the document is immutable for the life of the version
const _cache = new Map();
const CACHE_MAX = 16;
async function readEligibility(db, rid, versionId) {
  if (typeof versionId !== 'string' || !versionId) return null;
  const k = `${rid}\u0000${versionId}`;
  if (_cache.has(k)) return _cache.get(k);
  const snap = await eligibilityRefOf(db, rid, versionId).get();   // a read error THROWS — the caller decides (§4)
  const doc = snap.exists ? snap.data() : null;
  const valid = !!(doc && doc.version === DOC_VERSION && doc.projection && typeof doc.projection === 'object' && doc.public_deny && typeof doc.public_deny === 'object');
  const out = valid ? doc : null;
  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(k, out);
  return out;
}

module.exports = { buildEligibilityDoc, readEligibility, eligibilityRefOf, DOC_VERSION, _cache };
