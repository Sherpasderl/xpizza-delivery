# EXECUTOR HANDOFF — Logged-in Profile-First UX (batch)

**You build. You do NOT gate or deploy.** Advisor runs codex-on-diff (customer-facing + order-submit path); Xavier deploys (Netlify CLI per-folder). The design survived a 2-round codex design-gate — follow the spec's **"Resolved implementation constraints"** section exactly; do not re-litigate the flow logic.

## Mission
One coherent refinement of the LIVE autofill/addresses feature: a logged-in customer builds a complete profile once, then every delivery order is cart → pay ("Tus Datos" data-entry disappears). Plus "+ Agregar" self-contained, name requires first+last, and 2 visual fixes. **Guest byte-identical.**

## Environment
- **Worktree:** `/Users/xavierlacayo/Downloads/xpizza-agregar` (off `main` @ `3b09c1a`).
- **Branch:** `feat/agregar-selfcontained` (checked out). Both forms: `xpizza-orders/`, `la-musa-orders/`.

## Read first (in order)
1. **Plan:** `docs/superpowers/plans/2026-07-25-loggedin-profile-first-ux.md` — Tasks 1–9, commit after each.
2. **Spec (codex-gated R2):** `docs/superpowers/specs/2026-07-25-loggedin-profile-first-ux-design.md` — the **"Resolved implementation constraints"** section is authoritative (step-removal = hide/pre-populate, atomic gating + invariant + map-timing, no-skip submit-time + saveAddress hardening, separate Nueva-dirección map, Cambiar two actions, order-type hook, guest no-marker branch, exact completeness predicate).
3. **Mockups:** `docs/superpowers/mockups/xpizza-loggedin-flow-mockup.html` (profile-first flow) + `xpizza-agregar-mockup.html` (Nueva dirección). Port + brand-recolor for La Musa.

## Hard rules (the gate will check ALL of these)
- **Guest byte-identical** — no marker → every label/stage-ID/handler/validation/submission/lazy-load EXACTLY as today; all step-count/label/summary changes behind a marker + confirmed-complete-profile branch.
- **Fail-open + atomic gating** — reduced flow ONLY after live snapshot COMPLETE + fields populated + checkout lat/lng+zone established (init gmap or set from the saved address FIRST — the map-timing note) + local invariant re-check (first+last, phone, detected, numeric lat/lng, IN-ZONE, details≥3). Any failure → normal fillable flow. Never advance to payment without valid delivery data.
- **No-skip** — submit-time re-validation in the handler before any write/transition; harden `saveAddress()` to REJECT (not normalize) empty label / details<3 / empty detected / non-numeric lat-lng.
- **Nueva dirección** uses its OWN `acctMap`/`acctMarker`/`acctLat`/`acctLng` + geocoder — NEVER `placeAccountPin`/checkout globals; init-on-open, teardown-on-close.
- **Cambiar** = two distinct actions (Usar en este pedido = order-only; Guardar dirección = persist+default). No silent default mutation.
- **Phone immutable**; **no cheap emoji**; reuse LIVE rules + `saveAddress`/`update({name})` (NO rules change).

## Done → hand to advisor
Tasks 1–9 on BOTH forms; guest byte-identical + fail-open verified; push `feat/agregar-selfcontained`; report the SHA for **codex-on-diff**. Advisor gates → Xavier Netlify-CLI per-folder deploy (xpizzaorders `6f09559f-0697-48ef-b498-a6523f0370d3`, lamusaorders `f8bac377-cea5-4688-ac3d-b4812c62360a`). Do NOT deploy/merge.
