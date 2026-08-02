'use strict';
/**
 * Static placement guard for the KDS 2b intake availability gate (Slice 4). Run: `node intake-gate-placement.test.js`
 *
 * The strict guarantee is "a blocked (86'd) attempt writes NOTHING — no orders/{id}, no payment_attempts/{id},
 * no rate_limits". The live-handler zero-write behavior is proven in the OWNER-RUN emulator test
 * (test/intake-availability.emulator.test.js); THIS test locks the structural precondition in source so a
 * future edit that moves the gate AFTER a write (or wires it into a post-commitment path) fails the build:
 *
 *   createOrder:       checkItemAvailability(...)  BEFORE  checkRateLimit(...)  and BEFORE any db.ref().update(...)
 *   chargeOnlineOrder: classifyHostedAttempt(...)  BEFORE  checkRateLimit(...);  checkItemAvailability(...)
 *                      BEFORE checkRateLimit(...), BEFORE acquireHostedAttempt(...), BEFORE any payment_attempts/ write
 *   post-commitment:   the gate is NOT referenced anywhere else (materializeOnConfirm / scheduled-release
 *                      must NOT re-check — plan §4/§7). Enforced by an exact occurrence count.
 */
const fs = require('fs');
const assert = require('assert');

const SRC = fs.readFileSync(require.resolve('./index.js'), 'utf8');
const slice = (from, to) => {
  const a = SRC.indexOf(from); assert.ok(a !== -1, `marker not found: ${from}`);
  const b = SRC.indexOf(to, a + from.length); assert.ok(b !== -1, `marker not found: ${to}`);
  return SRC.slice(a, b);
};
const before = (hay, a, b, msg) => {
  const ia = hay.indexOf(a), ib = hay.indexOf(b);
  assert.ok(ia !== -1, `not found: ${a}`);
  assert.ok(ib !== -1, `not found: ${b}`);
  assert.ok(ia < ib, `${msg}: expected "${a}" BEFORE "${b}" (got ${ia} vs ${ib})`);
};

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// ── createOrder (cash) handler body ──
{
  const body = slice("createOrderApp.all('*'", 'createOrderApp.use(');
  before(body, 'checkItemAvailability(', 'checkRateLimit(', 'cash gate before rate-limit increment');
  before(body, 'checkItemAvailability(', 'db.ref().update(', 'cash gate before any multi-path write');
  // dedupe must precede the gate (idempotent retry returns before an availability eval)
  before(body, "already exists, returning idempotent", 'checkItemAvailability(', 'idempotency dedupe before the gate');
  ok('createOrder: dedupe → gate → rate-limit → write (gate before rate-limit + any write)');

  // Rewards B1 (orphaned-hold fix): placeability (scheduled-slot validate + asapWhileClosed) MUST be proven
  // BEFORE the redemption reserve, and the reserve BEFORE the order write — so no reject between reserve and
  // write can strand a hold (the write itself releases on failure). A future edit that moves the reserve
  // ahead of either placeability check fails HERE.
  before(body, 'SCHED.validateScheduledFor(', 'resolveRedemptionForOrder(', 'B1: scheduled-slot validate before the redemption reserve');
  before(body, 'SCHED.asapWhileClosed(', 'resolveRedemptionForOrder(', 'B1: asapWhileClosed before the redemption reserve');
  before(body, 'resolveRedemptionForOrder(', 'db.ref().update(', 'B1: redemption reserve before the order write');
  ok('createOrder: placeability (slot/closed) → reserve → write (no reject can orphan a redemption hold)');
}

// ── chargeOnlineOrder (online) handler body ──
{
  const body = slice("chargeOnlineApp.all('*'", 'chargeOnlineApp.use(');
  before(body, 'classifyHostedAttempt(', 'checkRateLimit(', 'online classify before rate-limit');
  before(body, 'checkItemAvailability(', 'checkRateLimit(', 'online gate before rate-limit increment');
  before(body, 'checkItemAvailability(', 'acquireHostedAttempt(', 'online gate before the CAS');
  before(body, 'checkItemAvailability(', '.ref(`payment_attempts/', 'online gate before any payment_attempts write');
  // classify precedes the availability read (terminal bypass decided first)
  before(body, 'classifyHostedAttempt(', 'checkItemAvailability(', 'read-only classify before the availability read');
  // Codex fix #2: the rate-limit loop is GATED behind cartBlocked===[] — a blocked (86'd) cart is decided by
  // acquire (item_unavailable/reuse/in_progress/terminal, none minting fresh) and must NOT burn rate-limit
  // quota. So the blocking path never reaches checkRateLimit → 0 rate_limits writes on a state-drift block.
  before(body, 'if (cartBlocked.length === 0)', 'checkRateLimit(', 'online rate-limit gated behind cartBlocked===[] (a blocked cart never reaches checkRateLimit)');
  ok('chargeOnlineOrder: classify → gate → (cartBlocked===[] ? rate-limit) → acquire/charge — blocked cart writes nothing, incl. rate_limits');

  // Rewards B1 (online): prepare BEFORE both fingerprint sites (so both carry the discounted total); reserve
  // BEFORE the CAS; attach the claimed attempt after acquire; release on EVERY abandoned outcome; PRESERVE on
  // in_progress/reuse. A regression that drops a release (orphaned hold) or moves the reserve ahead of
  // placeability / behind the fingerprints fails HERE.
  before(body, 'prepareRedemption(', 'orderFingerprint(', 'B1: redemption prepared before the (read-only) fingerprint site');
  before(body, 'prepareRedemption(', 'reserveRedemption(', 'B1: prepare (compute/price) before the reserve (debit)');
  before(body, 'reserveRedemption(', 'acquireHostedAttempt(', 'B1: reserve before the CAS acquire');
  before(body, 'acquireHostedAttempt(', 'attachAttempt(', 'B1: attach the claimed attempt AFTER the acquire');
  // every truly-abandoned branch releases the owned hold: acquire-throw, item_unavailable, already_paid,
  // conflict, closed, !claimed, hosted-create throw, hosted-create !ok, hosted-create persist-fail [C/#30] = 9 call-sites.
  const releaseCount = (body.match(/releaseHoldIfOwned\(\)/g) || []).length;
  assert.strictEqual(releaseCount, 9, `expected releaseHoldIfOwned() on all 9 abandoned branches, got ${releaseCount}`);
  // in_progress + reuse must PRESERVE the hold (no release) — they back a creating/live checkout.
  const preserveSpan = body.slice(body.indexOf("outcome === 'in_progress'"), body.indexOf("outcome !== 'claimed'"));
  assert.ok(preserveSpan.length > 0 && !/releaseHoldIfOwned/.test(preserveSpan), 'in_progress + reuse branches must PRESERVE the hold (no release)');
  ok('chargeOnlineOrder: prepare → fingerprints → placeability → reserve → acquire → (release abandoned | preserve in_progress/reuse | attach claimed)');
}

// ── post-commitment paths must NOT re-check (plan §4/§7) ──
{
  const availCount = (SRC.match(/checkItemAvailability\(/g) || []).length;    // 2 handler CALLS (require has no paren)
  const classifyCount = (SRC.match(/classifyHostedAttempt\(/g) || []).length; // 1 handler CALL (require has no paren)
  assert.strictEqual(availCount, 2, `checkItemAvailability( should be CALLED exactly 2x (cash + online), got ${availCount}`);
  assert.strictEqual(classifyCount, 1, `classifyHostedAttempt( should be CALLED exactly 1x (online), got ${classifyCount}`);
  // Prove absence inside the post-commitment handlers explicitly.
  const materialize = slice('exports.materializeOnConfirm', 'exports.');
  assert.ok(!/checkItemAvailability|classifyHostedAttempt/.test(materialize), 'materializeOnConfirm must NOT re-check availability');
  ok('materializeOnConfirm + scheduled-release do NOT re-check (exact occurrence count + body scan)');
}

console.log(`\nAll ${pass} intake-gate placement guards passed.`);
