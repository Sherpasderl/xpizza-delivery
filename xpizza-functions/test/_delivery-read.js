'use strict';
/* S3a ENVÍO — the DECLARED delivery-pricing config read in the trace / call-sequence suites (advisor ruling 2026-10-22: one
 * honest read, no cache). Every createOrder / chargeOnlineOrder / quoteOrder / quoteRedemption request now issues ONE plain
 * `get platform_config/delivery_pricing`, started in parallel with the request's first reads (index.js dpP). Like the
 * floor and extras-mode reads before it, it is set aside DECLARED, never ignored: declare() asserts it is at most one plain
 * get per request and records where it sat; without() removes exactly it, so the rest of the trace must still equal the
 * FROZEN golden byte-for-byte (the goldens are never regenerated). At exit the suite prints how many requests carried it
 * and at which positions — the hand-back's per-suite evidence that the read is the only difference.
 */
const assert = require('assert');

const isDeliveryPricingRead = (e) => !!e && e.db === 'rtdb' && e.path === 'platform_config/delivery_pricing';
const POS = [];
function declare(ops, label) {
  const m = ops.filter(isDeliveryPricingRead);
  assert.ok(m.length <= 1 && m.every((e) => e.op === 'get'), `🔴 ${label}: the envío config read is at most ONE plain get (${JSON.stringify(m)})`);
  if (m.length) POS.push(ops.findIndex(isDeliveryPricingRead));
  return m.length;
}
const without = (ops) => ops.filter((e) => !isDeliveryPricingRead(e));
process.on('exit', () => {
  const at = {}; for (const p of POS) at[p] = (at[p] || 0) + 1;
  console.log(`  · S3a envío config read: ${POS.length} recorded request(s) carried exactly one plain get; positions {index: count} ${JSON.stringify(at)}`);
});

module.exports = { isDeliveryPricingRead, declare, without };
