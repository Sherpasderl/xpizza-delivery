# User Profiles — Logged-in Autofill + Saved Addresses (P1+P2) — Design Spec

**Date:** 2026-07-25 · **Advisor-designed, to be codex design-gated, then plan → executor → codex-on-diff → deploy.**
**Locked mockup:** `scratchpad/xpizza-autofill-mockup.html` (published artifact). Both forms; La Musa is the config twin (muted rojo musa).

## Goal
Make a customer account *worth having*: a logged-in customer never re-types name/phone or re-pins their delivery location. The "Tus datos" step collapses into a **one-tap "Entregar a" confirmation card**; addresses are saved, labeled, and reusable. Guest checkout stays **byte-identical**; nothing ships half-wired.

## Why now
P0 shipped login but with no payoff (you still re-typed everything) and a chip/keyboard rough edge. Owner decision (2026-07-25): commit fully to the value — name + phone + **saved address** autofill — accepting the pre-launch recycled-number risk on addresses rather than deferring.

---

## Locked design (see mockup)
Three states, logged-in:
1. **Confirm (hero)** — the "Tus datos" step for a logged-in customer becomes a card: mini-map + gold pin + ETA chip, name + phone, the **address label** (e.g. gold "CASA"), the address line, a green "Guardado de tu último pedido" tick, a **Cambiar** link, and one **Continuar al pago** CTA. Delivery/Pickup segmented control above it (pickup hides the address block).
2. **Cambiar (edit)** — inline edit of name + phone; **Ubicación** (map + "Mover el pin" + a reference line); and **"Guardar como"** — a label picker: chips **Casa · Trabajo · Otra** (monochrome line icons, NO emoji) where *Otra* reveals a free-text name ("Casa de un amigo", "Casa de mis papás"). Save-and-continue.
3. **Mi cuenta** — "Hola, {name}" + phone; **Mis direcciones** = the saved labeled addresses (tap one to select as the delivery target; "+ Agregar"); "Mis pedidos" stays **Pronto** (P3); sign-out; delete.

**Chrome fixes (in this build):** the chip is a **seamless soft avatar disc + name + caret, no pill outline** (drop the old ink ring AND the pill); the login/name-capture input is **squared** to match the form and the bottom-sheet **lifts above the iOS keyboard** so the focused field is never covered.

**Ground:** warm off-white kept (owner call). No cheap emoji anywhere ([[no-cheap-emoji-in-form-chrome]]).

---

## Data model — saved addresses
New per-account structure under the (currently denied) `user_profiles/{uid}/addresses` node. Fields map 1:1 to the ORDER schema (codex R1 #5 — orders use `address_detected` + `address_details` + `lat` + `lng`, see `create-order-build.js:51`; online pending snapshots them at `index.js:929`), so autofill reconstructs a delivery order exactly:
```
addresses/{addrId}: {                     // addrId = server-safe key (a_<hex>), NOT a raw path
  label:    string  1..40                  // customer-chosen: "Casa", "Trabajo", "Casa de un amigo"
  detected: string  1..200                 // → order.address_detected (geocoded/selected string)
  details:  string  0..200                 // → order.address_details (reference: portón, color, piso)
  lat:      number  -90..90                 // pin, same bounds as order intake (index.js:287)
  lng:      number  -180..180
  created_at:   number
  last_used_at: number                     // "your last address" default ordering
}
default_address: string | null             // null OR an addrId that EXISTS under this profile's addresses
```
- **Owner-only, via the P0 PARENT guard — NO weaker child `.write` (codex R1 #1/#8).** Address writes are governed by the existing `user_profiles/$uid` `.write` (owner + `newData.exists()` + `hasChildren(['phone','phone_hash','created_at','last_login'])` + `!deleted_uids/$uid`), which cascades to every child. The `addresses/{addrId}` children get **`.validate` only** (never a child `.write`), so a client can't bypass the tombstone/server-truth guards to write an address.
- **Bounded (codex R1 #4):** per-field `.validate` as above (lat/lng range-checked, label/detected non-empty & length-capped), `$other:false` on the address child, and a **max count** `addresses.numChildren() <= 10` so one account can't store unbounded data.
- **Multiple addresses**; the confirm card shows `default_address` (or most-recent `last_used_at`); account sheet lists all; picking one sets the delivery target.

## Rules changes (the security surface — needs the gate)
Exact RTDB text to be written in the PLAN; the design constraints:
- `user_profiles/{uid}/addresses` — replace `".validate": false` with an owner-only structured store, using **`.validate` only** (the parent `$uid` `.write` already gates owner + tombstone + server-truth `hasChildren`; do NOT add a child `.write`):
  - `addresses` (parent): `".validate": "newData.numChildren() <= 10"` (max count).
  - `addresses/$addrId`: the `".validate"` combines THREE things (codex R2 + R4): (i) the KEY — **`$addrId.matches(/^a_[a-f0-9]{6,32}$/)`** (server-safe, not client convention); (ii) **required fields present** — **`newData.hasChildren(['label','detected','details','lat','lng','created_at','last_used_at'])`** (per-field `.validate` does NOT run on a MISSING child, so without `hasChildren` a partial `{label:"Casa"}` with no lat/lng would pass — same RTDB trap as P0's `hasChildren`); (iii) the per-field checks: `label` (`isString`, 1..40), `detected` (`isString`, 1..200), `details` (`isString`, 0..200 — present but may be empty), `lat` (`isNumber && >= -90 && <= 90`), `lng` (`isNumber && >= -180 && <= 180`), `created_at`/`last_used_at` (`isNumber`), and `$other:false`.
- `default_address`: validate against **POST-write** state via `newData.parent()` (NOT `root`, which is pre-write and would reject an atomic create-address+set-default and permit a dangling default on delete — codex R2):
  `".validate": "newData.val() === null || (newData.isString() && newData.parent().child('addresses').child(newData.val()).exists())"` — null OR an addrId that exists in the SAME post-write profile. Works for an atomic update that creates the address and sets it default together; denies leaving `default_address` pointed at an address the same update deletes.
- **Referential integrity of `default_address` — enforced on the `$uid` `.write`, NOT a child `.validate` (codex R3).** A `.validate` on the `addresses` parent will NOT run when a client deletes a single `addresses/$addrId` child (same `.validate`-doesn't-run-on-ancestor-delete fact behind P0's R2 fix), so it can't catch "delete an address while `default_address` still points at it." Put the invariant on the **cascading `$uid` `.write`** (which governs every child write incl. deletes), evaluated on POST-write `newData`:
  append to the existing `.write`: `&& (!newData.child('default_address').exists() || newData.child('default_address').val() === null || newData.child('addresses').hasChild(newData.child('default_address').val()))`.
  So after ANY profile write (create/update/delete of an address, or a name edit), a non-null `default_address` MUST point to an address that exists post-write — deleting the referenced address without clearing/repointing the default is DENIED. The `default_address` child `.validate` stays too (covers default-only writes with a precise message).
- **Untouched:** the H1 staff-read exclusion, the immutable `phone`/`created_at`/`last_login`, and the `hasChildren(['phone','phone_hash','created_at','last_login'])` server-truth guard all stay exactly as deployed (the referential clause is appended, not a replacement). A client still cannot drop the 4 server fields.
- **Tombstone:** because address writes ride the parent `.write`, a tombstoned (deleted) account CANNOT recreate `addresses`/`default_address` — verified by new emulator tests (below).

## Emulator tests (P1 — mirror the P0 suite `user-profiles-rules.emulator.test.js`)
Assert: (a) owner writes a valid address → OK; (b) a DIFFERENT authed uid cannot read/write this uid's addresses; (c) an address child-write that would drop a server-truth field (or under a tombstoned uid) → DENIED; (d) out-of-range lat/lng, over-length label/detected, a stray `$other` key, an 11th address → DENIED; (e) `default_address` pointing at a non-existent addrId → DENIED; null → OK; an **atomic update that creates an address AND sets it as `default_address` in one write → OK** (proves `newData.parent()` post-write validation); an update that **deletes the referenced address while leaving `default_address` pointed at it → DENIED**; a bad `$addrId` key (not `a_<hex>`) → DENIED; a **partial address** missing required fields (e.g. `{label:"Casa"}` with no `lat`/`lng`/`detected`) → DENIED (proves `hasChildren`); (f) H1 unchanged (customer token still can't read /orders).

## Recycled-number risk (documented owner risk-acceptance, tightened per codex R1 #9)
Enabling saved addresses turns the P0 recycled-number exposure from **mild** (a recycled number inherits a *name* — P0 already returns prior `name` after OTP at `index.js:4457`) into **home-location exposure**. Owner ACCEPTED this for the pre-launch window (near-zero real accounts today; exposure grows with account volume). The anti-recycling control (recovery PIN / re-verify-on-new-device / faster address-aging) is a **fast-follow that MUST land before growth/marketing/meaningful account volume** — not merely "before scale," and not silently dropped.
- **Tap-to-reveal hedge — DECIDED: NOT included; go fully auto everywhere.** Owner priority is a seamless, zero-friction customer experience. The tap-to-reveal is a half-measure (hides the address one layer without solving recycling) and adds friction; rejected in favor of maximal seamlessness now + the REAL anti-recycling control as the mandatory fast-follow **before growth/marketing/meaningful account volume**. Pre-launch recycled-number probability is near-zero, so the residual until the fast-follow is bounded. This is an explicit owner risk-acceptance, on the record.

## Behavior & invariants
- **Guest byte-identical** — no marker → the form is exactly as today (no confirm card, no autofill, no address reads, intake POST unchanged, zero Firebase SDK on load). Proven the same way as P0 (Network tab + guest order).
- **Logged-in autofill** — on the "Tus datos" step, if logged in and a profile/address exists, render the confirm card prefilled: **name** from the profile, **phone** displayed from the profile, **address** from default/last-used. Editing (Cambiar) edits **name + address** (writes back to the account); the picked address populates the order's `address_detected`/`address_details`/`lat`/`lng`.
- **PHONE is immutable account identity (codex R1 #2):** the confirm card SHOWS the account phone but does NOT offer editing it into the profile — `user_profiles/phone` is rule-immutable and a batched change would reject the whole save. If a customer needs a different *delivery contact* for one order, that value is posted to `createOrder` as the order's `customer_phone` ONLY, and is **never** written to `user_profiles/phone`. (Changing the account phone = re-verify a new number; out of scope here.)
- **Fail-open is a hard invariant (codex R1 #7), mirroring the payment path's timeboxed attribution (index.js:879):** the normal form renders immediately (or after a short deadline); profile/address READS and the SDK init are **timeboxed (~1.5s) and non-blocking** → on miss, fall back to the empty form and let the customer order. Address SAVES are best-effort and post-hoc; a failed save is ignored. **Never** wait on any account read/write before `createOrder` / `chargeOnlineOrder`.
- **Save-on-order (codex R1 #6):** only for **delivery** orders, only **after a confirmed order** (cash placed / online **materialized** — NOT hosted-checkout creation), and **opt-in/dismissible** — a clear "Guardar esta dirección" affordance (default sensible) so a one-off address isn't silently saved. Upsert label+detected+details+lat/lng, bump `last_used_at`.
- **Attribution** unchanged (the X-Firebase-ID-Token header already ships; this just fills fields).
- **Lazy SDK (H8)** preserved — reads happen only for a logged-in session, never on guest load.
- **No regression** to cart, draft/pending-pay snapshot, PixelPay submit, intl-phone picker, the map/pin capture, or pickup (pickup needs no address).

## Out of scope
Order history + reorder (P3). The anti-recycling control (fast-follow before scale). Non-delivery address logic beyond pickup's existing no-address path.

## Open decisions — RESOLVED
- Ground: warm (keep). · Autofill UX: one-tap confirm card. · Address: full experience now, accept recycled-risk pre-launch. · Chip: seamless soft avatar, no outline. · Label model: Casa/Trabajo/custom free-text. · Tap-to-reveal: NO — fully auto everywhere (seamless priority); real anti-recycling control = fast-follow before growth.

## Gate focus (for codex design-review)
1. The `addresses` rules opening — owner-only, no leak of other fields, no weakening of H1 or the server-truth `hasChildren` guard.
2. Guest byte-identical + fail-open (a broken account read must never block an order).
3. The recycled-number acceptance — is name+phone+address the right risk line for pre-launch, and is the fast-follow control correctly scoped?
4. Save-on-order write path — can a client forge/overwrite another uid's address? (owner-only rules must prevent it.)
