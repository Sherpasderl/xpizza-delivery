'use strict';
// FINDING-hosted-charge-recover-race (fix/hosted-recover-exclusive) — the ONE declared I/O delta against older baselines:
// the hosted attempt claim moved from `update payment_attempts/<id>` to an EXCLUSIVE `transaction payment_attempts/<id>`
// (absent → creating; the same stored data). Differential / golden tests map exactly that call back before comparing,
// for hosted scenarios only, and count every mapping so the delta is PINNED (a test asserts it occurred), never hidden.
// Stored data and results are still compared byte-for-byte.
const RE = /^transaction (payment_attempts\/[^/]+)$/;

function preExclusiveClaim(label, rec, counter) {
  if (typeof label !== 'string' || !/^hosted\./.test(label) || !rec || !Array.isArray(rec.calls)) return rec;
  return { ...rec, calls: rec.calls.map((c) => {
    const m = String(c).match(RE);
    if (!m) return c;
    if (counter) { counter.n += 1; counter.byLabel = counter.byLabel || {}; counter.byLabel[label] = (counter.byLabel[label] || 0) + 1; }
    return `update ${m[1]}`;
  }) };
}

// The same delta for recorders that log op OBJECTS (test/order-exists.emulator.test.js: { db, op, path, keys? }; an update
// carries its value's sorted keys, a transaction none). The exclusive claim writes exactly these fields (pixelpay-hosted-charge.js,
// the claim transaction's absent → creating value), so the mapped op is the base's `update` of the same fields; the stored
// data is compared separately. Only a `transaction` on a payment_attempts/<…> path is mapped, and every mapping is counted.
const CLAIM_KEYS = Object.freeze(['hosted_created_at', 'hosted_expires_at', 'hosted_order_id', 'hosted_state', 'order_id', 'poll_token', 'total_cents']);
function preExclusiveClaimOps(ops, counter) {
  if (!Array.isArray(ops)) return ops;
  return ops.map((o) => {
    if (!o || o.db !== 'rtdb' || o.op !== 'transaction' || !/^payment_attempts\/[^/]+$/.test(String(o.path))) return o;
    if (counter) counter.n += 1;
    return { db: 'rtdb', op: 'update', path: o.path, keys: [...CLAIM_KEYS] };
  });
}

module.exports = { preExclusiveClaim, preExclusiveClaimOps, CLAIM_KEYS };
