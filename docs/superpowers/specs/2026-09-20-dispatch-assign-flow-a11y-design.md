# Dispatch — Assign/Reassign flow: keyboard + screen-reader accessibility (A11y hardening)

**Status:** DESIGN (from `/impeccable critique` of `xpizza-dispatch/index.html`, 25/40) → relay to auditor session for **codex gate** → owner deploy.
**Date:** 2026-09-20
**Base:** `origin/main` (verify tip directly with `git ls-remote origin` before building — [[verify-remote-git-state-directly]]). Single file: `xpizza-dispatch/index.html`. Own worktree off origin/main per [[parallel-session-file-coordination]].
**Money-adjacency:** **NOT money-adjacent** — assignment/reassignment is a *task* write, never a charge. Still a **full codex gate** (every build, no self-approve — [[codex-gate-always]]).
**Motivation (critique findings):**
- **P0** — the driver picker (the board's most-used action) is a **keyboard / screen-reader dead end and is not Escape-closable**. Rows are `<div class="picker-row">` with click handlers only (`:4835–4863`); no `role`/`tabindex`/keydown; the keydown handlers (`:2901`, `:5132`) never reference the picker; dismissal is only backdrop-click or the Cancel button (`:4877–4880`). A keyboard-only dispatcher can Tab to "Asignar", open the picker, then neither select a driver nor escape — the primary task is unfinishable.
- **P1** — **grayed picker rows look disabled but still assign.** Full / en-route / unreachable drivers get `.disabled` styling (opacity 0.4, `cursor:not-allowed`, `:4836`) yet remain clickable behind a `confirm()` (`:4854–4860`). In a rush the fastest available driver may be the one styled "unavailable"; the dispatcher skips them or second-guesses. Disabled-looking-but-active is a trust break.

## Goal
Make the assign/reassign picker fully operable by keyboard and announced correctly by a screen reader, and make the confirm-required drivers read as **"allowed with caution"** rather than **"blocked"** — **without changing one byte of assignment logic.**

## Scope (all in `xpizza-dispatch/index.html`, additive; presentation + interaction only)

1. **Picker as an accessible dialog.** `#picker-overlay` (the dialog card, not the backdrop) gets `role="dialog"`, `aria-modal="true"`, and `aria-labelledby` pointing at `#picker-title`. On open: move focus into the driver list (the first / highest-priority row). While open: **trap focus** within the overlay (Tab / Shift-Tab cycle; focus never leaks to the board behind). On close (any path — Enter-assign, click-assign, Cancel, backdrop, Esc): **restore focus** to the element that opened the picker (capture `document.activeElement` at the top of `openPicker`, restore in `closePicker`).
2. **Picker rows become real `<button>`s.** Change `<div class="picker-row" data-driver-uid …>` (`:4835`) to `<button type="button" class="picker-row" …>` keeping every existing class, `data-driver-uid`, `data-full`/`data-enroute`/`data-unreachable`. Add an `aria-label` summarizing the row (name · status · load · distance-to-base/customer · any "requiere confirmación" reason) so a SR user hears the whole row, not just the name. Keyboard Enter/Space already activates a `<button>`, so the existing click listener (`:4852`) fires unchanged. Optional nicety: `↑`/`↓` (or `j`/`k`) move focus between rows.
3. **Warning affordance replaces fake-disabled.** For `requireConfirm` rows (full | en-route | unreachable, `:4821`): **drop the `.disabled` (opacity/`not-allowed`) treatment** and render a `.needs-confirm` **amber warning** style with an inline reason already visible in the row (`requiere confirmación · lleno` / `· en camino` / `· sin notificaciones`). The row stays fully interactive; the existing `confirm()` override (`:4854–4860`) fires exactly as today. Result: reads as *cautioned*, not *disabled*. (No `pointer-events`/`cursor` change that would block the click.)

### Explicitly OUT of scope (separate relays)
- Number-key / bulk assign and driver **type-ahead search** in the picker → the `optimize` (P3) relay.
- Replacing native `confirm()` with a styled in-board confirm → track with the reconciliation-`prompt()` cleanup in the `polish` (C) relay. (Keep `confirm()` here; the new warning affordance already removes the *surprise*.)
- Restoring the delivery destination into the picker sub-header (`:4777` currently shows only `customer · L total`) → optional; include only if trivial, else defer to C.

## Invariants (no-regression — [[no-regression-hard-rule]])
- **Assignment logic is byte-identical.** No change to: the priority sort + `getActiveDrivers` mapping (`:4780–4794`), the **`pickerFromDriver` CAS freeze** (`:4772`), the `requireConfirm` policy (`:4821`), `ordersByDriver` load counting (`:4802–4808`), the `confirm()` texts (`:4855–4859`), `assignOrder` / `XPD.reassignOrder` / `XPD.assignOrderToDriver` (`:4897–4912`), `assignFailMsg`, the success/error toasts, and `closePicker` state resets (`:4869–4874`). The diff must be render-markup (`div`→`button`, classes/aria), focus management, one Esc branch, and the disabled→warning CSS — nothing else.
- **Mouse path unchanged.** Click still assigns; backdrop-click and Cancel still close; the "No hay drivers en turno" empty state (`:4797`) is untouched.
- **XSS.** The new `aria-label` is an **attribute sink** → every interpolated field `escapeHtml(String(...))`'d (driver name already is at `:4839`; the status/reason/distance strings are app-controlled but coerce + escape anyway). No new raw `${…}` into markup or attribute.
- **Read-only re: data.** No new DB writes or subscriptions; opening/closing the picker changes no server state.
- **Focus trap must not fight the existing keydown handlers** (`:2901` detail/msg modals, `:5132` search). Guard the new Esc branch on `pickerOpen` so Esc-while-picker-open closes only the picker (the picker sits above the board; when it's open it owns Esc).
- **`prefers-reduced-motion`.** Any focus-scroll / open animation is skipped/instant under reduced-motion.
- **Brand-agnostic.** Shared dispatch file (both X.Pizza + La Musa); no `restaurant_id` literal introduced ([[brand-agnostic-no-hardwiring]]).

## Gate focus (codex, on the build diff)
- **Semantics frozen:** confirm the diff shows only render/focus/aria/style deltas + one `pointerOpen`-guarded Esc branch — no touch to the CAS freeze, `requireConfirm`, or the assign/reassign calls.
- **Keyboard:** Tab/Shift-Tab cycle *within* the overlay; Esc closes and **restores focus to the opener**; Enter/Space on a row assigns (or opens `confirm()` for a needs-confirm row); focus never lands on the board behind an open picker.
- **Warning rows are genuinely clickable** — no residual `pointer-events:none`/`cursor:not-allowed`/`disabled` attribute blocks the click; `confirm()` still fires and the override still assigns.
- **XSS:** `aria-label` attribute sink escaped; no new raw interpolation.
- **No regression:** mouse assign, backdrop/Cancel close, empty-state, and the reassign path (`isReassign`) all still work.

## Test plan (owner bench + gate reasoning)
1. **Keyboard-only:** Tab to a queue "Asignar" → Enter opens picker → focus lands on the top driver → `↑`/`↓` (or Tab) move → Enter assigns; for a needs-confirm driver, Enter → `confirm()` → override assigns → toast → picker closes → **focus returns to the "Asignar" button**. Esc at any point closes and restores focus.
2. **Screen reader:** overlay announced as a dialog titled "Asignar #N" / "Reasignar #N"; each row announces name · status · load · distance · (reason).
3. **needs-confirm row:** visually **amber + reason**, fully clickable by mouse and keyboard, `confirm()` appears, override assigns (behavior identical to today).
4. **Mouse regression:** click-assign, backdrop-close, Cancel-close, empty state — all unchanged.
5. **Hostile `driver.name`** (`<img onerror=…>` / `" onmouseover=…`) renders as text in the row **and** inside its `aria-label` (attribute context) — no execution.
6. **Reduced-motion:** focus-scroll/open animation is instant; no motion.
7. **Reassign path** (`openPicker(orderId, true)`): same keyboard/SR behavior; the `pickerFromDriver` CAS freeze still aborts a doomed reassign if the order moved (unchanged).

## If APPROVED → deploy (owner)
`git fetch` + confirm `origin/main` directly ([[verify-remote-git-state-directly]]). Dispatch Netlify **`xpizzadispatch`** git-CD (explicit `--site ac3fa94a-564a-4df4-9428-34e6cb41f778` if CLI — [[netlify-deploy-mechanics]]). **No functions, no rules.** Both brands share the file. Verify on-device: keyboard-only assign end-to-end, Esc closes + restores focus, a "lleno" driver reads amber-cautioned and still assigns behind confirm.
