'use strict';
// H1c-server (PLAN-H1c) — the slice's index.js INVERSE: H1c adds ONE delimited block at the END of index.js,
//   "\n/* h1c:begin */ … /* h1c:end */\n"
// and nothing else. unapplyH1cIndex removes it (exactly once, both delimiters, begin before end), returning H1a's approved index.js
// byte-for-byte. It is the NEWEST layer, so every index.js-reversing guard applies it FIRST (innermost), before H1a's inverse.
const BEGIN = '/* h1c:begin */';
const END = '/* h1c:end */';

function unapplyH1cIndex(src) {
  const b = src.indexOf(BEGIN);
  const e = src.indexOf(END);
  if (b < 0 || e < 0) throw new Error(`h1c block not found exactly once (begin ${b >= 0}, end ${e >= 0})`);
  if (src.indexOf(BEGIN, b + 1) >= 0 || src.indexOf(END, e + 1) >= 0) throw new Error('h1c block not found exactly once (a second delimiter)');
  if (e < b) throw new Error('h1c block delimiters out of order');
  const start = b - 1;
  if (src[start] !== '\n') throw new Error('h1c block is not preceded by its blank-line separator');
  const stop = e + END.length;
  if (src[stop] !== '\n') throw new Error('h1c block is not followed by its trailing newline');
  return src.slice(0, start) + src.slice(stop + 1);
}

module.exports = { BEGIN, END, unapplyH1cIndex };
