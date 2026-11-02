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

module.exports = { preExclusiveClaim };
