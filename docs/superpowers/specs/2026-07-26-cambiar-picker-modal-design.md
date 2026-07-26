# Cambiar → Dedicated Address-Picker Modal — Design Spec

**Date:** 2026-07-26 · Advisor-designed from owner-approved mockup (`https://claude.ai/code/artifact/856cc06a-…`). Replaces the confusing `showStage('s2')` jump when "Cambiar" is tapped on the reduced-flow delivery summary. Branch `feat/cambiar-picker-modal` (off live `main` `ea8364b`). **Both forms** (`account.js` byte-identical past the ~20-line CONFIG block; `index.html` UNTOUCHED). codex design-gate HERE → order-form executor session builds → codex-on-diff HERE → owner deploys.

## The problem (owner-reported)
For a logged-in complete-profile user, tapping **"Cambiar"** on the "Entregar a" address (in s1 "Tus datos") does `showStage('s2')` — throwing the user to **"Paso 2 de 2 — Pago"** and flipping the step label. You tapped "change address" and landed on "payment." It's a vestigial artifact: the chooser was mounted in `#acct-s2-summary` (s2) because the OLD new-address flow needed the checkout map (in s2). That map dependency is GONE — "usar una dirección nueva" now uses the isolated account map. So the jump serves no purpose.

## The design (owner-approved mockup)
Tap **"Cambiar"** → a **focused address-picker modal** slides up over checkout (the account sheet, shown to a dedicated picker pane) — NO stage jump, NO step-label change:
- Header **"Elegí una dirección"** + ✕.
- The saved addresses as tappable cards (the currently-selected order address highlighted with the accent + check), matching the account-sheet card visual language.
- **"+ Usar una dirección nueva."**
- Tap a saved address → applies to **THIS order** (one-off — `_acctAddrOneOff`, default untouched) via the existing `selectSavedAddressForOrder`, then the sheet closes back to checkout **at the same stage the user was on**.
- Tap "+ Usar una dirección nueva" → transitions (within the SAME sheet) to the isolated new-address pane (map + referencia + save/one-off) → `confirmNewAddressForOrder` applies + closes back to checkout.
- ✕ / scrim / back → close, order unchanged.

## Architecture — reuse the sheet's pane system (the seamless path)
The account sheet already has `showPane` + `acct-pane-*` panes with a smooth `acct-pane-in` transition (~L104/113/234) and the polished open/close/inert/reduced-motion infra from the last batch. Build the picker as a NEW pane, so picker → new-address is a **pane cross-fade within one sheet** — no sheet close/reopen flicker (this is what makes it seamless).
- New pane `acct-pane-addrpicker` in the overlay template + `renderAddrPicker()` that populates it (header, saved-address cards, "+ nueva").
- `openCambiarPanel()` becomes: `openOverlay(); renderAddrPicker(); showPane('addrpicker');` — REMOVE the `showStage('s2')` jump and the `#acct-s2-summary` inline-chooser render.
- Saved-card tap → `selectSavedAddressForOrder(id)` (UNCHANGED one-off logic) → `closeSheet()`. The order's summary (s1 compact + s2 rich) is already re-rendered by `selectSavedAddressForOrder`/`refreshDeliveryUI`, so on sheet-close the checkout shows the new address at whatever stage the user was on.
- "+ Usar una dirección nueva" → `renderNewAddressPane({ mode:'order' })` + `showPane('newaddr')` (existing order-mode flow, UNCHANGED) → its confirm runs `confirmNewAddressForOrder(saveToAccount)` (UNCHANGED) → `closeSheet()` + applied. **Back** from the new-address pane returns to `showPane('addrpicker')` (not straight out), so the flow is reversible.
- Both the s1 Cambiar (`acct-change-btn-s1`) and s2 Cambiar (`acct-change-btn-s2`) call `openCambiarPanel` → the same picker. After apply, `closeSheet` returns to the current stage (the sheet overlays; no `showStage`), so a Cambiar from Pago returns to Pago, from Tus-datos returns to Tus-datos.

## Seamless / aesthetic bar (owner: "flows aesthetically and naturally… seamless; spotless")
- **Picker ↔ new-address = one sheet, pane transition** (`acct-pane-in`), never a close-then-reopen. The isolated map pane is already polished (black-balloon pin, hint-hides-on-placement, no giant pin, smooth blow-up — all shipped). Verify the picker→map→(save/one-off)→checkout chain has consistent, smooth transitions end to end, with NO orphaned scrim, double-sheet, or flash.
- **Picker visuals = the account-sheet language** exactly (the approved mockup): white/cream, accent-highlighted selected card + check, the same card radius/spacing as `renderAddressesSection`/`deliverCardHtml`, the same header/✕ treatment as other panes, the dashed "+ nueva" affordance. No cheap emoji; monochrome/line icons.
- **Open/close** uses the sheet's existing polished transition (slide + scrim fade, inert-on-close, keyboard-safe, reduced-motion-instant) — inherit it, don't reinvent.
- Selecting a card gives a brief highlight before the sheet closes (feels responsive, not abrupt).
- The current order address is pre-highlighted in the picker so the user sees what's active.

## Codex design-gate R1 REVISE — folded contracts (all accepted)

**(F1) The currently-active address card is a NO-OP (High).** The picker highlights the address currently backing the order (`_acctOrderAddr`/`_acctAddrId`). Tapping THAT card must NOT call `selectSavedAddressForOrder` — doing so sets `_acctAddrOneOff = true`, silently converting a default/saved-backed order into "use once" with no visible change. Tapping the active card simply **closes the sheet, no state change** (preserves the existing `_acctAddrOneOff`). Only tapping a DIFFERENT saved address runs `selectSavedAddressForOrder` (one-off apply) + close.

**(F2) New-address back-target contract by mode (High).** `renderNewAddressPane({mode})` currently: `mode:'order'` back → `backFromOrderNewAddress` (resets `_nad*` + `closeSheet()`); `mode:'account-save'` (Mi-Cuenta "+ Agregar") back → Mi Cuenta. Now that "+ nueva" is reached FROM the picker, its back must return to the PICKER, not close. Add an explicit return-target to the opts (e.g. `renderNewAddressPane({ mode:'order', returnTo:'addrpicker' })`); the back handler routes: `returnTo:'addrpicker'` → reset `_nad*` + `showPane('addrpicker')`; Mi-Cuenta "+ Agregar" keeps `returnTo:'account'` → `showPane('account')`. Never hardcode a single back target.

**(F3) Contextual close teardown for order-mode new-address (Medium).** The global topbar-✕ / scrim close (`closeSheet`) does NOT run the new-address teardown (bump `_acctFsEpoch`, reset `_nad*`, restore pane mode). Closing the sheet from the order-mode new-address pane (after opening the map) via ✕/scrim must run that teardown so no stale map/`_nad*`/mode state lingers into the next open. Route ✕/scrim close through a handler that, if the active pane is the order-mode new-address, performs the teardown before/at `closeSheet` — not only the polished sheet finalizer.

**(F4) Scrim-close must be ADDED (Medium).** There is currently NO `acct-overlay` scrim click handler (only topbar-✕, guest-close, OTP-back). The design promises scrim-dismiss, so add a scrim click handler on `.acct-overlay` guarded to the scrim target only (`e.target === overlay`, not clicks inside `.acct-sheet`), which closes with the SAME contextual teardown (F3). = cancel (no order change) from the picker; from newaddr, teardown + close.

## Non-negotiables
- **No money-path/logic change** — `selectSavedAddressForOrder` (one-off), `confirmNewAddressForOrder` (save/one-off + deterministic detected-authority), `_acctAddrOneOff`, `_acctOrderAddr`, `establishCheckoutFromAddress`, `processPayment`, the reduced-flow all UNCHANGED. This is a presentation/navigation change: WHERE the chooser lives (a sheet pane) and removing the stage jump.
- **index.html UNTOUCHED** — all in `account.js` (the sheet/panes are account-layer). `showStage` is only STOPPED being called from Cambiar; not modified.
- **Guest byte-identical** — the picker is marker-gated (reachable only from the reduced-flow Cambiar, which only exists for a logged-in complete profile). No new Firebase SDK on guest load.
- **Both forms identical past CONFIG.**
- **Do NOT overload "Mis direcciones"** — the picker is a SEPARATE focused pane with "use for this order" (one-off) semantics; the account-management "Mis direcciones" list (tap = set default, delete) stays as-is. Keeping them separate preserves the one-off safety (owner's "don't overcomplicate").

## Out of scope
Order history; passkeys; any change to "Mis direcciones" management; any logic in `selectSavedAddressForOrder`/`confirmNewAddressForOrder`.

## Gate focus (codex design-review)
1. Removing `showStage('s2')` + the `#acct-s2-summary` inline render from `openCambiarPanel`: does anything still depend on Cambiar being on s2 or rendering into that mount? After apply, does the checkout show the new address correctly at BOTH stages (Cambiar from s1 → s1; from s2 → s2)?
2. Pane flow correctness: picker → newaddr → back returns to the picker; ✕/scrim/back from the picker leaves the order UNCHANGED (nothing applied); saved-card tap applies one-off + closes; no orphaned pane/scrim/inert state (reuses the polished close finalizer + token guard from the last batch).
3. One-off/save semantics UNCHANGED (`selectSavedAddressForOrder` one-off; `confirmNewAddressForOrder` save/one-off; `_acctAddrOneOff`/`_acctOrderAddr` intact; toggle-survival preserved).
4. Seamless transitions: picker↔new-address is a pane transition within one sheet (no close/reopen); reduced-motion honored; no double-scrim/flash.
5. Guest byte-identical; both forms identical past CONFIG; index.html untouched; no money-path change.
