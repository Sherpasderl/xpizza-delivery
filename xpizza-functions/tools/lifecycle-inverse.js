'use strict';
// SECURITY BACKLOG r2 (advisor rulings 2026-11-01) — the index.js INVERSE of the account-lifecycle slice: removes EXACTLY the named
// `/* lifecycle:begin NAME */ … /* lifecycle:end NAME */` whole-line hunks (each marker exactly once, each on its OWN line). Every
// hunk is INSERTED whole lines — no base line is edited. The NEWEST layer: composed INNERMOST (inside unapplyCheckoutIndex) in every
// index.js chain.   login-uid: forms verifyOtp's lifecycle gate (SE.loginUid) right after the phone_index resolution.
const NAMES = ['login-uid'];
const HUNKS = NAMES.map((n) => ({ name: n, begin: `/* lifecycle:begin ${n} */`, end: `/* lifecycle:end ${n} */` }));
const count = (s, t) => s.split(t).length - 1;
function unapplyLifecycleIndex(src) {
  let out = src;
  for (const h of HUNKS) {
    if (count(out, h.begin) !== 1 || count(out, h.end) !== 1) throw new Error(`lifecycle-inverse: the ${h.name} hunk is missing or its marker appears more than once`);
    const a = out.lastIndexOf('\n', out.indexOf(h.begin)) + 1;
    const eAt = out.indexOf(h.end);
    if (eAt < a) throw new Error(`lifecycle-inverse: the ${h.name} hunk is malformed`);
    if (out.slice(a, out.indexOf(h.begin)).trim() !== '' || out[eAt + h.end.length] !== '\n') throw new Error(`lifecycle-inverse: the ${h.name} markers must sit on their own lines`);
    out = out.slice(0, a) + out.slice(eAt + h.end.length + 1);
  }
  if (/lifecycle:(begin|end) /.test(out)) throw new Error('lifecycle-inverse: an unknown lifecycle hunk remains');
  return out;
}
module.exports = { HUNKS, unapplyLifecycleIndex };
