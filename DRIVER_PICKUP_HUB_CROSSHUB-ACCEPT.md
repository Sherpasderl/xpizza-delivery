# Design spec — cross-hub 2nd-order accept (incoming-order banner) — REV 4

**Status:** APPROVED in substance (design-spec gate: transaction emulator-proven 5/5, invariants confirmed).
REV 4 pins the 3 verbatim render-safety refinements (#4 drag-suppression reset+replay, #5 collapse-Set
discipline, #7 attach idempotency) → auditor read-only confirmation → **cleared to build**. The next Codex
gate is on the BUILT diff (where "verify against code" is the right frame) + the emulator harness against the
real `acceptSecondOrder` + on-device.
**Fixes:** `DRIVER_PICKUP_HUB_ONDEVICE-FINDING.md`. **Launch blocker** for `la_musa active:true`.
**Scope (revised):** CLIENT (`xpizza-driver/index.html`) **+ SDK** (`xpizza-delivery.js` ×5) — the "reuse
`acceptTask`" premise was wrong (see below), so a dedicated SDK accept path is required → **5-copy
byte-identity discipline + re-gate apply.** No server/functions change; no server contract change.

## Why REV 2 (the gate's findings, verified against code)
`acceptTask(driverId, taskId)` has side-effects that make it UNSAFE for a 2nd order:
- It writes `drivers/{driverId}/current_task_id = taskId` + `status = ASSIGNED` (xpizza-delivery.js). For a
  2nd order that would **repoint the driver's current task → `syncDriverHub` re-stamps the hub to the 2nd
  restaurant → the IN-PROGRESS order's nav/geofence breaks.** [BLOCKER 1]
- It is **read-then-write, non-atomic** (get → check → update) → an accept-vs-60s-timeout race could accept a
  pickup that `monitorAssignmentTimeout` has just reassigned to another driver. [BLOCKER 2]
- (The stacking "auto-accept" is at server *assignment* time via `buildAssignmentUpdates` `isStacked`, not
  at accept-tap; a dedicated fn touching only the one task inherently avoids it.)

## Goal (unchanged)
Make a 2nd cross-hub order (`status=assigned` / `awaiting_acceptance`, 60s deadline) acceptable from the
driver UI via a swipe, WITHOUT demoting the in-progress delivery **and without moving the driver's current
task/hub off it.** Affordance: a **collapsible incoming-order banner** above the active card.

## Design

### 1. NEW SDK fn — `acceptSecondOrder(driverId, pickupTaskId)` (xpizza-delivery.js ×5, byte-identical)
Accepts a task WITHOUT becoming the current task and WITHOUT the auto-accept/driver-status side-effects.
CAS-guarded (atomic) on **status AND ownership** via a node transaction:
```js
export async function acceptSecondOrder(driverId, pickupTaskId) {
  const tx = await runTransaction(ref(db, `tasks/${pickupTaskId}`), (t) => {
    if (t === null) return null;                        // NULL-FIRST-SAFE: RTDB calls with a speculative null when the
                                                        //   node isn't locally cached; returning null (not undefined)
                                                        //   makes the server REJECT the hash-of-null on a real node →
                                                        //   RTDB RE-RUNS with the actual value. A genuinely-absent task
                                                        //   commits a no-op delete → {ok:false} below. (Emulator 5/5.)
    if (t.status !== TASK_STATUS.ASSIGNED) return;      // cancelled / already accepted / reassigned → abort (undefined)
    if (t.assigned_driver_id !== driverId) return;      // reassigned to another driver → abort (accept-vs-timeout race)
    t.status = TASK_STATUS.ACCEPTED;
    t.accepted_at = Date.now();                         // client ts — the serverTimestamp() sentinel is NOT valid inside a
                                                        //   transaction (writes the sentinel object, not a time). accepted_at
                                                        //   is non-load-bearing → Date.now() chosen (keeps the accept atomic;
                                                        //   NOT the cuadre field, which is completed_at server-side). [item #2]
    return t;
  });
  const v = tx.snapshot.val();
  return (tx.committed && v && v.status === TASK_STATUS.ACCEPTED && v.assigned_driver_id === driverId)
    ? { ok: true } : { ok: false, reason: 'unavailable' };
}
```
- **Does NOT write `current_task_id` / driver `status`** → the in-progress order stays the current task; the
  driver's hub snapshot is untouched (fixes BLOCKER 1).
- **CAS/atomic** on `status==='assigned' && assigned_driver_id===driverId` → the accept-vs-timeout race is
  safe: if the 60s timer reassigned the pickup (owner→nextDriver, or status→pending/other), the transaction
  aborts → `{ok:false}` (emulator-proven: reassigned-to-E aborts, E not clobbered; cancelled aborts, no
  resurrect; absent → {ok:false}). (fixes BLOCKER 2).
- **Touches exactly one task node** → cannot auto-accept any other stacked order.
- Flips only the PICKUP task to `accepted` (mirrors `acceptTask`'s task-level effect; the delivery task
  follows the same path it does for a normally-accepted order). After accept, `getDriverOrders` re-phases
  the order `awaiting_acceptance`→`pickup` → it leaves the banner and becomes a correct view-only queue item.
- **null-first CORRECT BY CONSTRUCTION** via `if (t === null) return null` (item #1) — an uncached / cold /
  pre-sync task node proceeds to the server round-trip and re-runs with the real value, instead of the
  `if(!t) return` version that spuriously aborted a valid uncached task (emulator-confirmed). This does NOT
  rely on the `subscribeToTasks` cache being warm; the CAS transaction is the authority, so **no defensive
  `get()` pre-read** (it would only add a round-trip + a TOCTOU gap).
- 5-copy byte-identical (`runTransaction` already imported).

### 2. Banner (renderActiveAndQueue, index.html) — surfaces ALL pending accepts
```
const [active, ...rest] = orders;
const pendingAccept = rest.filter(o => o.phase === 'awaiting_acceptance');   // 2nd swipe-needed orders — ALL of them
const queue         = rest.filter(o => o.phase !== 'awaiting_acceptance');   // accepted stacked orders (view-only, as today)
bannerSlot.innerHTML = renderIncomingBanners(pendingAccept);   // one banner PER pending order (never drop one)
activeSlot.innerHTML = renderActiveCard(active, queue.length === 0 && pendingAccept.length === 0);
queueSlot.innerHTML  = renderQueue(queue);
attachActiveCardHandlers(active);
pendingAccept.forEach(attachIncomingBannerHandlers);
```
- **[BLOCKER 3 fix] Surface ALL pending accepts** — a banner per `awaiting_acceptance` order (common case =
  1). The soonest-deadline banner defaults **expanded**, the rest **collapsed** (one-line bars). NONE are
  filtered out → no invisible-then-timed-out lost order. (Rare: a driver getting ≥2 cross-hub orders at once.)
- Banner appears only for `awaiting_acceptance` → idle-single-order (it's `orders[0]` = active swipe card)
  and same-hub-auto-accept (status `accepted`) paths are **untouched**.

### 3. renderIncomingBanners + handlers
- Each banner: restaurant + total + "otro hub" hint; a **countdown** chip reusing `.accept-countdown[data-
  deadline]` (the tick already `querySelectorAll`s at index.html:2044 → handles multiple — gate-confirmed OK);
  a `.slide-confirm` with a per-order id `btn-accept-inc-<orderId>` (no collision with the active card's
  `btn-accept` or between banners).
- **Accept:** `attachSlideConfirm('btn-accept-inc-'+o.orderId, async () => { const r = await
  XPD.acceptSecondOrder(currentUser.uid, o.pickupTask.id); if (r.ok===false) toast('Ese pedido ya no está
  disponible'); })`. On success the order re-phases → next render it's a queue item, its banner gone.
- **Auto-dismiss:** timeout/reassign removes it from `getDriverOrders` → re-render drops its banner. No timer.

### 4. Render-safety disciplines (gate refinements #4/#5/#7 — pin exactly)

**#4 — drag-suppression with guaranteed reset + deferred-render replay** (closes the stuck-suppression freeze):
- Track the drag by the ELEMENT, not a bare global: `let slidingEl = null` (set to the `.slide-confirm` on
  drag-start). Render is suppressed only while `slidingEl` is non-null.
- `slidingEl` is RESET on **every** drag-terminating path: `pointerup`/`mouseup`, `touchend`, `touchcancel`,
  **accept-success, and accept-error** — so a dropped/interrupted gesture can never leave it stuck.
- While `slidingEl` is set, `renderActiveAndQueue` does NOT rebuild the DOM; it sets `renderPending = true`.
- On any reset path, if `renderPending` → run `renderActiveAndQueue` once (replay). So a new order, a
  cancellation, or an in-progress update that arrived during the suppressed window is reflected immediately
  on drag-end (never silently swallowed).

**#5 — collapse-Set discipline** (no leak, urgent order always visible):
- `const collapsedBanners = new Set()` keyed by orderId. **Each render:** (a) PRUNE — delete any orderId not
  in the current `pendingAccept` (no unbounded leak of stale ids); (b) FORCE the soonest-deadline pending
  order (`pendingAccept[0].orderId`) OUT of the set → it always renders **expanded** (a new/most-urgent order
  can never be stuck collapsed). The remaining pending banners honor the set (collapsible by tap).

**#7 — `attachSlideConfirm` same-node idempotency guard** (no double-bind):
- On attach, mark the element `el.dataset.slideAttached = '1'` and early-return if it's already set, so
  re-invoking attach on the same node (e.g. a partial re-attach) cannot double-bind pointer/touch listeners.
  (Full re-renders build fresh nodes, so this only guards the same-node path — belt-and-suspenders.)

**Layout:** `#incoming-banner-slot:empty { display:none }` so an empty banner slot takes no space and doesn't
break the `.solo` full-height active layout. (Confirmed: the `.solo` formula is `queue.length===0 &&
pendingAccept.length===0` — gate finding #6.)

## Invariants / don't-regress (gate targets)
1. Idle driver, single order → `orders[0]` = active swipe card, **no banner** (S1-confirmed).
2. Same-hub 2nd order → auto-accepted (`accepted`, never `awaiting_acceptance`) → view-only queue — unchanged.
3. **In-progress order's current_task_id + hub are UNCHANGED after accepting a 2nd order** (the crux — new
   fn writes neither). Active card stays fully rendered below the (collapsible) banner.
4. Accept is CAS/atomic (status + ownership); no `current_task_id`/driver-status writes; touches one task.
5. No server/contract change; SDK change is byte-identical across the 5 copies (re-hash `acceptSecondOrder`).
6. `getDriverOrders` unchanged (the split is in the UI); the tick reuse is confirmed (`querySelectorAll`).

## Testing / validation
- **On-device multi-hub smoke re-run** (`/tmp/mh-seed.js` → `/tmp/mh-seed-xpizza.js` → `/tmp/mh-cleanup.js`):
  with a held la_musa order, the cross-hub x_pizza order shows the **banner** and is **swipe-acceptable**.
  **After accepting it, VERIFY (read RTDB): `drivers/{uid}/current_task_id` is STILL the la_musa task and the
  hub snapshot is STILL la_musa** (blocker-1 regression check) — the new order is `accepted`, in the queue.
- Accept-vs-timeout: `acceptSecondOrder` returns `{ok:false}` if the pickup was reassigned; confirm no double.
- Regression on-device: idle single order still swipes on the active card; same-hub stack still auto-accepts.
- SDK unit seam (optional, if the gate wants it): `acceptSecondOrder`'s CAS predicate is testable against a
  fake-ref like `claim-delivery.test.js` (assigned+owned→accept; wrong-owner/non-assigned→abort).

## Resolved by the emulator authority (was: risks)
- **null-first — RESOLVED** by `if (t === null) return null` (emulator 5/5: uncached valid task now commits
  the accept; the old `if(!t) return` spuriously aborted it). Correct by construction; no cache reliance, no
  defensive `get()`.
- **accepted_at — DECIDED:** `Date.now()` (client, non-load-bearing; keeps the accept atomic in one txn). Not
  the cuadre field (that's `completed_at`, server-side). No post-CAS split.
- **CAS race — PROVEN:** reassigned-to-E aborts (E not clobbered); cancelled aborts (no resurrect); absent →
  `{ok:false}`.

## Risks for the re-gate to still probe (UI-side)
- Multiple-pending banner layout: first-expanded/rest-collapsed correctness; no lost order; space on a phone.
- `isSliding` re-render suppression: does deferring RTDB re-renders during a drag risk a stale accept, and
  how is a dropped re-render replayed on drag-end?
- Emulator harness `/tmp/accept-second-emu.js` is reusable to validate the REAL `acceptSecondOrder` once coded.

## Build/ship (after re-gate APPROVED)
Client + SDK (5 copies) → mirror `xpizza-driver/` → `cap copy` → **versionCode 11→12, versionName 2.2.0→2.3.0**
+ **in-app `SYSTEM_VERSION` '2.1.2'→'2.3.0'** → signed AAB → Play internal testing → Xavier re-runs the
on-device multi-hub smoke (incl. the current_task_id/hub-unchanged check) → auditor verifies → then
`sweep_pending_enabled` + `active:true`.
