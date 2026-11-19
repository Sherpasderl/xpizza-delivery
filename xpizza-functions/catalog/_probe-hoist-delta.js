'use strict';
// PLAN-3a-order-owner r1 (Codex #172 P1-a, ecff209bb) — the ONE declared I/O delta of the order-owner probe hoist against older
// baselines: chargeOnlineOrder's read-only order probe (the SAME single `once orders/<oid>`, no read added, no write moved) now
// runs at the first point the verified uid is known — right after the uid check (`get deleted_uids/<uid>`) — instead of after
// the bookkeeping. Golden tests whose baseline predates the hoist (the frozen 717f97e d4b trace) move exactly that one read back
// before comparing, and count every mapping so the delta is PINNED (a test asserts it occurred), never hidden.
// The 717f97e slot, read off the frozen golden itself (all six cases): directly after the request's FIRST
// `once restaurants/<rid>/identity`. Anything else — no hoisted probe, or no such anchor — is returned UNCHANGED, so the
// comparison stays red.
const isProbe = (o) => !!o && o.db === 'rtdb' && o.op === 'once' && o.path === 'orders/<oid>';
const isUidCheck = (o) => !!o && o.db === 'rtdb' && o.op === 'get' && o.path === 'deleted_uids/<uid>';
const isIdentity = (o) => !!o && o.db === 'rtdb' && o.op === 'once' && /^restaurants\/[^/]+\/identity$/.test(String(o.path));

function preProbeHoistOps(ops, counter) {
  if (!Array.isArray(ops)) return ops;
  const i = ops.findIndex(isProbe);
  if (i < 1 || !isUidCheck(ops[i - 1])) return ops;
  const rest = ops.slice(0, i).concat(ops.slice(i + 1));
  const a = rest.findIndex(isIdentity);
  if (a < i) return ops;   // the 717f97e slot lies AFTER the hoisted one, or it is absent
  if (counter) counter.n += 1;
  return rest.slice(0, a + 1).concat([ops[i]], rest.slice(a + 1));
}

module.exports = { preProbeHoistOps };
