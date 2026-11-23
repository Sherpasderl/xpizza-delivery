// Customer app — the shared TEXT helper (16b, OWNER 11-22 «fix everywhere»: no orphaned last word in a row subtitle). ONE source for
// capp-home and capp-push (rule 4). Pure, UMD, no DOM.
//   noOrphan(html)  glues the LAST two words of an ALREADY-ESCAPED text with U+00A0 (a character, never «&nbsp;»), so the last word
//                   never wraps alone. It builds no markup and only replaces a plain space, so an escaped entity stays whole. Two words
//                   longer than GLUE_MAX together stay breakable (one unbreakable run would overflow a 320 px phone). The CSS keeps
//                   text-wrap balance + pretty on the same spans (capp.css .rowbtn .t span).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappText = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GLUE_MAX = 24;   // visible characters of the glued pair (an entity counts as one)
  const LAST_TWO = /(\S+) (\S+)$/;

  function noOrphan(html) {
    const s = String(html == null ? '' : html), m = LAST_TWO.exec(s);
    if (!m || (m[1] + ' ' + m[2]).replace(/&#?\w+;/g, 'x').length > GLUE_MAX) return s;
    return s.slice(0, m.index) + m[1] + '\u00a0' + m[2];
  }
  return { noOrphan, GLUE_MAX };
});
