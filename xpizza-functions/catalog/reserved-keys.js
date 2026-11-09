'use strict';
// ---------------------------------------------------------------------------
// S1c (PLAN-portal-item-edit r6 §2.2; design D4c-grill/item-s1/S1c-DESIGN.md D1) — THE RESERVED-KEY SET.
// Every item and extra key a restaurant has ever activated, kept forever so no later item can take a key an old cart, a
// stored order or a cached form still names. One doc per restaurant (restaurants/{rid}/meta/reserved_keys):
//   { v: 1, keys: { <b64url(key)>: { dish?: <first version>, extra?: <first version> } } }
// Add-only: a union never removes or rewrites an entry. The key codec is the identity registry's own, so one key has one
// spelling everywhere. A stored doc that does not have this exact shape is refused, never read as empty — an unread set is
// not an empty one. Past a conservative entry cap the set refuses (503) rather than silently drop a key. Pure.
// ---------------------------------------------------------------------------
const { encodeKey } = require('./identity-registry');

const KINDS = ['dish', 'extra'];
// codex S1c r1 P2-1 (advisor): a conservative ENTRY cap, far below Firestore's 1 MiB doc limit for any realistic key length
// (real menus hold ~100 keys). No size arithmetic.
const RESERVED_MAX_ENTRIES = 5000;

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
  if (Object.keys((doc && doc.keys) || {}).length > RESERVED_MAX_ENTRIES) {
    const e = new Error('reserved_keys_full'); e.status = 503; throw e;
  }
}

// D3 (owner 2026-11-09): only a RENAME is judged — an item whose display.id the active version also holds, under a different
// display name. Its new name may not fold to a reserved key other than its own, nor take the opaque-key syntax. An addition is
// never judged here: it is a new item (with minting on, under a fresh key), and history stays with the old one.
const { OPAQUE_SYNTAX } = require('./mint-opaque');
function renameConflicts({ items, activeItems, reserved }) {
  const { normalizeName } = require('./add-product');
  const wasName = new Map((activeItems || []).filter((it) => isPlainObj(it) && isPlainObj(it.display) && it.display.id != null).map((it) => [String(it.display.id), it.display.name]));
  const folded = new Set([...reserved.keys()].map(normalizeName));
  const out = [];
  for (const it of items || []) {
    if (!isPlainObj(it) || !isPlainObj(it.display) || it.display.id == null || typeof it.display.name !== 'string') continue;
    const id = String(it.display.id);
    if (!wasName.has(id) || wasName.get(id) === it.display.name) continue;
    const f = normalizeName(it.display.name);
    const own = typeof it.key === 'string' && normalizeName(it.key) === f;
    if (OPAQUE_SYNTAX.test(it.display.name.trim()) || (!own && folded.has(f))) out.push({ key: it.key, field: 'name', name: it.display.name });
  }
  return out;
}

// codex S1c r1 P2-3 (advisor): a NAME in the minted-key syntax is refused — a new product's, and a renamed one's (its own key
// included) — always, whatever the switches say. An untouched existing name is never judged. Returns [{ key | ref, field }].
function opaqueNameProblems({ items, activeItems }) {
  const wasName = new Map((activeItems || []).filter((it) => isPlainObj(it) && isPlainObj(it.display) && it.display.id != null).map((it) => [String(it.display.id), it.display.name]));
  const out = [];
  for (const it of items || []) {
    if (!isPlainObj(it) || !isPlainObj(it.display) || typeof it.display.name !== 'string') continue;
    const untouched = it.display.id != null && wasName.has(String(it.display.id)) && wasName.get(String(it.display.id)) === it.display.name;
    if (!untouched && OPAQUE_SYNTAX.test(it.display.name.trim())) out.push(own(it, 'ref') ? { ref: it.ref, field: 'name' } : { key: it.key, field: 'name' });
  }
  return out;
}

const reservedRefOf = (db, rid) => db.collection('restaurants').doc(rid).collection('meta').doc('reserved_keys');

module.exports = { renameConflicts, OPAQUE_SYNTAX, reservedRefOf, emptyReserved, readReserved, unionReserved, reservedKeySet, assertWithinLimit, RESERVED_MAX_ENTRIES, opaqueNameProblems };
