# vclock chunk 5: evidence (PLAN-capp-virtual-clock r0 §4)

**Scope:** capp-s7a2 cells 187–231 in file order: the Volver a pedir tail, the receipt API, capp-dark §3/§4, and the desk layouts C-6a / C-6b / C-6c / C-6d. Cell names join the VIRTUAL list. Eight wait lines inside the breakpoint-crossing cells changed (below); no assertion changed.

## 1. Assertion inventory
- `capp-s7a2.test.mjs`: **IDENTICAL** (293 tests, 1,577 assertions; the parent vs this commit).

## 2. Mutant re-kill
The 30 catalogue mutants whose commands exercise chunk-5 cells (19 run the whole file): **30/30 KILLED at their kills_with.**
- **Coverage note:** only 11 mutants are scoped to these cells (dsk-06, pf-01…18, c3r-01). The C-6a–d desk cells are otherwise covered only by the whole-file mutants. This is a coverage gap, not a regression; faithful C-6 mutants can follow, as they did for chunk 3.

## 3. Stress
- **20× back to back, chunks 1–5 (231 cells):** 20/20, 231/231 each, load 2–18.
- The full file: 292/0 in 106 s.
- **5× synthetic load:** deferred (the quiet box).

## 4. Findings (reported as found; fixed in the HARNESS, never an assertion)
1. **The breakpoint-crossing cells waited out the view's settle on real time.**
   - Four cells (C-6b r2 crossing, C-6c crossing, C-6c r2 crossing with the dialog, C-6d order panel through the shell) flip the media query, then wait DESK_SETTLE (300 ms) with a real `setTimeout`. The view's 120 ms settle is a virtual timer, so it never fired: «premise: the phone now» failed.
   - **Fixed:** the 8 waits became `flush(DESK_SETTLE)`. That advances the virtual clock by the same 300 ms, and on the real clock it is the same real sleep.
