'use strict';
/* Remove JS comments before matching code with a regex.
 *
 * 🔴 WHY THIS IS SHARED. Two copies already existed — catalog/project-guard.test.js and
 * catalog/publish-paths.test.js — and BOTH stripped only `//`, leaving a documented `/* *​/` gap. A
 * detector that reads a call inside a block comment reports code that does not run; one that misses
 * a real call reports a guard that is not there. Writing a third copy would have made three
 * definitions of "is this line code", which is how they drift apart. Both copies are gone;
 * strip-comments.test.js cell 7 asserts every caller takes this definition and carries no local one.
 *
 * Deliberately NOT a parser. It removes line comments and block comments while respecting string
 * and template literals, which is what a regex-based code check needs and no more.
 *
 * 🔴 WHAT IT DOES NOT MODEL, MEASURED RATHER THAN GUESSED (cells in strip-comments.test.js):
 *   - REGEX LITERALS are not tracked as their own mode. Escapes are consumed in code position, which
 *     is what makes the common `/https:\/\//` safe; what remains unhandled is an UNESCAPED `//`
 *     inside a character class (`/[//]/`), which opens a phantom line comment. Redundant as JS and
 *     absent from this tree — pinned by a cell so the limit is known rather than discovered.
 *   - `${...}` INSIDE A TEMPLATE is treated as string content, so a comment written inside an
 *     interpolation survives. Also pinned.
 * Both are recorded because a caller that believes this is a parser will eventually be wrong in a way
 * that makes a guard SEE LESS CODE, and a guard blind to a line reports a writer that is not there.
 */
function stripComments(src) {
  const s = String(src == null ? '' : src);
  let out = '';
  let i = 0;
  let mode = 'code';          // code | line | block | sq | dq | tpl
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (mode === 'code') {
      /* 🔴 AN ESCAPE IN CODE POSITION IS COPIED WHOLE, AND THIS IS WHAT KEEPS REGEXES INTACT.
         Without it a regex containing an escaped slash PAIR — `/https:\/\//`, the ordinary way to
         match a URL — lexed as: copy `\`, then see `/` next to the following `/` and open a LINE
         COMMENT. The rest of the line was deleted as a comment. That is a stripper EATING CODE, and
         the two guards adopting this file count writers in the source it returns: a swallowed line is
         a writer that is not there, or a second writer of the pointer doc going unseen.
         Consuming `\` plus the next character makes the escaped slash never pair with anything.
         Safe in every code position: a bare `\` outside a string/regex/comment is otherwise only a
         unicode identifier escape (`\u0041`), where copying both characters is also correct. */
      if (c === '\\') { out += c + (d === undefined ? '' : d); i += 2; continue; }
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

module.exports = stripComments;
module.exports.stripComments = stripComments;
