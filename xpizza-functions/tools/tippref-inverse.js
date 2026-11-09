'use strict';
// PLAN-capp-tip-step r6 §1 (tip-pref) — the index.js INVERSE of the member last-tip hooks: removes EXACTLY the named
// `/* tippref:begin NAME */ … /* tippref:end NAME */` whole-line hunks (each marker exactly once, each on its OWN line). Every hunk is
// INSERTED whole lines — no base line is edited. The NEWEST layer: composed INNERMOST (inside unapplySbIndex) in every chain.
//   require: the tip-pref module; cash-held: after the held (scheduled) commit; cash-live: after the immediate commit;
//   card-issued: after a hosted charge actually issued (flow.respond returned on every non-issuing path).
const NAMES = ['require', 'cash-held', 'cash-live', 'card-issued'];
const HUNKS = NAMES.map((n) => ({ name: n, begin: `/* tippref:begin ${n} */`, end: `/* tippref:end ${n} */` }));
const count = (s, t) => s.split(t).length - 1;
function unapplyTipprefIndex(src) {
  let out = src;
  for (const h of HUNKS) {
    if (count(out, h.begin) !== 1 || count(out, h.end) !== 1) throw new Error(`tippref-inverse: the ${h.name} hunk is missing or its marker appears more than once`);
    const a = out.lastIndexOf('\n', out.indexOf(h.begin)) + 1;
    const eAt = out.indexOf(h.end);
    if (eAt < a) throw new Error(`tippref-inverse: the ${h.name} hunk is malformed`);
    if (out.slice(a, out.indexOf(h.begin)).trim() !== '' || out[eAt + h.end.length] !== '\n') throw new Error(`tippref-inverse: the ${h.name} markers must sit on their own lines`);
    out = out.slice(0, a) + out.slice(eAt + h.end.length + 1);
  }
  if (/tippref:(begin|end) /.test(out)) throw new Error('tippref-inverse: an unknown tippref hunk remains');
  return out;
}
module.exports = { HUNKS, unapplyTipprefIndex };
