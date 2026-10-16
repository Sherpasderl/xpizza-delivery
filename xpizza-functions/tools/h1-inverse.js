'use strict';
// H1a (PLAN-H1a r2 T8) — the slice's index.js INVERSE. H1a adds exactly ONE delimited block at the END of index.js:
//   "\n/* h1:begin */ … /* h1:end */\n"
// unapplyH1Index removes it (it must occur exactly once, both delimiters present, begin before end) and returns the index.js
// that existed before H1a, byte-for-byte. It is the NEWEST layer, so every index.js-reversing wiring guard applies it FIRST
// (innermost), before S1a's inverse. h1-wiring.guard.test.js proves the result equals the base and that the block is the ONLY
// change; a byte inside, a missing delimiter, a second block and a byte outside are each caught.
const BEGIN = '/* h1:begin */';
const END = '/* h1:end */';

function unapplyH1Index(src) {
  const b = src.indexOf(BEGIN);
  const e = src.indexOf(END);
  if (b < 0 || e < 0) throw new Error(`h1 block not found exactly once (begin ${b >= 0}, end ${e >= 0})`);
  if (src.indexOf(BEGIN, b + 1) >= 0 || src.indexOf(END, e + 1) >= 0) throw new Error('h1 block not found exactly once (a second delimiter)');
  if (e < b) throw new Error('h1 block delimiters out of order');
  const start = b - 1;                                   // the blank-line separator before the block
  if (src[start] !== '\n') throw new Error('h1 block is not preceded by its blank-line separator');
  const stop = e + END.length;
  if (src[stop] !== '\n') throw new Error('h1 block is not followed by its trailing newline');
  return src.slice(0, start) + src.slice(stop + 1);
}

module.exports = { BEGIN, END, unapplyH1Index };
