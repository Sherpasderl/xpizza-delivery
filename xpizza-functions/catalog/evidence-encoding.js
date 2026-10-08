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

module.exports = { ENC, H, D, DS, sortedSet, CLS, CLASSES, cmpUtf16 };
