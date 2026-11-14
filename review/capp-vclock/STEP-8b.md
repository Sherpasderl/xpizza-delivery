# vclock step 8b: capp-ui fakeTimers on the virtual clock (advisor 11-14, option (a))

**Scope:**
- `test-clock.mjs` gains two members:
  - `fireThrough(t)`, which is synchronous: it fires every timer due by t in (due, arming) order, including chained arms and re-armed intervals, with no drain between. Time ends at max(now, t). It is bounded: a same-instant loop throws «not quiet».
  - `lastDue`.
- `capp-ui.test.mjs` fakeTimers is rebuilt on `createClock`:
  - `flush()` is `fireThrough(lastDue)`;
  - `advance(ms)` fires only what is due within ms;
  - setInterval / clearInterval delegate, so intervals are real;
  - `timers.ms` keeps its old semantics (every setTimeout's delay; the 7 reading cells are unchanged).
- The old fake fired a snapshot in arming order and never fired an interval.

## 1. Assertion inventory
- `capp-ui.test.mjs`: one ADDED test («vclock 8b», below); every existing cell is unchanged.
- `test-clock.test.mjs`: two ADDED tests (VC8, VC9); the rest are unchanged.

## 2. RED first
- VC8 and VC9 failed before `fireThrough` / `lastDue` existed, then went green (9/9).

## 3. Findings
**F-3, closed here: no cell depended on the app's intervals.**
- Probe: the old dead-interval fake (now vc-16) SURVIVED the whole capp-ui file.
- New real-writer cell «vclock 8b»: the «Realizando pedido…» countdown (capp-ui.js placeTap: a 1 s interval beside the 2 s send) reads 0:01 at 1 s, and nothing is sent before 2 s (`🔴 VC-UI1`).
- First the cell read the countdown before checking the send. Under vc-18 the sheet had already closed, so the cell died on a TypeError (DRIFTED). The fix: check the send first, and read the countdown null-safely. Both are harness changes; no assertion was loosened.

**No cell newly failed** under the real (due, arming) order and real intervals. There was nothing to fix in the harness and no app bug.

**F-2, PRE-EXISTING, reported and not fixed here:** s4-27 («row 10's CTA depends on fresh-slot availability», `anySlot: hasSlotLock() || anySlotNow()` → `anySlotNow()`) SURVIVES.
- It survives identically on the HEAD test file (control: the old fake, 0/1).
- Likely masking: with a slot lock held, the CTA label returns «Reintentar» first (capp-ui.js `if (hasSlotLock()) return 'Reintentar'`), and `ctaOff` has its own `!hasSlotLock()` terms. The gate context's `hasSlotLock() ||` is never what the cell observes.

## 4. Mutant re-kill
- **All 158 catalogue mutants whose commands run capp-ui.test.mjs or test-clock.test.mjs** (79 whole-file): 155/157 killed, +1 documented equivalent.
  - s4-27 SURVIVED (F-2, pre-existing).
  - vc-18 DRIFTED; fixed above.
- Re-run after the fix: **vc-16, vc-17, vc-18: 3/3 KILLED at `🔴 VC-UI1`**.
- New mutants, all KILLED at their named assertion:
  - vc-13 (arming order) and vc-15 (snapshot-only flush) at VC8;
  - vc-14 (intervals never re-arm) at VC9;
  - vc-16 (the fake's intervals dead), vc-17 (the countdown never ticks) and vc-18 (the send at 1 s) at VC-UI1.

## 5. Stress
- **20× the FULL capp-ui file** (the rebuild touches every cell that flushes timers): 20/20 clean, load 3–8.
- **After the cell fix:** the full file 252/0, 40 s; 20× the cell 20/20.
- **5× synthetic load:** deferred (the quiet box).
- **Guards:** mutation-anchors, sweep-baseline, firestore-config-isolation, capp-guards 7/0 and test-clock 9/0 are all green.

## 6. F-2 resolved: s4-27 is EQUIVALENT (advisor 11-14: «ANALYSE first, then act»)
- `gateCtx().anySlot` has exactly one reader: `missingStep` (capp-checkout.js:171), through `need()`.
- With a slot lock held, no `need()` reader decides an outcome. Each guard below pre-empts it (capp-ui.js unless named):
  - **The CTA label:** «Reintentar» is returned before `need()` (:945–946).
  - **ctaOff:** it ignores `need()` under the lock (:956).
  - **The CTA tap:** under the lock it sends the replay directly (:1859), so `enterTip` / `placeTap` are never reached from it (:1860).
  - **The tip step:** it is reachable only through :1860. A forward history move is ignored (:1801) and `backTo` walks back (:1542), so `tip-place` / `tipReady` (:1867 / :1276) never run under the lock.
  - **The guest paths** (`placeNow` :1328 via the code :1428; `guest-card` :1912): the lock is member-only (`lockedBody` :838–839).
  - **`err-card`** (:1917 / :1920) and **`contextRestored`** (:1724): both follow a `payment_failed` return, which releases the record first (capp-api.js:399). A non-clearable return shows the pending sheet, which has no `err-card` (:1722).
  - **`sdkPlaceIfReady`** (:2071): it follows an SDK switch. Under a base lock the tender is fixed (:1180, :1847) and the tap replays the base body (:1859), so no SDK flow runs.
- **Catalogue:** s4-27 now has `equivalent: true` with this proof. The sweep reports it as EQUIVALENT; the anchors, baseline and isolation guards are green.
- **Proposal: KEEP the term** as defence-in-depth (rt-05 precedent; :844 says «hasSlotLock() is the ONE predicate every consumer reads»). Deleting it changes a production gate for no behaviour change, and it would silently become load-bearing again if a future path reads `need()` under a lock.
