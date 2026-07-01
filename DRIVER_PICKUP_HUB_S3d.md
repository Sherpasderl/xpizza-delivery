# S3d — Universal delivery-CAS via one shared server helper (+ folded S3a/S3b fixes)

**Batch:** S3a + S3b + S3d commit together. They pair for race-safety — no writer may be
enabled without every other writer also claiming the same field.

## Decision
The delivery-task claim on `tasks/{orderId}_delivery/assigned_driver_id` becomes **universal**.
Before S3d only two of the four assignment writers claimed:

| Writer | Runtime | Pre-S3d | S3d |
|---|---|---|---|
| `autoAssignOnOrderCreate` | server | plain write both tasks | **null-claim** then finalize |
| `monitorAssignmentTimeout` (reassign) | server | plain write both tasks | **reassign-claim** (`expectCurrent=timedOut`) then finalize |
| `sweepPendingOrders` (S3a) | server | inline null-claim | **shared** null-claim (+ folded fixes) |
| `assignOrderToDriver` (S3b) | **client** (5 SDK copies) | client `runTransaction` CAS | unchanged (parallel mirror) |

So no writer can overwrite another's claim: the loser of the CAS backs off instead of double-assigning.

## The shared helper — `xpizza-functions/claim-delivery.js`
`claimDelivery(db, orderId, driverId, { expectCurrent = null }) → { claimed, current, rollback }`

- CAS: `ref.transaction(cur => cur === expectCurrent ? driverId : undefined)`.
- `rollback()` restores the field to `expectCurrent`, but only if it's still **our** claim
  (`cur === driverId ? expectCurrent : undefined`) — never clobbers a later writer. No-op if `!claimed`.
- One place = one exception-safe rollback, replacing the sweeper's inline transactions and the
  scattered per-caller try/catches.
- The **client** manual-assign (`assignOrderToDriver`) can't `require` a server module, so it stays a
  deliberate parallel implementation of the same shape with the browser modular `runTransaction` (S3b).

### CRITICAL subtlety — reassign is NOT a null-claim
`monitorAssignmentTimeout` reassigns an order whose delivery is **already on the timed-out driver**
(pickup+delivery were assigned together). Its claim must be `expectCurrent = driverId` (the timed-out
driver): commit only if the field is *still* that driver, else a concurrent writer moved it during the
60s wait and we back off. Applying the null-claim here would abort **every** reassign. Pinned by the
regression test *"reassign WITHOUT expectCurrent … always aborts a non-null field — the flagged bug."*

## Invariant #1 — live x_pizza auto-assign stays behavior-identical
The claim is a **no-op on the uncontended path**:
- A brand-new order's delivery is `null` → the null-claim commits uncontended → the finalize `update()`
  rewrites the same `assigned_driver_id` = driver. Byte-for-byte the same end state as the pre-S3d plain
  write. Grace / 2-strike / cooldown / `isStacked` / `pickEligibleDriver` are all untouched.
- The claim writes **only** the delivery field. It is invisible to `monitorAssignmentTimeout` (filters
  `_pickup`) and to `notifyDriverOnAssignment` (filters `type === 'pickup'`), so no premature timer or
  push — the push still fires only when the finalize writes the PICKUP task.
- It changes behavior **only** in the genuinely contended case (another writer already claimed) → the
  loser backs off. That is the entire point.

**Pinned by:** `claim-delivery.test.js` (uncontended-wins, contended-backs-off, reassign-replace,
reassign-null-bug, rollback restores/​no-clobber/​no-op) + the unchanged `sweep-pending.test.js` goldens.

## Folded S3a fixes (sweeper)
1. **Exception-safety** — the entire post-claim block is wrapped in try/catch; any throw rolls the claim
   back (was: only the final `update()` was guarded → a throw in the recheck reads stranded the claim).
2. **Fresh finalize revalidation** — re-read order + delivery task immediately before the write (not just
   `dispatch_parked`): a cancel, a status change, a loss of ownership, or a park landing after the claim
   now aborts. `sweepDecision` ran against the batch snapshot; this closes that window.
3. **Atomic retry_count** — bumped from the **fresh** `delNow.retry_count` read under our exclusive claim
   (no other writer can touch this delivery while we hold it), not the stale batch-snapshot value → the
   throttle can't double- or under-count.
4. **Same-hub force-accept** — the sweeper now passes `recheck.hasAcceptedSameHubOrder` to
   `buildAssignmentUpdates`, mirroring autoAssign: a same-hub stack is force-accepted (no swipe), a
   cross-hub 2nd order stays `assigned`. (Was: always `assigned`.)

## Folded S3b fixes
1. **Exception-safety** — already present in the 5 SDK copies (round-2 try/catch rollback); unchanged.
2. **Caller {ok}-handling** — the two dispatch callers (`assign-self`, `assignOrder`) now surface
   `{ok:false,reason}` as a Spanish error toast (`assignFailMsg`) instead of an unconditional "Asignado".
   The list is RTDB-subscription-driven so it already reflected reality; this removes the false cue.
   `reassignOrder` still throws on error (unchanged). The 5 SDK copies stay byte-identical (`5d788aa8`).

## Post-Codex revisions (my adversarial round → REVISE → fixed)
My Codex gate returned REVISE with 3 findings; two were actionable:

- **[High] `reassignOrder` was a FIFTH, un-CAS'd delivery writer** (the four-writer list missed it). The
  dispatch reassign picker calls `reassignOrder`, which plain-overwrote both tasks → it could clobber a
  sweeper/timeout claim mid-finalize (split assignment). **Fixed:** `reassignOrder` now CAS-claims the
  delivery field with `expectCurrent = oldDriverId` (the current holder — `null` for an unassigned order,
  so the same code path also safely handles assign-from-SIN-ASIGNAR). On a lost CAS it returns
  `{ok:false, reason:'already_assigned'}`; write-failure rolls back + returns `{ok:false,'write_failed'}`.
  The dispatch reassign caller now surfaces `{ok}` too. Applied byte-identically to all 5 SDK copies
  (`reassignOrder` body md5 `b5e1686e`; `assignOrderToDriver` still `5d788aa8`). This makes the
  mutual-exclusion truly universal across all FIVE delivery writers (3 server + 2 client).

- **[High] Strand on a double RTDB fault** — if a finalize `update()` threw AND `claim.rollback()` also
  threw, the order was left delivery-claimed + pickup-unassigned = hidden from SIN ASIGNAR with no timer.
  **Fixed:** a shared `rollbackOrAlert(db, claim, orderId, ctx)` retries the rollback once, then pushes a
  `dispatcher_alert` (type `assignment_strand`, rendered as "Pedido atascado") so a strand is never
  silent. Used by all three server writers' catch blocks.

- **[Med] Reassign-claim aborts leave the timed-out driver cooled-down, no alert, no timer** — assessed as
  defensive-only and NOT a regression: the reassign-claim aborts only when the delivery field already
  moved off the timed-out driver, i.e. another writer legitimately took the order over (its own finalize
  arms the timer). Once `reassignOrder` is CAS'd (above) and strands are alerted (above), the pathological
  input is unreachable in the fully-CAS'd world. Pre-S3d this same scenario *clobbered* the other writer;
  post-S3d it correctly backs off. Left as-is by design.

## S3e revisions (auditor's two independent gates → REVISE, 4 findings, all fixed)

1. **[High] Client exception-safety incomplete** — in `assignOrderToDriver` + `reassignOrder` the
   post-CAS pickup/old-driver `get()` and the pickup-taken rollback were OUTSIDE the try/catch (the S3b
   round-2 guard only wrapped `update()`); a throw there stranded the claim. **Fixed:** the ENTIRE
   post-CAS section is now guarded in both functions (all 5 copies). On any throw → best-effort
   `rollbackClaim()`; if the rollback itself throws, still return `{ok:false,'write_failed'}` — never a
   silent strand (the server self-heal below is the last-resort net). New body md5:
   `assignOrderToDriver 5d7a1127`, `reassignOrder 5621b783` (identical across 5).

2. **[High] Sweeper cancel-revival** — the finalize re-read order/parked/delivery but not fresh PICKUP,
   and `cancelOrder` doesn't touch `delivery/assigned_driver_id` (so our claim survives a cancel) → the
   unconditional finalize could revive both tasks to `assigned` + fire a spurious driver push for an order
   that stays cancelled. **Fixed:** the finalize revalidation now also re-reads fresh pickup and requires
   `pickupClean` (unassigned + not cancelled). This narrows the exposure to the irreducible read→update
   ms-gap, documented as an accepted residual (RTDB has no multi-path conditional write).

3. **[High] Universal-CAS missed the UNASSIGN paths** — `monitorAssignmentTimeout`'s 2-strike-takeover +
   no-eligible branches plain-nulled both tasks; a concurrent reassign A→B in the escalation's await gap
   would be clobbered by the stale null. **Fixed:** new `releaseToSinAsignar(db,orderId,driverId)` CAS-
   guards the unassign (`claimDelivery` to null with `expectCurrent=driverId` — only nulls if delivery is
   still on the timed-out driver, else aborts and leaves the concurrent winner intact). The dispatcher
   alert fires only if the release actually happened. Pinned by 3 new `claim-delivery.test.js` release
   cases. Extends the universal-CAS discipline to unassign.

4. **[Med] Strand on process-kill** — a kill between `claimDelivery` and finalize/rollback strands the
   delivery (rollbackOrAlert can't run on a kill); not re-sweepable → black hole. **Fixed:** the sweeper
   now self-heals. New pure `halfClaimState(pickup,delivery,now,{staleMs})` (TDD, 9 new cases) classifies
   `none|mark|wait|heal` via a `half_claim_since` marker: a half-claim (delivery-assigned + pickup-null +
   delivery never finalized) is marked on first sighting, and only rolled back (CAS delivery→null) once it
   has persisted past `2×SWEEP_INTERVAL` (120s). Two-pass so a LIVE in-flight claim (resolves in ms) is
   never nulled; a stranded (non-null) delivery is immovable by any other writer, so the heal CAS is
   race-safe. A kill now heals within ~1–2 sweep cycles instead of black-holing.

**Documented dev-only non-issue:** `assignTask` (test-harness-only, `xpizza-reference/test-harness.html`,
not in any prod app — same class as the dead `createOrderWithTasks`) is left un-CAS'd by design.

## S3f revisions (my Codex round on S3e → REVISE, 3 findings, all fixed)

- **[High/A] Cancel-revival: persistent state + spurious push.** The S3e fresh-pickup guard narrowed but
  didn't close the read→update gap, and the revive both flipped tasks back to `assigned` AND pushed
  (`notifyDriverOnAssignment` didn't suppress cancelled orders). **Fixed at the enforcement point:**
  `notifyDriverOnAssignment` fires on exactly the pickup null→driver transition a revive causes — it now
  detects `order.status === 'cancelled'` and UNDOES the revived assignment (both tasks → null/cancelled,
  marker cleared) and skips the push. Fully self-healing, not just documented.

- **[High/B] Self-heal marker not cleared on finalize/unassign → a stale marker could heal a FUTURE live
  claim** (double-assignment risk). **Fixed:** every finalize + unassign path now clears
  `half_claim_since` — server `buildAssignmentUpdates` (covers autoAssign/timeout/sweeper), `releaseToSin­
  Asignar`, `notifyDriverOnAssignment` undo, and the client `assignOrderToDriver` + `reassignOrder`
  finalizes. A successful claim can never leave a marker behind; an unassign→re-claim starts its two-pass
  fresh. So the heal can only ever null a genuine strand, never a live claim.

- **[Med/C] `reassignOrder` build (`serverTimestamp()`) still outside the try.** S3e only wrapped the
  old-driver read + write; the `deadline`/updates build was outside. **Fixed:** the try now wraps the
  ENTIRE post-CAS section in `reassignOrder` (all 5 copies), matching `assignOrderToDriver`. New body md5:
  `assignOrderToDriver 731be1fd`, `reassignOrder b28dac10`.

## S3g revision (my Codex round on S3f → REVISE, 1 finding, fixed)

- **[High] Stalled-client vs self-heal → double-assign.** A client that CAS-claims delivery then **stalls**
  (frozen tab / network hang) past the sweeper's 120s heal threshold could later **resume** and run its
  unconditional finalize `update()` *after* the heal rolled its claim back and the order was reassigned —
  clobbering the new driver. **Fixed (client-only, provably):** each client records `claimTime` at claim
  and, immediately before the finalize, aborts if `Date.now() - claimTime >= 90s` (< the 120s heal
  threshold, 30s margin). A frozen tab runs this check *on resume, before its write*, so it aborts +
  CAS-rolls-back instead of clobbering. The **server** finalizes need no guard: a Cloud Function dies at
  its 90–120s timeout and cannot resume-then-write, so it can never finalize after being healed.
  `reassignOrder` normally keeps the pickup on the old driver (not a half-claim → never healed); the guard
  covers only its degenerate `oldDriver=null` case. New body md5: `assignOrderToDriver ec45809b`,
  `reassignOrder cbb978b6`. Residual (documented, negligible): a single `update()` that stays *in-flight*
  >120s — beyond RTDB SDK connection timeouts — is the same ms-class TOCTOU accepted elsewhere.

## S3h revision (my Codex round on S3g → REVISE, 1 concrete finding, fixed)

- **[High] The self-heal's two writes aren't atomic → an orphaned STALE marker can heal a live re-claim.**
  The heal did `CAS assigned_driver_id → null` (index.js:3497) and *then separately* `set half_claim_since
  = null` (3499). If the function is killed between them, the delivery is left `{assigned_driver_id: null,
  half_claim_since: <already-stale>}` — a null (re-claimable) delivery carrying an already-stale marker. A
  client re-claims (`null→d2`), and the next heal pass inherits the old marker → immediately nulls the LIVE
  d2 claim → double-assign. This is exactly the invariant S3f/S3g claimed. **Fixed:** clear the marker
  **before** the CAS-null (order is load-bearing) — now `assigned_driver_id === null` *implies* the marker
  was already cleared; a mid-heal death instead leaves the delivery still claimed (non-null → not
  re-claimable) and marker-less, simply re-marked/re-healed next cycle.
- **Same class, client side:** `assignOrderToDriver`'s `rollbackClaim` also nulled the claim without
  clearing the marker. **Fixed the same way** (clear-marker-first) across all 5 copies (`assignOrderToDriver`
  md5 `250aba74`). Weaker than the heal case (it orphans a *fresh* <90s marker, and the sweeper's `none`
  pass clears it while null), but closed for completeness.
- **Documented residual (not coded):** `reassignOrder`'s rollback restores the *old* driver — non-null in
  every real reassign, so no null+marker state arises; only its degenerate `oldDriver=null` path (reassign
  of an already-unassigned order, which the reassign picker never triggers) could orphan a *fresh* marker,
  `none`-cleared within one sweep. Left as-is to keep the un-split rollback the priority there.

## S3i revision (auditor's Path-A ruling: REVISE, 3 fixes + 2 rulings)

Rulings: (1) `reassignOrder` 5th-writer scope — **APPROVED**. (2) `reassignOrder oldDriver=null` marker
residual — **CODE IT** (confirmed a real double-assign vector).

- **[High/H1] Ungate the heal.** S3d put claim→finalize on the LIVE autoAssign/timeout paths, but the
  self-heal lived behind the `sweep_pending_enabled`-OFF gate → a mid-claim process death on live x_pizza
  would strand with no heal. **Fixed:** the sweeper now runs the **heal pass every scheduled tick
  regardless of the flags**; only the pending-re-offer (OFFER pass) stays gated. **Also generalized the
  heal** beyond the literal ask: the half-claim predicate only caught the autoAssign strand
  (delivery-claimed + pickup-null); the **timeout-reassign strand is a *split*** (delivery→new, pickup
  still old — both non-null), which it missed. New `assignmentStrandState` detects any pickup≠delivery
  driver **mismatch** (covers half-claim AND split) — provably sound because every live claim→finalize
  window is ≤90s < the 120s two-pass threshold, so only a real strand persists. Heal action: unassign
  BOTH tasks → SIN ASIGNAR. Pinned: `sweep-pending.test.js` 28 cases incl. the split shape.
  **(Superseded by S3k — see below: the atomic-`update()` heal was reverted to a CAS-guarded, non-atomic
  marker→delivery-CAS→pickup-CAS. It is NOT atomic; a death mid-heal is simply recovered by the next sweep
  pass and is benign — the marker-first ordering means no orphaned stale marker can result.)**
- **[High/M3+H] Clear-marker-first on the two remaining null-transitions.** (a) `releaseToSinAsignar`'s
  ownership CAS (`claimDelivery`→null) nulled `assigned_driver_id` without clearing the marker → clear-first
  added. (b) `reassignOrder`'s rollback restored the old driver without clearing → clear-first `rollbackClaim`
  helper (ruling 2). Swept all null-transitions: every one now clears the marker (atomic or clear-first);
  `cancelOrder` leaves both tasks on the same driver (consistent); task-creation literals start null (no marker).
- **[Med] `assignTask` dev-only.** Explicit ⚠️ header on all 5 copies: test-harness-only, bypasses the CAS
  discipline, do not wire into any live app without the guard (same disposition as `createOrderWithTasks`).

Final body md5s (each single hash across 5): `assignOrderToDriver 250aba74`, `reassignOrder a9553cab`,
`assignTask f06a2c7d`.

### Path A residual (accepted, self-healing)
The live autoAssign/timeout paths now carry a rare, bounded strand window: a process death in the
sub-second gap between the delivery CAS and the finalize `update()` leaves a mismatch that the ungated heal
recovers within ~1–2 sweep cycles (≤~3 min). This is the deliberate Path-A trade — full mutual-exclusion on
every writer, backed by a tested self-healing net — chosen over Path B (leave autoAssign/timeout un-CAS'd)
because the directive is "build it correctly, touch x_pizza if needed," not "preserve bytes."

## S3j revision (both gates converged on ONE finding — the shared rollback)

- **[High] `claimDelivery.rollback()` didn't clear the marker.** The S3i clear-firsts were applied at the
  leaf sites (`releaseToSinAsignar`, `reassignOrder`, client rollback) but missed the ONE shared spot: the
  server helper's own `rollback()`. Every server writer's failure path funnels through it (autoAssign,
  timeout-reassign, sweeper — directly or via `rollbackOrAlert`), so a claim a sweep MARKED and then rolled
  back to null left `{delivery null + stale marker}` → a later legit claim inherits it → the ungated heal
  false-positive-yanks the fresh live claim. **Fixed at the root:** `rollback()` now clears
  `half_claim_since` FIRST, then CAS-restores `assigned_driver_id` — covering all server rollback paths by
  construction (harmless on a non-null reassign restore; load-bearing on null restores). Pinned:
  `claim-delivery.test.js` +2 (mark→rollback→assert marker cleared, null- and non-null-restore). 14 total.

## S3k revision (server gate: REVISE — ONE fix, guard the heal)

The S3i change to an unconditional atomic `update()` (chosen to clear the marker atomically) **dropped the
CAS-guard**, reopening two holes on the now-always-on heal:
- **#1 overlapping healers** — the sweeper fn timeout (120s) > the 60s interval, so two invocations overlap;
  healer A heals an order → it's legitimately re-claimed → healer B, on its stale snapshot, nulls both →
  yanks the live assignment.
- **#2 cancel-revert** — a cancel-while-mismatched had the heal write `status: 'pending'`, reverting a
  cancelled order's tasks (order stays cancelled).

**Fix (root, CAS like every other writer):** extracted `healStrandedOrder(db, orderId, strandedDel,
strandedPick)` (claim-delivery.js) — clears the marker FIRST, then **CAS-nulls delivery then pickup, each
guarded on the STRANDED snapshot value**. Every claim goes through the delivery CAS, so a re-claim since the
snapshot has a changed `assigned_driver_id` → the txn aborts → the fresh live assignment is never clobbered
(#1). The heal now touches **only** `assigned_driver_id` + the marker — **never `status`/`deadline`** — so it
can't revert a cancelled order; the sweeper also re-reads `orders/{id}/status` fresh and **skips cancelled**
orders (#2). Pinned: `claim-delivery.test.js` +4 (half-claim heal, split heal, **overlapping-healer aborts
on a re-claim without clobbering E**, marker-cleared-first); the fake db throws on any non-`assigned_driver_id`
/marker path, so the tests also prove the heal never writes status. **18 total.**

**Pre-deploy note (integration, not a code change):** the heal + `claimDelivery` reassign use the leaf-CAS
idiom `transaction(cur => cur === expected ? x : undefined)`; verify the Admin-SDK initial-`null` behavior in
the emulator before flipping the sweeper on (same idiom throughout, so one emulator pass covers all).

## S3l revision (server gate elevated to blocker: the null-first transaction gotcha)

- **[🔴 High] The non-null-expected CAS idiom aborts on the RTDB Admin-SDK speculative null-first call.**
  RTDB calls the transaction fn with a speculative `null` first when the leaf isn't locally cached;
  returning `undefined` there aborts the whole transaction before the server round-trip. `cur === nonNull ?
  x : undefined` therefore silently no-ops whenever `expectCurrent` is non-null — hitting **reassign**
  (`claim-delivery.js:55`), **rollback** (`:71`), and **heal** (`:96`, `:99`). Confirmed real by this repo's
  own fix `a679797` and the `index.js:1510` comment *"cur||preAttempt to avoid the Admin-SDK first-call-null
  abort."* Live x_pizza timeout-reassign + rollback are exposed (not flag-gated); the heal net would be dead.
  **Fixed** with a shared null-first-safe `casAssign(expected, target)`: never abort on a `null` cur —
  return `null` (a no-op that RTDB rejects + retries with the real value if the field actually holds data),
  abort ONLY on a real non-null mismatch. `target` is written only when cur genuinely === expected on the
  retried real-value call, so it never wrong-commits on a speculative null. Applied to all three: claim
  forward, rollback, heal (both txns).
- **Unit tests now MODEL null-first** — the fake ref issues the speculative `null` call and aborts on
  `undefined`, so the tests reproduce the gotcha (demonstrated: the old idiom aborts, `casAssign` commits).
  +3 regression tests (reassign/rollback/heal each commit on a non-null field despite null-first). **21 total.**
- **⚠️ Emulator authority pass still OWED — could not run here (no Java Runtime in this environment).** The
  fix follows the repo's own established remedy and is proven against a faithful null-first model, but the
  auditor's requested emulator run (real Admin-SDK semantics) should still happen before commit:
  `firebase emulators:exec --only database` with a reassign/rollback/heal transaction against a non-null,
  uncached leaf.
- **Client parallel (flagged, currently SAFE):** the same idiom exists in the client `reassignOrder` claim
  (`xpizza-delivery.js:720`) + rollbacks (`:652`, `:730`). It is **safe in practice** because the dispatch
  UI holds a persistent `subscribeToTasks` (`onValue('/tasks')`) subscription → the browser caches every
  task leaf → `runTransaction` gets the real value first (no null-first). It's a latent coupling (a change
  to that subscription could silently break reassign). Offered to apply the same `casAssign`-style fix
  client-side for robustness (re-hashes the 2 client fns → client re-gate) — auditor's call.

## S3l-rev (server re-gate: ONE regression casAssign introduced + a comment fix)

- **[🔴 BLOCKER, #1] casAssign regressed the null-TARGET release path.** `releaseToSinAsignar` used
  `claimDelivery(target=null, expectCurrent=driverId)`. With `casAssign`, an ALREADY-null delivery hit
  `cur===null → return null` (no-op) → `claimed = (snapshot null === target null)` = **false-positive true**;
  then on an `update()` failure the shared rollback wrote the driver back → **resurrected the timed-out
  driver onto an already-released order**. (The old idiom aborted here → `claimed=false`, so this is new.)
  **Fixed:** release no longer reuses claimDelivery. New dedicated `releaseDeliveryFromDriver(db, orderId,
  expectDriver)` succeeds ONLY if the committing transaction call actually saw `expectDriver` (a real
  transition, tracked via a closure flag — the null-target `snapshot===target` test can't), is null-first-
  safe, and has **no driver-restoring rollback**. `releaseToSinAsignar`'s `update()`-failure path now leaves
  the delivery released (no resurrect) — the pickup is a reverse-mismatch the heal reconciles — and reports
  not-fully-released so the caller skips a premature alert. Regression pinned: *"delivery ALREADY null →
  NOT released, stays null (no resurrect)"* + not-clobber + null-first cases. `claim-delivery` **22**.
- **[#2, comment] Heal is intentionally non-atomic.** Corrected the stale "same atomic `update()`" claim
  (S3i) — S3k reverted to the CAS-guarded marker→delivery-CAS→pickup-CAS; a mid-heal death is recovered by
  the next sweep pass and is benign. Updated the design doc (S3i note) and the `healStrandedOrder` doc
  comment to spell out each mid-heal-death recovery.
- **[#3] accept-steal window** — Codex agrees pre-existing (not S3d's), out of scope. No action.

## S3m — client hardening (after SERVER GATE APPROVED)

The client had the same null-first exposure as the server, currently masked only by the dispatch's
persistent `onValue('/tasks')` cache (a latent coupling). Made the client's non-null-expected CAS idioms
null-first-safe with a module-level `casAssign` mirroring the server helper (identical across all 5 copies):
- `reassignOrder` **claim** (`cur === oldDriverId ? newDriverId : undefined`) → `casAssign(oldDriverId,
  newDriverId)` (the `oldDriver=null` picker case was already a safe null-claim).
- `assignOrderToDriver` **rollback** → `casAssign(driverId, null)`; `reassignOrder` **rollback** →
  `casAssign(newDriverId, oldDriverId)`.
- The `assignOrderToDriver` **claim** (`cur == null ? driverId`) is a safe null-claim — left untouched.

**The #1 release primitive does NOT apply client-side** (confirmed with the auditor): reassign targets
`newDriverId` (always non-null) → `snapshot === newDriverId` is unambiguous (no false-positive); the reassign
rollback restoring `oldDriverId` (may be null) is a legitimate UNDO, not a release — `casAssign` restores
only if still-ours (no resurrect), and restoring-to-null is correct. The rollbacks are fire-and-forget
best-effort (no `claimed`-flag consumer). So `casAssign` is the right tool; no client release primitive.

New body md5s (single hash across 5): `assignOrderToDriver e2117aca`, `reassignOrder a176fc11`, `casAssign
5fdcfb23`. Client logic is byte-identical to the server `casAssign` that passed the emulator 6/6; auditor to
run a browser-SDK null-first emulator pass + client Codex gate.

## S3n — stale-picker-view clobber (client gate: pre-existing, fixed properly)

The client gate found a **pre-existing** clobber (worse pre-S3, which had no CAS at all): the reassign CAS
protects the read→transaction window but NOT the picker-open→click window. If a dispatcher opens the picker
while the order is on A, it moves to C, and they click B, `reassignOrder` read C fresh and CAS'd C→B —
effecting C→B though the dispatcher intended A→B, clobbering C. S3 also introduced a **false comment**
claiming the CAS aborts on a move "since the picker's view loaded" (untrue).

**Fixed (Xavier chose fix-properly-now):** the picker captures the delivery driver **shown at open-time**
and passes it as the expected-current, so a stale-view reassign aborts.
- `xpizza-dispatch/index.html`: `openPicker` freezes `pickerFromDriver = allTasks[{orderId}_delivery]
  .assigned_driver_id` at open; `assignOrder` passes it to `reassignOrder`; cleared on close.
- `reassignOrder(orderId, newDriverId, expectedFromDriver)` (5 copies): CASes against `expectedFromDriver`
  (fresh-read fallback if a caller omits it); the driver we CAS-confirmed we moved away from is also the
  cleanup target. Comment corrected — the contract is now TRUE. New `reassignOrder` md5 `6f8a036d`
  (identical across 5); `casAssign 5fdcfb23`, `assignOrderToDriver e2117aca` unchanged.

## Out of scope (unchanged from S3 plan)
- `dispatch_parked` rule + park toggle UI (S3c) — separate increment.
- The OFFER pass stays gated OFF (`config/sweep_pending_enabled !== true`) until the full batch is live; the
  HEAL pass runs always (it is the safety net for the live-path CAS).
