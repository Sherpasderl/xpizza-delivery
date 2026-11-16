# vclock chunk 4: evidence (PLAN-capp-virtual-clock r0 §4)

**Scope:** capp-s7a2 cells 139–186 in file order: getMyOrders / Pedidos, receipts. Cell names join the VIRTUAL list. Three harness lines inside the receipt-prefetch cells changed (below); no assertion changed.

## 1. Assertion inventory
- `capp-s7a2.test.mjs`: **IDENTICAL** (293 tests, 1,577 assertions; the parent vs this commit).

## 2. Mutant re-kill
The 41 catalogue mutants whose commands exercise chunk-4 cells (19 run the whole file): **40/40 KILLED at their kills_with, plus 1 documented equivalent (rt-05).**

## 3. Stress
- **20× back to back, chunks 1–4 (186 cells):** 20/20, 186/186 each, load 2–7.
- The full file: 292/0 in 133 s.
- **5× synthetic load:** deferred (the quiet box).

## 4. Findings (reported as found; fixed in the HARNESS, never an assertion)
1. **The receipt-prefetch cells slept on real time.**
   - Three real sleeps (600 / 20 / 500 ms) waited for the prefetch.
   - Their fake myOrders server answered through a real `setTimeout` delay, so the virtual clock could never reach the answer.
   - **Fixed:** the fake server's delay runs on the cell's virtual clock (`VC.setTimeout` when the cell is virtual), and the sleeps became `flush(600)`, `flush(20)` and `flush(500)`. The delays and assertions are unchanged.
