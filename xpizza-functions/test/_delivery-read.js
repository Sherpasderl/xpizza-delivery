'use strict';
/* S3a ENVÍO — the DECLARED delivery-pricing config read in the trace / call-sequence suites (advisor ruling 2026-10-22: one
 * honest read, no cache). Every createOrder / chargeOnlineOrder / quoteOrder / quoteRedemption request issues ONE plain
 * `get platform_config/delivery_pricing`, started in parallel with the request's first reads (index.js dpP). Like the floor
 * and extras-mode reads before it, it is set aside DECLARED — and (codex S3a r1 P2-5) VALIDATION IS INSEPARABLE FROM
 * REMOVAL: without() is the ONLY way to drop it, and it asserts, every time:
 *   · exactly ONE op on that path, and it is a plain `get` (two reads, or a write there, fail);
 *   · its position: every op BEFORE it is a read (it starts with the first reads, ahead of any write);
 *   · ZERO only for a request that wrote NOTHING (it returned before the read's line — a floor refusal, a bad body).
 * The rest of the trace must still equal the FROZEN golden byte-for-byte (the goldens are never regenerated). At exit the
 * suite prints how many requests carried it and at which positions — the per-suite evidence that it is the only difference.
 *
 * ENVÍO RESTAURANT LIMIT (PLAN-envio-restaurant-limit-r5 §2.4 / §8, the plan's ONE accepted extra customer read): chargeOnlineOrder's
 * pre-bookkeeping check reads `orders/<oid>` ONCE on the null-dq route (a request the app pricing does not classify), as the op right
 * before the bookkeeping opens (the content-stamp read, or a rate-limit op without a phone). without() sets it aside too, validating:
 *   · at most ONE such op, a plain rtdb `get` of orders/<id>, whose NEXT op opens the bookkeeping (recent_order_content/ | rate_limits/);
 *   · no bookkeeping write (recent_order_content / rate_limits / user_rewards) precedes it. Any other orders read is left in place (compared to the frozen golden like everything else).
 */
const assert = require('assert');

const isDeliveryPricingRead = (e) => !!e && e.path === 'platform_config/delivery_pricing';
const READ_OPS = new Set(['get', 'once', 'getAll', 'listCollections', 'getDocuments']);
const isWrite = (e) => !!e && !READ_OPS.has(e.op);
const POS = []; const PRE_POS = [];
const BOOKKEEPING = /^(recent_order_content|rate_limits|user_rewards)(\/|$)/;
const isPrecheck = (e, next) => !!e && e.db === 'rtdb' && e.op === 'get' && /^orders\/[^/]+$/.test(String(e.path)) && !!next && /^(recent_order_content|rate_limits)\//.test(String(next.path));
function withoutPrecheck(ops, label, ignore) {
  const at = []; ops.forEach((e, i) => { if (isPrecheck(e, ops[i + 1])) at.push(i); });
  if (!at.length) return ops;
  assert.strictEqual(at.length, 1, `🔴 ${label}: the envío limit pre-check read must occur at most ONCE (${JSON.stringify(at.map((i) => ops[i]))})`);
  assert.ok(!ops.slice(0, at[0]).some((e) => !ignore(e) && e.db === 'rtdb' && isWrite(e) && BOOKKEEPING.test(String(e.path))), `🔴 ${label}: the envío limit pre-check read must precede every bookkeeping write (stamp / rate / reward)`);   // r5 §2.4's claim; a suite's injected state drift (an attempt expired mid-request) is not the request's bookkeeping
  PRE_POS.push(at[0]);
  return ops.filter((_, i) => i !== at[0]);
}
// opts.expected: 0 for a recorded flow that is NOT an intake request (e.g. a scheduled sweep release) — it must carry NONE;
// opts.ignore: the suite's own harness ops (e.g. its rate_limits cleanup) — never counted as the request's writes.
function without(ops, label, { expected = null, ignore = () => false } = {}) {
  const at = [];
  ops.forEach((e, i) => { if (isDeliveryPricingRead(e)) at.push(i); });
  const writes = (xs) => xs.some((e) => !ignore(e) && isWrite(e));
  if (expected === 0) {
    assert.strictEqual(at.length, 0, `🔴 ${label}: this flow is not an intake request — it must carry NO envío config read (${JSON.stringify(at.map((i) => ops[i]))})`);
    return ops.slice();
  }
  if (at.length === 0) {
    assert.ok(expected !== 1 && !writes(ops), `🔴 ${label}: a request that WROTE must carry exactly one envío config read — found none`);
    return withoutPrecheck(ops.slice(), label, ignore);
  }
  assert.strictEqual(at.length, 1, `🔴 ${label}: the envío config read must occur exactly ONCE (${JSON.stringify(at.map((i) => ops[i]))})`);
  const e = ops[at[0]];
  assert.ok(e.db === 'rtdb' && e.op === 'get', `🔴 ${label}: the envío config op must be a plain rtdb get (${JSON.stringify(e)})`);
  assert.ok(!writes(ops.slice(0, at[0])), `🔴 ${label}: the envío config read must precede every write (${JSON.stringify(ops.slice(0, at[0]))})`);
  POS.push(at[0]);
  return withoutPrecheck(ops.filter((_, i) => i !== at[0]), label, ignore);
}
process.on('exit', () => {
  const by = {}; for (const p of POS) by[p] = (by[p] || 0) + 1;
  console.log(`  · S3a envío config read: ${POS.length} recorded request(s) carried exactly one plain get; positions {index: count} ${JSON.stringify(by)}`);
  const pb = {}; for (const p of PRE_POS) pb[p] = (pb[p] || 0) + 1;
  console.log(`  · envío limit pre-check read: ${PRE_POS.length} recorded request(s) carried exactly one plain get orders/<oid> opening the bookkeeping; positions ${JSON.stringify(pb)}`);
});

module.exports = { without };
