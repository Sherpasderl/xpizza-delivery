'use strict';
// MIRROR KEY ENCODING (hotfix 2026-10-26) — the test-only INVERSE of this fix's hunks in the modules older guards pin whole
// (catalog/context-guards: mirror-rtdb.js and snapshot-fallback.js by sha). Those guards apply unapplyMirrorKeysModule FIRST
// (newest layer); mirrorkeys-wiring.guard.test.js proves it reproduces 6fcd7ff2 for each file byte-for-byte.
// GENERATED from 6fcd7ff2 vs the candidate; each `now` occurs exactly once.
const BASE = '6fcd7ff2';
const HUNKS = Object.freeze([
 {
  "file": "catalog/mirror-rtdb.js",
  "now": "const { encodeMirrorTables } = require('./mirror-keys');   // hotfix 2026-10-26: RTDB-unsafe name keys\n",
  "was": ""
 },
 {
  "file": "catalog/mirror-rtdb.js",
  "now": "    const enc = encodeMirrorTables(payload.menu, payload.extras);   // today's tables unless a key needs encoding\n",
  "was": ""
 },
 {
  "file": "catalog/mirror-rtdb.js",
  "now": "      menu: enc.menu,\n      extras: enc.extras,\n",
  "was": "      menu: payload.menu,\n      extras: payload.extras,\n"
 },
 {
  "file": "catalog/mirror-rtdb.js",
  "now": "      ...(enc.key_encoding ? { key_encoding: enc.key_encoding } : {}),\n",
  "was": ""
 },
 {
  "file": "catalog/snapshot-fallback.js",
  "now": "const { decodeMirror } = require('./mirror-keys');   // hotfix 2026-10-26: the mirror's key encoding\n",
  "was": ""
 },
 {
  "file": "catalog/snapshot-fallback.js",
  "now": "    return decodeMirror(snap && typeof snap.val === 'function' ? snap.val() : null);   // names as typed; a bad key throws (fail closed)\n",
  "was": "    return snap && typeof snap.val === 'function' ? snap.val() : null;\n"
 }
]);
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);

function unapplyMirrorKeysModule(file, src) {
  if (!FILES.includes(file)) return src;
  let out = src;
  for (const h of HUNKS.filter((x) => x.file === file)) {
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`mirrorkeys-module-inverse: ${file}: a hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}

module.exports = { HUNKS, FILES, BASE, unapplyMirrorKeysModule };
