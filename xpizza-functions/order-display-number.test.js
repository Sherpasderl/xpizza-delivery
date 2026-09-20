'use strict';
// Unit tests for the display_number pure core (order-display-number.js). Run: node order-display-number.test.js
// Proves the NON-SEQUENTIAL 3-digit contract: a drawn number is in-range and unique within the day, idempotent
// per order, collision-avoiding, deterministic-fallback on a dense day, fail-open on exhaustion — and, the point
// of the change, NOT an order-count ordinal. Plus the eligibility predicate.
const assert = require('assert');
const { decideDisplayNumber, displayNumberEligible, DISPLAY_LO, DISPLAY_HI } = require('./order-display-number');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// Deterministic RNG: pops from a fixed sequence (asserts we control every draw); throws if it runs dry so a test
// can never accidentally fall through to real randomness.
const seqRand = (draws) => { let i = 0; return () => { if (i >= draws.length) throw new Error('rng drained'); return draws[i++]; }; };
const ri = (fn) => (_lo, _hi) => fn();   // adapt a 0-arg draw source to the (lo,hi) signature

// ── in range + stored under by_order, on an empty node ──
{
  const d = decideDisplayNumber(null, 'A', ri(seqRand([347])));
  assert.strictEqual(d.number, 347);
  assert.ok(d.number >= DISPLAY_LO && d.number <= DISPLAY_HI, 'in 3-digit range');
  assert.deepStrictEqual(d.next.by_order, { A: 347 });
  ok('empty node → the drawn 3-digit number, stored under by_order[orderId]');
}

// ── NOT sequential: a fresh node does NOT yield 1/2/3 (the old count leak) ──
{
  const d = decideDisplayNumber({ by_order: {} }, 'A', ri(seqRand([500])));
  assert.notStrictEqual(d.number, 1);
  assert.strictEqual(d.number, 500);
  ok('non-sequential: first order of the day is NOT #1 (no volume signal)');
}

// ── idempotency: an already-reserved order returns the SAME number and writes nothing ──
{
  const node = { last: 347, by_order: { A: 347 } };
  const d = decideDisplayNumber(node, 'A', ri(seqRand([999])));   // rng would draw 999 — must NOT be used
  assert.strictEqual(d.number, 347);
  assert.strictEqual(d.next, undefined);
  ok('idempotent: reserved order → same number, ABORT (no write), rng untouched');
}

// ── collision avoidance: a draw that hits a used number is rejected; the next free draw wins ──
{
  const node = { last: 500, by_order: { A: 500, B: 731 } };
  const d = decideDisplayNumber(node, 'C', ri(seqRand([500, 731, 428])));   // 500,731 used → 428 assigned
  assert.strictEqual(d.number, 428);
  assert.ok(!(new Set(Object.values(node.by_order))).has(d.number), 'assigned number is unique within the day');
  assert.deepStrictEqual(d.next.by_order, { A: 500, B: 731, C: 428 });
  ok('collision avoidance: used draws rejected, first free draw assigned, uniqueness held');
}

// ── dense-day fallback: 40 colliding draws → deterministic lowest-unused (still not an order count) ──
{
  // used = every number 100..998 EXCEPT 999; rng keeps drawing 100 (always used) → falls back to lowest unused = 999
  const by_order = {}; for (let c = DISPLAY_LO; c < DISPLAY_HI; c++) by_order['o' + c] = c;   // 100..998 used
  const node = { by_order };
  const d = decideDisplayNumber(node, 'NEW', ri(seqRand(Array(40).fill(100))));
  assert.strictEqual(d.number, 999);   // the only free slot
  ok('dense day: colliding draws fall back to the lowest unused number');
}

// ── exhaustion: all 900 slots taken → number null, no write (trigger fails open → order_id shown) ──
{
  const by_order = {}; for (let c = DISPLAY_LO; c <= DISPLAY_HI; c++) by_order['o' + c] = c;   // 100..999 all used
  const d = decideDisplayNumber({ by_order }, 'NEW', ri(seqRand(Array(40).fill(100))));
  assert.strictEqual(d.number, null);
  assert.strictEqual(d.next, undefined);
  ok('exhaustion (>900/day): number null → fail-open, no write');
}

// ── malformed node fail-safe: absent/garbage by_order treated as empty, still yields a valid number ──
{
  assert.strictEqual(decideDisplayNumber(undefined, 'X', ri(seqRand([222]))).number, 222);
  assert.strictEqual(decideDisplayNumber({ last: 'nope' }, 'Z', ri(seqRand([333]))).number, 333);
  ok('malformed node → treated as empty, valid number drawn');
}

// ── default RNG path (no injection): still produces a valid, in-range, unique number ──
{
  const node = { by_order: { A: 500 } };
  const d = decideDisplayNumber(node, 'B');   // real Math.random default
  assert.ok(Number.isInteger(d.number) && d.number >= DISPLAY_LO && d.number <= DISPLAY_HI, 'default rng in range');
  assert.notStrictEqual(d.number, 500, 'default rng avoids the used number');
  ok('default RNG (uninjected) → valid in-range unique number');
}

// ── eligibility predicate (unchanged) ──
{
  assert.strictEqual(displayNumberEligible(null), false);
  assert.strictEqual(displayNumberEligible({ status: 'pending_payment' }), false);
  assert.strictEqual(displayNumberEligible({ status: 'new', payment_method: 'cash' }), true);
  assert.strictEqual(displayNumberEligible({ status: 'new', payment_method: 'online', payment_status: 'pending' }), false);
  assert.strictEqual(displayNumberEligible({ status: 'new', payment_method: 'online', payment_status: 'confirmed' }), true);
  ok('displayNumberEligible: only live/Sale (online requires confirmed)');
}

console.log(`\norder-display-number: ${pass} checks passed`);
