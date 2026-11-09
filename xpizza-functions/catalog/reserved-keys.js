'use strict';
// ---------------------------------------------------------------------------
// S1c (PLAN-portal-item-edit r6 §2.2; design D4c-grill/item-s1/S1c-DESIGN.md D1) — THE RESERVED-KEY SET.
// Every item and extra key a restaurant has ever activated, kept forever so no later item can take a key an old cart, a
// stored order or a cached form still names. One doc per restaurant (restaurants/{rid}/meta/reserved_keys):
//   { v: 1, keys: { <b64url(key)>: { dish?: <first version>, extra?: <first version> } } }
// Add-only: a union never removes or rewrites an entry. The key codec is the identity registry's own, so one key has one
// spelling everywhere. A stored doc that does not have this exact shape is refused, never read as empty — an unread set is
// not an empty one. Past the Firestore doc limit the set refuses (503) rather than silently drop a key. Pure.
// ---------------------------------------------------------------------------
const { encodeKey } = require('./identity-registry');

const KINDS = ['dish', 'extra'];
// Firestore's doc limit is 1 MiB including the doc name and per-field overhead; the JSON length is a close upper bound for
// a map of short strings, and the margin covers the rest.
const RESERVED_LIMIT_BYTES = 1048576 - 16384;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const malformed = (why) => { const e = new Error(`reserved_keys_malformed: ${why}`); e.status = 503; return e; };

function decodeKey(encoded) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const key = Buffer.from(encoded, 'base64url').toString('utf8');
  return key && encodeKey(key) === encoded ? key : null;
}

const emptyReserved = () => ({ v: 1, keys: {} });

function readReserved(data) {
  if (data === undefined || data === null) return emptyReserved();
  if (!isPlainObj(data) || data.v !== 1) throw malformed('version');
  if (!isPlainObj(data.keys)) throw malformed('keys');
  for (const [enc, entry] of Object.entries(data.keys)) {
    if (decodeKey(enc) === null) throw malformed('key');
    if (!isPlainObj(entry)) throw malformed('entry');
    const kinds = Object.keys(entry);
    if (kinds.length === 0 || kinds.some((k) => !KINDS.includes(k) || typeof entry[k] !== 'string' || !entry[k])) throw malformed('entry');
  }
  return { v: 1, keys: JSON.parse(JSON.stringify(data.keys)) };
}

function unionReserved(doc, byKind, versionId) {
  if (typeof versionId !== 'string' || !versionId) throw new Error('reserved_keys_bad_version');
  const out = readReserved(doc);
  let added = 0;
  for (const kind of KINDS) {
    for (const key of (byKind && byKind[kind]) || []) {
      const enc = encodeKey(key);
      const entry = own(out.keys, enc) ? out.keys[enc] : (out.keys[enc] = {});
      if (!own(entry, kind)) { entry[kind] = versionId; added += 1; }
    }
  }
  return { doc: out, added };
}

function reservedKeySet(doc) {
  const m = new Map();
  for (const [enc, entry] of Object.entries(readReserved(doc).keys)) m.set(decodeKey(enc), Object.keys(entry).sort());
  return m;
}

function assertWithinLimit(doc) {
  if (Buffer.byteLength(JSON.stringify(doc), 'utf8') > RESERVED_LIMIT_BYTES) {
    const e = new Error('reserved_keys_full'); e.status = 503; throw e;
  }
}

const reservedRefOf = (db, rid) => db.collection('restaurants').doc(rid).collection('meta').doc('reserved_keys');

module.exports = { reservedRefOf, emptyReserved, readReserved, unionReserved, reservedKeySet, assertWithinLimit, RESERVED_LIMIT_BYTES };
