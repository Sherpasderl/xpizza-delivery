'use strict';
/* 1D D4-c2a — THE DETERMINISTIC ENCODING THE BINDING EVIDENCE IS DIGESTED THROUGH (PLAN-D4c2a rev 9 §2 "ENC").
   Pure: no I/O, no clock, no randomness. Nothing in the live paths READS what it produces — c2a records
   evidence, c2b consumes it.

   🔴 A CLASSIFIER, NOT A GENERAL FIRESTORE ENCODER. Digests cover only values our own code defines: the
   projected registry fields the binding judgement compares (strings, absence) and the in-memory plans and
   verdicts the activation builds. Every leaf is CLASSIFIED and never inspected beyond its class:
     string → ["s", s]   absent/undefined → ["u"]   null → ["n"]   boolean → ["b", 0|1]
     safe integer that is not -0 → ["i", "<decimal>"]
     EVERY other leaf → ["o", <class>], <class> ∈ CLASSES (closed): fractional/unsafe/-0/NaN/±Infinity numbers,
       Timestamp, bytes, DocumentReference, VectorValue, GeoPoint, any other object, function, symbol, bigint.
   Containers: a PLAIN object (prototype Object.prototype or null) → ["m", [[k, v]…]] sorted by the UTF-16
   code units of k; an Array → ["a", […]]; any non-plain object → ["o", <class>] with NO traversal.
   🔴 STATED SEMANTICS: exact for the values the judgement compares; two different malformed values of the
   same class digest EQUALLY — accepted, the judgement already treats any non-string as a mismatch.
   🔴 TOTAL AND IT CANNOT THROW: a getter that throws, a Proxy, a cyclic structure — every failure is caught
   and the value reads as ["o","other"], so no activation that succeeds today can be refused by this
   module. (A cycle cannot occur in the values the writers pass; it is guarded rather than assumed.) */
const crypto = require('crypto');
/* Through firebase-admin, as every other module here: these ARE the underlying SDK's classes (identity-checked in the unit
   test). firebase-admin does not export VectorValue by name, so it is taken from a vector value's own constructor. */
const { Timestamp, GeoPoint, DocumentReference, FieldValue } = require('firebase-admin/firestore');
const VectorValue = FieldValue.vector([]).constructor;

const CLASSES = Object.freeze(['number', 'timestamp', 'bytes', 'reference', 'vector', 'geopoint', 'object', 'other']);
const MAX_DEPTH = 64;   // far beyond any value the writers build; a deeper (or cyclic) value is classified, not walked

function isPlain(v) {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

// The class of a value that is NOT one of the exact tags. Never throws (the caller guards it too).
function classOf(v) {
  if (typeof v === 'number' || typeof v === 'bigint') return 'number';
  if (typeof v !== 'object' || v === null) return 'other';            // function, symbol (null/str/bool are tagged before)
  if (v instanceof Timestamp) return 'timestamp';
  if (v instanceof DocumentReference) return 'reference';
  if (v instanceof VectorValue) return 'vector';
  if (v instanceof GeoPoint) return 'geopoint';
  if (v instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(v))) return 'bytes';
  return 'object';
}

/* A property read that throws (a getter, a Proxy trap) collapses THAT leaf to ["o","other"], not its whole container. */
const THREW = Symbol('threw');
function read(o, k) { try { return o[k]; } catch (_) { return THREW; } }

function tag(v, depth, seen) {
  try {
    if (v === THREW) return ['o', 'other'];
    if (v === undefined) return ['u'];
    if (v === null) return ['n'];
    if (typeof v === 'string') return ['s', v];
    if (typeof v === 'boolean') return ['b', v ? 1 : 0];
    if (typeof v === 'number') {
      if (Number.isSafeInteger(v) && !Object.is(v, -0)) return ['i', String(v)];
      return ['o', 'number'];
    }
    if (typeof v !== 'object') return ['o', classOf(v)];
    if (depth >= MAX_DEPTH || seen.has(v)) return ['o', 'other'];
    if (Array.isArray(v)) {
      seen.add(v);
      const out = [];
      for (let i = 0; i < v.length; i += 1) out.push(tag(read(v, i), depth + 1, seen));
      seen.delete(v);
      return ['a', out];
    }
    if (!isPlain(v)) return ['o', classOf(v)];
    seen.add(v);
    const keys = Object.keys(v).sort(cmpUtf16);
    const out = keys.map((k) => [k, tag(read(v, k), depth + 1, seen)]);
    seen.delete(v);
    return ['m', out];
  } catch (_) {
    return ['o', 'other'];
  }
}

// UTF-16 code-unit order — what `<` on strings already is; written out so no locale ever enters.
function cmpUtf16(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

/* ENC(v) — the canonical UTF-8 JSON of the tagged tree. JSON.stringify of strings/arrays only cannot throw;
   it is still guarded so the module's promise ("total") is a property of the code and not of its inputs. */
function ENC(v) {
  try { return JSON.stringify(tag(v, 0, new Set())); } catch (_) { return '["o","other"]'; }
}

// H(x) = base64url(sha256(bytes)) — 43 characters. A string is hashed as its UTF-8 bytes.
function H(x) {
  return crypto.createHash('sha256').update(typeof x === 'string' ? Buffer.from(x, 'utf8') : x).digest('base64url');
}

// H(ENC(v)) — the digest of a value.
function D(v) { return H(ENC(v)); }

/* A set-like list, sorted by the ENCODED BYTES of each member (so the order is a function of content alone,
   never of read order or Map insertion order). Returns the tagged list's digest input directly. */
function sortedSet(list) {
  const enc = (Array.isArray(list) ? list : []).map((x) => ENC(x));
  enc.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return `["a",[${enc.join(',')}]]`;
}
/* The digest of a set-like list — EXACTLY H(sortedSet(list)), computed without the per-comparison allocations: each member is
   encoded once and turned into its UTF-8 bytes once; the sort compares those same Buffers (UTF-8 byte order, as sortedSet's
   comparator does); and the hash is fed the frame and the members incrementally rather than one joined string. Every piece is a
   complete well-formed string (JSON output and ASCII punctuation), so the UTF-8 of the parts IS the UTF-8 of the whole. */
const OPEN = Buffer.from('["a",[', 'utf8'), COMMA = Buffer.from(',', 'utf8'), CLOSE = Buffer.from(']]', 'utf8');
function DS(list) {
  const bufs = (Array.isArray(list) ? list : []).map((x) => Buffer.from(ENC(x), 'utf8'));
  bufs.sort(Buffer.compare);
  const h = crypto.createHash('sha256').update(OPEN);
  for (let i = 0; i < bufs.length; i += 1) { if (i) h.update(COMMA); h.update(bufs[i]); }
  return h.update(CLOSE).digest('base64url');
}

/* CLS(x) — a BOUNDED header projection: x itself if it is a safe non-negative integer, else "o:<class>".
   The class here extends the closed enum with the exact-tag kinds a header field can also hold, so a
   malformed record value is RECORDED (never refused): "o:absent", "o:null", "o:string", "o:boolean", or one
   of CLASSES. Longest: "o:reference"/"o:timestamp" = 11 chars (≤ 12, plan §2 size arithmetic). */
function CLS(x) {
  try {
    if (Number.isSafeInteger(x) && x >= 0 && !Object.is(x, -0)) return x;
    if (x === undefined) return 'o:absent';
    if (x === null) return 'o:null';
    if (typeof x === 'string') return 'o:string';
    if (typeof x === 'boolean') return 'o:boolean';
    if (typeof x === 'object' && !isPlain(x)) return `o:${classOf(x)}`;
    if (typeof x === 'object') return 'o:object';
    return `o:${classOf(x)}`;
  } catch (_) {
    return 'o:other';
  }
}

/* ══ ENC2 — THE SCHEMA-SPECIFIC RECORD ENCODING (PLAN-D4c2a rev 14 §2E; §2E.8 binding) ══════════════════════════════════════
   The record digests (final / stampmap / observed / every plan sub-list / checks) encode the builder's OWN fixed-shape records
   through this, not through the generic ENC above (which stays the leaf classifier, and the encoding of `ch` and CLS).
     L(v)   leaf: a string → JSON.stringify(v) (well-formed: lone surrogates escaped; starts with `"`); anything else → ENC(v)
            (the closed classifier; starts with `[`). So the class collapse is ENC's, inherited and not re-implemented.
     A(a)   address: a NON-EMPTY string → JSON.stringify(a); anything else (non-string OR empty string — the builder's own
            normalisation to {none:true}, unchanged) → the bare literal `null`.
     R(row) registry row, presence digit: [A,0] absent | [A,1,L(f₁),…,L(fₖ)] data is a non-null object (its declared fields read
            through guarded access, exactly as rowAt projects every object incl. arrays/non-plain) | [A,2,L(data)] otherwise.
     T(r)   one record = a JSON array text of FIXED arity per type (TUPLES below); no tuple ever contains U+000A.
     DS2    H("c2a/<type>/1\n" + the tuples sorted by UTF-16 code units, joined by "\n") — domain-tagged, a multiset.
     plan   H("c2a/plan/1\n" + [L(source), L(sub-digest)…]).
   🔴 TOTAL: every property read in T/R/K — including the sentinels `absent` / `none` / `data` and list slots — goes through
   read(); a throwing getter or proxy trap collapses THAT field to ["o","other"] (an address that throws reads as none).
   🔴 ANY FUTURE CHANGE TO ANY OF THIS (a field, a tag, an order, a separator) MUST BUMP THE STORED `v` (§2E.8 (5)): the domain
   tag sits inside the hash preimage and a reader cannot recover it. */
const OTHER_LEAF = '["o","other"]';
function L(v) {
  try { return typeof v === 'string' ? JSON.stringify(v) : ENC(v); } catch (_) { return OTHER_LEAF; }
}
const A = (a) => (typeof a === 'string' && a.length > 0 ? JSON.stringify(a) : 'null');
// a record field: a slot that itself threw stays THREW for every one of its fields; a null/undefined holder has no fields (absent)
const fld = (e, k) => (e === THREW ? THREW : (e === null || e === undefined ? undefined : read(e, k)));
const ID_ROW_FIELDS = Object.freeze(['legacy_key', 'status', 'kind']);
const KEY_ROW_FIELDS = Object.freeze(['canonical_id', 'kind']);
function R(row, fields) {
  const addr = A(fld(row, 'addr'));
  if (fld(row, 'absent') === true) return `[${addr},0]`;
  const data = fld(row, 'data');
  if (data !== null && typeof data === 'object') {
    let out = `[${addr},1`;
    for (let i = 0; i < fields.length; i += 1) out += `,${L(read(data, fields[i]))}`;
    return `${out}]`;
  }
  return `[${addr},2,${L(data)}]`;
}
// a check's key row: `null` iff it is the {absent:true} marker, else the leaf
function K(kr) {
  return kr !== null && typeof kr === 'object' && read(kr, 'absent') === true ? 'null' : L(kr);
}
// a list of leaves (check claimants): the builder always hands an array; anything else is the empty list (its arr() normalisation)
function LIST(v) {
  try {
    if (!Array.isArray(v)) return '[]';
    const parts = new Array(v.length);
    for (let i = 0; i < parts.length; i += 1) parts[i] = L(read(v, i));
    return `[${parts.join(',')}]`;
  } catch (_) { return '[]'; }
}
const leafTuple = (fields) => (e) => {
  let out = '[';
  for (let i = 0; i < fields.length; i += 1) out += (i ? ',' : '') + L(fld(e, fields[i]));
  return `${out}]`;
};
/* The DIGEST-INPUT SCHEMA: exactly the fields each type's tuple reads, in tuple order (§2E.2 table). The source-shape guard asserts
   the builder's records carry exactly these keys (retire has two declared variants: derive-retire omits `why` → ["u"]). */
const TUPLE_FIELDS = Object.freeze({
  final: ['k', 'c', 'n', 'o'],
  stampmap: ['k', 'o', 'addr', 'code', 'relocated'],
  observed: ['k', 'o', 'id_row', 'key_row', 'other_kind_id_row', 'sm_id_row'],
  check: ['k', 'n', 'claimants', 'key_row_canonical_id'],
  move: ['id', 'from', 'to'],
  mint: ['id', 'name'],
  retire: ['id', 'name', 'why'],
  restore: ['id', 'name', 'was', 'resurrects'],
  deletion: ['name', 'encoded', 'id'],
  land: ['id', 'name', 'via'],
  release: ['id', 'name', 'via'],
});
const TUPLES = Object.freeze({
  final: leafTuple(TUPLE_FIELDS.final),
  stampmap: (e) => `[${L(fld(e, 'k'))},${L(fld(e, 'o'))},${A(fld(e, 'addr'))},${L(fld(e, 'code'))},${L(fld(e, 'relocated'))}]`,
  observed: (e) => `[${L(fld(e, 'k'))},${L(fld(e, 'o'))},${R(fld(e, 'id_row'), ID_ROW_FIELDS)},${R(fld(e, 'key_row'), KEY_ROW_FIELDS)},${
    R(fld(e, 'other_kind_id_row'), ID_ROW_FIELDS)},${R(fld(e, 'sm_id_row'), ID_ROW_FIELDS)}]`,
  check: (e) => `[${L(fld(e, 'k'))},${L(fld(e, 'n'))},${LIST(fld(e, 'claimants'))},${K(fld(e, 'key_row_canonical_id'))}]`,
  move: leafTuple(TUPLE_FIELDS.move),
  mint: leafTuple(TUPLE_FIELDS.mint),
  retire: leafTuple(TUPLE_FIELDS.retire),
  restore: leafTuple(TUPLE_FIELDS.restore),
  deletion: leafTuple(TUPLE_FIELDS.deletion),
  land: leafTuple(TUPLE_FIELDS.land),
  release: leafTuple(TUPLE_FIELDS.release),
});
const frameOf = (type) => `c2a/${type}/1\n`;
// the sorted tuples of a list (a non-array is the empty list; every slot read guarded)
function tuplesOf(type, list) {
  const t = TUPLES[type];
  let n = 0;
  try { n = Array.isArray(list) ? list.length : 0; } catch (_) { n = 0; }
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = t(read(list, i));
  return out.sort();   // the default order IS UTF-16 code-unit order for strings (ECMAScript SortCompare → IsLessThan)
}
function DS2(type, list) { return H(frameOf(type) + tuplesOf(type, list).join('\n')); }
function planDigest(source, subDigests) {
  return H(`c2a/plan/1\n[${[source, ...subDigests].map(L).join(',')}]`);
}
/* §2E.8 (4): the EXACT UTF-8 byte length of the `final` digest preimage, for c2b's size budget — the domain framing once, each
   tuple's bytes, and max(0, n−1) "\n" separators. c2b computes through these, never re-derives. */
const FINAL_FRAME_BYTES = Buffer.byteLength(frameOf('final'), 'utf8');
const finalTupleBytes = (entry) => Buffer.byteLength(TUPLES.final(entry), 'utf8');
function finalPayloadBytes(entries) {
  const ts = tuplesOf('final', entries);
  let n = FINAL_FRAME_BYTES + Math.max(0, ts.length - 1);
  for (const t of ts) n += Buffer.byteLength(t, 'utf8');
  return n;
}

module.exports = { ENC, H, D, DS, sortedSet, CLS, CLASSES, cmpUtf16, read, THREW,
  L, A, R, K, LIST, TUPLES, TUPLE_FIELDS, ID_ROW_FIELDS, KEY_ROW_FIELDS, tuplesOf, DS2, planDigest, frameOf,
  FINAL_FRAME_BYTES, finalTupleBytes, finalPayloadBytes };
