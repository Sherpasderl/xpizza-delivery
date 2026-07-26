# Cambiar → Dedicated Address-Picker Modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Replace the confusing `showStage('s2')` jump on "Cambiar" with a dedicated address-picker pane in the account sheet (owner-approved mockup). Spec: `docs/superpowers/specs/2026-07-26-cambiar-picker-modal-design.md` (codex design-gate APPROVED R2). No money-path logic change; presentation/navigation only.

**Branch:** `feat/cambiar-picker-modal` (off live `main` `ea8364b`). Edit `la-musa-orders/account.js`; mirror byte-identical past CONFIG into `xpizza-orders/account.js` (Task 6). **index.html UNTOUCHED.** Commit per task.

**Reuse (do not reinvent):** the sheet pane system (`showPane`/`openOverlay`/`closeSheet`, `.acct-pane`/`acct-pane-in`, the polished close finalizer + token + inert + reduced-motion), `selectSavedAddressForOrder` (one-off, UNCHANGED), `renderNewAddressPane(opts)` order-mode + `confirmNewAddressForOrder` (UNCHANGED), the address-card markup, `_acctAddrOneOff`/`_acctOrderAddr`/`_acctAddrId`.

---

## Task 1: Add the picker pane + `renderAddrPicker()`
**Files:** `la-musa-orders/account.js` — overlay template (add pane near `acct-pane-newaddr` ~L219) + new render fn.
- [ ] **Step 1:** Add `<section class="acct-pane" id="acct-pane-addrpicker"></section>` to the overlay template.
- [ ] **Step 2:** `renderAddrPicker()` — populate the pane in the account-sheet visual language (match the mockup + `renderAddressesSection`/`deliverCardHtml` card style):
  - Header row: title **"Elegí una dirección"** + ✕ (wire ✕ to the contextual close, Task 5).
  - A card per saved address (`_acctData.addresses`): label + short line (`details||detected`); the card matching `_acctOrderAddr`/`_acctAddrId` gets the ACTIVE style (accent dot + check). No delete/×, no default-management here (this is a picker, not the manager).
  - A dashed **"+ Usar una dirección nueva"** affordance.
  - Escape all interpolated address text (reuse `escapeHtml`).
- [ ] **Step 3:** Wire card taps (Task 2) + "+ nueva" (Task 3).
- [ ] **Step 4: Commit** — `feat(cambiar-picker): address-picker pane + renderAddrPicker (account-sheet styling)`

## Task 2: Card tap — active = no-op, other = one-off apply (codex F1)
**Files:** `la-musa-orders/account.js` — `renderAddrPicker` card handlers.
- [ ] **Step 1:** On card tap: if the tapped `addrId === (_acctAddrId of the current order address)` → **close the sheet, NO state change** (do NOT call `selectSavedAddressForOrder` — that would set `_acctAddrOneOff=true` and silently convert a default-backed order to one-off). If a DIFFERENT addrId → `selectSavedAddressForOrder(addrId)` (UNCHANGED one-off apply) then close.
- [ ] **Step 2:** Brief highlight on the tapped card before close (feels responsive; ~200ms), consistent with the mockup.
- [ ] **Step 3:** Verify — reopening the picker and tapping the already-active address leaves `_acctAddrOneOff` unchanged (a default stays a default); tapping a different one applies it one-off (default untouched).
- [ ] **Step 4: Commit** — `feat(cambiar-picker): active card no-op, other card one-off apply (no silent one-off flip)`

## Task 3: "+ Usar una dirección nueva" → order-mode new-address with returnTo (codex F2)
**Files:** `la-musa-orders/account.js` — `renderNewAddressPane(opts)` back handler + the picker's "+ nueva" wiring.
- [ ] **Step 1:** Add a `returnTo` opt to `renderNewAddressPane`/its back handler. From the picker: `renderNewAddressPane({ mode:'order', returnTo:'addrpicker' })` + `showPane('newaddr')`. The order-mode back handler (`backFromOrderNewAddress`) routes by `returnTo`: `'addrpicker'` → reset `_nad*` + `showPane('addrpicker')`; default/`'account'` (Mi-Cuenta "+ Agregar") → the existing Mi-Cuenta return (`showPane('account')`). Do NOT hardcode a single back target.
- [ ] **Step 2:** Confirm the Mi-Cuenta "+ Agregar" caller still passes its existing mode (account-save) and returns to Mi Cuenta — unchanged.
- [ ] **Step 3:** On confirm in order mode → `confirmNewAddressForOrder(saveToAccount)` (UNCHANGED) → `closeSheet()` + applied.
- [ ] **Step 4:** Verify — picker → "+ nueva" → back returns to the PICKER (not close, not Mi Cuenta); Mi-Cuenta "+ Agregar" → back still returns to Mi Cuenta.
- [ ] **Step 5: Commit** — `feat(cambiar-picker): + nueva opens order-mode new-address with returnTo:addrpicker`

## Task 4: Rewire `openCambiarPanel` — open the picker, drop the stage jump
**Files:** `la-musa-orders/account.js` — `openCambiarPanel` (~L2684), the s1/s2 Cambiar buttons.
- [ ] **Step 1:** Replace `openCambiarPanel` body with: `openOverlay(); renderAddrPicker(); showPane('addrpicker');`. REMOVE the `showStage('s2')` jump AND the `#acct-s2-summary` inline-chooser render. Both `acct-change-btn-s1` and `acct-change-btn-s2` keep calling `openCambiarPanel`.
- [ ] **Step 2:** Verify the s2 rich summary (`renderS2RichSummary` → `#acct-s2-summary`) still renders normally (it just keeps showing the summary; the picker is a separate pane). Both apply paths (`selectSavedAddressForOrder`, `confirmNewAddressForOrder`) already re-render s1+s2 summaries before close, so on `closeSheet` the checkout shows the new address at whatever stage the user was on (Cambiar from s1 → back to s1; from s2 → back to s2; `closeSheet` is stage-neutral).
- [ ] **Step 3:** Verify — no code still depends on Cambiar being on s2. No step-label flip.
- [ ] **Step 4: Commit** — `feat(cambiar-picker): openCambiarPanel opens the picker pane (drop showStage('s2') jump)`

## Task 5: Contextual close teardown + scrim-close (codex F3/F4)
**Files:** `la-musa-orders/account.js` — the topbar-✕ handler (~L323), `closeSheet`, add scrim handler.
- [ ] **Step 1:** Route ✕ (and the new scrim handler) through a `dismissSheet()` that, if the active pane is the order-mode new-address (`acct-pane-newaddr` in order mode), runs its teardown FIRST — bump `_acctFsEpoch`, reset `_nad*`, restore `_nadPaneMode`/mode — then `closeSheet()`. For other panes (picker/account), just `closeSheet()` (order unchanged). This closes the stale-state gap the polished sheet finalizer doesn't cover.
- [ ] **Step 2:** ADD an `.acct-overlay` scrim click handler guarded to the scrim only: `overlay.addEventListener('click', e => { if (e.target === overlay) dismissSheet(); })` — clicks inside `.acct-sheet` do NOT dismiss. (There is currently no scrim-close; the design promises it.)
- [ ] **Step 3:** Verify — ✕/scrim from the picker closes with the order UNCHANGED; ✕/scrim from the order-mode new-address pane runs the teardown (no stale `_nad*`/map/mode into the next open); clicks inside the sheet don't dismiss; the polished close finalizer/token/inert still applies.
- [ ] **Step 4: Commit** — `feat(cambiar-picker): contextual close teardown + scrim-dismiss (target-guarded)`

## Task 6: Mirror to X. Pizza + guest-safety + self-review
- [ ] **Step 1:** Port Tasks 1–5 into `xpizza-orders/account.js` below CONFIG; Node-compare → identical past CONFIG.
- [ ] **Step 2:** Guest-safety (both forms, agent-browser at `~/.npm-global/bin`): guest load — no account Firebase SDK, guest flow unchanged, index.html untouched (`git diff --stat ea8364b..HEAD -- '*index.html'` empty).
- [ ] **Step 3:** Self-review proofs — (a) no money-path/logic change: `selectSavedAddressForOrder`/`confirmNewAddressForOrder`/`_acctAddrOneOff`/`_acctOrderAddr`/`processPayment` untouched (grep the diff); (b) active-card no-op preserves `_acctAddrOneOff`; (c) returnTo routing correct for both callers; (d) no orphaned pane/scrim after close, no two panes `acct-on` at once; (e) reduced-motion inherited; (f) both forms parity.
- [ ] **Step 4:** Push `feat/cambiar-picker-modal`, report tip SHA for codex-on-diff. No deploy/merge.

---

## Self-Review (author, pre-handoff)
- **Spec coverage:** picker pane (T1), active-no-op/one-off (T2, F1), returnTo (T3, F2), rewire+drop-jump (T4), teardown+scrim (T5, F3/F4), mirror+proofs (T6). All 4 codex R1 contracts + the core change.
- **Watch:** T2 active-card no-op (the silent-one-off-flip trap); T3 returnTo must not break Mi-Cuenta "+ Agregar"; T5 contextual teardown must run on ✕/scrim from newaddr. Seamless: picker↔newaddr is a pane transition within ONE sheet (acct-pane-in) — never close/reopen.
- **Placeholder scan:** none.
