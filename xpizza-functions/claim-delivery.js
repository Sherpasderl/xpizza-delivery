// claim-delivery.js — the ONE shared CAS claim over a delivery task's
// assigned_driver_id, used by every SERVER assignment writer:
//   - autoAssignOnOrderCreate       (null-claim: brand-new order, delivery is null)
//   - monitorAssignmentTimeout      (reassign:   delivery is on the timed-out driver)
//   - sweepPendingOrders            (null-claim: stuck pending order, delivery is null)
//
// One place = one exception-safe rollback, instead of scattered inline
// transactions + hand-written try/catches at each call site.
//
// The CLIENT manual-assign path (assignOrderToDriver in xpizza-delivery.js) mirrors
// this exact shape with the browser modular SDK's runTransaction — it can't require a
// server module, so it stays a deliberate parallel implementation (S3b).
//
// -------------------------------------------------------------------------------
// expectCurrent is the crux of correctness. RTDB serializes transactions per path,
// so the claim is mutual-exclusion across all writers (server + client). But WHAT we
// expect the field to be differs by caller:
//
//   - null-claim  (autoAssign / sweeper): the delivery is UNassigned.
//         cur === null      ? driver : abort
//   - reassign    (timeout-monitor):      the delivery is ALREADY on the timed-out
//         driver — reassigning must only succeed if it's STILL that driver, else a
//         concurrent writer already moved it and we must back off.
//         cur === timedOut  ? next   : abort
//
//   Applying the null-claim to a reassign would abort EVERY reassign (the field is
//   non-null), silently breaking the 60s takeover. Hence the parameter.
//
// The claim is a NO-OP on the uncontended path: a brand-new order's delivery is null,
// so the null-claim commits uncontended and the caller's finalize update() rewrites
// the same value — byte-for-byte the same end state as today's plain write. It only
// changes behavior in the CONTENDED case: the loser aborts instead of overwriting.
// -------------------------------------------------------------------------------

// null-first-safe compare-and-set for a leaf ("write `target` only if the field currently === `expected`,
// else leave it"). RTDB Admin-SDK transactions call the update fn with a SPECULATIVE `null` first when the
// leaf isn't locally cached, and returning `undefined` on THAT call aborts the whole transaction before the
// server round-trip (this repo's own a679797 / index.js:1510 gotcha, with its "cur||preAttempt to avoid the
// Admin-SDK first-call-null abort" note). A bare `cur === nonNull ? x : undefined` therefore silently
// no-ops whenever `expected` is non-null (reassign / rollback / heal). The safe form NEVER aborts on a null
// cur: it returns `null` — a harmless no-op that RTDB REJECTS and retries with the real value if the field
// actually holds data, or commits a no-op if it's genuinely null. `target` is written ONLY when cur really
// === expected (on the retried call with the real server value), so this never wrong-commits on a
// speculative null. (For expected === null — a fresh claim — the first branch handles it directly.)
function casAssign(expected, target) {
  return (cur) => {
    if (cur === expected) return target;
    if (cur === null) return null;   // speculative-or-genuine null → no-op / retry, NOT an abort
    return undefined;                // real, non-null mismatch → abort (leave the other writer's value)
  };
}

/**
 * CAS-claim tasks/{orderId}_delivery/assigned_driver_id.
 *
 * @param {object} db            Admin-SDK Database (getDatabase()).
 * @param {string} orderId
 * @param {string} driverId      The driver we want the field to become.
 * @param {object} [opts]
 * @param {*} [opts.expectCurrent=null]  The value the field must currently hold for
 *                                       the claim to commit (null for a fresh claim,
 *                                       the timed-out driver id for a reassign).
 * @returns {Promise<{claimed:boolean, current:*, rollback:()=>Promise<void>}>}
 *   claimed  — true iff we now own the field.
 *   current  — the field's value after the attempt (ours if claimed, else the winner's).
 *   rollback — restores the field to expectCurrent, but ONLY if it's still OUR claim
 *              (never clobbers a writer who changed it after us). No-op if !claimed.
 *              Safe to call unconditionally in a catch.
 */
async function claimDelivery(db, orderId, driverId, opts = {}) {
  const expectCurrent = opts.expectCurrent === undefined ? null : opts.expectCurrent;
  const ref = db.ref(`tasks/${orderId}_delivery/assigned_driver_id`);
  const tx = await ref.transaction(casAssign(expectCurrent, driverId));
  const claimed = tx.committed && tx.snapshot.val() === driverId;
  return {
    claimed,
    current: tx.snapshot.val(),
    async rollback() {
      if (!claimed) return;
      // Clear the self-heal marker BEFORE restoring assigned_driver_id (invariant: clear the marker before
      // every null-transition of the claim). EVERY server writer's failure path funnels through this shared
      // rollback (autoAssign, timeout-reassign, sweeper, releaseToSinAsignar — directly or via
      // rollbackOrAlert). Without this, a claim that a sweep MARKED and we then roll back to null leaves
      // {delivery null + stale marker}; a later legit claim inherits the stale marker and the ungated heal
      // false-positive-yanks that fresh live claim. Harmless on a non-null restore (e.g. reassign). Order is
      // load-bearing: a death between the two writes leaves the claim still held (non-null) + marker-less →
      // simply re-marked/re-healed, never an orphaned stale marker on a null delivery.
      await db.ref(`tasks/${orderId}_delivery/half_claim_since`).set(null);
      await ref.transaction(casAssign(driverId, expectCurrent));
    }
  };
}

/**
 * CAS-guarded unassign of a STRANDED / inconsistent order back to SIN ASIGNAR (the sweeper heal action).
 *
 * The sweeper decides 'heal' from a batch snapshot, but its function runtime (120s) can exceed the 60s
 * schedule — so two heal invocations can overlap, and an order healed by A may be legitimately re-claimed
 * before B (running on its stale snapshot) acts. An UNCONDITIONAL null would then yank that fresh live
 * assignment. So we CAS each task's assigned_driver_id on the STRANDED value the snapshot observed: every
 * claim goes through the delivery CAS, so a re-claim since the snapshot has a CHANGED assigned_driver_id →
 * the transaction aborts → we do not clobber it.
 *
 * The three writes (marker-clear → delivery-CAS → pickup-CAS) are NOT atomic — deliberately. Order is
 * load-bearing and every mid-heal death is self-healing on the next pass: die after the marker-clear → the
 * claim is still held (mismatch) → re-marked/re-healed, never an orphaned stale marker on a null delivery;
 * die after the delivery-CAS but before the pickup-CAS → delivery null + pickup still on the old driver = a
 * reverse mismatch → the next heal pass reconciles it. We deliberately touch ONLY assigned_driver_id + the
 * marker — NOT status — so a heal can never revert a cancelled order's terminal tasks to a live status (the
 * caller also skips cancelled orders).
 *
 * @returns {Promise<{healed:boolean}>} healed=true iff we unassigned the delivery (pickup follows).
 */
async function healStrandedOrder(db, orderId, strandedDel, strandedPick) {
  await db.ref(`tasks/${orderId}_delivery/half_claim_since`).set(null);   // clear-first (S3h/S3j ordering)
  const delBack = await db.ref(`tasks/${orderId}_delivery/assigned_driver_id`)
    .transaction(casAssign(strandedDel, null));
  if (!delBack.committed || delBack.snapshot.val() != null) return { healed: false };  // re-claimed → leave it
  await db.ref(`tasks/${orderId}_pickup/assigned_driver_id`)
    .transaction(casAssign(strandedPick, null));
  return { healed: true };
}

/**
 * Transition tasks/{orderId}_delivery/assigned_driver_id FROM `expectDriver` → null, reporting whether we
 * ACTUALLY made that transition (the escalation-unassign / releaseToSinAsignar primitive).
 *
 * Why this is NOT claimDelivery(target=null): with a null target, claimDelivery's ownership test
 * (`snapshot === target`) can't tell "I nulled a field that held expectDriver" from "the field was ALREADY
 * null" — both leave snapshot=null → a FALSE-POSITIVE success on an already-released order. And its shared
 * rollback would then restore expectDriver → RESURRECT a timed-out driver onto an order that was already
 * released. So release gets its own primitive: it succeeds only if the committing call saw `expectDriver`
 * (a real transition), and it has NO driver-restoring rollback — a failed release must never resurrect.
 *
 * Null-first-safe: never abort on the speculative null (return null → RTDB rejects + retries with the real
 * value), abort only on a real non-null value that isn't ours.
 *
 * @returns {Promise<{released:boolean}>} released=true iff the delivery was on `expectDriver` and is now null.
 */
async function releaseDeliveryFromDriver(db, orderId, expectDriver) {
  const ref = db.ref(`tasks/${orderId}_delivery/assigned_driver_id`);
  let transitioned = false;
  const tx = await ref.transaction((cur) => {
    transitioned = (cur === expectDriver);   // reflects THIS call; the committing call's value is what counts
    if (cur === expectDriver) return null;   // the release: expectDriver → null
    if (cur === null) return null;           // already null / speculative → no-op, NOT an abort
    return undefined;                        // re-owned by another driver → abort, don't clobber
  });
  return { released: tx.committed && transitioned };
}

module.exports = { claimDelivery, healStrandedOrder, releaseDeliveryFromDriver };
