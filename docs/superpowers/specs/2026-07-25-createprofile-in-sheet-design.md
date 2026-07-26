# Creá tu perfil in the login sheet + account-scoped fullscreen map — Design Spec

**Date:** 2026-07-25 · Advisor-designed follow-on to the shipped Logged-in Profile-First UX batch (live on both forms @ `0febe4f`).
**Branch:** `feat/createprofile-in-sheet` (off local `main`/live `0febe4f`; origin/main is a stale FF-behind backup — do not branch off it).
**Both forms** (`xpizza-orders` + `la-musa-orders`; account.js byte-identical past the 16-line CONFIG block). Deploy: Netlify CLI per-folder.
**Codex design-gate:** R1 REVISE (8 findings, all accepted) → this revision. C3 (twin over shared-component) codex-endorsed. Findings folded into A1 (tri-state read), A4 (throwing name write + re-confirm), C2 (symbol firewall, user-only `_nadPinTouched`, epoch/teardown, z-stack/restore, mid-checkout, account.js-only lazy DOM).
**Owner-approved decisions (this session):** (a) after OTP verify, a first-time/incomplete user lands on a full **Creá tu perfil** inside the login sheet, not the old `¿Cómo te llamás?` capture; (b) no-skip is **field-level + dismissible** — can't SAVE partial, but can `‹` out to browse (checkout stays the hard block); (c) the account map must behave **exactly like the checkout map** (tap-to-blow-out fullscreen, center-fixed pin, satellite toggle) — replacing the fiddly inline `_nad*` marker map, for BOTH this screen and the existing "+ Agregar".

## Goal
A first-time customer who logs in from the menu is offered profile creation immediately (name + address), reusing the checkout map's superior fullscreen center-pin UX — so their very next order is `cart → pay`. Nothing is forced (they can browse), guest is byte-identical, and the account map NEVER writes the checkout's live delivery pin.

## Part A — Creá tu perfil in the login sheet (post-OTP)

### A1. Trigger (robust, completeness-driven — not `is_new`) — TRI-STATE read (codex R1 #1)
Today `verifyCode()` (account.js ~L425) routes on `if (data.is_new || !data.name) showPane('name')`. Replace with a completeness branch that runs AFTER `signInWithCustomToken` + marker persist. **The read must be a TRI-STATE, not a bare `accountSnapshot()`** — the raw helper collapses "no profile node", timeout, SDK error, and dead session all into `null`, so a slow/failed read would be misread as "incomplete → show create." Wrap it:
- A timeboxed reader returning `{ status: 'ok', snap }` on a resolved read (snap may be null/partial = a genuine profile state), or `{ status: 'unavailable' }` on timeout/reject/SDK-error. (A `Promise.race` against a ~1.5s timer, catch→`unavailable`.)
- **`status:'ok'` AND `profileComplete(snap)` true** → `renderChip()` + `closeSheet()` + re-run the mid-session hooks exactly as the current else-branch does (`wrapPageHooks(); initDeliveryStep()`). Unchanged for returning complete users.
- **`status:'ok'` AND `profileComplete(snap)` false** → show the new **Creá tu perfil** pane (Part A2), pre-filling name if present (only the address section empty). Any partial saved address is NOT auto-loaded — creation always requires a fresh valid address save.
- **`status:'unavailable'`** (timeout/error — CANNOT confirm completeness) → **fail-open to Mi Cuenta** (`renderAccountPane(); showPane('account')`) — NEVER the create pane, never a block, never a spinner-wedge. Complete-before-pay is still enforced at checkout (unchanged). Showing create is reserved for a POSITIVELY-confirmed incomplete read only.

`profileComplete` = the EXISTING predicate (name `split(/\s+/).filter(Boolean).length>=2` AND `pickDefaultAddress` valid). Reuse verbatim — do not re-derive.

### A2. The pane (`acct-pane-createprofile`, new)
A new overlay pane, structurally the Nueva-dirección pane (Part C map) **plus** an identity section on top:
- **Phone**: read-only, shown as `+504 <number> · verificado` (from `_loginPhone`/marker). Never an input; never written to `user_profiles/phone`.
- **Nombre** + **Apellido**: two required inputs (the profile `name = "${nombre} ${apellido}".trim()`). Height/radius = the corrected tall login input (matches the R-batch name-box fix).
- **Address**: the account-scoped fullscreen map (Part C) — preview → blow-out, center pin — + **Referencia** + **Guardar como** label chips (Casa/Trabajo/Otra+custom).
- CTA: **Guardar perfil** (disabled until all valid; see A3).
- **Dismiss**: a `‹` back / sheet-close returns to Mi Cuenta (`renderAccountPane(); showPane('account')`) or closes the sheet — the user may leave without finishing. Nothing persisted on dismiss.

### A3. No-skip (field-level, submit-time re-validated)
The **Guardar perfil CTA is disabled** until ALL valid: `nombre` non-empty, `apellido` non-empty, a **user-placed** pin (`_nadPinTouched` true + numeric `_nadLat/_nadLng` + non-empty `_nadDetected`), `referencia.trim().length>=3`, a label chosen (or non-empty custom for Otra). The save handler MUST **re-validate ALL of these inside the handler** before any write (covers Enter/autofill/double-click/programmatic) — the same submit-time-revalidation discipline codex required for the checkout Creá tu perfil.

### A4. Save (own throwing name write; re-confirm before declaring success) — codex R1 #2, #7
On valid submit, do NOT call `saveName()` (it swallows write failures and returns nothing → an address-only partial with false success, codex R1 #2). Follow the CHECKOUT create pattern (account.js ~L1637): a local **throwing** name write, checked, before the address save.
1. **Name (throwing):** `await dbMod.update(ref(db,'user_profiles/'+uid), { name })` (≤80, name = `"${nombre} ${apellido}".trim()`). If it THROWS → stop, inline error ("No pudimos guardar tu nombre, intentá de nuevo"), CTA re-enabled, nothing else runs. On success, update marker.name.
2. **Address:** `saveAddress({ label, detected:_nadDetected, details, lat:_nadLat, lng:_nadLng, makeDefault: true })` (the hardened writer — REJECTS empty label / details<3 / empty detected / non-numeric lat-lng). `!res.ok` → inline error, CTA re-enabled, stay on pane.
3. **Re-confirm before success (codex R1 #7):** after BOTH writes, re-run the A1 tri-state reader. Only on `status:'ok'` AND `profileComplete(snap)` true → `renderChip()`, "Perfil creado" toast, close pane to Mi Cuenta/menu, `wrapPageHooks(); initDeliveryStep()`. If the re-confirm is `unavailable` OR still-incomplete → do NOT show "Perfil creado"; fail-open to Mi Cuenta (the writes persisted; checkout re-enforces). `saveAddress ok` + a local name write does NOT by itself prove the live predicate (server rules/transforms) — the re-read does.

**Partial-write safety (no corruption):** name-throw-abort (no address written) or address-fail (name written, address not) both read as **still-incomplete** via `profileComplete` → safely re-prompted (here or at checkout). Neither partial produces a false "complete"; the step-removal decision keys off the re-confirmed live predicate, never an optimistic local assumption.

### A5. Coexistence with the checkout Creá tu perfil (unchanged)
The checkout-step Creá tu perfil (`applyCreateProfileFlow`, `_acctCreateProfileActive`, `placeAccountPin`, checkout `gmap`) stays exactly as gated/shipped — it remains the **hard block** for anyone still incomplete at pay. The two surfaces share only the predicate + `saveAddress` + name-write; they never touch each other's map state (login-sheet uses `_nad*`/account fullscreen twin; checkout uses `gmap`/`lat`/`lng`/`placeAccountPin`).

## Part B — Guest & regression invariants (unchanged, restated)
- **Guest byte-identical** — guests never verify an OTP, so Part A is unreachable for them; zero new code on the guest path, zero Firebase SDK on load. Part C touches ONLY the account-sheet map (behind the overlay), never the guest/checkout `#map`/`openFullscreenMap`/`fsMap` DOM or handlers.
- **Checkout money-path untouched** — no edit to `openFullscreenMap`/`closeFullscreenMap`/`fsMap`/`gmap`/`gmarker`/`lat`/`lng`/`__restorePos`/`processPayment`. Part C is a parallel twin, not a refactor of the live map.
- **Phone immutable**; **reuse gated writes** (no new rules — `name` via update, addresses via existing `saveAddress`/rules); **no cheap emoji** (monochrome line icons, existing ICON_* set).

## Part C — Account-scoped fullscreen map twin (replaces inline `_nad*` marker map)
The current "+ Agregar" map (`initNewAddrMap`/`placeNewAddrPin`, an inline 168px **draggable-marker** map) is replaced by an **account-scoped twin of the checkout fullscreen map** — matching the checkout UX the owner prefers, while keeping isolated state.

### C1. Checkout map behavior to replicate (from index.html)
- Small preview (`<div onclick=…><div id=map …pointer-events:none></div> + "Toca para ajustar" hint>`) → tap opens a **fullscreen overlay** (`.map-fullscreen-overlay`, `#map-fullscreen`, `fsMap`).
- **Center-fixed pin**: no draggable marker — the pin is CSS-centered; the user drags the MAP; `center_changed`→reverse-geocode, `dragend`→commit lat/lng.
- Satellite/roadmap toggle; big zoom; **Listo ✓** closes and commits center→lat/lng + reverse-geocode.

### C2. The twin (account-scoped, isolated)
- **Lives ENTIRELY in `account.js`, lazily built (codex R1 #8).** The overlay DOM + its `<style>` are injected by account.js at account-overlay build time (same lazy, marker-gated pattern as the account sheet itself) — **ZERO new map DOM in `index.html`, no new global functions, no guest-visible style/layout change.** (The checkout fullscreen overlay is permanent `index.html` DOM at ~L4088; the twin must NOT mirror that placement.) This is what makes guest byte-identical true, not just asserted.
- A **separate overlay DOM** (`#acct-map-fullscreen-overlay`, `#acct-map-fullscreen`) + a **separate map instance** (`acctFsMap`) + a small preview inside the account pane (`#acct-map-preview` + "Toca para ajustar" hint).
- Center-pin + drag-map + satellite toggle + Listo ✓ — **behaviorally identical** to checkout.
- **Hard symbol firewall (codex R1 #4):** the twin MUST NOT call, reference, or reuse `openFullscreenMap`, `closeFullscreenMap`, `setFullscreenMapType`, `reverseGeocodeFS`, the `#map-fullscreen*`/`#fs-*` ids, or any checkout onclick string. Own functions, own ids, own geocoder. "Separate DOM" alone is insufficient — the shared checkout `closeFullscreenMap` writes `lat/lng`, `gmap/gmarker`, address fields, the loc card, and the pay button; none of that may be reachable from the account path.
- **State sink = account-only**: commit ONLY to `_nadLat`/`_nadLng`/`_nadDetected`. It MUST NOT read-then-write or ever assign `lat`/`lng`/`gmap`/`gmarker`/`fsMap`/`__restorePos`. Reading the checkout `lat`/`lng` ONCE as a starting center hint is allowed (read-only, as `initNewAddrMap` already does) — but see the mid-checkout note below.
- **`_nadPinTouched` = genuine USER placement only (codex R1 #3).** Set it ONLY on a user drag gesture (`acctFsMap` `dragend`, or the marker/center committed by an explicit user drag) — NEVER on raw `center_changed`, `setCenter()`, resize, geolocation recenter, or any programmatic recenter (Maps fires `center_changed` during all of those). `center_changed` may drive reverse-geocode display, but must not flip `_nadPinTouched`. Mirrors the checkout `fsMap`, which commits `lat/lng` on user `dragend` only.
- **Lifecycle / late-callback safety (codex R1 #5):** teardown on EVERY exit (Listo ✓, back, sheet-close, dismiss) — drop `acctFsMap`/marker/geocoder refs AND reset `_nadLat/_nadLng/_nadDetected/_nadPinTouched`. Guard against late async: stamp a monotonic **map-session epoch** on open; a reverse-geocode callback that resolves after teardown (epoch changed) must be IGNORED — it may not repopulate `_nadDetected` or any field. This prevents a dismissed login-create's stale geocode bleeding into the next "+ Agregar".
- **Sheet↔fullscreen stacking + restore (codex R1 #6):** the account fullscreen overlay sits **above** the sheet (sheet is z-1000, toast z-1100 → use z-1200+). On open, record the CURRENT `document.body.style.overflow` and the keyboard-inset binding state; on close, **restore to what they were with the sheet still open** (do NOT blindly clear overflow — the sheet may still need it locked), and re-assert the keyboard-inset handler. No path may leave the page scroll-locked, the sheet shifted, or the fullscreen rendered beneath the sheet on mobile.
- **Mid-checkout `+ Agregar` (codex R1 #4):** "+ Agregar" can be invoked from Mi Cuenta WHILE a live order pin exists (checkout `s2` open, `lat/lng/gmap` set). The twin reading checkout `lat/lng` once as a center hint is fine, but it must never write them back on Listo/close — verify no code path (shared helper, mirrored close logic) touches checkout globals in this state.
- Used by BOTH the new Creá tu perfil pane (Part A2) and the existing "+ Agregar" Nueva-dirección pane. `saveNewAddressFromPane`'s existing validation (`_nadPinTouched`, `_nadLat/_nadLng` numeric, `_nadDetected`, details>=3, label) is unchanged — it already reads the `_nad*` sink.

### C3. Shared-component vs twin (call out for the gate)
Recommended: a **standalone account twin** (duplicated ~fullscreen logic, account-scoped sink) rather than refactoring the checkout `openFullscreenMap` into a shared parameterized component. Rationale: the checkout map is a live money path; a parameterized refactor risks guest/checkout regression for a cosmetic DRY win. The gate should confirm this trade (or justify the shared component with a guest-byte-identical proof).

## Out of scope
Passkeys/biometric login (future). Order history/reorder (P3). Pickup unchanged (no address). No change to the checkout map, `processPayment`, rules, or the checkout Creá-tu-perfil flow.

## Gate focus (for codex design-review)
1. **Fail-open at login**: can a failed/slow `accountSnapshot()` ever trap the user in the create pane, block the menu, or wedge on a spinner? The incomplete-branch must fail-open to Mi Cuenta, never to a dead create screen.
2. **Map isolation**: can the account fullscreen twin, in ANY path ("+ Agregar" mid-checkout with a live order pin, or Creá-tu-perfil at login), read-then-write or clobber `lat`/`lng`/`gmap`/`gmarker`/`fsMap`/`__restorePos`? Prove the sink is account-only.
3. **No-skip**: can any field be bypassed (paste/autofill/Enter/double-click/programmatic) to save an incomplete profile? Submit-time re-validation + `saveAddress`/rules backstop.
4. **Partial-write corruption**: can a name-only or address-only outcome ever read as "complete" and remove the checkout step with missing delivery data? (Must not.)
5. **Guest byte-identical**: confirm zero guest-path/checkout-map delta; the twin's DOM/handlers are wholly separate from `#map`/`openFullscreenMap`.
6. **Coexistence**: the login-sheet create and the checkout create sharing predicate + saveAddress + name-write without state bleed; the checkout hard-block still fires for anyone incomplete at pay.
