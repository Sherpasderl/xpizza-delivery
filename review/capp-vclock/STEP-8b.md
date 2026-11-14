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
