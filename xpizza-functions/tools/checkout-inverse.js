'use strict';
// PLAN-guest-checkout-server S1 — the index.js inverse for the checkout slice: removes EXACTLY the one appended
// `/* checkout:begin endpoints */ … /* checkout:end endpoints */` block (each marker exactly once), restoring the base
// index.js byte-for-byte. Composed INNERMOST (newest slice first) into the index.js fold guards.
const BEGIN = '/* checkout:begin endpoints */\n';
const END = '/* checkout:end endpoints */\n';
const HUNKS = [{ begin: BEGIN, end: END }];
function unapplyCheckoutIndex(src) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a < 0 || b < 0 || b < a) throw new Error('checkout-inverse: the checkout block is missing or malformed');
  if (src.indexOf(BEGIN, a + 1) >= 0 || src.indexOf(END, b + 1) >= 0) throw new Error('checkout-inverse: a checkout marker appears more than once');
  return src.slice(0, a) + src.slice(b + END.length);
}
module.exports = { HUNKS, unapplyCheckoutIndex };
