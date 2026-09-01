# REVISE RELAY — Phase 1c-b3 P0: X. Pizza form TDZ crash (blank menu)

**To:** executor session · **From:** advisor. **Base:** the built branch `feat/phase1cb3-form-cutover @ ff47351` (worktree `~/Downloads/xpizza-1cb3`, base origin/main @ 430ad9c). **Verdict:** codex gate returned **REVISE** on ff47351 — one P0 BLOCKING finding. Items 1–4 CONFIRMED SOUND (money path diff-empty; `</script>` escaping sufficient — `scriptSafeJson` + `splice_unescaped_lt` belt + exact HTML script-data extractor; MENU-rename coupling/re-seed sound). **Do NOT touch any of that.** Fix ONLY the P0 below.

## The P0 — X. Pizza form has a runtime TDZ crash (temporal dead zone) before the menu renders

`xpizza-orders/index.html` (the x_pizza form) executes `MENU.forEach(...)` **before** `const MENU` is declared:

```
line 1608:  const qty = {};
line 1609:  MENU.forEach(p => qty[p.id] = 0);   ← USES MENU
...
line 1628:  const MENU = _okDishes(_BUNDLE.dishes) ? _BUNDLE.dishes : FALLBACK_MENU;   ← DECLARES MENU (validated-select)
```

`const`/`let` are in the **temporal dead zone** from the top of the block until their declaration line, so `MENU.forEach` at 1609 throws `ReferenceError: Cannot access 'MENU' before initialization`. Because this is **top-level** inline-script execution, the throw kills the whole script — `renderMenu()` (line ~4030) never runs → **the X. Pizza menu blanks on load = zero orders.** This is the availability-critical failure mode the whole cutover was supposed to avoid.

**Codex's falsifiable probe (verbatim):** `xpizza-orders/index.html inline script #3 -> ReferenceError: Cannot access 'MENU' before initialization`.

**La Musa is CORRECT** — `la-musa-orders/index.html`: validated-select block at 1966, `const MENU` at 1971, first `MENU.forEach` at 2041 (declare-before-use). **Do not touch La Musa.** This is x_pizza-only: the executor placed the x_pizza validated-select block *after* the `qty` init instead of where the original `const MENU = [...]` lived (before every consumer).

## The fix — reorder the x_pizza validated-select ABOVE its first consumer

Move the **entire** x_pizza validated-select block (the `_BUNDLE`/`_okDishes`/`_okStrArr` helpers + `const MENU` + `const PICKUP_ONLY_CATS` + `const WEEKEND_ONLY_CATS` + the `// Phase 1c-b3` comment banner, currently ~1622–1633) to sit **immediately above `const qty = {}` (line 1608)** — i.e. exactly where the original hard-coded `const MENU = [...]` declaration used to be, before ANY consumer references `MENU`, `PICKUP_ONLY_CATS`, or `WEEKEND_ONLY_CATS`.

- Keep `const FALLBACK_MENU = [...]` (the renamed literal) wherever it currently is **as long as it is declared before the validated-select that reads it** — it already is; just make sure moving the select up doesn't put the select above `FALLBACK_MENU`. The safe order is: `FALLBACK_MENU` → `FALLBACK_PICKUP_ONLY`/`FALLBACK_WEEKEND_ONLY` → validated-select (`const MENU`/`PICKUP_ONLY_CATS`/`WEEKEND_ONLY_CATS`) → `const qty` → `MENU.forEach` → everything else.
- **Verify by eye** after the move: every one of `MENU`, `PICKUP_ONLY_CATS`, `WEEKEND_ONLY_CATS`, `isPickupOnlyItem`, `cartHasPickupOnly`, `isWeekendOnlyItem`, `cartHasWeekendOnly` reads a name that is already declared above it. (The `isPickupOnlyItem`/`cartHasPickupOnly` arrow fns at 1611–1613 are fine — they're only *called* later, at render time, long after all consts exist. The only true top-level eager use is `MENU.forEach` at 1609.)
- The generated `<script id="form-menu-bundle">` global block stays where it is (above the main script) — only the in-main-script validated-select moves.

## The REQUIRED new test — execute the inline script, don't just parse it

This is why the 26 existing tests + `npm test` were green: they only **parse** the inline scripts (syntax) and run the validated-select block **in isolation** — a TDZ is a *runtime* error that parses fine. Add a regression test that **EXECUTES the form's full main inline script far enough to hit top-level runtime errors:**

- Extract the main inline `<script>` from each form's built HTML (the one containing `const MENU` + `renderMenu`), and **run it** in a JS realm with a minimal `window`/`document` stub (or `jsdom` if the executor judges a real DOM cleaner — adding a devDependency for a test-only harness is fine here; flag it in the handback). Drive it far enough that the top-level statements (through `const qty`/`MENU.forEach`) actually execute.
- **Assert it does NOT throw** (specifically no `ReferenceError`). Two cases per form: (a) bundle present on `window.__FORM_MENU_BUNDLE__` → runs clean; (b) bundle **absent** (`window.__FORM_MENU_BUNDLE__` undefined) → still runs clean and falls back to `FALLBACK_*`.
- This test MUST FAIL on the current ff47351 x_pizza form (proves it catches the TDZ) and PASS after the reorder. State that red→green transition in the handback.
- Keep it in `form-bundle-splice.test.js` or a sibling; it runs under the existing `npm test`.

**Root-cause note for the handback (banked lesson):** "form parses" ≠ "form runs"; a syntax/parse check can't catch declaration-order/TDZ or any top-level runtime error. Any future form-structure change gets the execute-the-script test, not just the parse test.

## Guards (unchanged from the original relay)
- **Money path stays diff-empty**: `xpizza-functions/index.js`, `menu-pricing.js`, catalog readers, factura, redemption, rules — BYTE-UNCHANGED. Grep-prove in the handback.
- **The splice/escaping is CONFIRMED SOUND — do not modify** `catalog/splice-form-bundle.js`, `form-menu-source.js`, `menu-extract.mjs`, or the escaping logic. This REVISE is a pure reorder in `xpizza-orders/index.html` + one new test.
- **La Musa form BYTE-UNCHANGED** (diff-prove vs ff47351).

## Handback DoD
- The `xpizza-orders/index.html` diff (only the validated-select block moved up; show the new ordering around `FALLBACK_MENU`→select→`qty`→`MENU.forEach`).
- The new execute-the-script regression test + proof it goes **red on ff47351 x_pizza, green after the reorder** (paste both runs).
- `la-musa-orders/index.html` byte-unchanged proof; money-path diff-empty grep; `form-bundle-splice.test.js` (now 27+/…) + `npm test` green.
- New branch/SHA off ff47351.

---
*REVISE relay (advisor→executor). After this clears the re-gate (codex re-run on the new diff, focused on the reorder + that the new test actually executes), owner git-CD deploys both forms (expand) → prove-in-prod → contract → 1d.*
