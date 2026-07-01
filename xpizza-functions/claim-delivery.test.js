// Tests for claimDelivery — the shared CAS claim over
// tasks/{orderId}_delivery/assigned_driver_id used by every SERVER assignment
// writer (autoAssign, monitorAssignmentTimeout-reassign, sweepPendingOrders).
//
// The claim is tested against a faithful in-memory fake of the RTDB Admin-SDK
// transaction contract:
//   - the update fn is called with the current value;
//   - returning undefined ABORTS (committed:false, snapshot = current value);
//   - returning a value COMMITS (committed:true, snapshot = new value).
// RTDB serializes transactions per-path, which is exactly the mutual-exclusion
// guarantee the claim relies on. We drive that boundary directly so the claim's
// LOGIC (expectCurrent handling, claimed detection, rollback) is what's under test.
//
// Run: node claim-delivery.test.js

const assert = require('node:assert');
const { claimDelivery, healStrandedOrder, releaseDeliveryFromDriver } = require('./claim-delivery');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok - ${name}`); })
    .catch((e) => { console.error(`  FAIL - ${name}\n    ${e.stack || e}`); process.exitCode = 1; });
}

// Faithful fake of a single RTDB path supporting .transaction(fn).
function makeFakeRef(initial) {
  let value = initial === undefined ? null : initial;
  let txCount = 0;
  return {
    _value: () => value,
    _txCount: () => txCount,
    // Let a test simulate a concurrent external writer between claim and rollback.
    _set: (v) => { value = v; },
    async set(v) { value = v; },   // RTDB ref.set() — used by rollback's marker-clear
    async transaction(fn) {
      txCount++;
      // Model the Admin-SDK "null-first" behavior: when the leaf is non-null but not locally cached, RTDB
      // calls fn with a SPECULATIVE null FIRST. If fn returns undefined there, the transaction ABORTS before
      // the server round-trip (the a679797 / index.js:1510 gotcha). If it returns a value, the server rejects
      // the hash-mismatch and RTDB RETRIES with the real value. This makes the null-first bug reproducible in
      // unit tests: a bare `cur === nonNull ? x : undefined` aborts here; the null-first-safe casAssign does not.
      if (value !== null) {
        const speculative = fn(null);
        if (speculative === undefined) {
          return { committed: false, snapshot: { val: () => value } };   // aborted on the null-first (the bug)
        }
        // returned a value → server rejects (real value !== null) → fall through to the real-value retry
      }
      const next = fn(value);
      if (next === undefined) {
        return { committed: false, snapshot: { val: () => value } };
      }
      value = next;
      return { committed: true, snapshot: { val: () => value } };
    }
  };
}

// Fake db exposing the two paths claimDelivery touches: the assigned_driver_id (claim/rollback CAS) and
// the half_claim_since self-heal marker (cleared first by rollback).
function makeFakeDb(orderId, initial, markerInitial = null, pickupInitial = null) {
  const driverPath = `tasks/${orderId}_delivery/assigned_driver_id`;
  const markerPath = `tasks/${orderId}_delivery/half_claim_since`;
  const pickupPath = `tasks/${orderId}_pickup/assigned_driver_id`;
  const ref = makeFakeRef(initial);
  const markerRef = makeFakeRef(markerInitial);
  const pickupRef = makeFakeRef(pickupInitial);
  return {
    db: { ref: (p) => {
      if (p === driverPath) return ref;
      if (p === markerPath) return markerRef;
      if (p === pickupPath) return pickupRef;
      throw new Error(`unexpected ref path: ${p}`);   // heal must touch ONLY these paths — never status/deadline
    } },
    ref, markerRef, pickupRef
  };
}

async function main() {
  // ---- null-claim (autoAssign / sweeper): cur === null ? driver : abort ----

  await test('uncontended null-claim wins (delivery empty → claimed, value=driver)', async () => {
    const { db, ref } = makeFakeDb('o1', null);
    const claim = await claimDelivery(db, 'o1', 'driverA');
    assert.strictEqual(claim.claimed, true);
    assert.strictEqual(claim.current, 'driverA');
    assert.strictEqual(ref._value(), 'driverA');
  });

  await test('contended null-claim backs off (delivery held → not claimed, value unchanged, no clobber)', async () => {
    const { db, ref } = makeFakeDb('o2', 'otherDriver');
    const claim = await claimDelivery(db, 'o2', 'driverA');
    assert.strictEqual(claim.claimed, false);
    assert.strictEqual(claim.current, 'otherDriver');
    assert.strictEqual(ref._value(), 'otherDriver'); // loser did NOT overwrite
  });

  // ---- reassign (timeout-monitor): cur === timedOut ? next : abort ----

  await test('reassign replaces the timed-out driver (expectCurrent=timedOut → claimed, value=next)', async () => {
    const { db, ref } = makeFakeDb('o3', 'timedOut');
    const claim = await claimDelivery(db, 'o3', 'nextDriver', { expectCurrent: 'timedOut' });
    assert.strictEqual(claim.claimed, true);
    assert.strictEqual(ref._value(), 'nextDriver');
  });

  await test('reassign aborts if the field already moved off the timed-out driver (backs off)', async () => {
    const { db, ref } = makeFakeDb('o4', 'someoneElse');
    const claim = await claimDelivery(db, 'o4', 'nextDriver', { expectCurrent: 'timedOut' });
    assert.strictEqual(claim.claimed, false);
    assert.strictEqual(ref._value(), 'someoneElse'); // did NOT clobber the concurrent writer
  });

  // Regression guard for the exact bug the auditor flagged: applying the
  // null-claim pattern (default expectCurrent=null) to a reassign would abort
  // EVERY reassign, because the delivery is already non-null.
  await test('reassign WITHOUT expectCurrent (default null) always aborts a non-null field — the flagged bug', async () => {
    const { db, ref } = makeFakeDb('o5', 'timedOut');
    const claim = await claimDelivery(db, 'o5', 'nextDriver'); // BUG shape: forgot expectCurrent
    assert.strictEqual(claim.claimed, false, 'null-claim on a non-null field must not commit');
    assert.strictEqual(ref._value(), 'timedOut');
  });

  // ---- rollback ----

  await test('rollback after a null-claim restores the field to null', async () => {
    const { db, ref } = makeFakeDb('o6', null);
    const claim = await claimDelivery(db, 'o6', 'driverA');
    assert.strictEqual(ref._value(), 'driverA');
    await claim.rollback();
    assert.strictEqual(ref._value(), null);
  });

  await test('rollback after a reassign-claim restores the field to the timed-out driver', async () => {
    const { db, ref } = makeFakeDb('o7', 'timedOut');
    const claim = await claimDelivery(db, 'o7', 'nextDriver', { expectCurrent: 'timedOut' });
    assert.strictEqual(ref._value(), 'nextDriver');
    await claim.rollback();
    assert.strictEqual(ref._value(), 'timedOut');
  });

  await test('rollback does NOT clobber a later writer (field changed after our claim → abort)', async () => {
    const { db, ref } = makeFakeDb('o8', null);
    const claim = await claimDelivery(db, 'o8', 'driverA');
    ref._set('thief'); // a concurrent writer stole the field after we claimed
    await claim.rollback();
    assert.strictEqual(ref._value(), 'thief'); // rollback aborted rather than nulling someone else's claim
  });

  // ---- releaseDeliveryFromDriver (escalation-unassign) — transitions FROM the timed-out driver → null,
  // reporting whether it ACTUALLY transitioned. Must NOT reuse claimDelivery(target=null) (false-positive +
  // resurrect, the S3l/#1 regression). No driver-restoring rollback. ----

  await test('release: delivery on the timed-out driver → released, value null', async () => {
    const { db, ref } = makeFakeDb('r1', 'timedOut');
    const rel = await releaseDeliveryFromDriver(db, 'r1', 'timedOut');
    assert.strictEqual(rel.released, true);
    assert.strictEqual(ref._value(), null);
  });

  await test('release: delivery moved to another driver → NOT released, no clobber', async () => {
    const { db, ref } = makeFakeDb('r2', 'reassignedDriver');
    const rel = await releaseDeliveryFromDriver(db, 'r2', 'timedOut');
    assert.strictEqual(rel.released, false);
    assert.strictEqual(ref._value(), 'reassignedDriver'); // concurrent reassign untouched
  });

  // THE S3l/#1 regression: expected A but delivery ALREADY null → must report NOT released (no
  // false-positive) and leave it null (no resurrect). The old claimDelivery(target=null) reported claimed
  // and its rollback wrote A back.
  await test('release: delivery ALREADY null → NOT released (no false-positive), stays null (no resurrect)', async () => {
    const { db, ref } = makeFakeDb('r3', null);
    const rel = await releaseDeliveryFromDriver(db, 'r3', 'A');
    assert.strictEqual(rel.released, false, 'an already-null delivery was not ours to release');
    assert.strictEqual(ref._value(), null, 'must NOT resurrect driver A onto an already-released order');
  });

  await test('release: null-first-safe — transitions on a non-null field despite the speculative null call', async () => {
    const { db, ref } = makeFakeDb('r4', 'timedOut');   // non-null → fake issues the null-first call
    const rel = await releaseDeliveryFromDriver(db, 'r4', 'timedOut');
    assert.strictEqual(rel.released, true);
    assert.strictEqual(ref._value(), null);
  });

  // The last hole both gates converged on: the SHARED rollback must clear the self-heal marker FIRST, so a
  // claim that a sweep marked and we then roll back to null cannot leave {delivery null + stale marker} for
  // a later live claim to inherit (which the ungated heal would false-positive-yank).
  await test('rollback clears the half_claim_since marker before restoring (null-restore path)', async () => {
    const { db, ref, markerRef } = makeFakeDb('m1', null);   // delivery starts null
    const claim = await claimDelivery(db, 'm1', 'driverA');   // null-claim → driverA
    assert.strictEqual(ref._value(), 'driverA');
    markerRef._set(1712345678000);   // a sweep MARKED the half-claim while we held it
    await claim.rollback();
    assert.strictEqual(markerRef._value(), null, 'marker must be cleared by rollback');
    assert.strictEqual(ref._value(), null, 'assigned_driver_id restored to null');
  });

  await test('rollback clears the marker on a reassign (non-null) restore too — harmless but consistent', async () => {
    const { db, ref, markerRef } = makeFakeDb('m2', 'timedOut');
    const claim = await claimDelivery(db, 'm2', 'nextDriver', { expectCurrent: 'timedOut' });
    markerRef._set(1712345678000);
    await claim.rollback();
    assert.strictEqual(markerRef._value(), null, 'marker cleared');
    assert.strictEqual(ref._value(), 'timedOut', 'restored to the timed-out driver');
  });

  await test('rollback is a no-op when the claim was never acquired', async () => {
    const { db, ref } = makeFakeDb('o9', 'otherDriver');
    const claim = await claimDelivery(db, 'o9', 'driverA'); // loses
    assert.strictEqual(claim.claimed, false);
    const before = ref._txCount();
    await claim.rollback();
    assert.strictEqual(ref._txCount(), before, 'rollback must not issue a transaction when nothing was claimed');
    assert.strictEqual(ref._value(), 'otherDriver');
  });

  // ---- healStrandedOrder (the sweeper heal action, S3k) — CAS-guarded so overlapping healers on a stale
  // snapshot cannot clobber a re-claimed order. The fake db throws on any path other than the two
  // assigned_driver_ids + the marker, so these tests also PROVE the heal never writes status/deadline
  // (the S3i over-write that caused the cancel-revert #2). ----

  await test('heal unassigns a half-claim (delivery=D, pickup=null) → both null, marker cleared, healed', async () => {
    const { db, ref, pickupRef, markerRef } = makeFakeDb('h1', 'D', 111, null);
    const res = await healStrandedOrder(db, 'h1', 'D', null);
    assert.strictEqual(res.healed, true);
    assert.strictEqual(ref._value(), null);
    assert.strictEqual(pickupRef._value(), null);
    assert.strictEqual(markerRef._value(), null, 'marker cleared');
  });

  await test('heal unassigns a split (delivery=next, pickup=old) → both null, healed', async () => {
    const { db, ref, pickupRef } = makeFakeDb('h2', 'next', null, 'old');
    const res = await healStrandedOrder(db, 'h2', 'next', 'old');
    assert.strictEqual(res.healed, true);
    assert.strictEqual(ref._value(), null);
    assert.strictEqual(pickupRef._value(), null);
  });

  await test('overlapping healer: order re-claimed to E since the snapshot → heal aborts, E not clobbered', async () => {
    const { db, ref, pickupRef } = makeFakeDb('h3', 'E', null, 'E');   // E now owns BOTH tasks (re-claimed + finalized)
    const res = await healStrandedOrder(db, 'h3', 'D', 'D');            // the sweeper's STALE snapshot saw stranded 'D'
    assert.strictEqual(res.healed, false, 'must not heal a re-claimed order');
    assert.strictEqual(ref._value(), 'E', 'delivery: the fresh live claim E is NOT clobbered');
    assert.strictEqual(pickupRef._value(), 'E', 'pickup: NOT clobbered (delivery CAS aborted first, pickup never touched)');
  });

  await test('heal clears the marker BEFORE the CAS-null (clear-first ordering)', async () => {
    const { db, markerRef } = makeFakeDb('h4', 'D', 999, null);
    await healStrandedOrder(db, 'h4', 'D', null);
    assert.strictEqual(markerRef._value(), null);
  });

  // ---- null-first regression (the a679797 gotcha): with the fake modelling RTDB's speculative null-first
  // call, a NON-null-expected CAS must still commit on the real value. The old `cur === nonNull ? x : undefined`
  // idiom aborts here; casAssign survives. These pin reassign / rollback / heal against a silent no-op. ----

  await test('null-first: reassign COMMITS on a non-null field despite the speculative null-first call', async () => {
    const { db, ref } = makeFakeDb('nf1', 'timedOut');   // field is non-null → fake issues the null-first call
    const claim = await claimDelivery(db, 'nf1', 'nextDriver', { expectCurrent: 'timedOut' });
    assert.strictEqual(claim.claimed, true, 'reassign must survive the null-first (regression a679797)');
    assert.strictEqual(ref._value(), 'nextDriver');
  });

  await test('null-first: rollback RESTORES on a non-null field despite the null-first call', async () => {
    const { db, ref } = makeFakeDb('nf2', null);
    const claim = await claimDelivery(db, 'nf2', 'driverA');   // null-claim (value now 'driverA', non-null)
    assert.strictEqual(ref._value(), 'driverA');
    await claim.rollback();   // rollback CAS runs against the non-null 'driverA' → must not abort on null-first
    assert.strictEqual(ref._value(), null, 'rollback must survive the null-first');
  });

  await test('null-first: heal COMMITS on a non-null stranded delivery despite the null-first call', async () => {
    const { db, ref, pickupRef } = makeFakeDb('nf3', 'D', null, 'old');   // non-null delivery + pickup
    const res = await healStrandedOrder(db, 'nf3', 'D', 'old');
    assert.strictEqual(res.healed, true, 'heal must survive the null-first');
    assert.strictEqual(ref._value(), null);
    assert.strictEqual(pickupRef._value(), null);
  });

  console.log(`\nclaim-delivery: ${passed} passed`);
}

main();
