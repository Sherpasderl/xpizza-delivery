// Customer app — the shared TEXT helper (16b, OWNER 11-22 «fix everywhere»: no orphaned last word in a row subtitle). ONE source for
// capp-home and capp-push (rule 4). Pure, UMD, no DOM.
//   noOrphan(html)  glues the LAST two words of an ALREADY-ESCAPED text with ONE U+00A0 (a character, never «&nbsp;»; the whitespace
//                   run between them collapses to it), so the last word never wraps alone. It builds no markup and only replaces
//                   whitespace, so an escaped entity stays whole. Always glued (Codex #260): a pair wider than the whole line breaks
//                   inside the word instead (capp.css .rowbtn .t span: overflow-wrap:break-word, with text-wrap balance + pretty).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappText = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LAST_TWO = /(\S+)\s+(\S+)$/;

  function noOrphan(html) {
    const s = String(html == null ? '' : html), m = LAST_TWO.exec(s);
    return m ? s.slice(0, m.index) + m[1] + '\u00a0' + m[2] : s;
  }
  return { noOrphan };
});
