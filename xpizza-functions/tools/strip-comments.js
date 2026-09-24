'use strict';
/* Remove JS comments before matching code with a regex.
 *
 * 🔴 WHY THIS IS SHARED. Two copies already existed — catalog/project-guard.test.js:27 and
 * catalog/publish-paths.test.js:57 — and BOTH strip only `//`, leaving a documented `/* *​/` gap. A
 * detector that reads a call inside a block comment reports code that does not run; one that misses
 * a real call reports a guard that is not there. Writing a third copy would have made three
 * definitions of "is this line code", which is how they drift apart.
 *
 * Deliberately NOT a parser. It removes line comments and block comments while respecting string
 * and template literals, which is what a regex-based code check needs and no more. The two existing
 * copies are unchanged here: adopting this changes what those guards SEE, so that belongs in its own
 * increment rather than riding along inside an unrelated one.
 */
function stripComments(src) {
  const s = String(src == null ? '' : src);
  let out = '';
  let i = 0;
  let mode = 'code';          // code | line | block | sq | dq | tpl
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
      if (c === "'") mode = 'sq';
      else if (c === '"') mode = 'dq';
      else if (c === '`') mode = 'tpl';
      out += c; i += 1; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; }   // keep the newline: line numbers and ^ anchors survive
      i += 1; continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; i += 2; continue; }
      if (c === '\n') out += c;                       // ditto
      i += 1; continue;
    }
    // inside a string or template: copy through, honouring escapes
    if (c === '\\') { out += c + (d === undefined ? '' : d); i += 2; continue; }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) mode = 'code';
    out += c; i += 1;
  }
  return out;
};

/* 🔴 A STRING CONTAINING CODE IS DATA, NOT CODE. Stripping comments is not enough: this file's own
   test fixtures hold the TEXT of an arming call inside string literals, and a detector that reads
   them matches its own test data. That is not hypothetical — the sweep refused tools/
   sweep-preflight.test.js as an armed emulator suite the first time the detector was comment-aware
   but not literal-aware. (It refused rather than mis-scoring, which is the pre-flight working, but a
   guard that fails honest runs is the worse of the two directions.)

   So literals are MASKED, not removed: each is replaced by a sentinel and kept, because a genuine
   `require('…')` has its module path in a literal too — blanket removal would delete the very thing
   being matched. A matcher then works on structure, resolving a sentinel back only where it needs
   the text. A fixture holding a whole call collapses to ONE sentinel and cannot match. */
function maskLiterals(src) {
  const s = String(src == null ? '' : src);
  const literals = [];
  let out = '', i = 0, mode = 'code', buf = '', quote = '';
  while (i < s.length) {
    const c = s[i];
    if (mode === 'code') {
      if (c === "'" || c === '"' || c === '`') { mode = 'str'; quote = c; buf = ''; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (c === '\\') { buf += c + (s[i + 1] === undefined ? '' : s[i + 1]); i += 2; continue; }
    if (c === quote) { out += `\u0000${literals.push(buf) - 1}\u0000`; mode = 'code'; i += 1; continue; }
    buf += c; i += 1;
  }
  if (mode === 'str') out += `\u0000${literals.push(buf) - 1}\u0000`;   // unterminated: still data
  return { code: out, literals };
}

module.exports = stripComments;
module.exports.stripComments = stripComments;
module.exports.maskLiterals = maskLiterals;
