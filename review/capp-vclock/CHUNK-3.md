# vclock chunk 3: evidence (PLAN-capp-virtual-clock r0 §4)

**Scope:** capp-s7a2 cells 93–138 in file order: D-4a locks and holds, the store + home promo and the token timers, Pedido recibido, store-update. Names only; no cell line changed.

## 1. Assertion inventory
- `capp-s7a2.test.mjs`: **IDENTICAL** (the parent vs this commit).

## 2. Mutant re-kill
The 49 catalogue mutants whose commands exercise chunk-3 cells: **48/48 KILLED at their kills_with, plus 1 documented equivalent.**
- They include the D-4a `rt-*` and the whole-file mutants. Those ran in chunks 1–2 while chunk 3's cells were still on the real clock, so they are re-proven here.
- Pedido recibido and store-update have no capp-s7a2-scoped mutant in the catalogue (a coverage note, not a regression).

## 3. Stress
- **20× back to back, chunks 1–3 (138 cells):** 20/20, 138/138 each, load 4–8.
- The full file: 291/0 in 139 s.
- **5× synthetic load:** deferred (the quiet box).

## 4. Findings (reported as found; each fixed in the HARNESS, never a cell)
1. **Relaunches rewound time.**
   - A cell that boots the shell more than once (store-update r2: leave, relaunch on the same build, relaunch on a new build) got a FRESH virtual clock at T0 per boot. The store handoff recorded at the first boot's later time then looked future-dated (`age < 0`) to the next boot, which treats it as invalid and clears it.
   - The real harness hid this: every boot's time was frozen at T0.
   - **Fixed:** a later boot in the same cell continues from the previous boot's virtual time.
2. **A cell that brings its own app-time object (`now: { t }`) owns app time.**
   - The store promo token cells move it by hand (`clock.t = cutoff - 1`). Binding it to the virtual clock made every flush ADVANCE app time, which changed what «1 ms early» means.
   - **Fixed:** such a cell keeps manual app time, exactly as on the real harness. The virtual clock drives its timers and flush only.
   - Cells without their own object keep app time = the virtual clock.
