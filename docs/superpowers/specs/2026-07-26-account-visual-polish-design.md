# Account / Cambiar Visual Polish — Design Spec

**Date:** 2026-07-26 · Advisor-designed from on-device owner feedback (WhatsApp img 1–7 + transitions) on the LIVE account/Cambiar features. Branch `feat/account-visual-polish` (off live `main` `bfd8338`). **Both forms** (`account.js` byte-identical past the ~20-line CONFIG block; `index.html` UNTOUCHED — all fixes are in the account layer). Deploy: Netlify CLI per-folder. codex design-gate HERE → order-form executor session builds → codex-on-diff HERE → owner deploys.

## Goal
Seven visual/UX defects on the shipped account + Cambiar surfaces. All cosmetic/UX (no money-path logic change): a broken preview-map render, a wrong pin, a stuck hint, two off-brand native dialogs, two alignment issues, and missing smooth transitions. Guest byte-identical; no `index.html` change; no logic/coordinate change.

## The items

### 1. "+ Agregar" preview shows a giant unsized pin instead of a map (BUG)
`renderNewAddressPane()` (~L1639) calls `injectNewAddrStyles()` but NOT `injectAcctFsStyles()`, which is where `.acct-map-preview` and `.acct-fs-pin{width:30px;height:30px;...}` are defined (~L1457–1462). `renderAcctMapPreview()` (~L1591) also doesn't inject them. So on first render (before any fullscreen open runs `injectAcctFsStyles` via `ensureAcctFsOverlay`), the preview pin `<svg class="acct-fs-pin">` has NO width/height → an inline viewBox SVG defaults to filling the container width → the giant pin in img 1. (The order-mode confirm pane at ~L1739 already injects `injectAcctFsStyles`, which is why it's fine there.)
**Fix:** call `injectAcctFsStyles()` at the top of `renderNewAddressPane()` AND `renderAcctMapPreview()` (idempotent) so `.acct-map-preview`/`.acct-fs-pin` are styled from the first paint. Verify the preview shows a proper small map + correctly-sized centered pin immediately on "+ Agregar".

### 2. Account map pin ≠ the original map's pin
The account preview + fullscreen pins are an accent-colored **teardrop** (`fill="${CONFIG.accent}"`, the `<path d="M12 2C8.1 2…"/>` + inner white circle — img 2/3, red on La Musa). The original checkout map (index.html `gmarker`, ~L2495) is a **black balloon**: a `#1E1B18` filled circle on a short stick, white stroke — brand-neutral on BOTH forms.
**Fix:** replace the account map pin SVG (in `renderAcctMapPreview` ~L1594 AND the fullscreen overlay `ensureAcctFsOverlay` ~L1479) with a balloon matching the original's shape + color (`#1E1B18` circle + stick, white outline) — **the same on both brands** (owner: "the same pin we use on our original map"). Keep the drop-shadow. The `.acct-fs-pindot` shadow ellipse can stay or adapt to the balloon's base. Do NOT tie this pin to `CONFIG.accent`.

### 3. "Toca para ajustar" hint never disappears after placement
`renderAcctMapPreview` (~L1595) always renders the hint (`placed ? 'Toca para ajustar' : 'Toca para marcar tu ubicación'`), where `placed = typeof _nadLat === 'number'` — true even for the auto/GPS starting pin. So after the user drops a pin (img 3) the hint persists. The original map hides its "Toca para ajustar tu ubicación" hint after a real placement (index.html `closeFullscreenMap` sets `#map-tap-hint` `display:none`).
**Fix:** show the hint ONLY until a real USER placement — gate on `!_nadPinTouched` (not `placed`). Before any user placement: "Toca para marcar tu ubicación". After `_nadPinTouched` (drag/Listo-commit): NO hint. `closeAcctFullscreenMap(commit)` already re-renders the preview on return — ensure that re-render reflects `_nadPinTouched` so the hint is gone after Listo.

### 4. Native `confirm()` dialogs are off-brand
Two `window.confirm()` calls — delete-address (~L1372, "¿Borrar esta dirección guardada?", img 4) and delete-account (~L573, "Esto borra tu cuenta…"). Both render the iOS system dialog — jarring and off-brand (violates the no-cheap-chrome design bar). Both callers are ALREADY `async`.
**Fix:** replace BOTH with a reusable `acctConfirm({ title, message, confirmLabel, destructive })` → `Promise<boolean>`, styled like the account sheet (scrim + centered card, title + message, neutral "Cancelar" + destructive-styled confirm). Call sites use `if (!(await acctConfirm(...))) return;`.
- **Re-entrancy (codex R1 #3 — native confirm blocks double-taps, a Promise modal does NOT):** singleton — only one modal instance at a time (a second call while one is open either rejects→false or reuses). Disable the confirm button after the first tap. Cancel / scrim-tap / Escape resolve `false` EXACTLY once; the confirm resolves `true` exactly once; the promise settles once and the modal tears down. The triggering delete control should also be disabled while the modal is open. Verify the deletion cannot proceed before the promise resolves and cannot double-fire.
- **z-index (codex R1 #4 — the account fullscreen map is z-1200, toast z-1100):** put the confirm modal at **z-1300** (above the fullscreen map AND toast) so it's never occluded regardless of which surface is open. Focus moves into the modal on open (focus the safe/cancel action), returns to the trigger on close; scrim + Escape = cancel.
- No cheap emoji; typographic buttons + existing design tokens.

### 5. Checkout "Creá tu perfil" is misaligned (img 5)
The inline create-profile surface in s1 ("Tus datos" → "CREÁ TU PERFIL") — the phone-verified + Nombre/Apellido card, its eyebrow, and the native fields below (Correo/factura/Instrucciones) don't share a consistent horizontal inset; the card reads inset-inconsistent/"messy".
**Fix:** harmonize the account-rendered create-profile block's insets with the surrounding native "Tus datos" fields — the eyebrow, the phone/name card, and the section dividers should align to the same left/right inset as Correo/Instrucciones. Purely CSS/structure in the account-injected styles; no field/logic change. Verify at 360/390/414px.

### 7. "Cambiar dirección de entrega" + "Usar una dirección nueva" flush-left (img 7)
`openCambiarPanel` renders the chooser (eyebrow "CAMBIAR DIRECCIÓN DE ENTREGA", the saved-address card, "+ Usar una dirección nueva", "‹ Cancelar") into `#acct-s2-summary`, which lacks the form's container horizontal padding → the eyebrow + link sit flush at the screen edge while the native s2 fields are inset (~16px). Same root for the s1/s2 summary mounts (`renderS1CompactSummary`/`renderS2RichSummary`).
**Fix (codex R1 #8 — single rule, no double-pad):** apply the form's horizontal inset via ONE account-scoped rule on the MOUNT elements (`#acct-deliver`, `#acct-s2-summary`) — NOT per-card/per-eyebrow padding (which would double-pad against existing card margins). Match the native field inset exactly. **Empty mounts must add ZERO space** (no padding/margin/min-height) so a guest or a non-reduced state shows no phantom gap — verify `#acct-deliver`/`#acct-s2-summary` when empty. Verify the "Entregar a" summary, compact line, and Cambiar chooser all align with Correo/Detalles/payment, and that #5's create-profile block uses the same single inset (don't introduce a competing one).

### 8. Smooth transitions (open/close sheet, Cambiar, map blow-up)
The original map blow-up uses `transform: translateY(100%) → translateY(0)` with `transition: transform .35s cubic-bezier(0.32,0.72,0,1)` + `pointer-events` toggle — it stays in the DOM and animates BOTH open and close (index.html `.map-fullscreen-overlay`). The account surfaces are abrupt: the account **sheet** (`.acct-overlay`/`.acct-sheet`) has an entrance `@keyframes acct-up` but the close just removes `.acct-open` → `display:none` (no exit animation); the account **fullscreen map** (`.acct-fs-overlay`) toggles `display:none↔flex` (abrupt both ways); pane switches (`showPane`) are instant.
**Fix:** bring the account surfaces to the original's feel, WITH these hard requirements (codex R1 #1/#2/#5):

- **Account fullscreen map** (`.acct-fs-overlay`): switch from `display:none↔flex` to the original's pattern — stays in DOM, `transform: translateY(100%)→translateY(0)` + `transition: transform .35s cubic-bezier(0.32,0.72,0,1)` + `pointer-events:none↔all`. **On open, trigger `google.maps.event.trigger(_acctFsMap,'resize')` + recenter AFTER the open class is applied** (rAF/transitionstart) — the map instance is cached and a transformed/previously-offscreen container can misrender tiles/center on mobile/orientation/address-bar changes (codex R1 #5). **Focus/tab-order:** when closed, the overlay must be removed from the a11y/focus tree — `pointer-events:none` alone does NOT (its buttons stay tabbable) — so apply `inert` + `aria-hidden="true"` (with a `visibility:hidden` fallback) at the END of the close transition (`transitionend`), and clear them on open (codex R1 #2).

- **Account sheet** (`.acct-overlay`/`.acct-sheet`): add a smooth EXIT, not just the entrance. **Keyboard-collision (codex R1 #1 — critical):** `.acct-sheet` ALREADY owns an inline `transform` for the keyboard lift (`applyKeyboardInset` sets `sheet.style.transform=translateY(-covered)`). The open/close slide must NOT clobber that. Implement one of: (a) run the open/close slide on a WRAPPER element (or the `.acct-overlay`), leaving `.acct-sheet.transform` for the keyboard only; OR (b) compose BOTH into one transform via CSS custom properties — `applyKeyboardInset` sets `--acct-kb-y` (not `style.transform`), the open/close sets `--acct-open-y`, and `.acct-sheet { transform: translateY(calc(var(--acct-open-y,0px) + var(--acct-kb-y,0px))) }`. Pick one and specify it; the keyboard lift must still work during an open sheet. Scrim (`.acct-overlay` background) fades in/out. Same `inert`/`aria-hidden` on the closed overlay (codex R1 #2).

- **Pane switches** (`showPane`) + the Cambiar chooser appear/dismiss: a short (~.2s) cross-fade/slide consistent with the above. Inactive panes that remain rendered must be `inert`/not focusable (codex R1 #2).

- **`prefers-reduced-motion: reduce`** → no transitions/animations (instant show/hide), for all of the above. No layout jank; nothing left capturing taps after close.

## Non-negotiables
- **index.html UNTOUCHED** — all fixes in `account.js`. (Reference the original map's transition values, but implement the account equivalents in account.js's injected styles.)
- **No money-path/logic/coordinate change** — this is visual only; `_nad*` sink, `confirmNewAddressForOrder`, `establishCheckoutFromAddress`, `processPayment`, the reduced-flow logic, `_acctAddrOneOff`/`_acctOrderAddr` all unchanged. The pin SVG swap and hint gating change appearance only (the pin still marks `_nadLat/_nadLng`; `_nadPinTouched` semantics unchanged).
- **Guest byte-identical** — the account layer is marker-gated; guests run none of this. The confirm-modal + transition CSS are account-scoped. No new Firebase SDK on guest load.
- **Both forms identical past CONFIG**; the pin color is a literal `#1E1B18` (NOT `CONFIG.accent`) — same on both.
- **No cheap emoji** (reuse ICON_*/SVG); the confirm modal uses typographic buttons + the existing design tokens.

## Codex design-gate: R1 REVISE (findings folded) → this revision
#1/#2/#3 confirmed sound (idempotent style-inject covers both preview callers; pin swap visual-only; hint gated on `_nadPinTouched`). Folded: #4 = `await acctConfirm` + singleton/one-shot re-entrancy + button-disable + **z-1300** + focus return; #5/#7 = ONE mount-inset rule (no per-card double-pad) + empty mounts add zero space; #8 = keyboard-transform composition (CSS vars or wrapper — never clobber the inline keyboard lift), `inert`+`aria-hidden` on closed overlays/inactive panes (pointer-events alone leaves them tabbable), google.maps resize+recenter on fullscreen-map open, `prefers-reduced-motion` honored. Optional hardening: give the injected `<style>` blocks an id for cross-reload idempotency.

## Out of scope
Any logic/flow change to Cambiar/create-profile/reduced-flow; order history; passkeys. `index.html`.

## Gate focus (codex design-review)
1. #1: injecting `injectAcctFsStyles` in `renderNewAddressPane`/`renderAcctMapPreview` fully fixes the giant pin (styles present before first paint), idempotent, no double-inject side effect.
2. #2/#3: the pin swap is display-only (still marks `_nadLat/_nadLng`); the hint gating on `_nadPinTouched` matches the original's hide-after-placement and doesn't hide it prematurely (auto/GPS pin still shows the hint).
3. #4: the custom confirm modal is a correct Promise-based replacement for BOTH `confirm()` sites (delete-address + delete-account) with no double-fire / focus-trap / z-index issue, and cancel is the safe default (scrim/esc = cancel).
4. #5/#7: the inset alignment doesn't break guest layout or the native fields; account-scoped only.
5. #8: transitions animate open AND close without breaking show/hide logic, keyboard-inset, or leaving an interactive overlay after close (pointer-events); `prefers-reduced-motion` honored.
6. Guest byte-identical; both forms identical past CONFIG; index.html untouched; zero money-path/logic change.
