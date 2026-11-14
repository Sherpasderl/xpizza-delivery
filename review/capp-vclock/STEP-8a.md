# vclock step 8a: capp-ui `popped()` evidence (PLAN-capp-virtual-clock r0 §4, step 8)

**Scope:** `capp-ui.test.mjs`. `popped()` was a fixed 30 ms real sleep that raced jsdom's popstate. It is now `createClock(0).drain()`, which yields to jsdom's own 0 ms tasks until QUIET (two empty rounds, so a skipped popstate also ends), then `settle()`. The 11 cells that use `popped()` / `backToCart` are affected; no assertion changed.

## 1. Assertion inventory
- `capp-ui.test.mjs`: **IDENTICAL** (246 tests, 1,239 assertions).

## 2. Mutant re-kill
- The 88 catalogue mutants whose commands run `capp-ui.test.mjs` (79 run the whole file): **85/88 KILLED**.
- **3 SURVIVED: s2ck-a12, s2ck-u17, s2ck-u19.** This predates step 8. Control: the same 3 mutants on the HEAD test file (the popped() patch removed) gave **0/3 killed**.
- See finding F-1.

## 3. Stress
- **20× the 11 cells, back to back:** 20/20 clean.
- **The full file:** 250/0, 48 s.
- **5× synthetic load:** deferred (the quiet box).

## 4. Findings
**F-1 (pre-existing, reported to the advisor, not fixed here; money-adjacent).** The two reload-switch cells («Codex r2 P2: a reload DURING a pending cash switch…» and «Codex r3 P2-4 repro…») cannot see the switch's stored cash inputs being lost or ignored.
- **Cause:** after a reload, `sdkRestore` (capp-ui.js, «Codex r1 P2-3») rebuilds the flow from the card order's bound inputs (`api.sdkInputs`). In both cells those inputs equal the switch's `switch_body`, so the switch restore (capp-ui.js `sdk_switched`: `if (out.body) …`) and the `switch_body` write (capp-api.js `sdkSwitchInner`) are masked.
- **Probe:** with u19 applied AND `handlePayReturn`'s stash restore also removed, both cells still pass.
- **The missing case:** the customer edits the checkout (e.g. notes or recipient) between the decline and the cash switch, then reloads. Advisor r3 C says the switch's stored inputs ALWAYS win, and no cell exercises that.

## 5. F-1 resolved (advisor 11-14: «add the cell NOW, before step 8b»)
- **New cell «vclock F-1»** (capp-ui.test.mjs):
  - the card is declined;
  - the customer taps «Probar otra tarjeta» and closes the chooser;
  - they edit the recipient and notes («Tercera persona», «Sin tomate»), pick cash and tap «Hacer pedido»;
  - the switch is not yet safe; then a reload.
- The cell asserts that the placed cash order carries the EDITED inputs: `🔴 SDKUI-F1`.
- **No app bug:** the cell passes on the real code, so `sdkRestore` does not override `switch_body`.
- **RED:** s2ck-a12, u17 and u19 are each KILLED at `🔴 SDKUI-F1`, both run against the cell alone and with the catalogue's own whole-file commands: 3/3 each time.
  - Their catalogue `kills_with` now names `SDKUI-F1`. The old anchors (SDKUI-reload-switch / SDKUI-restore) could not see them.
- **Assertion inventory:** one ADDED test; every existing cell is unchanged.
- **Full file:** 251/0, 41 s. **20× stress of the cell:** 20/20 clean.
- **Catalogue guards:** mutation-anchors, sweep-baseline, firestore-config-isolation and capp-guards are all green.
