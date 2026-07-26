# Cambiar "Usar una dirección nueva" — isolated-map rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rebuild "Cambiar → Usar una dirección nueva" (logged-in checkout) to use the ALREADY-GATED isolated account map instead of the checkout map — eliminating the wrong-coordinate race class by construction. Spec: `docs/superpowers/specs/2026-07-26-cambiar-newaddress-isolated-map-design.md` (codex design-gate APPROVED R2). Ships as ONE batch with the 5 polish fixes already on this branch.

**Branch:** `feat/loggedin-delivery-polish` (currently at `2efedfd`). All work in `la-musa-orders/account.js`, mirrored byte-identical past CONFIG into `xpizza-orders/account.js`. **index.html UNTOUCHED.**

**Architecture:** The isolated map (`renderNewAddressPane` + `openAcctFullscreenMap`/`closeAcctFullscreenMap`, sink `_nadLat/_nadLng/_nadDetected/_nadPinTouched`, `saveAddress`) writes ONLY `_nad*`. The order's checkout coordinate is written ONCE at confirm, from the explicitly-placed `_nad*`. No checkout-map geolocation.

---

## Ground rules (every task)
- Edit `la-musa-orders/account.js`; mirror to `xpizza-orders/account.js` (Task 6). Verify identical past CONFIG with a Node compare.
- index.html UNTOUCHED (`git diff --stat 2b56d21..HEAD -- '*index.html'` empty).
- Money path: no change to `processPayment`/`openFullscreenMap`/`fsMap`; the ONLY checkout-global writes in this flow are at confirm via `establishCheckoutFromAddress`/`placeAccountPin`, from confirmed `_nad*`.
- No cheap emoji (reuse ICON_*). Guest byte-identical. Commit per task.

---

## Task 1: Delete the racey checkout-map new-address machinery

**Files:** `la-musa-orders/account.js` — `openCambiarPanel`'s new-address handler (~L2374) + the R1–R4 additions.

- [ ] **Step 1: Remove** from the "Usar una dirección nueva" handler: the `__restorePos` reset/seed, `lat=null;lng=null`, `gmarker` removal, `google.maps.event.trigger(gmap,'resize')`, `_acctNewAddrGeoGen`/`applyFreshPin`/`navigator.geolocation.getCurrentPosition`, and the `enterEditMode(true)` call (for this Cambiar path). Also remove the `openCambiarPanel` `__restorePos` seed block and the `_acctNewAddrGeoGen++` bumps in `exitEditMode` and the wrapped `setOrderType` (added in R2/R3). Leave the SAVED-address path (`selectSavedAddressForOrder`) and "+ Agregar" untouched.
- [ ] **Step 2: Grep** for any remaining reference to `_acctNewAddrGeoGen`/`applyFreshPin` — must be zero. Confirm `enterEditMode`/`exitEditMode` still used by their OTHER callers (the edit-saved-address flow) and those are unchanged.
- [ ] **Step 3: Commit** — `refactor(cambiar): remove racey checkout-map new-address machinery (superseded by isolated map)`

---

## Task 2: `renderNewAddressPane({ mode })` — order-mode footer + confirm gate

**Files:** `la-musa-orders/account.js` — `renderNewAddressPane` (~L1612), its footer wiring, `saveNewAddressFromPane` (~L1806).

- [ ] **Step 1:** Add a `mode` param (default `'account-save'`). In `'account-save'`, current behavior EXACTLY (single "Guardar dirección" → `saveNewAddressFromPane` persists + back to Mi Cuenta). In `'order'`: render the footer as a primary button **"Usar esta dirección"** + a checkbox **"Guardar en mi cuenta para la próxima"** (default CHECKED), and the back/cancel target returns to the order (see Task 4), not Mi Cuenta.
- [ ] **Step 2:** Confirm-disabled gate (both modes already require `_nadPinTouched`): the order-mode confirm button is disabled until `_nadPinTouched === true` AND `details.trim().length >= 3` (+ label if the pane shows one). Wire a live refresh on pin-commit (`commitAcctPin`) and referencia input.
- [ ] **Step 3:** Order-mode confirm handler calls `confirmNewAddressForOrder(saveToAccount)` (Task 3) with the checkbox state. `'account-save'` mode keeps calling `saveNewAddressFromPane` unchanged.
- [ ] **Step 4: Commit** — `feat(cambiar): renderNewAddressPane order-mode (checkbox save/one-off + confirm gate)`

---

## Task 3: `confirmNewAddressForOrder(saveToAccount)` — apply to the order (the ONLY checkout write)

**Files:** `la-musa-orders/account.js` — new function; reuse `saveAddress`, `establishCheckoutFromAddress`, `placeAccountPin`, `reducedFlowInvariantOk`, `renderS1CompactSummary`/`renderS2RichSummary`, `setReducedDeliveryChromeVisible`, `hideRawAndAddrSection`.

- [ ] **Step 1:** Re-validate `_nadPinTouched` + numeric `_nadLat/_nadLng` + `_nadDetected` + `details>=3` inside the handler (defense-in-depth; never trust the disabled button). If invalid → inline error, no write.
- [ ] **Step 2: Save case (`saveToAccount === true`):** `const res = await saveAddress({ label, detected:_nadDetected, details, lat:_nadLat, lng:_nadLng, makeDefault: <no other addresses yet> });` on `!res.ok` → inline error, abort. On ok: `addr = { id:res.addrId, label, detected:_nadDetected, details, lat:_nadLat, lng:_nadLng }`; update `_acctData.addresses[res.addrId]`; `_acctAddrId = res.addrId`.
- [ ] **Step 3: One-off case (`saveToAccount === false`):** NO `saveAddress`. `addr = { label:(label||'Otra'), detected:_nadDetected, details, lat:_nadLat, lng:_nadLng }` (no id); keep `_acctAddrId` = prior default.
- [ ] **Step 4: Apply to order (both cases), in this order:**
  1. `establishCheckoutFromAddress(addr)` (checkout lat/lng + zone).
  2. Manual fields — `setVal('address-detected', _nadDetected); setVal('address-details', details);` — do **NOT** call `populateOrderFieldsFromAddress` (it resets `_acctAddrOneOff`).
  3. `placeAccountPin(addr.lat, addr.lng)`.
  4. **Detected-string authority (codex R1 #3):** `placeAccountPin`→`placePin` triggers an async checkout reverse-geocode that overwrites `#address-detected`. Guarantee `#address-detected` ends as `_nadDetected` — the robust way: after `placeAccountPin`, capture a token and re-assert `setVal('address-detected', _nadDetected)`; if the checkout `reverseGeocode` is async, also re-assert on the next tick / after it resolves (e.g. a short `setTimeout` re-assert guarded by "still this order address"), OR suppress the checkout geocode for this known-address placement. **PROOF REQUIRED:** after the flow settles, `#address-detected` == `addr.detected` == (save case) the saved address's `detected`. Test with a coordinate whose checkout-geocode formats differently from `_nadDetected`.
  5. `_acctOrderAddr = addr` (Task 5 retained pointer).
  6. `reducedFlowInvariantOk(_acctData, addr)` → true: `renderS1CompactSummary(_acctData, addr)` + `renderS2RichSummary(_acctData, addr)` + `relabelSteps(true)` + `_acctReducedActive = true` + `hideRawAndAddrSection()` + `setReducedDeliveryChromeVisible(true)`. → false (out of zone): fall to the normal fillable view (mirror `selectSavedAddressForOrder`'s fail-open), never a hidden-but-invalid summary.
  7. **Set `_acctAddrOneOff` LAST:** `false` (save) / `true` (one-off) — after every shared helper, so nothing flips it.
  8. Close the account sheet back to the order at the payment step; toast ("Dirección actualizada para este pedido" / "Dirección guardada").
- [ ] **Step 5: Commit** — `feat(cambiar): confirmNewAddressForOrder — apply confirmed isolated-map address to the order (save/one-off)`

---

## Task 4: Wire "Usar una dirección nueva" → open the order-mode pane

**Files:** `la-musa-orders/account.js` — `openCambiarPanel`'s `#acct-cambiar-new` handler.

- [ ] **Step 1:** Replace the (now-deleted) handler body with: open the account sheet overlay to `renderNewAddressPane({ mode: 'order' })` (fresh `_nad*` reset as the pane already does). Back/Cancel from the order-mode pane returns to the Cambiar chooser (or the order summary) WITHOUT applying anything; close-sheet teardown resets `_nad*` (existing `closeNewAddressPane`).
- [ ] **Step 2:** Verify opening/closing the account sheet from the order form restores the order at the payment step (cart + stage intact) — the account chip already opens this sheet, reuse that open path.
- [ ] **Step 3: Commit** — `feat(cambiar): route Usar-una-direccion-nueva to the order-mode isolated-map pane`

---

## Task 5: Retained `_acctOrderAddr` — survive delivery↔pickup toggle

**Files:** `la-musa-orders/account.js` — declare state; `refreshDeliveryUI` (~L2215); the wrapped `setOrderType`; `selectSavedAddressForOrder`; the default establish in `refreshDeliveryUI`'s complete branch; sign-out/reset.

- [ ] **Step 1:** `let _acctOrderAddr = null;` Set it to the current order address in: the reduced-flow default establish (`refreshDeliveryUI` complete branch), `selectSavedAddressForOrder`, and `confirmNewAddressForOrder` (Task 3). Clear on sign-out/delete revert and "otro pedido"/`startAnotherOrder` reset.
- [ ] **Step 2:** In `refreshDeliveryUI`, use `const addr = addrOverride || _acctOrderAddr || pickDefaultAddress(_acctData);` and PRESERVE `_acctAddrOneOff` across a pure order-type toggle (do not reset it in the delivery re-apply). A pickup toggle hides the delivery summary without touching `_acctOrderAddr`/`_acctAddrOneOff`; toggling back re-applies the SAME order address, one-off intact.
- [ ] **Step 3: Verify** — pick a one-off (saved OR new) → toggle delivery→pickup→delivery → the one-off address (not the default) is still on the order, `_acctAddrOneOff` still true. Save-but-not-default new address survives a toggle too.
- [ ] **Step 4: Commit** — `feat(cambiar): retained _acctOrderAddr so a one-off/new address survives a delivery<->pickup toggle`

---

## Task 6: Mirror to X. Pizza + guest-safety + self-review

- [ ] **Step 1:** Port Tasks 1–5 into `xpizza-orders/account.js` below CONFIG; Node-compare → identical past CONFIG.
- [ ] **Step 2:** Guest-safety (both forms, agent-browser `~/.npm-global/bin`): no account Firebase SDK on guest load, guest flow unchanged, index.html untouched.
- [ ] **Step 3: The core proofs** — (a) no checkout-global write happens before an explicit `_nadPinTouched` placement + confirm (grep every `lat=`/`lng=`/`gmap`/`establishCheckoutFromAddress`/`placeAccountPin` in this flow); (b) `#address-detected` == confirmed `_nadDetected` == saved `detected` after the flow settles (no async drift); (c) one-off never persists (`_acctAddrOneOff` true → `onOrderConfirmed` skips); (d) delivery↔pickup toggle preserves the chosen address.
- [ ] **Step 4:** Push `feat/loggedin-delivery-polish`, report the new tip SHA for codex-on-diff. No deploy/merge.

---

## Self-Review (author, pre-handoff)
- **Spec coverage:** delete racey machinery (T1), order-mode pane (T2), apply-to-order with one-off + detected-authority (T3), wiring (T4), toggle-survival (T5), mirror+proofs (T6). All 4 codex R1 findings covered.
- **Watch:** T3 Step 4.4 (detected-string async drift) is the subtle one — codex's explicit build-time proof; do not hand back without demonstrating `#address-detected` doesn't drift. `_acctAddrOneOff` must be the LAST write in T3.
- **Placeholder scan:** none — concrete functions/fields throughout.
