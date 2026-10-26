'use strict';
// MIRROR KEY ENCODING (hotfix 2026-10-26, «N.Y. Plain Slice» — catalog_mirror_write_failed). The RTDB mirror catalog_snapshot/{rid}
// stores the price tables keyed by item / extra NAME for name-keyed restaurants, and RTDB refuses a key containing . # $ / [ ] or a
// control character. At the mirror boundary ONLY: when (and only when) some key needs it, encodeMirrorTables returns EVERY menu /
// extras key through the shared reversible availKey (encodeURIComponent + %2E) plus key_encoding:'uri1'; otherwise it returns the
// tables untouched (the written mirror is today's, byte-identical — la_musa ids, ordinary names). decodeMirror (the ladder's reader
// and the identity verifier's mirrorValue) restores the names exactly as typed; an unmarked mirror reads as stored; an unknown
// marker or a key that does not round-trip THROWS mirror_key_decode_failed (the readers' callers fail closed).
const { availKey, decodeAvailKey } = require('../avail-key');

const KEY_ENCODING = 'uri1';
const RTDB_UNSAFE_KEY = /[.#$/[\]\u0000-\u001f\u007f]/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const mapKeys = (t, f) => (isObj(t) ? Object.fromEntries(Object.entries(t).map(([k, v]) => [f(k), v])) : t);

function encodeMirrorTables(menu, extras) {
  const needs = [menu, extras].some((t) => isObj(t) && Object.keys(t).some((k) => RTDB_UNSAFE_KEY.test(k)));
  return needs ? { menu: mapKeys(menu, availKey), extras: mapKeys(extras, availKey), key_encoding: KEY_ENCODING } : { menu, extras };
}
function decodeKey(k) {
  let d;
  try { d = decodeAvailKey(k); } catch (_) { throw new Error(`mirror_key_decode_failed: ${JSON.stringify(String(k).slice(0, 80))}`); }
  if (availKey(d) !== k) throw new Error(`mirror_key_decode_failed: non-canonical ${JSON.stringify(String(k).slice(0, 80))}`);
  return d;
}
function decodeMirror(value) {
  if (!isObj(value) || value.key_encoding === undefined) return value;   // today's unmarked shape: exactly as stored
  if (value.key_encoding !== KEY_ENCODING) throw new Error(`mirror_key_decode_failed: unknown key_encoding ${JSON.stringify(value.key_encoding)}`);
  const out = { ...value, menu: mapKeys(value.menu, decodeKey), extras: mapKeys(value.extras, decodeKey) };
  delete out.key_encoding;
  return out;
}

module.exports = { encodeMirrorTables, decodeMirror, KEY_ENCODING, RTDB_UNSAFE_KEY };
