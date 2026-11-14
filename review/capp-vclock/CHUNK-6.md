# vclock chunk 6: evidence (PLAN-capp-virtual-clock r0 §4)

**Scope:** capp-s7a2 cells 232–288 in file order, minus 266 and 269: C-2 ratings, C-5 help, S2 pay-adjust, C-1a store ratings, WAKE-6, RULE 10, G-B / G-C. That is 55 cells, joining the VIRTUAL list. Every listable cell of the file is now migrated; the VC guard cells (289–292) are the harness itself.

## 0. Real by design (advisor 11-13)
- 266 «harness (2e: test 35 …)» proves a frame the shell requests lands before a 0 ms timer.
- 269 «harness · REAL frames» proves the app under jsdom's own timer-driven frames.
- Both stay on the REAL clock, in a new `REAL_BY_DESIGN` set.
- **VC-M** now also asserts that each real-by-design name is exactly one cell and is never also listed VIRTUAL. Mutants **vc-11** (a stale name) and **vc-12** (a double listing) are both KILLED at «🔴 VC-M: a real-by-design name».

## 1. Assertion inventory
- `capp-s7a2.test.mjs`: identical except **VC-M (4 → 5)**, the new check above. Every chunk-6 cell is unchanged.

## 2. Mutant re-kill
The 41 catalogue mutants whose commands exercise chunk-6 cells (19 run the whole file): **41/41 KILLED at their kills_with.**

## 3. Stress
- **20× back to back, chunks 1–6 (286 cells):** 20/20, 286/286 each, load 1–13.
- The full file: 292/0 in 70 s (chunk 5: 106 s; chunk 4: 133 s; the virtual clock removes the real waits).
- **5× synthetic load:** deferred (the quiet box).

## 4. Findings (fixed in the HARNESS, never an assertion)
1. **The C-2 rating fake server delayed every answer on a real `setTimeout`** (5 ms; 400 ms for the slow-server cell).
   - **Fixed:** the delay runs on the cell's virtual clock when the cell is virtual, as myOrdersServer's rdelay already does (chunk 4). The delays are unchanged.
