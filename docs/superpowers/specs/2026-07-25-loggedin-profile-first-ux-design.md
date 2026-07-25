# Logged-in Profile-First UX — Design Spec

**Date:** 2026-07-25 · Advisor-designed refinement of the shipped autofill/addresses feature. To be codex design-gated → plan → executor → codex-on-diff → deploy (Netlify CLI per-folder). Both forms.
**Locked mockups:** `scratchpad/xpizza-loggedin-flow-mockup.html` (profile-first flow) + `scratchpad/xpizza-agregar-mockup.html` (Nueva dirección self-contained). Both owner-approved.

## Goal
Turn the account into a real time-saver: a logged-in customer builds their profile ONCE (name + address), and after that every order is just **cart → pay** — the "Tus Datos" step disappears. Guest checkout stays **byte-identical**; nothing half-wired.

## The three flow states (delivery orders)
1. **Guest (no marker)** — 100% unchanged. The full existing "Tus Datos" step, the existing submit. No account logic beyond the marker check.
2. **Logged-in, INCOMPLETE profile** (no complete name OR no saved address) — the "Tus Datos" step becomes **"Creá tu perfil"**: phone shown read-only + "verificado" (already known, never asked), **Nombre + Apellido**, an **address** (map pin + referencia), and the **Guardar como** label picker. **ALL required, no skip** (see below). On save → persist the profile (name + address) → continue to payment. After this, the customer is "complete."
3. **Logged-in, COMPLETE profile** (name has first+last AND ≥1 saved address) — **the "Tus Datos" step is REMOVED**: the flow is cart → payment (step count 3→2). The order's `cname`/`cphone`/`address-detected`/`address-details`/map-pin are set from the default/last-used saved address (via the existing field-population + `placeAccountPin`). The payment step shows an **"Entregar a"** summary card at its top (label · full name · address · phone · **Cambiar**).

**"Complete profile" =** `name` present with ≥2 words (first+last) AND at least one valid saved address (detected + lat/lng + details≥3). Anything less → state 2.

## No-skip on profile creation (owner requirement)
In "Creá tu perfil," the **"Guardar y continuar al pago" CTA is disabled** until ALL are valid:
- `nombre` non-empty, `apellido` non-empty (first AND last required — the profile `name` = `"${nombre} ${apellido}".trim()`).
- a map pin dropped/geocoded (lat/lng present), `address-detected` populated.
- `referencia` (→ `address-details`) trimmed length ≥3.
- a label chosen (Casa/Trabajo, or a non-empty custom for Otra).
Inline validation messages on attempted submit; no field may be blank.

## Cambiar (on the returning payment summary) — TWO distinct actions (codex R1 #5)
Opens a compact delivery editor for THIS order. It must separate per-order use from persistence:
- **"Usar en este pedido"** (pick a saved address, one tap) → updates ONLY the order fields (`cname`/`cphone`/`address-*`/pin) for this order. Does NOT change `default_address` or persist anything.
- **"Guardar dirección"** (edit/add: re-pin + referencia + label, same no-blank rules) → persists via `saveAddress({ makeDefault })` AND applies to this order.
So a one-off delivery can never silently overwrite the profile's default. Defaults to the current selection; no forced return to Mi Cuenta.

## "+ Agregar" — self-contained Nueva dirección (separate from ordering)
From **Mi Cuenta → Mis direcciones → "+ Agregar"**: open a **self-contained "Nueva dirección" screen inside the account sheet** — its OWN map instance (a second `google.maps.Map` in the sheet; do NOT reuse/disturb the order-form `gmap`), a draggable/tappable pin + geocode, a referencia field, and the label picker. **All required (no blank).** On save → `saveAddress` → **return to Mi Cuenta** (the address list, new one shown). It must NEVER dump the customer into the order/checkout flow (the current bug). The in-order "Cambiar → add address" path is separate and unchanged (it stays in the order context).

## Visual fixes (ride along)
- The login/name-capture **name input height** feels short (`52px`, squared) — raise to ~58px and soften the radius toward the phone field so it reads substantial.
- Verify the login sheet's **title vs subtitle** spacing in the settled state (screenshot showed overlap — likely a mid-animation frame; fix the `h1`/`sub` spacing if it persists).

## Non-negotiables (invariants)
- **Guest byte-identical** — no marker → the full existing Tus Datos step + submit, zero account logic, zero Firebase SDK on load.
- **Fail-open** — the "complete profile" decision depends on a timeboxed (~1.5s) account read. If it fails/times out, **fall back to the normal Tus Datos step** (never a removed-but-empty step, never a block). Step removal happens ONLY when a live read confirms a complete profile.
- **Phone immutable** — read-only/verified in profile creation; per-order contact → `cphone`/`createOrder` only, never `user_profiles/phone`.
- **Reuse the gated writes** — profile `name` via `update({name})`; addresses via the existing `saveAddress`/rules (Phase A live). No new rules.
- **No cheap emoji**; the confirm/summary use the monochrome line icons + soft avatar.
- **Don't regress** the existing cart/draft-pending-pay/PixelPay submit/intl-phone/map-geocoder; the returning-user CHECKOUT path must still produce a correct order (right `address_*` + lat/lng — for the CHECKOUT map, the pin-family invariant holds: place via `placeAccountPin`). **NOTE (codex R1 #4):** the pin-family invariant + `placeAccountPin` apply ONLY to the CHECKOUT map (autofill/Cambiar, which target the order globals `gmap`/`lat`/`lng`/`__restorePos`). The "+ Agregar" **Nueva dirección** screen uses a SEPARATE map/state (below) and must NOT call `placeAccountPin`.

## Out of scope
Passkeys/biometric login (future). Order history/reorder (P3). Non-delivery (pickup) is unchanged (no address needed).

## Resolved implementation constraints (codex R1 — precise, against the real DOM)
The shipped form: **`s1`** (`Paso 1 de 3 — Tu pedido`) = cart + `#acct-deliver` (card mount) + `#raw-name-phone` (name/phone) + `goToLocation()`→`s2`; **`s2`** (`Paso 2 de 3 — Entrega & Pago`) = the delivery map/address section + payment; `processPayment()` gates delivery on `lat&&lng` (pin), delivery-zone, and `address-details.trim().length>=3`. There is NO standalone "Tus Datos" step — data is split across `s1` (name/phone) + `s2` (address).

1. **"Step removal" = HIDE + PRE-POPULATE, never delete the DOM (codex R1 #1).** For a COMPLETE-profile returning user: the delivery/address section STAYS in `s2`'s DOM (so `processPayment`'s field reads still work) but is **hidden and pre-populated**; `s1` shows the cart + a compact "Entregar a … · Cambiar" line (raw name/phone hidden); the **"Entregar a" summary renders atop `s2`** above payment. Step LABELS become 2 (`s1`="Paso 1 de 2 — Tu pedido", `s2`="Paso 2 de 2 — Pago"). Nothing is skipped in the DOM — only hidden.
2. **Atomic gating sequence + a final pre-payment invariant (codex R1 #2).** The reduced flow is presented ONLY after: (a) a live `accountSnapshot()` returns a profile confirmed COMPLETE; (b) the order fields are populated (`cname`,`cphone`,`address-detected`,`address-details`) AND the CHECKOUT pin placed via `placeAccountPin` (sets `lat`/`lng`); (c) a **local invariant re-check passes**: non-empty first+last name, phone, `address-detected`, numeric `lat`/`lng`, **in delivery zone**, `address-details.trim().length>=3`. If ANY step fails/times out → fall back to the NORMAL fillable `s1`/`s2` (never a hidden-but-empty section, never advance to payment). `processPayment` keeps its existing checks as defense-in-depth. **Map-timing (codex R2):** `placeAccountPin()` only sets the checkout `lat`/`lng` when `gmap` already exists (else it writes `__restorePos`), and the checkout map initializes on entering `s2` via `goToLocation()` — so **if `gmap` is not initialized, either initialize it before the invariant check, or set the checkout `lat`/`lng` and delivery-zone state directly from the saved address, before presenting the reduced flow.** The numeric-`lat/lng` + in-zone re-check must run against actually-established values, not a pending `__restorePos`.
3. **No-skip = submit-time re-validation, not just a disabled CTA (codex R1 #3).** The "Guardar y continuar" handler MUST re-validate ALL fields (first+last, pin `lat/lng`, `address-details>=3`, label) INSIDE the handler before any `update({name})`, `saveAddress()`, or stage transition — covering Enter, autofill timing, double-click, DOM tampering, programmatic calls. ALSO **harden `saveAddress()` itself** to REJECT (not normalize) a missing/empty label, `details.trim().length<3`, empty `detected`, or non-numeric `lat`/`lng` — so persistence enforces the invariant regardless of caller.
4. **"+ Agregar" Nueva dirección — its own map state (codex R1 #4).** A separate `acctMap`/`acctMarker`/`acctLat`/`acctLng` + account-sheet geocoder; `saveAddress` from there uses those values ONLY; init on open, teardown/cleanup on close (no leak); never touches the checkout `gmap`/`lat`/`lng`/`__restorePos`.
5. **Order-type switch hook (codex R1 #6).** `setOrderType('delivery')` must re-run the completeness application (re-populate + re-check → reduced flow, else the normal fillable delivery UI); `setOrderType('pickup')` hides the delivery summary + drops delivery validation WITHOUT clearing persisted/default data. Wire this into the existing `setOrderType`.
6. **Guest byte-identical under the restructure (codex R1 #7).** Any change to step-count/progress/labels/`showStage`/`goToLocation` MUST have a **no-marker branch** that leaves the guest DOM, step labels ("de 3"), stage IDs, button handlers, validation text, Firebase lazy-load, and form submission EXACTLY as today. The 2-step relabel + summary-relocation apply ONLY when a marker + confirmed-complete profile exist.
7. **"Complete profile" — exact predicate (codex R1 #8).** Name complete = `String(name).trim().split(/\s+/).filter(Boolean).length >= 2` (first + last). Address complete = REUSE the existing `pickDefaultAddress` predicate (a valid default/first address: `detected` + numeric `lat`/`lng` + `details.trim().length>=3`). The LIVE `accountSnapshot()` profile is authoritative for the completeness decision (the marker is only the instant chip/fast-path hint, never the gate for step-removal).

## Gate focus (for codex design-review)
1. The step-removal logic: can a logged-in user EVER reach payment without valid delivery data (a removed step + a failed/partial profile read)? The fail-open must guarantee the normal step appears whenever completeness isn't positively confirmed.
2. Guest byte-identical under the new conditional-step logic.
3. The no-skip gate — can any field be bypassed (paste, autofill, direct submit) to save an incomplete profile or reach payment?
4. The second map instance for "+ Agregar" — conflicts with the order-form `gmap`, teardown, and the pin-correctness (the saved lat/lng must be that map's pin).
5. Cambiar correctness — editing delivery for one order must not corrupt the saved profile/default unless the customer saves.
