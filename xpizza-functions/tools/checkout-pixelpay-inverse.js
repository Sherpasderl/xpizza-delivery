'use strict';
// PLAN-guest-checkout-server S2 (Codex r1 P1-2 / r2 P1) — the test-only INVERSE of the slice's lines in pixelpay-hosted-charge.js:
// the guestForeign helper + its three checks (pre-read, inside the CAS, on the committed record). Every block is WHOLE inserted
// lines (no base line edited); each must occur EXACTLY once. The guest-checkout slice is the NEWEST layer on this file, so this
// runs FIRST (INNERMOST) wherever a guard byte-pins pixelpay-hosted-charge.js (s2tip-wiring's module pin); that base pin is the
// byte proof that nothing else moved.

const FILE = 'pixelpay-hosted-charge.js';
const BLOCKS = Object.freeze([
 "/* PLAN-guest-checkout-server S2 (Codex r1 P1-2): a capp GUEST's pending record carries `guest_verified` (forms / members never\n   do ⇒ every existing path is unchanged). An EXISTING order under the id must carry the SAME verified phone, or this call is a\n   foreign phone: it is refused at the pre-read AND inside the CAS (a no-op), so it can never install / recover / rotate another\n   guest's attempt — the caller answers guest_ticket_invalid, nothing written. */\nconst guestForeign = (order, pending) => !!(pending && pending.guest_verified)\n  && !(order && order.guest_verified && order.guest_verified.phone_hash === pending.guest_verified.phone_hash);\n",
 "      if (guestForeign(order, pendingOrderRecord)) return { outcome: 'conflict', reason: 'guest_phone' };   // S2: before ANY answer about it\n",
 "      if (guestForeign(c, pendingOrderRecord)) return c;                    // S2: a foreign guest phone never mutates the order (re-read refuses)\n",
 "    // S2 (Codex r2 P1): the guarded CAS answers a foreign phone with the record UNCHANGED — still a committed transaction — so the\n    // AUTHORITATIVE record is re-checked here, before every claim / recovery write: a foreign phone writes NO payment_attempts row\n    if (guestForeign(committed, pendingOrderRecord)) return { outcome: 'conflict', reason: 'guest_phone' };\n"
]);

function unapplyCheckoutPixelpay(src) {
  let out = src;
  for (const b of BLOCKS) {
    const i = out.indexOf(b);
    if (i < 0 || out.indexOf(b, i + 1) !== -1) throw new Error(`checkout-pixelpay-inverse: a guest-checkout block not found exactly once: ${b.slice(0, 60)}`);
    if (i > 0 && out[i - 1] !== '\n') throw new Error('checkout-pixelpay-inverse: a block does not start a line');
    out = out.slice(0, i) + out.slice(i + b.length);
  }
  return out;
}
const unapplyCheckoutPixelpayModule = (file, src) => (file === FILE ? unapplyCheckoutPixelpay(src) : src);

module.exports = { unapplyCheckoutPixelpay, unapplyCheckoutPixelpayModule, BLOCKS, FILE };
