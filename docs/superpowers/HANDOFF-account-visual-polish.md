# HANDOFF → order-form executor session

**What:** 7 visual/UX polish fixes to the LIVE account/Cambiar surfaces (owner on-device feedback). All in `account.js`. No money-path/logic change.

**Branch:** `feat/account-visual-polish` (tip = design docs, off live `main` `bfd8338`). Check it out fresh.

**Read (on the branch):**
- Spec (codex design-gate APPROVED R2): `docs/superpowers/specs/2026-07-26-account-visual-polish-design.md`
- Plan (8 tasks, exact functions/lines): `docs/superpowers/plans/2026-07-26-account-visual-polish.md`

**The 7 fixes:** (1) "+ Agregar" giant unsized pin → inject preview styles before render; (2) account map pin red teardrop → black balloon `#1E1B18` matching the original map (both brands); (3) "Toca para ajustar" hint → hide after a real placement (`_nadPinTouched`); (4) native `confirm()` (delete address + account) → on-brand `acctConfirm` modal; (5)+(7) account content misaligned → one mount-inset rule on `#acct-deliver`/`#acct-s2-summary` (no double-pad, empty mounts = zero space); (8) smooth enter/EXIT transitions for the sheet, panes, and fullscreen-map blow-up matching the original map.

**Hard rules:**
- Edit `la-musa-orders/account.js`; mirror byte-identical past the ~20-line CONFIG into `xpizza-orders/account.js`. **index.html UNTOUCHED** (`git diff --stat bfd8338..HEAD -- '*index.html'` empty).
- NO money-path/logic/coordinate change — visual only. The pin swap is display-only (still marks `_nadLat/_nadLng`); `_nadPinTouched`/`confirmNewAddressForOrder`/`processPayment`/reduced-flow all unchanged.
- Guest byte-identical. No cheap emoji. Both forms identical past CONFIG.

**The subtle ones codex will re-check on-diff:**
1. **#8 keyboard collision:** `.acct-sheet` already owns an inline `transform` for the keyboard lift — the open/close slide must NOT clobber it. Use CSS-var composition (`--acct-open-y` + `--acct-kb-y`) or a wrapper; the keyboard lift must still work on an open sheet.
2. **#8 focus/tab-order:** `pointer-events:none` leaves hidden overlay buttons TABBABLE — apply `inert`+`aria-hidden` on closed overlays/inactive panes at `transitionend`. **Move focus OUT before applying `inert`** (codex note) so focus isn't stranded in an inert subtree.
3. **#8 map resize:** the now-in-DOM fullscreen map must `google.maps.event.trigger(resize)`+recenter AFTER the open class applies.
4. **#4 re-entrancy:** `await acctConfirm`, singleton, one-shot settlement, disable confirm after first tap, z-1300; a Promise modal doesn't block double-taps like native confirm did.
5. **#5/#7:** ONE mount-inset rule, empty mounts add ZERO space (guest/pickup — no phantom gap).
6. `prefers-reduced-motion` → instant, everywhere.

**FILE COORDINATION:** advisor is NOT editing `account.js` — you are the SOLE editor on this branch. Advisor reads + runs codex gates only. Push the branch, report the tip SHA; advisor runs codex-on-diff, loops to APPROVED, owner deploys (Netlify CLI per-folder: xpizzaorders 6f09559f / lamusaorders f8bac377).

**Do NOT deploy/merge/run codex.**
