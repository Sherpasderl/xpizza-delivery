# HANDOFF → order-form executor session — 3 account/picker quick fixes

**What:** Three small visual fixes on the LIVE account/Cambiar UI (owner on-device feedback). All in `account.js`. No logic/money-path change. Branch `feat/account-quick-fixes` (off live `main` `e9708ba`). Both forms; mirror byte-identical past the ~20-line CONFIG. **index.html UNTOUCHED.**

These are mechanical bug fixes (no design decision) — advisor will codex-on-diff the build; no separate design-gate. Push and report the SHA when done.

---

## Fix 1 — Picker modal shows TWO ✕
**Root cause:** `renderAddrPicker` renders its OWN close button `#acct-picker-close` inside `.acct-picker-top`, AND the account sheet's global topbar already has `#acct-close` (×) shown for every pane. Result: two ✕ top-right.
**Fix:** In `renderAddrPicker`, REMOVE the picker's own ✕ button (`#acct-picker-close`) and its `onclick` wiring. Keep the "Elegí una dirección" title. Rely on the global topbar ✕ (`#acct-close`), which already routes to `dismissSheet` (contextual close) — same as every other pane. Verify: the picker now shows exactly ONE ✕ (the global topbar one), and it still closes/dismisses correctly (contextual teardown intact).
- Adjust `.acct-picker-top` styling if needed so the lone title reads well without the button (it no longer needs space-between with a button).

## Fix 2 — "Entregar a" sits too tight on the left of the "Tus datos" box
**Context:** In s1 "Tus datos" (`.section`, no horizontal padding), native fields get 16px via `.field-group{padding:14px 16px}` and `.section-head{padding:14px 16px}`. The reduced-flow "Entregar a" mount `#acct-deliver` has `padding-left:16px;padding-right:16px` (from the prior batch) — but the owner reports the "Entregar a" eyebrow/card still sits tighter-left than the native "Correo"/"Instrucciones" fields in the same box.
**Fix:** MEASURE, don't guess. Open the reduced flow (logged-in complete profile) and compare the computed left edge of the "Entregar a" eyebrow (and the card content) against a native field label (e.g. "Correo" / "Detalles"/"Instrucciones") in the same "Tus datos" `.section`. Adjust the `#acct-deliver` (and, if present, `#acct-s2-summary`) content inset so the "Entregar a" eyebrow + card align EXACTLY with the native field labels — same left edge, top to bottom. If the card (`.acct-compact`/`.acct-deliver`/`.acct-eyebrow`) has its own margin/inset causing the mismatch, fix at that level; the goal is pixel-aligned left edges between account-rendered content and native fields. Verify at 360/390/414px, on BOTH s1 (compact) and, if applicable, the s2 rich summary vs payment fields.
- Do NOT reintroduce double-padding; keep `:empty` mounts at zero (guest/pickup no phantom gap).

## Fix 3 — "Dirección actualizada…" toast flashes at the BOTTOM, owner wants it centered
**Root cause:** `.acct-toast{ position:fixed; left:50%; bottom:28px; transform:translateX(-50%) translateY(20px); … }` — anchored to the bottom.
**Fix:** Reposition the toast to the VERTICAL CENTER of the viewport: `top:50%; left:50%;` with the transform composing the centering + the show/hide offset, e.g. hidden `transform:translate(-50%,calc(-50% + 12px))` → shown `transform:translate(-50%,-50%)` (keep the opacity fade). The `.acct-show` state must land dead-center. Keep the existing fade timing and `z-index:1100`. Verify: "Dirección actualizada para este pedido" (and any other `toast()` call — they share `.acct-toast`) appears centered on screen, fades in/out smoothly, both forms.

---

## Guardrails (all fixes)
- `account.js` only; mirror byte-identical past CONFIG into `xpizza-orders/account.js` (Node compare → identical). **index.html UNTOUCHED** (`git diff --stat e9708ba..HEAD -- '*index.html'` empty).
- NO logic/money-path change — pure CSS/markup. `dismissSheet`/`selectSavedAddressForOrder`/`confirmNewAddressForOrder`/`toast()` behavior unchanged (Fix 3 only moves where the toast appears).
- Guest byte-identical (all three are account-layer, marker-gated; the toast reposition is a shared CSS rule but the toast only fires from account actions — confirm no guest-visible change). No cheap emoji.
- `prefers-reduced-motion` still honored where it already is.

## FILE COORDINATION
Advisor is NOT editing `account.js` — you are the SOLE editor on this branch. Advisor reads + runs codex-on-diff only. Push `feat/account-quick-fixes`, report the tip SHA. Do NOT deploy/merge/run codex. On APPROVED, owner deploys (Netlify CLI per-folder: xpizzaorders 6f09559f / lamusaorders f8bac377).
