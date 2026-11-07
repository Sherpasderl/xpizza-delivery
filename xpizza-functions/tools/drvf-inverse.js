'use strict';
// DRIVER F (PLAN-driver-server-F-problema r2) — the slice's index.js INVERSE: F adds ONE delimited block at the END of index.js,
//   "\n/* drvf:begin */ … /* drvf:end */\n"
// and nothing else. unapplyDrvfIndex removes it (exactly once, both delimiters, begin before end), returning e2266b24's index.js
// byte-for-byte. It is the NEWEST layer, so every index.js-reversing guard applies it FIRST (innermost), before PORTAL-UI's inverse.
const BEGIN = '/* drvf:begin */';
const END = '/* drvf:end */';

function unapplyDrvfIndex(src) {
  const b = src.indexOf(BEGIN);
  const e = src.indexOf(END);
  if (b < 0 || e < 0) throw new Error(`drvf block not found exactly once (begin ${b >= 0}, end ${e >= 0})`);
  if (src.indexOf(BEGIN, b + 1) >= 0 || src.indexOf(END, e + 1) >= 0) throw new Error('drvf block not found exactly once (a second delimiter)');
  if (e < b) throw new Error('drvf block delimiters out of order');
  const start = b - 1;
  if (src[start] !== '\n') throw new Error('drvf block is not preceded by its blank-line separator');
  const stop = e + END.length;
  if (src[stop] !== '\n') throw new Error('drvf block is not followed by its trailing newline');
  return src.slice(0, start) + src.slice(stop + 1);
}

module.exports = { BEGIN, END, unapplyDrvfIndex };
