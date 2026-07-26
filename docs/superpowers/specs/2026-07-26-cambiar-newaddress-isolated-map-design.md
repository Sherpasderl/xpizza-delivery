# Cambiar "Usar una dirección nueva" — robust isolated-map rebuild — Design Spec

**Date:** 2026-07-26 · Advisor-designed. Supersedes the racey checkout-map fresh-pin approach that failed codex-on-diff R1–R4 on the polish batch. Part of `feat/loggedin-delivery-polish` (both forms). To be codex-design-gated HERE, then built by the order-form executor session, then codex-on-diff HERE, then owner-deployed as ONE batch with the 5 polish fixes.

## Why this rebuild
On a logged-in complete-profile order, "Cambiar → Usar una dirección nueva" needs a fresh pin for a delivery address different from the saved one. The prior approach re-used the **checkout** map (`#map`/`gmap`/global `lat`/`lng`) and tried to force a fresh geolocation on it. That produced FOUR successive races (no marker → stale fullscreen center → async GPS cancel-clobber → dual host-`initMap` GPS → stale-payable seed), because the checkout map has a shared coordinate `processPayment` reads, a 100ms `initMap` timer, and multiple geolocation sources. Every patch relocated the race. Root cause: **the wrong map.**

## The design — route through the already-gated ISOLATED account map
The account "+ Agregar Nueva dirección" flow (`renderNewAddressPane` + the fullscreen twin `openAcctFullscreenMap`/`closeAcctFullscreenMap`, state sink `_nadLat`/`_nadLng`/`_nadDetected`/`_nadPinTouched`, persisted via `saveAddress`) already delivers EXACTLY the owner's described UX — "map loads at my actual location, I move the pin, drop it, it recognizes the address" — and is **isolated by construction**: it writes ONLY `_nad*`, NEVER the checkout `lat`/`lng`/`gmap`/`gmarker`/`fsMap`/`__restorePos`, and requires an explicit user placement (`_nadPinTouched`) before it will save. That isolation makes the entire race class **structurally impossible**: nothing can leak a coordinate into the paid order until the customer has placed a pin and confirmed, and the checkout coordinate is written ONCE, synchronously, from the confirmed value — never from a pending/async/seeded source.

**"Usar una dirección nueva" (from `openCambiarPanel`) opens the isolated new-address pane** (reuse `renderNewAddressPane`'s machinery + the isolated fullscreen map) instead of `enterEditMode(true)` on the checkout map. On confirm, the address applies to the order.

## Owner requirement — BOTH save and one-off
The isolated pane, when opened from Cambiar, presents two outcomes (owner: "let the customer save OR have the just-this-once option"):
- **"Guardar en mi cuenta"** (persist + use): `saveAddress({label, detected:_nadDetected, details, lat:_nadLat, lng:_nadLng, makeDefault: (no other addresses yet)})` → new saved address (shows next time like "Casa") AND applied to THIS order. `_acctAddrOneOff = false`.
- **"Usar solo esta vez"** (one-off, no persist): do NOT call `saveAddress`; apply the confirmed `_nad*` values (+ referencia + a default/implicit label) to THIS order ONLY. `_acctAddrOneOff = true` (so `onOrderConfirmed` never persists/defaults it — the existing one-off contract).

**Recommended UX (confirm at gate):** one primary button **"Usar esta dirección"** + a checkbox **"Guardar en mi cuenta para la próxima"** (default checked). Checked → save+use; unchecked → one-off. (Alternative: two explicit buttons. The checkbox matches DoorDash/UberEats "use + optionally save" and keeps one primary action — advisor recommends the checkbox; gate/owner may pick two buttons.) Both paths require `_nadPinTouched` (explicit placement) — the confirm control is DISABLED until a pin is placed + referencia ≥3 + (label, if shown).

## Applying the confirmed address to the order (codex R1 #2/#3 hardened)
After confirm (either outcome), build the order's delivery state from the CONFIRMED values, synchronously:
- Construct `addr = { id?: res.addrId (save case only), label, detected:_nadDetected, details, lat:_nadLat, lng:_nadLng }`.
- `establishCheckoutFromAddress(addr)` (sets checkout `lat`/`lng` + delivery-zone state).
- **Do NOT call `populateOrderFieldsFromAddress` (codex R1 #2)** — it unconditionally sets `_acctAddrOneOff = false`, which would make a one-off save-eligible. Instead set the fields MANUALLY: `setVal('address-detected', _nadDetected)` + `setVal('address-details', details)`, then set `_acctAddrOneOff` explicitly (see below) AFTER any shared helper runs.
- `placeAccountPin(addr.lat, addr.lng)` for the checkout pin.
- **Detected-string authority (codex R1 #3):** `placeAccountPin`→`placePin` fires an ASYNC checkout reverse-geocode that can overwrite `#address-detected` AFTER we set the confirmed `_nadDetected` → the paid order's address text could drift from what the customer confirmed on the isolated map. The confirmed `_nadDetected` is authoritative (it's what the customer saw + what gets saved). The apply path MUST guarantee `#address-detected` ends as `_nadDetected`: re-assert it after the async settles (or suppress the checkout reverse-geocode for this known-address placement, or use a non-geocoding pin set). Build must prove `#address-detected` == the summary's shown address == the saved address's `detected`, with no async drift. `#address-details` = the referencia (never reverse-geocoded).
- Re-render the reduced summary: `renderS1CompactSummary(_acctData?, addr)` + `renderS2RichSummary(_acctData?, addr)` + `relabelSteps(true)` + `_acctReducedActive = true` + `hideRawAndAddrSection()` + `setReducedDeliveryChromeVisible(true)` (confirmed-summary state; the redundant checkout map stays hidden — Fix 1).
- **Save case:** `_acctAddrId = res.addrId`; update `_acctData.addresses[res.addrId]`; `_acctAddrOneOff = false`. **One-off case:** keep `_acctAddrId` = prior default; `_acctAddrOneOff = true` (never persisted; `onOrderConfirmed` contract unchanged). Set `_acctAddrOneOff` LAST, after every shared helper, so nothing flips it.
- `reducedFlowInvariantOk` check before showing the reduced summary; fail (e.g. out of zone) → normal fillable view (never a hidden-but-invalid summary) — same fail-open as `selectSavedAddressForOrder`.

Because the checkout coordinate is written from `_nad*` (which only ever held an explicitly-placed `_nadPinTouched` pin) and never before confirm, there is NO window where a stale/auto/async coordinate is payable.

## Retained current-order address — survive delivery↔pickup toggle (codex R1 #1)
`setOrderType('delivery')` re-enters `refreshDeliveryUI()` with NO override, which picks `pickDefaultAddress(_acctData)` and rewrites checkout `lat/lng`/fields/summary — clobbering a one-off OR a saved-but-not-default new address if the customer toggles delivery→pickup→delivery before paying. (This also clobbers a saved-address one-off today — pre-existing; fix it uniformly.)
**Fix:** introduce a retained pointer `_acctOrderAddr` = the address currently backing THIS order (set on EVERY order-address selection: default establish, `selectSavedAddressForOrder`, and the new save/one-off confirm). `refreshDeliveryUI` uses `addrOverride || _acctOrderAddr || pickDefaultAddress(_acctData)` as the address, and PRESERVES `_acctAddrOneOff` across the toggle (never resets it on a pure order-type toggle). Clear `_acctOrderAddr` only on sign-out / "otro pedido" reset / an explicit new default. A pickup toggle hides the delivery summary without touching `_acctOrderAddr`/`_acctAddrOneOff`; toggling back to delivery re-applies the SAME order address, one-off intact.

## Revert the racey machinery (delete, don't layer)
Remove from the Cambiar new-address path: the checkout-map pin reset, the `applyFreshPin`/`getCurrentPosition` geolocation, `_acctNewAddrGeoGen` + its bumps in `exitEditMode`/wrapped `setOrderType`, and the `openCambiarPanel` `__restorePos` seed (R1–R4 additions). The isolated-map route replaces all of it. `enterEditMode(true)` is no longer used for Cambiar-new-address (verify no other caller depends on the removed bumps).

## Mount / UX flow — Option A, explicit order-mode semantics (codex R1 #4)
Use **Option A** (codex-confirmed lower-surface): open the account sheet overlay to the new-address pane, but parameterize it with a **mode flag** — `renderNewAddressPane({ mode })` where `mode ∈ {'account-save','order'}`:
- **`'account-save'`** (Mi Cuenta "+ Agregar", UNCHANGED): current behavior — single "Guardar dirección", `saveNewAddressFromPane` persists (makeDefault per hadNoAddresses) + `renderAddressesSection`, back → Mi Cuenta.
- **`'order'`** (from Cambiar): footer = primary **"Usar esta dirección"** + checkbox **"Guardar en mi cuenta para la próxima"** (default checked). Confirm DISABLED until `_nadPinTouched` + `details.trim().length>=3` (+ label if the pane shows one). On confirm → the apply-to-order path above (checkbox checked → save+use; unchecked → one-off). Back/Cancel → return to the Cambiar chooser (or the order summary) WITHOUT saving or mutating the order. Close-sheet/teardown → bump the isolated-map epoch + reset `_nad*` (existing `closeNewAddressPane` teardown), and the order's prior state is untouched (nothing applied unless "Usar esta dirección" was tapped).
The mode flag must thread through the pane render, its footer wiring, its back/cancel target, and the confirm handler. `'account-save'` is the default so every existing "+ Agregar" caller is unchanged.

**Reachability of the isolated map from the order context:** the isolated fullscreen map (`openAcctFullscreenMap`) is invoked from the pane's preview tap; opening the account SHEET over the order form is the existing modal pattern (the account chip already opens it). Verify the sheet open/close from a Cambiar tap restores the order form at the payment step cleanly (no lost cart/stage).

## Non-negotiables (invariants)
- **Isolation (the whole point):** the new-address placement writes ONLY `_nad*`; the checkout `lat`/`lng`/`gmap`/`gmarker`/`fsMap`/`__restorePos` are written ONCE at confirm via `establishCheckoutFromAddress`/`placeAccountPin`, from the confirmed `_nadPinTouched` value. No `getCurrentPosition` ever writes a checkout global. No `initMap`/host-map geolocation in this flow.
- **Explicit placement required** (`_nadPinTouched`) before confirm — no auto/GPS/fallback pin is payable.
- **One-off never persists** (`_acctAddrOneOff` = true; `onOrderConfirmed` contract unchanged).
- **Guest byte-identical**; **money path** otherwise untouched (`processPayment` unchanged); **both forms identical past CONFIG**; **no cheap emoji** (reuse ICON_*); **index.html untouched** (all in `account.js`).
- Ships as ONE batch with the 5 polish fixes (all already gated-clean; the map-hide Fix 1's Cambiar-reveal is now satisfied by this isolated route, not the checkout-map reveal).

## Out of scope
Passkeys, order history, the createprofile pane (unchanged), the account map twin's internals (reused as-is).

## Codex design-gate: R1 REVISE (4 findings, all accepted) → this revision
Folded: (#1) retained `_acctOrderAddr` + preserved `_acctAddrOneOff` so a delivery↔pickup toggle re-applies the SAME order address (fixes one-off clobber, incl. the pre-existing saved-pick case); (#2) manual field set — never `populateOrderFieldsFromAddress` — with `_acctAddrOneOff` set LAST; (#3) `#address-detected` guaranteed to end as the confirmed `_nadDetected` with no async checkout-geocode drift; (#4) explicit `mode:'order'` pane semantics (checkbox footer, confirm-disabled-until-placed, back/cancel/teardown, apply-to-order), `'account-save'` default keeps "+ Agregar" unchanged. Codex cleared: the isolated map is clean, Option A is lower-surface, the racey machinery is the thing to delete.

## Gate focus (codex design-review)
1. Can ANY coordinate reach `processPayment`/the paid order before the customer explicitly placed a pin and confirmed? (Must be no — the checkout global is written once at confirm from `_nadPinTouched` value.)
2. Is the new-address placement fully isolated from the checkout map (zero `getCurrentPosition`/`initMap`/`__restorePos` interaction with checkout globals during placement)?
3. One-off vs save: does one-off truly never persist/default, and does save persist + apply correctly? Does `_acctAddrOneOff` remain honored by `onOrderConfirmed`?
4. Applying to the order: `reducedFlowInvariantOk` fail-open (out-of-zone new address) never leaves a hidden-but-invalid summary; the checkout pin + fields + zone are consistent with the confirmed coordinate.
5. Removing the racey machinery leaves no dangling caller (`enterEditMode(true)` for Cambiar, the `_acctNewAddrGeoGen` bumps, the `__restorePos` seed).
6. Guest byte-identical; both forms identical past CONFIG; index.html untouched.
