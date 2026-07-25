# Logged-in Autofill + Saved Addresses — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A logged-in customer never re-types name/phone or re-pins their location: the "Tus datos" step becomes a one-tap "Entregar a" confirm card, backed by saved, labeled, reusable addresses. Guest checkout stays **byte-identical**; nothing ships half-wired.

**Architecture:** Two phases. **Phase A (backend rules, gates+deploys FIRST):** open the currently-denied `user_profiles/{uid}/addresses` node — validation-only children riding the P0 parent `.write` guard, plus a `default_address` referential invariant appended to that `.write`. **Phase B (frontend):** `account.js` on both forms reads the account (fail-open, timeboxed), renders the confirm card into the "Tus datos" step, populates the existing order fields (`cname`,`cphone`,`address-detected`,`address-details`,map lat/lng) so the existing submit logic is untouched, and upserts the used address after a confirmed delivery order. La Musa is a config-only twin.

**Tech:** RTDB rules; vanilla JS `account.js` (Firebase RTDB SDK already lazy-loaded from P0); the deployed order forms (`xpizza-orders/`, `la-musa-orders/`).

**Design source (LOCKED + codex-gated R5):** `docs/superpowers/specs/2026-07-25-profiles-autofill-addresses-design.md`. Locked mockup: the published artifact / `scratchpad/xpizza-autofill-mockup.html` (port markup/CSS; brand-recolor for La Musa).

**Form integration anchors (verified from source):** `cname`/`cphone`/`cemail` inputs; `address-detected` (readonly geocoded, →`order.address_detected` at `index.html:2356`); `address-details` (reference, required-for-delivery, →`order.address_details` at 2357); map lat/lng placed via the `__restorePos = {lat,lng}` mechanism that `initMap` honors instead of geolocating (`index.html:2553`); delivery/pickup via `.delivery-toggle`.

---

## Non-negotiables (from the codex design-gate)
1. **Guest byte-identical** — no marker → no confirm card, no address reads, no Firebase SDK on load, intake POST unchanged. Prove it (Task B9).
2. **Fail-open, timeboxed (~1.5s)** — profile/address reads + SDK init are non-blocking; on miss → the normal empty form; NEVER wait on any account read/write before `processPayment`/submit.
3. **Phone immutable** — the confirm card shows the account phone; a per-order contact goes to `cphone`→`createOrder` only, NEVER written to `user_profiles/phone`.
4. **Address writes ride the parent `.write` guard** — `.validate`-only children; no weaker child `.write`.
5. **Save-on-order** — delivery-only, post-**confirmed** (online = materialized, not hosted-checkout), opt-in/dismissible.
6. **No cheap emoji**; the chip is the seamless soft-avatar (no pill, no ring).

---

# PHASE A — Backend rules (gate + deploy FIRST; frontend depends on it)

## Task A1: Open the `addresses` node + `default_address` + `.write` referential invariant

**Files:** Modify `xpizza-reference/database.rules.json` (the `user_profiles/$uid` block).

- [ ] **Step 1: Replace the `addresses` deny + add `default_address`, and append the referential clause to the `$uid` `.write`.** Exact rules (mirror the spec):

```jsonc
"$uid": {
  ".read":  "auth != null && auth.uid === $uid",
  ".write": "auth != null && auth.uid === $uid && newData.exists() && newData.hasChildren(['phone','phone_hash','created_at','last_login']) && !root.child('deleted_uids').child($uid).exists() && (!newData.child('default_address').exists() || newData.child('default_address').val() === null || newData.child('addresses').hasChild(newData.child('default_address').val()))",
  "name":       { ".validate": "newData.isString() && newData.val().length <= 80" },
  "phone":      { ".validate": "newData.isString() && (!data.exists() || newData.val() === data.val())" },
  "created_at": { ".validate": "newData.isNumber() && (!data.exists() || newData.val() === data.val())" },
  "updated_at": { ".validate": "newData.isNumber() && newData.val() <= now + 60000" },
  "last_login": { ".validate": "newData.isNumber() && (!data.exists() || newData.val() === data.val())" },
  "default_address": { ".validate": "newData.val() === null || (newData.isString() && newData.parent().child('addresses').child(newData.val()).exists())" },
  "addresses": {
    ".validate": "newData.numChildren() <= 10",
    "$addrId": {
      ".validate": "$addrId.matches(/^a_[a-f0-9]{6,32}$/) && newData.hasChildren(['label','detected','details','lat','lng','created_at','last_used_at'])",
      "label":        { ".validate": "newData.isString() && newData.val().length >= 1 && newData.val().length <= 40" },
      "detected":     { ".validate": "newData.isString() && newData.val().length >= 1 && newData.val().length <= 200" },
      "details":      { ".validate": "newData.isString() && newData.val().length <= 200" },
      "lat":          { ".validate": "newData.isNumber() && newData.val() >= -90 && newData.val() <= 90" },
      "lng":          { ".validate": "newData.isNumber() && newData.val() >= -180 && newData.val() <= 180" },
      "created_at":   { ".validate": "newData.isNumber()" },
      "last_used_at": { ".validate": "newData.isNumber()" },
      "$other":       { ".validate": false }
    }
  },
  "$other": { ".validate": false }
}
```
Note: `addresses` is NO LONGER `$other` (it's a named child now) — remove the old `"addresses": { ".validate": false }` line. Do NOT add any `.write` under `addresses`/`$addrId` (the parent `.write` governs).

- [ ] **Step 2:** `npm --prefix xpizza-functions run check:rules` (syncs to the deploy-source copy + asserts synced + runs the existing guard tests). Expected: green.

- [ ] **Step 3: Commit** `feat(rules): saved-addresses under user_profiles (owner-only, bounded, referential default)`

## Task A2: Emulator + guard tests for the new rules

**Files:** Modify `xpizza-functions/test/user-profiles-rules.emulator.test.js`; `xpizza-functions/user-auth-rules.guard.test.js`.

- [ ] **Step 1: Add emulator assertions** (mirror the spec's list): owner writes a valid full address → OK; a different authed uid cannot read/write this uid's `addresses` → DENIED; an address write under a **tombstoned** uid → DENIED; out-of-range `lat`(91)/`lng`(-181), over-length `label`(41)/`detected`(201), a stray `$other` key, an **11th** address → each DENIED; a **partial** address `{label:'Casa'}` (missing lat/lng/detected) → DENIED; bad `$addrId` key (`x_1`) → DENIED; `default_address` → non-existent addrId DENIED, `null` OK, **atomic create-address+set-default in one update → OK**, **delete the referenced address leaving default → DENIED**; a profile write that drops a server-truth field while adding an address → DENIED; H1 unchanged (customer token can't read `/orders`).

- [ ] **Step 2: Add a structural guard assertion** in `user-auth-rules.guard.test.js`: the `$uid` `.write` contains the referential clause (`newData.child('addresses').hasChild(...)`) and the `addresses/$addrId` `.validate` contains both `$addrId.matches` and `hasChildren([...7 fields])`.

- [ ] **Step 3:** `cd xpizza-functions && npm test` (offline guards) + `npm run test:user-profiles-rules` (emulator; needs Java) → all green.

- [ ] **Step 4: Commit** `test(rules): saved-addresses owner/bounds/referential/tombstone emulator coverage`

- [ ] **Step 5: DONE Phase A → hand to advisor for `codex-on-diff` (rules), then Xavier deploys `--only database`** (reconcile ← xpizza-reference, diff vs LIVE = only these additions, 0 stripped). Phase B does NOT ship until the addresses rules are live.

---

# PHASE B — Frontend (after Phase A rules are live)

## Task B1: Seamless chip (soft avatar, no pill, no ring)

**Files:** Modify `xpizza-orders/account.js` (chip CSS/markup) + `la-musa-orders/account.js`.

- [ ] **Step 1:** Change the chip to the locked mockup's treatment: NO pill border/background/shadow; a soft borderless avatar disc (`background:#F0E8DA` for X. Pizza; a muted rojo-musa tint for La Musa) + first name + caret; hover = opacity only. Keep the existing `PERSON_SVG`. Logged-out chip ("Entrar") gets the same seamless treatment.
- [ ] **Step 2: Verify** the live chip on each form has no pill outline and the avatar has no hard ring (screenshot/agent-browser).
- [ ] **Step 3: Commit** `fix(account): seamless chip — soft avatar, no pill/ring`

## Task B2: Keyboard-safe login/name sheet + squared input

**Files:** Modify `xpizza-orders/account.js` (login sheet CSS/behavior) + La Musa twin.

- [ ] **Step 1:** The bottom-sheet overlay must keep the focused input visible above the iOS keyboard. Use `visualViewport` resize handling (on `window.visualViewport` `resize`/`scroll`, translate the sheet up by the covered amount, or scroll the focused field into view). Square the name input to match the form's field radius (drop the pill radius).
- [ ] **Step 2: Verify** on a narrow viewport (or device): focusing the name field keeps it + the Guardar button visible above the keyboard.
- [ ] **Step 3: Commit** `fix(account): login sheet lifts above the iOS keyboard + squared name input`

## Task B3: Address data layer in `account.js` (fail-open, timeboxed)

**Files:** Modify `xpizza-orders/account.js` (+ La Musa twin).

- [ ] **Step 1: Read profile + addresses, timeboxed and fail-open.** Add a helper that returns the account snapshot (name, phone, addresses map, default_address) or `null` — never throws, never blocks:
```js
async function accountSnapshot() {
  if (!marker()) return null;                                    // guest — no SDK, no read
  try {
    return await Promise.race([
      (async () => {
        const { auth, db, dbMod } = await ensureFirebase();
        await auth.authStateReady();
        if (!auth.currentUser) { heal(); return null; }
        const snap = await dbMod.get(dbMod.ref(db, 'user_profiles/' + auth.currentUser.uid));
        return snap.exists() ? snap.val() : null;
      })(),
      new Promise((r) => setTimeout(() => r(null), 1500)),        // deadline → treat as no-account
    ]);
  } catch (_) { return null; }
}
```

- [ ] **Step 2: Address CRUD helpers** (owner writes, rule-validated). `newAddrId()` = `'a_' + <12 hex>` (matches the `$addrId` rule). `saveAddress({label,detected,details,lat,lng, makeDefault})` builds an atomic multi-path update: `user_profiles/{uid}/addresses/{addrId} = {label,detected,details,lat,lng,created_at:now,last_used_at:now}` and, if `makeDefault`, `user_profiles/{uid}/default_address = addrId` — in ONE `update()` (the referential rule requires the address to exist post-write, so create+set-default must be atomic). `deleteAddress(addrId)` clears the node and, if it was the default, sets `default_address = null` in the SAME update (else the `.write` referential clause denies it). All wrapped try/catch, non-blocking.
- [ ] **Step 3: Verify** (unit-ish): `newAddrId()` matches `/^a_[a-f0-9]{6,32}$/`; the update maps are shaped as above. `node --check account.js`.
- [ ] **Step 4: Commit** `feat(account): fail-open account/address read + atomic address CRUD helpers`

## Task B4: The "Entregar a" confirm card + autofill into "Tus datos"

**Files:** Modify `xpizza-orders/account.js` (render + populate) + `xpizza-orders/index.html` (a mount point in the delivery "Tus datos" step) + La Musa twin.

- [ ] **Step 1:** Add a mount container in the delivery data step of `index.html` (e.g. `<div id="acct-deliver"></div>` above the existing name/address fields) and, in `account.js`, on that step: if `accountSnapshot()` returns an account with a usable address AND order_type is delivery, render the confirm card (ported from the mockup: map + pin, name/phone, label + address line, "Guardado", Cambiar, no separate CTA — the form's existing Continuar drives submit) into `#acct-deliver` and **hide the raw fields**. Guest / no-account / pickup → leave the raw fields exactly as today (no card).
- [ ] **Step 2: Populate the existing order fields from the chosen address** so the unchanged submit logic just works: set `cname`=account name, `cphone`=account phone, `address-detected`=addr.detected, `address-details`=addr.details, and place the map pin at addr.lat/lng via the existing `__restorePos` mechanism (assign `__restorePos = {lat,lng}` and re-init/recenter the map). Do this WITHOUT dispatching anything that would mark the form dirty in a way that breaks the draft/pending-pay snapshot.
- [ ] **Step 3: Fail-open** — if `accountSnapshot()` is null (timeout/miss), render nothing and leave the normal empty form; the customer fills it as a guest would. Never block the step.
- [ ] **Step 4: Verify (LIVE, logged-in delivery):** the card shows the saved name/phone/address; Continuar produces an order whose `address_detected`/`address_details`/lat/lng match the saved address. Guest delivery: raw fields, unchanged.
- [ ] **Step 5: Commit** `feat(account): one-tap Entregar a confirm card + autofill into Tus datos`

## Task B5: Cambiar — edit + label picker + re-pin

**Files:** Modify `xpizza-orders/account.js` (+ La Musa twin).

- [ ] **Step 1:** "Cambiar" reveals the normal fields (prefilled: name/`address-details`, the map for re-pin) plus the **"Guardar como" label picker** (chips Casa/Trabajo/Otra with the mockup's monochrome line icons; Otra → free-text label). Editing name updates `cname` (and the profile `name` via `update({name})` — NEVER phone). On re-pin, the geocoder fills `address-detected` and the map lat/lng update (reuse the form's existing pin/geocode flow).
- [ ] **Step 2:** "Guardar y continuar" → `saveAddress({label, detected:address-detected, details:address-details, lat, lng, makeDefault:true})` (atomic), re-render the confirm card with the new address, continue. A failed save is non-blocking (still lets them order this once).
- [ ] **Step 3: Verify (LIVE):** edit → re-pin → label "Casa de un amigo" → save → the address appears in Mi cuenta and is used for the order.
- [ ] **Step 4: Commit** `feat(account): Cambiar edit + label picker (Casa/Trabajo/custom) + re-pin`

## Task B6: Account sheet — saved addresses (select / add / delete)

**Files:** Modify `xpizza-orders/account.js` (+ La Musa twin).

- [ ] **Step 1:** In the account sheet, replace the "Pronto" addresses row with the **real Mis direcciones** list (ported from the mockup): each saved address (label + line), the default marked; tapping one sets it as the delivery target (populate fields + set `default_address`); "+ Agregar" opens the same edit flow (Task B5); a delete affordance calls `deleteAddress` (clearing default atomically if needed). "Mis pedidos" stays **Pronto** (P3).
- [ ] **Step 2: Verify (LIVE):** add a 2nd address, switch default, delete one — the confirm card reflects the selection; deleting the defaulted address doesn't wedge (default clears).
- [ ] **Step 3: Commit** `feat(account): saved-addresses management in Mi cuenta`

## Task B7: Save-on-order (delivery, post-confirmed, opt-in)

**Files:** Modify `xpizza-orders/account.js` + `xpizza-orders/index.html` (post-confirm hook) + La Musa twin.

- [ ] **Step 1:** When a logged-in customer places a **delivery** order with an address that isn't already saved (or edited a one-off), show a subtle **"Guardar esta dirección"** affordance (default-checked) on the confirm/edit surface. Only **after the order is confirmed** — cash: order accepted; online: the return/poll reports **materialized/confirmed** (NOT hosted-checkout creation) — call `saveAddress({..., makeDefault:true})`. A dismissed toggle → don't save. A failed save is ignored (never affects the order).
- [ ] **Step 2: Verify (LIVE):** a first-time logged-in delivery order with "Guardar" on → the address shows in Mi cuenta next visit; with it off → not saved; an online order only saves after payment confirms.
- [ ] **Step 3: Commit** `feat(account): opt-in save-on-order for confirmed delivery addresses`

## Task B8: La Musa parity

**Files:** `la-musa-orders/account.js`, `la-musa-orders/index.html`.

- [ ] **Step 1:** Apply Tasks B1–B7 to La Musa: `account.js` logic byte-identical past the CONFIG block; brand-recolor the confirm card/label chips/avatar to the muted rojo musa; same `index.html` mount points (its "Tus datos" step + field IDs — verify they match: `cname`/`cphone`/`address-detected`/`address-details`/`__restorePos`).
- [ ] **Step 2: Verify (LIVE)** the full flow on orders.lamusa.hn.
- [ ] **Step 3: Commit** `feat(account): La Musa parity for autofill + saved addresses`

## Task B9: End-to-end verification (both forms) — the guarantees

- [ ] **Step 1 — Guest byte-identical:** no marker → zero Firebase/gstatic on load, no confirm card, a guest delivery order's intake POST is unchanged. (Gate-critical.)
- [ ] **Step 2 — Autofill:** logged-in delivery → confirm card prefilled → order carries the saved `address_detected`/`address_details`/lat/lng.
- [ ] **Step 3 — Edit/label/save/select/delete** all work; deleting the default doesn't wedge.
- [ ] **Step 4 — Fail-open:** simulate a slow/blocked account read → the normal form renders within ~1.5s and the order still submits.
- [ ] **Step 5 — Pickup:** logged-in pickup → no address card, unchanged.
- [ ] **Step 6:** Push the branch; hand to advisor for `codex-on-diff`. Do NOT deploy/merge.

---

## Self-review notes
- **Spec coverage:** rules (A1/A2) = the codex-gated rules text + all emulator cases; phone-immutable (B4/B5); guest byte-identical + fail-open (B3/B4/B9); save-on-order opt-in/post-confirmed (B7); address↔order field mapping (B4); chip + keyboard (B1/B2).
- **Type consistency:** `accountSnapshot()`, `saveAddress()`, `deleteAddress()`, `newAddrId()`, `marker()`, `ensureFirebase()`, `heal()`, `renderChip()` used consistently.
- **Deploy order:** Phase A (rules) codex-on-diff → deploy `--only database` FIRST; then Phase B frontend codex-on-diff → Netlify CLI deploy per-folder (xpizzaorders 6f09559f / lamusaorders f8bac377). The frontend must not write addresses before the rules are live.
