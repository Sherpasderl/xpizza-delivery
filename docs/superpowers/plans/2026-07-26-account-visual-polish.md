# Account / Cambiar Visual Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** 7 visual/UX fixes to the LIVE account/Cambiar surfaces (spec: `docs/superpowers/specs/2026-07-26-account-visual-polish-design.md`, codex design-gate APPROVED R2). All in `account.js`; **index.html UNTOUCHED**; no money-path/logic/coordinate change; guest byte-identical; both forms identical past CONFIG.

**Branch:** `feat/account-visual-polish` (off live `main` `bfd8338`). Edit `la-musa-orders/account.js`; mirror byte-identical past CONFIG into `xpizza-orders/account.js` (Task 8). Verify with a Node compare. Commit per task.

**Codex build note:** when closing the sheet/fullscreen map, move focus OUT before (or as part of) applying `inert`, so focus isn't left inside an inert subtree.

---

## Task 1: Fix the giant preview pin (inject styles before render)
**Files:** `la-musa-orders/account.js` — `renderAcctMapPreview` (~L1591), `renderNewAddressPane` (~L1639).
- [ ] **Step 1:** Add `injectAcctFsStyles();` as the FIRST line of `renderAcctMapPreview()` (covers both preview callers `acct-nad-preview` + `acct-cp-preview`). Also add it in `renderNewAddressPane()` (harmless, defensive). Idempotent via `_acctFsStylesDone`.
- [ ] **Step 2 (optional hardening):** give the injected `<style>` in `injectAcctFsStyles`/`injectNewAddrStyles` a stable `id` and early-return if it exists (belt-and-suspenders idempotency).
- [ ] **Step 3:** Verify — open "+ Agregar" from Mi Cuenta: the preview shows a proper small map with a correctly-sized (~30px) centered pin immediately, no giant pin.
- [ ] **Step 4: Commit** — `fix(acctpolish): inject map-preview styles before render (no more giant unsized pin)`

## Task 2: Account map pin → black balloon (both brands)
**Files:** `la-musa-orders/account.js` — `renderAcctMapPreview` pin SVG (~L1594), `ensureAcctFsOverlay` fullscreen pin SVG (~L1479).
- [ ] **Step 1:** Replace BOTH account pin SVGs (currently the teardrop `<path d="M12 2C8.1 2…"/>` `fill="${CONFIG.accent}"`) with a balloon matching the original checkout `gmarker` (index.html ~L2495): a `#1E1B18` filled circle on a short stick, white outline. Use the LITERAL `#1E1B18` (NOT `CONFIG.accent`) — same on both brands. Keep the existing drop-shadow filter + `.acct-fs-pindot` base shadow (adjust position to the balloon tip if needed). Keep sizing from `.acct-fs-pin` (30px).
- [ ] **Step 2:** Verify — the account preview + fullscreen map pin visually match the original checkout map pin, on BOTH X.Pizza and La Musa. Pin still marks `_nadLat/_nadLng` (visual-only change).
- [ ] **Step 3: Commit** — `fix(acctpolish): account map pin = black balloon matching the original map (both brands)`

## Task 3: Hide "Toca para ajustar" after a real placement
**Files:** `la-musa-orders/account.js` — `renderAcctMapPreview` hint (~L1595).
- [ ] **Step 1:** Gate the hint on `!_nadPinTouched` (NOT `placed`): before any real user placement show "Toca para marcar tu ubicación"; once `_nadPinTouched` is true (drag or Listo-commit via `commitAcctPin`), render NO hint span. (`closeAcctFullscreenMap(true)` already re-renders the preview after `commitAcctPin`, so the hint disappears on return.)
- [ ] **Step 2:** Verify — auto/GPS starting pin still shows the hint; after you drop/adjust the pin and tap Listo, the hint is gone (matches the original map).
- [ ] **Step 3: Commit** — `fix(acctpolish): hide map hint after a real user placement (_nadPinTouched)`

## Task 4: On-brand confirm modal replacing native confirm()
**Files:** `la-musa-orders/account.js` — new `acctConfirm`; call sites ~L573 (delete-account) + ~L1372 (delete-address); styles in the account style block.
- [ ] **Step 1:** Add `acctConfirm({ title, message, confirmLabel, destructive }) → Promise<boolean>`: builds a scrim + centered card (title, message, "Cancelar" + a confirm button; destructive → red confirm), appended to body at **z-1300** (above fullscreen map 1200 + toast 1100). Singleton — if one is already open, a second call resolves `false` (or reuses). On open: move focus to the Cancel button; remember the trigger to restore focus on close.
- [ ] **Step 2:** One-shot settlement: the confirm button (disable after first tap), the Cancel button, scrim-tap, and Escape all resolve the SAME promise EXACTLY once, then tear down the modal + restore focus to the trigger. No path double-fires.
- [ ] **Step 3:** Rewire both call sites: `if (!(await acctConfirm({ title:'¿Borrar esta dirección guardada?', confirmLabel:'Borrar', destructive:true }))) return;` (delete-address) and the delete-account equivalent ("Eliminar mi cuenta" / "Esto borra tu cuenta y tus datos. No se puede deshacer."). Disable the triggering delete control while the modal is open. Remove the `window.confirm(...)` calls.
- [ ] **Step 4:** Verify — delete-address and delete-account both show the on-brand modal; Cancel/scrim/Esc abort; confirm proceeds once; rapid double-tap can't double-delete; modal sits above every account surface.
- [ ] **Step 5: Commit** — `feat(acctpolish): on-brand acctConfirm modal replaces native confirm() (delete address + account)`

## Task 5: Align checkout "Creá tu perfil" + Task 7: Cambiar/summary inset — ONE mount-inset rule
**Files:** `la-musa-orders/account.js` — the account style block; verify against `#acct-deliver`/`#acct-s2-summary` render sites (`applyCreateProfileFlow`, `openCambiarPanel`, `renderS1CompactSummary`, `renderS2RichSummary`).
- [ ] **Step 1:** Add ONE account-scoped inset rule applying the native form field horizontal inset to the MOUNTS `#acct-deliver` and `#acct-s2-summary` (padding-left/right matching the s1/s2 native fields — inspect index.html for the exact inset, e.g. the `.container`/field padding). Do NOT add per-card/per-eyebrow padding (avoids double-pad against existing card margins).
- [ ] **Step 2:** Ensure EMPTY mounts add ZERO space — the inset rule must not create phantom vertical/horizontal space when `#acct-deliver`/`#acct-s2-summary` are empty (guest, pickup, non-reduced). Use padding only on non-empty content or a rule that collapses when empty (e.g. `:empty { padding:0 }` or apply inset to inner content wrappers that only exist when populated).
- [ ] **Step 3:** Verify — the "CREÁ TU PERFIL" card/eyebrow (img 5), the "Entregar a" summary, the compact line, and the "CAMBIAR DIRECCIÓN DE ENTREGA" chooser + "Usar una dirección nueva" (img 7) all align with the native Correo/Detalles/payment fields at 360/390/414px. Guest layout unchanged (empty mounts = no gap).
- [ ] **Step 4: Commit** — `fix(acctpolish): single mount-inset so account content aligns with native fields (Creá-tu-perfil + Cambiar)`

## Task 6: Smooth transitions — fullscreen map
**Files:** `la-musa-orders/account.js` — `.acct-fs-overlay` styles (~L1447) + `openAcctFullscreenMap`/`closeAcctFullscreenMap`.
- [ ] **Step 1:** Change `.acct-fs-overlay` from `display:none↔flex` to the original pattern: always in DOM (or `display:flex` always), `transform: translateY(100%)` closed → `translateY(0)` open, `transition: transform .35s cubic-bezier(0.32,0.72,0,1)`, `pointer-events:none↔all`. Open/close toggle a class instead of `display`.
- [ ] **Step 2:** On open, AFTER the open class is applied (rAF or `transitionstart`), call `google.maps.event.trigger(_acctFsMap,'resize')` + recenter to the current `_nad*`/center — the cached map in a transformed container can misrender.
- [ ] **Step 3:** Focus/inert — on close, move focus out then apply `inert` + `aria-hidden="true"` (+ `visibility:hidden` fallback) at `transitionend`; clear them on open. `pointer-events:none` alone leaves buttons tabbable.
- [ ] **Step 4:** `@media (prefers-reduced-motion: reduce)` → no transition (instant).
- [ ] **Step 5:** Verify — the blow-up slides up on open and down on close (like the checkout map); tiles/center correct after open; nothing tabbable/tap-capturing while closed.
- [ ] **Step 6: Commit** — `feat(acctpolish): smooth slide transition + resize/inert for the account fullscreen map`

## Task 7: Smooth transitions — account sheet + panes (no keyboard collision)
**Files:** `la-musa-orders/account.js` — `.acct-overlay`/`.acct-sheet` styles (~L94-99), `openOverlay`/`closeSheet` (~L235/239), `applyKeyboardInset` (~L254), `showPane`.
- [ ] **Step 1: Keyboard-collision-safe slide.** `.acct-sheet` owns an inline `transform` for the keyboard lift. Do NOT clobber it. Implement composition: `applyKeyboardInset` sets a CSS var `--acct-kb-y` (e.g. `sheet.style.setProperty('--acct-kb-y', '-'+covered+'px')`) instead of `style.transform`; open/close sets `--acct-open-y` (0 open / 100% closed via a class); `.acct-sheet { transform: translateY(calc(var(--acct-open-y,0px) + var(--acct-kb-y,0px))); transition: transform .3s cubic-bezier(.2,.7,.2,1) }`. (Alternatively animate a wrapper for open/close and leave `.acct-sheet` transform for keyboard — pick one; the CSS-var route is cleaner.) The keyboard lift must still work on an open sheet.
- [ ] **Step 2:** `closeSheet` plays the exit (slide down + scrim fade) THEN sets the closed state; scrim (`.acct-overlay` bg) fades in/out. Move focus out, then apply `inert`+`aria-hidden` on the closed `.acct-overlay` at `transitionend`; clear on open.
- [ ] **Step 3:** `showPane` — short (~.2s) cross-fade/slide between panes; inactive rendered panes are `inert`/not focusable.
- [ ] **Step 4:** `@media (prefers-reduced-motion: reduce)` → instant.
- [ ] **Step 5:** Verify — sheet slides up on open, down on close; focusing an input still lifts the sheet above the keyboard; no tabbable hidden controls; pane switches smooth; reduced-motion instant.
- [ ] **Step 6: Commit** — `feat(acctpolish): smooth sheet open/close + pane transitions (keyboard-safe, inert on close)`

## Task 8: Mirror to X. Pizza + guest-safety + self-review
- [ ] **Step 1:** Port Tasks 1–7 into `xpizza-orders/account.js` below CONFIG; Node-compare → identical past CONFIG (pin is literal `#1E1B18`, same both).
- [ ] **Step 2:** Guest-safety (both forms, agent-browser at `~/.npm-global/bin`): guest load — no account Firebase SDK, guest chip/flow unchanged, NO phantom gap from the mount-inset rule (empty mounts), `index.html` untouched (`git diff --stat bfd8338..HEAD -- '*index.html'` empty).
- [ ] **Step 3:** Self-review — no money-path/logic/coordinate change (grep: no new writes to lat/lng/gmap/_nad*/processPayment beyond the visual pin swap which doesn't change values); reduced-motion honored; both forms parity.
- [ ] **Step 4:** Push `feat/account-visual-polish`, report the tip SHA for codex-on-diff. No deploy/merge.

---

## Self-Review (author, pre-handoff)
- **Spec coverage:** giant pin (T1), pin color (T2), hint (T3), confirm modal (T4), inset alignment (T5), fullscreen-map transition (T6), sheet/pane transitions (T7), mirror+guest (T8). All 7 items + all R1 findings.
- **Watch:** T7 Step 1 (keyboard-transform composition) is the subtle one — the sheet's inline keyboard transform must not fight the open/close; use the CSS-var composition and verify the keyboard lift on an open sheet. T4 one-shot settlement. T5 empty-mount-zero-space (guest).
- **Placeholder scan:** none.
