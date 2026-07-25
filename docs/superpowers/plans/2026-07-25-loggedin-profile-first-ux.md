# Logged-in Profile-First UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Sign in once → build a complete profile once → after that every delivery order is **cart → pay** (the "Tus Datos" data-entry disappears). Plus "+ Agregar" becomes self-contained, name requires first+last, and two visual fixes. **Guest byte-identical.** Both forms.

**Design source (codex-gated R2 APPROVED):** `docs/superpowers/specs/2026-07-25-loggedin-profile-first-ux-design.md` — the **"Resolved implementation constraints"** section is authoritative; follow it exactly. Locked mockups: `scratchpad/xpizza-loggedin-flow-mockup.html`, `scratchpad/xpizza-agregar-mockup.html`.

**Real DOM (verified):** `s1`=cart + `#acct-deliver` + `#raw-name-phone` + `goToLocation()`→`s2`; `s2`=delivery map/address + payment; `processPayment()` gates delivery on `lat&&lng`, delivery-zone, `address-details.trim().length>=3`. `setOrderType(type)` toggles the address section; `placeAccountPin()` sets checkout `lat/lng` only if `gmap` exists else `__restorePos`.

## Non-negotiables (from the gate)
1. **Guest byte-identical** — no marker → every existing label/stage-ID/handler/validation/submission/lazy-load EXACTLY as today. All step-count/label/summary changes live behind a marker + confirmed-complete-profile branch.
2. **Fail-open + atomic gating** — reduced flow presented ONLY after a live `accountSnapshot()` says COMPLETE, fields populated, checkout `lat/lng`+zone established (init `gmap` or set them from the saved address first — spec R1 #2 map-timing), and a **local invariant re-check passes** (first+last, phone, detected, numeric lat/lng, in-zone, details≥3). Any failure → normal fillable `s1`/`s2`. `processPayment` keeps its checks.
3. **No-skip** — submit-time re-validation in the handler before any write/transition; `saveAddress()` hardened to REJECT missing label / details<3 / empty detected / non-numeric lat-lng.
4. **Phone immutable**; **no cheap emoji**; reuse the LIVE rules + `saveAddress`/`update({name})` (no rules change).

---

## Task 1: Harden `saveAddress()` + the completeness predicate (foundation)
**Files:** both `account.js`.
- [ ] Harden `saveAddress()` to REJECT (return an error, do not persist/normalize) when: label empty, `details.trim().length<3`, `detected` empty, or `lat`/`lng` non-numeric. Keep the ≤10 create cap.
- [ ] Add `profileComplete(snap)` = name `String(snap.name).trim().split(/\s+/).filter(Boolean).length>=2` AND a valid default/first address via the existing `pickDefaultAddress` predicate. LIVE snapshot authoritative.
- [ ] Verify: `node --check`; a save with empty details/label/bad pin is rejected; `profileComplete` true only for first+last name AND a valid address.
- [ ] Commit `feat(account): harden saveAddress + profileComplete predicate`

## Task 2: "Creá tu perfil" (logged-in, incomplete profile) — no-skip
**Files:** both `account.js` (+ minimal `index.html` if a mount is needed).
- [ ] When logged-in + `!profileComplete`: render the data step as "Creá tu perfil" — phone read-only + verificado, **Nombre + Apellido** (two inputs), address (existing map/geocode) + referencia, label picker. All required.
- [ ] "Guardar y continuar" handler **re-validates ALL** fields inside the handler (first+last, pin lat/lng, details≥3, label) BEFORE `update({name:`${nombre} ${apellido}`.trim()})` + `saveAddress({makeDefault:true})` + advancing. Inline errors; CTA disabled until valid is UX-only, not the gate.
- [ ] Verify (LIVE): a new user can't proceed with any blank field (try Enter, empty apellido, no pin, empty referencia); on complete → profile saved (name has 2 words + address) → proceeds.
- [ ] Commit `feat(account): no-skip Creá tu perfil (first+last + required address)`

## Task 3: Complete-profile returning flow — hide/pre-populate + summary atop payment + 2 steps
**Files:** both `account.js` + `index.html` (step labels, an `s2`-top summary mount, the compact `s1` line).
- [ ] For logged-in + `profileComplete`: run the **atomic sequence** — live snapshot COMPLETE → populate `cname`/`cphone`/`address-detected`/`address-details` + establish checkout `lat/lng`+zone (init `gmap` or set from the saved address per spec R1 #2) → **local invariant re-check** → only then: hide `#raw-name-phone` + the `s2` delivery/address section (DOM stays, populated), render a compact "Entregar a … · Cambiar" line on `s1`, render the **"Entregar a" summary atop `s2`** (above payment), and relabel `s1`="Paso 1 de 2 — Tu pedido" / `s2`="Paso 2 de 2 — Pago". If the sequence fails at any point → leave the normal fillable flow.
- [ ] Guest/no-marker branch: labels/stages/handlers untouched.
- [ ] Verify (LIVE): a complete-profile user goes cart→pay (2 steps), summary correct, and the submitted order carries the right `address_detected`/`address_details`/lat-lng (pin invariant); a slow/failed read → normal fillable flow, order still completes.
- [ ] Commit `feat(account): profile-complete returning flow — 2 steps + delivery summary on payment`

## Task 4: Cambiar — two actions (Usar en este pedido / Guardar dirección)
**Files:** both `account.js`.
- [ ] The Cambiar surface (from the payment summary) offers: **"Usar en este pedido"** (pick a saved address → order fields only, no persist, no default change) and **"Guardar dirección"** (edit/add → `saveAddress({makeDefault})` + apply). No silent default/profile mutation on a one-off.
- [ ] Verify (LIVE): "Usar en este pedido" changes the order's address without changing `default_address`; "Guardar" persists + defaults.
- [ ] Commit `feat(account): Cambiar — per-order use vs save-to-account`

## Task 5: "+ Agregar" self-contained Nueva dirección (own map)
**Files:** both `account.js` (+ `index.html` mount inside the account sheet).
- [ ] `startAddNewAddress` opens a self-contained **Nueva dirección** pane INSIDE the account sheet (ported from `xpizza-agregar-mockup.html`): its OWN `acctMap`/`acctMarker`/`acctLat`/`acctLng` + account-sheet geocoder (init on open, teardown on close, no leak); referencia + label; all required. On save → `saveAddress` using the account-map values ONLY (never `placeAccountPin`/checkout globals) → **return to Mi Cuenta** (address list, new one shown). Never enters checkout.
- [ ] Verify (LIVE): "+ Agregar" stays in the account; the saved address's lat/lng match the account-map pin; returns to the list; the order-form map is untouched.
- [ ] Commit `feat(account): self-contained Nueva dirección with its own map`

## Task 6: Order-type switch hook
**Files:** both `index.html`/`account.js`.
- [ ] Hook `setOrderType`: `delivery` → re-run the completeness application (reduced flow or normal fillable); `pickup` → hide the delivery summary + drop delivery validation WITHOUT clearing persisted/default data.
- [ ] Verify (LIVE): delivery↔pickup toggling never strands the flow or loses saved data.
- [ ] Commit `feat(account): re-evaluate delivery UI on order-type switch`

## Task 7: Visual fixes
**Files:** both `account.js`.
- [ ] Name input in the login/creá-perfil: height ~52→58px, soften radius toward the phone field. Confirm the login-sheet `h1`/`sub` spacing has no overlap in the settled state (fix if real).
- [ ] Commit `fix(account): taller name input + login title/sub spacing`

## Task 8: La Musa parity
- [ ] Apply Tasks 1–7 to `la-musa-orders/account.js` (logic byte-identical past CONFIG) + mirror the `la-musa-orders/index.html` edits; verify field IDs + `s1/s2` structure match.
- [ ] Commit `feat(account): La Musa parity — profile-first UX`

## Task 9: End-to-end verification (both forms)
- [ ] Guest byte-identical (no marker → unchanged 3-step flow + submit + zero SDK on load).
- [ ] First-time: no-skip Creá tu perfil → profile saved.
- [ ] Returning complete: cart→pay (2 steps), right order data; slow/failed read → fillable fallback still completes.
- [ ] Cambiar (both actions); "+ Agregar" self-contained; order-type toggles; pickup unchanged.
- [ ] Push; hand to advisor for `codex-on-diff`. Do NOT deploy/merge.

## Self-review
Spec coverage: all 8 codex-R1 constraints + R2 map-timing map to Tasks 1–3/5/6. Guest-identical: Tasks 3/9. Type consistency: `profileComplete`, `saveAddress`, `pickDefaultAddress`, `placeAccountPin` (checkout only), `acctMap`/`acctLat`/`acctLng` (account only). Deploy: after codex-on-diff → Netlify CLI per-folder (xpizzaorders 6f09559f / lamusaorders f8bac377).
