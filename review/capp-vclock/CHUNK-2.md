# vclock chunk 2: evidence (PLAN-capp-virtual-clock r0 §4)

**Scope:** capp-s7a2 cells 47–92 in file order: Codex G6 r1–r4, the S4 shell, frames 15–18, G7, Part B, D-2 desktop, the Pedidos entry points, D-4a routing. Names only; no cell line changed.

## 1. Assertion inventory
- `capp-s7a2.test.mjs`: **IDENTICAL**, 292 tests / 1,575 assertions (the parent vs this commit).
- `test-clock.test.mjs`: one cell added, VC7 (below).

## 2. Mutant re-kill
The 61 catalogue mutants exercising chunk-2 cells: **58 KILLED at their kills_with, plus 2 documented equivalents.**
- **1 SURVIVED: `dsk-02`.** It is **PRE-EXISTING, not caused by the migration.**
  - On the REAL clock (the clock default forced off), with the mutant planted, the D-2 cells pass 10/0, twice.
  - `dsk-02` mutates `capp-ui.js:460`'s `S.desk ? <aside> : ''` branch. That branch is DEAD: `storeHtml()` returns `storeDeskHtml()` whenever `S.desk`, and the desk aside is emitted at `:512`.
  - So dsk-02 has been an equivalent mutant since C-6c, surviving unnoticed. **Proposed** (not done; for the advisor): re-point dsk-02 at the live `:512` aside, and delete the dead branch in a tiny separate commit.

## 3. Stress
- **20× back to back, chunks 1 + 2 (92 cells):** 20/20, 92/92 each, load 4–9 (chunk 1 re-proven on the new drain).
- The full file: 291/0 in 154 s (it was 190–250 s on the real clock).
- **5× synthetic load:** deferred (the quiet box).

## 4. Findings (reported as found)
1. **A leak surfaced by the clock.**
   - A chunk-2 cell leaves async work running past its end. It read `clock.t` after `afterEach` had cleared the shared clock: an uncaught TypeError after the test ended.
   - Root cause in step 0's harness (mine): the boot's clock object read the MODULE variable.
   - **Fixed in the harness:** each boot captures its OWN clock instance (`vc`), so leftover work reads its own clock and never the next cell's.
   - The leaking cell itself is unchanged; identifying it is a follow-up if wanted.
2. **jsdom delivers history traversal + popstate on its own REAL 0 ms timers.**
   - `D-4a sentinel unchanged` failed on the virtual clock: the unblocked Back had not landed. On the old drain, a real 0 ms task landed only by timing luck (VC7: 1 of 3 runs RED).
   - **Fixed in the clock:** each drain round ends with ONE real 0 ms yield, and drain returns only after 2 consecutive quiet rounds. Node fires equal-delay timers in order, so a two-hop environment chain (traversal → popstate) always lands.
   - VC7 guards it (5/5).
   - **Known limit:** the `QUIET = 1` mutant cannot be killed deterministically (its survival depends on how fast the microtask turns run). It is dropped rather than kept as a flaky kill.
   - 5 s7a2 sites use a real `history.back()`. A fully virtual session history (the plan's original idea) remains an option.
3. **No hidden false-green** in chunk 2's assertions beyond the above.
