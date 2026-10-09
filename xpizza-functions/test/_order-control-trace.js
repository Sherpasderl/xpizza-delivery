'use strict';
// D4-c4 (advisor ruling, DECISIONS 2026-10-08 — mirrors R3.2): the frozen-trace guards exclude EXACTLY one more call
// family — the pause switch's read, `{db: 'rtdb', op: 'once', path: 'order_control/<that request's rid>/current'}` —
// and assert it on its own: every order_control call of a request has exactly that shape, the request carries exactly
// the EXPECTED count (0 or 1, the caller states which, with the reader cache put in a known state first — never left to
// timing), and when it is 1 it sits at its §0.5 position (`anchor`: the neighbour calls). The rest is compared against
// the frozen golden as before; the goldens are untouched.
const assert = require('assert');
// lazy: a frozen-golden CAPTURE runs this suite inside a pre-c4 checkout, which has no switch (and no reader to prime)
const reader = () => { try { return require('../order-control'); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') return null; throw e; } };

const isFloorRead = (e) => e.db === 'rtdb' && e.path === 'platform_config/client_floor/orders';
const isControlPath = (e) => typeof e.path === 'string' && /^order_control(\/|$)/.test(e.path);
const isControlReadOf = (rid) => (e) => e.db === 'rtdb' && e.op === 'once' && e.path === `order_control/${rid}/current`;

// → the trace with the (exactly expected) control read removed; throws on any other order_control call, a wrong count
// or a wrong position. `anchor({ before, after })` gets the nearest non-floor calls on each side of the read.
function withoutControlRead(trace, rid, { expected, anchor, label }) {
  const ctl = trace.filter(isControlPath);
  const exact = isControlReadOf(rid);
  assert.ok(ctl.every(exact), `🔴 ${label}: the only allowlisted switch call is rtdb once order_control/${rid}/current (got ${JSON.stringify(ctl)})`);
  assert.strictEqual(ctl.length, expected, `🔴 ${label}: exactly ${expected} switch read(s) expected, got ${ctl.length}`);
  if (expected === 1) {
    const i = trace.indexOf(ctl[0]);
    const before = trace.slice(0, i).filter((e) => !isFloorRead(e)).pop();
    const after = trace.slice(i + 1).find((e) => !isFloorRead(e));
    assert.ok(anchor({ before, after }), `🔴 ${label}: the switch read is not at its §0.5 position (before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`);
  }
  return trace.filter((e) => !exact(e));
}

// SENSITIVITY: the same trace with its control read retargeted at ANOTHER restaurant's path must be refused
function assertOtherRidRefused(trace, rid, otherRid, opts) {
  const moved = trace.map((e) => (isControlReadOf(rid)(e) ? { ...e, path: `order_control/${otherRid}/current` } : e));
  assert.ok(moved.some(isControlReadOf(otherRid)), `sensitivity premise: the trace carried ${rid}'s switch read`);
  assert.throws(() => withoutControlRead(moved, rid, opts), /only allowlisted switch call/, `🔴 sensitivity: a switch read on ${otherRid}'s path must FAIL the ${rid} guard`);
}

// the reader cache put in a KNOWN state before a recorded request (call with the recorder OFF):
//   cold → the request makes its own read (if its path reads at all); warm → served from the cache, no read
const controlCold = () => { const OC = reader(); if (OC) OC._resetForTests(); };
const controlWarm = async (db, rid) => { const OC = reader(); if (OC) { OC._resetForTests(); await OC.orderControlFor(db, rid); } };

module.exports = { isFloorRead, isControlReadOf, withoutControlRead, assertOtherRidRefused, controlCold, controlWarm };
