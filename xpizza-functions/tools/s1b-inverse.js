'use strict';
// PLAN-S1b §8 — the slice's index.js INVERSE. index.js carries 2 delimited, SHA-pinned blocks
// `/* s1b:begin <id> */ … /* s1b:end <id> */` (pure insertions): (require) the driver-admin-ops require, and
// (callables) the six admin callables + the Auth-sync sweep. unapplyS1bIndex removes them, reproducing the S1a
// index.js byte-for-byte (s1b-wiring.guard). S1b is the NEWEST index.js slice, so every index.js fold guard applies
// unapplyS1bIndex FIRST (newest-first), then unapplyS1aIndex, then H0's, etc. Pure insertions ⇒ `original` is ''.
const crypto = require('crypto');
const BASE = '31f98d09'; // the S1a index.js layer (== applyS1aIndex(c83f2f9:index.js))
const BLOCKS = [
  { id: 'require', sha: 'ce082dfa78ca3693dec4b31415fd5ea79437569a03c84348486591b423b57bdd', original: '' },
  { id: 'callables', sha: 'b7b1cec10e1c65992f5c85a5510953e5bd8472738ee0a5a4f6399807a4b7c0fc', original: '' },
];
const rxFor = (id) => new RegExp(`[ \\t]*\\/\\* s1b:begin ${id} \\*\\/\\n[\\s\\S]*?\\/\\* s1b:end ${id} \\*\\/\\n`, 'g');
function unapplyS1bIndex(src) {
  const begins = (src.match(/\/\* s1b:begin /g) || []).length;
  const ends = (src.match(/\/\* s1b:end /g) || []).length;
  if (begins !== BLOCKS.length || ends !== BLOCKS.length) throw new Error(`s1b-inverse: expected exactly ${BLOCKS.length} s1b index.js blocks (begin ${begins}, end ${ends})`);
  let out = src;
  for (const b of BLOCKS) {
    const found = out.match(rxFor(b.id)) || [];
    if (found.length !== 1) throw new Error(`s1b-inverse: expected exactly one block ${b.id}, found ${found.length}`);
    if (crypto.createHash('sha256').update(found[0]).digest('hex') !== b.sha) throw new Error(`s1b-inverse: block ${b.id} differs from its pinned bytes`);
    out = out.replace(rxFor(b.id), () => b.original);
  }
  return out;
}
module.exports = { BASE, BLOCKS, unapplyS1bIndex };
