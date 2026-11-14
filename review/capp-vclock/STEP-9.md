# vclock step 9: the virtual clock is the default; the real-sleep flush is deleted; a guard forbids real sleeps (PLAN-capp-virtual-clock r0 §4, step 9)

**Scope:**
- `capp-s7a2.test.mjs`:
  - The per-cell VIRTUAL migration list is deleted. Every cell boots its shell on the virtual clock (`CLOCK_DEFAULT = !REAL_BY_DESIGN.has(t.name)`), except the REAL_BY_DESIGN paint-frame cells.
  - `flush()`'s real 30 ms sleep is deleted. A cell with no clock drains to QUIET (`createClock(T0).flush(ms)`).
  - VC-M is replaced: it now proves the default (see §1).
- `capp-guards.test.mjs`: new guard «no fixed real sleep in the customer-app suites».
  - It fails on any `new Promise(…)` settled by a real `setTimeout` in `customer-app/*.test.mjs`, unless the receiver is a virtual clock (`VC.` / `vc.` / `c.` / `POP.`).
  - Waiver (advisor): s7a1-shell's popTick, «event-based wait for jsdom's popstate, 1 s hang cap only», pinned to exactly 1 occurrence; a stale waiver also fails.
  - test-clock itself and the realFrames cell are outside the pattern by construction.
- `capp-api-sdk.test.mjs`: the SDK-fifo cell drains instead of racing a real 2 s cap (finding S9-2).

## 1. Assertion inventory
- **capp-s7a2.test.mjs:** VC-M is the only change.
  - REMOVED: «VC-M every name in the VIRTUAL migration list is a cell of this file (exactly once)».
  - ADDED: «VC-M the virtual clock is the default…», with three assertions:
    - `🔴 VC-M: a real-by-design name that is not exactly one cell`;
    - `🔴 VC-M: a real-by-design cell booted on the virtual clock`;
    - `🔴 VC-M: a cell booted a shell on the REAL clock`.
  - Every other cell is unchanged.
- **capp-api-sdk.test.mjs:** IDENTICAL, 56 tests and 218 assertions. Only the SDK-fifo cell's wait changed; its assertion is the same.
- **capp-guards.test.mjs:** one ADDED test (the guard).

## 2. Findings: what the flip exposed (all fixed in the harness; no assertion loosened; no app bug)
- **S9-1, «D-2 view»:** it passed only because of the real 120 ms sleep. The view now gets the virtual clock (`createView(…, { timers: vc })`, the same hand-off the shell gives it) and flushes `DESK_SETTLE` virtually.
- **S9-2, a real 2 s race in `capp-api-sdk.test.mjs` (Codex r3 P2-3 repro).** The guard caught it; my earlier search had missed it.
  - The cell raced the FIFO's work against a real 2 s timer, so a busy box could report a false «stuck».
  - It now drains to QUIET and reports «stuck» only if the work is still unsettled.
  - New mutant vc-22 (the queue never releases) proves it still catches a real deadlock: KILLED at `🔴 SDK-fifo: no deadlock`.
- **S9-3, «C-2 r2 the fake is contract-strict»:** it calls the rating fake directly, with no shell, so it has no virtual clock. The sweep refused the baseline (a TypeError on `VC.setTimeout`). It now runs with `delay: 0`, and the fake skips its timer when the delay is 0.

## 3. Mutant re-kill
- **New step-9 mutants, all KILLED at their named assertion (7/7):**
  - vc-12 (the default ignores REAL_BY_DESIGN) and vc-19 (bootShell defaults to real) at VC-M;
  - vc-10 and vc-11 (re-run) at their existing anchors;
  - vc-20 (flush regains its sleep) and vc-21 (a second sleep in the waived file) at `🔴 SLEEP`;
  - vc-22 (a deadlock) at `🔴 SDK-fifo`.
- **All 168 catalogue mutants whose commands run the touched files** (s7a2, capp-api-sdk, capp-guards and their neighbours): **165/166 scored KILLED, +2 documented equivalent.**
  - **1 SURVIVED: s2ck-a10. It predates step 9; see F-3.**

## 4. Stress
- **20× the FULL capp-s7a2 file:** 20/20 clean, 292/0 every run, load 3–12.
- **20× the FULL capp-api-sdk file:** 20/20 clean, 55/0 every run, load 4–6.
- **5× synthetic load:** deferred (the quiet box).
- **Guards and neighbours, all green:**
  - mutation-anchors, sweep-baseline and firestore-config-isolation: 1/0 each;
  - capp-guards 8/0, test-clock 9/0, capp-s7a1-shell 13/0, capp-ui 252/0.

## 5. F-3 (PRE-EXISTING, reported and not fixed here; money-adjacent): s2ck-a10 survives
- **The mutant:** capp-api.js `placeSdkInner`, `if (live && live.sdk !== true && Number(live.dispatched) > 0) return resolveExisting(…)` → `if (false)`.
- **HEAD control:** the mutant planted on a detached HEAD tree (66f7ff776, no step-9 change) also SURVIVES (55/0). Step 9 does not cause it.
- **The masker:** D4 F1 (110ecc04b, 2026-11-12), the later line `if (nsOfId(rec.order_id) !== 'sdk') return resolveExisting(rec.order_id)`.
  - `placeFor` returns a dispatched live record unchanged; a legacy record's id is not in the `sdk_` namespace, so D4 F1 resolves it anyway.
  - **Double plant** (a10 plus D4 F1 removed): the cell dies at `🔴 SDK-legacy: never paid over a dispatched placement`, alongside SDK-race and SDK-r3.
- **NOT equivalent.** The line sits BEFORE the `if (!h)` check, so it still decides one outcome. With no auth (a member whose token read fails, or a guest whose ticket is invalid) and a dispatched legacy placement:
  - **original:** `resolveExisting`, which needs no auth (the pay stash's own token) and gives the order's real outcome or the recovery sheet;
  - **mutant:** `{ kind: 'offline' }` or `guest_ticket_invalid`.
  - Nothing is sent either way, so no money is at risk. The customer sees a different, worse answer.
- **Proposal (advisor's call):** a RED-killing cell in capp-api-sdk: an unresolved dispatched hosted card, then `placeSdk` with the member token unavailable, asserting resolution and not «offline». s2ck-a10's `kills_with` then names it. Test-only; no production change.

## 6. F-3 resolved (advisor 11-14: «add the cell NOW»)
- **Two new cells** in capp-api-sdk, both built from real writers: `place()` sends the hosted card, and the network fails, so it is dispatched and unresolved.
  - **«F-3: … NO member token»:** the member's `getIdToken` gives nothing, so `place()` still sends with no token cached.
  - **«F-3: a guest whose keyed ticket EXPIRED»:** the `phone_key` still names the principal, but the ticket authorizes nothing.
- **Each asserts:** nothing is sent (`placeSdkOrder` 0), and the answer is `existing_order` for the dispatched id: `🔴 SDK-legacy-noauth`.
- **The real code passes both. RED:** s2ck-a10 is KILLED at `SDK-legacy-noauth` three ways: by the member cell alone, the guest cell alone, and the catalogue's whole-file command (3/3). Its `kills_with` now names `SDK-legacy-noauth`.
- **Inventory:** two ADDED tests; every existing cell is unchanged.
- **Results:** the full file 57/0; 20× the two cells 20/20 clean (load 4); anchors, baseline, isolation and capp-guards all green.
