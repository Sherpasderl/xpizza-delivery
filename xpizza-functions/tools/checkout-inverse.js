'use strict';
// PLAN-guest-checkout-server S1 + S2 — the index.js inverse for the checkout slices: removes EXACTLY the named
// `/* checkout:begin NAME */ … /* checkout:end NAME */` hunks (each marker exactly once, each on its OWN line, the whole
// lines removed), restoring the base index.js byte-for-byte. Every hunk is INSERTED whole lines — no base line is edited.
// Composed INNERMOST (newest slice first) into the index.js fold guards.
//   S1: endpoints (the appended block)
//   S2: gate-create (createOrder), gate-method (Codex r1 P2-4) / gate-charge / gate-verified / gate-bind / gate-grant / gate-grant-field (chargeOnlineOrder),
//       grant-secret / grant-secret-bind (the signup-grant secret, bound to chargeOnlineOrder only)
const NAMES = ['endpoints', 'gate-create', 'gate-method', 'gate-charge', 'gate-verified', 'gate-bind', 'gate-grant', 'gate-grant-field', 'grant-secret', 'grant-secret-bind'];
const HUNKS = NAMES.map((n) => ({ name: n, begin: `/* checkout:begin ${n} */`, end: `/* checkout:end ${n} */` }));
const count = (s, t) => s.split(t).length - 1;
function unapplyCheckoutIndex(src) {
  let out = src;
  for (const h of HUNKS) {
    if (count(out, h.begin) !== 1 || count(out, h.end) !== 1) throw new Error(`checkout-inverse: the ${h.name} hunk is missing or its marker appears more than once`);
    const a = out.lastIndexOf('\n', out.indexOf(h.begin)) + 1;   // the begin marker's line start
    const eAt = out.indexOf(h.end);
    if (eAt < a) throw new Error(`checkout-inverse: the ${h.name} hunk is malformed`);
    if (out.slice(a, out.indexOf(h.begin)).trim() !== '' || out[eAt + h.end.length] !== '\n') throw new Error(`checkout-inverse: the ${h.name} markers must sit on their own lines`);
    out = out.slice(0, a) + out.slice(eAt + h.end.length + 1);
  }
  if (/checkout:(begin|end) /.test(out)) throw new Error('checkout-inverse: an unknown checkout hunk remains');
  return out;
}
module.exports = { HUNKS, unapplyCheckoutIndex };
