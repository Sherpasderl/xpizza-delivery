'use strict';
// S-B step 3 (ruling F1) — the index.js INVERSE of the dish_qty intake stamp: removes EXACTLY the named
// `/* sb:begin NAME */ … /* sb:end NAME */` whole-line hunks (each marker exactly once, each on its OWN line). Every hunk is INSERTED
// whole lines after all pricing — no base line is edited. The NEWEST layer: composed INNERMOST (inside unapplySdIndex) in every chain.
//   cash-dish-qty-held: the held (scheduled) cash record; cash-dish-qty: the immediate cash record; online-dish-qty: the online pending
//   record (after the S-D reorder-price-snapshot hunk).
const NAMES = ['cash-dish-qty-held', 'cash-dish-qty', 'online-dish-qty'];
const HUNKS = NAMES.map((n) => ({ name: n, begin: `/* sb:begin ${n} */`, end: `/* sb:end ${n} */` }));
const count = (s, t) => s.split(t).length - 1;
function unapplySbIndex(src) {
  let out = src;
  for (const h of HUNKS) {
    if (count(out, h.begin) !== 1 || count(out, h.end) !== 1) throw new Error(`sb-inverse: the ${h.name} hunk is missing or its marker appears more than once`);
    const a = out.lastIndexOf('\n', out.indexOf(h.begin)) + 1;
    const eAt = out.indexOf(h.end);
    if (eAt < a) throw new Error(`sb-inverse: the ${h.name} hunk is malformed`);
    if (out.slice(a, out.indexOf(h.begin)).trim() !== '' || out[eAt + h.end.length] !== '\n') throw new Error(`sb-inverse: the ${h.name} markers must sit on their own lines`);
    out = out.slice(0, a) + out.slice(eAt + h.end.length + 1);
  }
  if (/sb:(begin|end) /.test(out)) throw new Error('sb-inverse: an unknown sb hunk remains');
  return out;
}
module.exports = { HUNKS, unapplySbIndex };
