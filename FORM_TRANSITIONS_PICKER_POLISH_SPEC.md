# Order-form transitions + picker polish — BUILD SPEC (executor)

Display-only. Both `account.js` **byte-identical past CONFIG** (keep parity 4/4). Branch from `main` (7a37f8b — already
has the golden-ticket + order-summary 16px inset). Build → **Netlify draft both forms** → owner **on-device eyeball**
→ advisor gate → `git push origin main` (forms git-CD, **no functions**).

## OWNER RULE (firm)
**Add smooth transitions ONLY where an element currently SNAPS. Do NOT touch or re-time anything already smooth**
(no "more smoothness"). Every added transition must respect `@media (prefers-reduced-motion:reduce)` → instant.
Line refs below are `xpizza-orders/index.html` (IH) / `account.js` (AJ); mirror into la-musa identically.

## SCOPE (owner-locked 2026-07-31): **TIER 1 transition fixes ONLY** + picker header + text bump.
Build Section A **Tier 1** (items 1–8), Section B (picker header ✕/title/points), Section C (text bump). **Tier 2 and
Tier 3 are DEFERRED** — do not build them this pass (owner may pull them in later). Everything in "LEAVE UNTOUCHED" stays untouched.

## A. Transition fixes — the SNAP inventory (from the full audit)

### Tier 1 — high-visibility (do these)
1. **Stage navigation — the headline snap.** `showStage()` (IH:2103) toggles `.stage{display:none}↔.active{display:block}`
   (IH:118); every step boundary flows through it (into paso 2, → "Enviando" s4, → "Pedido recibido" s5, payment-fallback).
   Fix: cross-fade — fade-out current → `scrollTo(0,0)` → fade-in incoming via rAF + an `.active` opacity/`translateY`
   class (position stages during the swap so they don't reflow). Match the modal easing `cubic-bezier(.32,.72,0,1)`.
2. **Programar (schedule) sheet** (IH:1008-1010) — `.sched-modal.open` appears with NO transform transition (hard pop).
   Fix: `.sched-sheet{transform:translateY(100%);transition:transform .3s}` + `.sched-modal.open .sched-sheet{transform:none}`,
   fade the backdrop opacity. **A fully-styled unused `.schedule-sheet`/`.schedule-overlay` already exists at IH:930-940 —
   copy that pattern.**
3. **Cash-change panel** (IH:2387) + **PixelPay panel** (IH:2383) reveals on payment-method select — `display` toggle.
   Fix: `max-height:0;opacity:0;overflow:hidden;transition:max-height .25s,opacity .2s` + `.open` class.
4. **Delivery ↔ Pickup content swap** (map/zone/loc/address ⇄ pickup-info; `setOrderType` IH:3494-3506) — `display` cut.
   Fix: cross-fade the two panels (opacity/height). (The toggle buttons themselves are already smooth — leave.)
5. **Error boxes** — out-of-zone (IH:2482), address-details (IH:2494), card-error, rtn-error, err1/err3 — all `display`
   toggles (`.error-box{display:none}` IH:660). Fix: `max-height`+`opacity` reveal + `.open` class.
6. **Category tab content** (12" ↔ NY, `.menu-section` IH:144) — `display` toggle (the tab underline is already smooth).
   Fix: `opacity` fade on `.menu-section`.
7. **DEAD scrim fades (easy wins)** — `.detail-overlay` (IH:309-314) and `.cart-overlay` (IH:878-879) declare an opacity
   transition that never fires because `display:none↔block` flips at opacity 1. Fix: start `opacity:0`, set `display:block`
   first, rAF-add `.open{opacity:1}`; on close remove `.open`, drop `display` on `transitionend`. (Their paired sheets are
   already smooth — only the scrim needs this.)
8. **Redeem picker CLOSE** — `rkCloseSheet()`→`rkUnmountSheet()` sets `innerHTML=''` (AJ:399), instant vanish. OPEN is
   already smooth (`rk-slideup`) — **leave open alone**. Fix close: add a `.rk-closing` exit (reverse slide-down + fade),
   remove the node on `animationend`.

### Tier 2 — secondary (do if quick)
Country-code dropdown (`.cc-menu` IH:627), sold-out overlay (`.pizza-card.sold-out` IH:1054 — add `transition:filter,opacity`),
sticky cart-bar show/hide (IH:535 — fade/scale, not `display`), deliver-card appearance (AJ:1932), pickup gate/note (IH:1187),
time-select "elegí un horario" note (IH:1199).

### Tier 3 — micro (owner's call, optional)
Qty controls (IH:224), card "✓ Extras" indicator (IH:1682), loc-card "confirmada" (IH:802 — add `transition:background,border-color`),
map "toca para ajustar" hint, Cambiar acard background (AJ:1971 — add `background` to the existing transition list).

### LEAVE UNTOUCHED (already smooth — do NOT retune)
Detail-modal panel + swipe, detail-CTA morph, cart-review sheet, fullscreen map(s), success receipt collapsible, pay-card
select, delivery/pickup toggle buttons, address-details red border, below-min blur, header chip collapse, **account overlay +
all pane swaps (Mis premios / Mis pedidos / Cambiar / create-profile)**, **redeem picker OPEN + in-place row dim/qty-bump/toast**,
on-brand confirm modal, account fullscreen map, account toast, label chips, spinner.

## B. Picker header restructure (both `rkSheetHtml` branches, AJ:410 punch / AJ:412 points)
Layout: **✕ top-left · title centered · points right** (X. Pizza same, with a spacer opposite the ✕ so the title stays
centered; X. Pizza has no balance). The ✕ = small round button carrying `data-rk-dismiss="1"`. **Change the close wiring
AJ:404** from `root.querySelector('[data-rk-dismiss]')…` to `querySelectorAll('[data-rk-dismiss]').forEach(el => el.addEventListener('click', () => rkCloseSheet(env)))`
so both the scrim and the ✕ dismiss. Center `.rk-shk`+`.rk-sht`(+ X. Pizza `.rk-shsub`); keep the grab centered on top;
La Musa balance stays top-right. Keep tap-outside + Listo working.

## C. Text bump (both `account.js`, byte-identical, tune on device)
`.rk-tk-h` 16→18 · `.rk-rnm` 13.5→15 · `.rk-rcost` 14→15 · `.rk-sht` 17→18 · `.rk-qn` 17→18 · `.rk-sec` 11.5→12.5.
(~1–2px "up a notch" — nudge on-device if any feels off.)

## Flow
One branch for A+B+C → **Netlify draft both forms** → owner on-device eyeball (the pago glide, the picker header/✕/text,
every added transition) → advisor display gate → owner `git push origin main` (forms git-CD, no functions). Redemption
stays gated OFF throughout.
