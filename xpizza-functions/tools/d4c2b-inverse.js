'use strict';
// D4-c2b — the test-only INVERSE of the identity integrity monitor slice in index.js (the fold pattern of tools/d4c4-inverse.js,
// tools/d4c5-inverse.js; advisor ruling N1, 2026-10-09). c2b adds EXACTLY ONE delimited block to index.js — the monitor's require
// and the scheduled export `verifyIdentityIntegrity` — between `/* d4c2b:begin */` and `/* d4c2b:end */`. Proof (i):
// unapplyD4c2b(index.js) === 37dcf43:index.js byte-for-byte. Proof (ii): the guards that pin index.js to its integration parent
// apply it FIRST on the portal fold (c2b lands on top of D4-c4), then the D4-c4 and D4-c5 inverses — reproducing the bb37684 pin.
// The block must occur EXACTLY once, with balanced delimiters, else this throws (a moved, duplicated or edited block is never tolerated).
const crypto = require('crypto');

const BEGIN = '/* d4c2b:begin */';
const END = '/* d4c2b:end */';
const BLOCK = /\/\* d4c2b:begin \*\/\n[\s\S]*?\/\* d4c2b:end \*\/\n/g;
// The block's EXACT bytes are pinned (as the D4-c4 / D4-c5 inverses pin their hunks' text): an edit INSIDE the block is detected
// too, never folded away silently. Changing the block means changing this pin, in review.
const BLOCK_SHA256 = 'e812cf78cbcb94ed5200ef1da7244e6f21ed07940ffb892c54b47a63c86e3560';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function unapplyD4c2b(src) {
  const begins = src.split(BEGIN).length - 1; const ends = src.split(END).length - 1;
  const blocks = src.match(BLOCK) || [];
  if (begins !== 1 || ends !== 1 || blocks.length !== 1) throw new Error(`d4c2b-inverse: expected exactly one d4c2b block (begin ${begins}, end ${ends}, blocks ${blocks.length})`);
  if (sha(blocks[0]) !== BLOCK_SHA256) throw new Error('d4c2b-inverse: the d4c2b block differs from its pinned bytes');
  return src.replace(BLOCK, '');
}

module.exports = { unapplyD4c2b, BEGIN, END, BLOCK_SHA256 };
