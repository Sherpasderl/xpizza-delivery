# HANDOFF → order-form executor session

**What:** Replace the confusing "Cambiar" → `showStage('s2')` jump with a dedicated address-picker MODAL (a pane in the account sheet). Owner-approved mockup: https://claude.ai/code/artifact/856cc06a-48f5-4a6d-81be-3215878ffec7 . Presentation/navigation change; NO money-path logic change.

**Branch:** `feat/cambiar-picker-modal` (tip = design docs, off live `main` `ea8364b`). Check it out fresh.

**Read (on the branch):**
- Spec (codex design-gate APPROVED R2): `docs/superpowers/specs/2026-07-26-cambiar-picker-modal-design.md`
- Plan (6 tasks, exact functions/lines): `docs/superpowers/plans/2026-07-26-cambiar-picker-modal.md`

**The flow:** Tap "Cambiar" → a focused picker pane slides up in the account sheet ("Elegí una dirección" + saved-address cards + "+ Usar una dirección nueva") — NO jump to Pago, NO step-label flip. Tap a saved address → one-off apply + close back to checkout at the same stage. "+ nueva" → the isolated new-address pane (same sheet, pane transition) → save/one-off → apply + close.

**Hard rules:**
- Edit `la-musa-orders/account.js`; mirror byte-identical past the ~20-line CONFIG into `xpizza-orders/account.js`. **index.html UNTOUCHED** (`git diff --stat ea8364b..HEAD -- '*index.html'` empty).
- NO money-path/logic change: `selectSavedAddressForOrder` (one-off), `confirmNewAddressForOrder` (save/one-off + detected-authority), `_acctAddrOneOff`/`_acctOrderAddr`, `processPayment`, reduced-flow all UNCHANGED. You change WHERE the chooser lives (a sheet pane) + remove the stage jump.
- SEAMLESS/SPOTLESS (owner's explicit bar): picker↔new-address is a PANE transition within ONE sheet (`acct-pane-in`) — never a close-then-reopen flicker. Reuse the polished open/close/inert/reduced-motion infra + the already-shipped isolated-map polish (black-balloon pin, hint-hides-on-placement, no giant pin, smooth blow-up). No orphaned scrim/pane/flash.
- Guest byte-identical (picker is marker-gated, reachable only from the reduced-flow Cambiar). Both forms identical past CONFIG. No cheap emoji.

**The 4 codex contracts (it will re-check on-diff):**
1. **Active-card no-op (High):** tapping the currently-active address must NOT call `selectSavedAddressForOrder` (that flips a default-backed order to one-off silently) — it just closes. Only a DIFFERENT card applies.
2. **returnTo (High):** new-address opened from the picker → back returns to the PICKER (`returnTo:'addrpicker'`); Mi-Cuenta "+ Agregar" → back still returns to Mi Cuenta. No single hardcoded back target.
3. **Contextual close teardown (Medium):** ✕/scrim close from the order-mode new-address pane must run its teardown (bump `_acctFsEpoch`, reset `_nad*`, restore mode) — not only the sheet finalizer.
4. **Scrim-close (Medium):** ADD an `.acct-overlay` scrim handler guarded to `e.target===overlay` (clicks inside `.acct-sheet` don't dismiss); it runs the same contextual teardown.

**FILE COORDINATION:** advisor is NOT editing `account.js` — you are the SOLE editor on this branch. Advisor reads + runs codex gates only. Push the branch, report the tip SHA; advisor runs codex-on-diff, loops to APPROVED, owner deploys (Netlify CLI per-folder: xpizzaorders 6f09559f / lamusaorders f8bac377).

**Do NOT deploy/merge/run codex.**
