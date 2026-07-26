# Logged-in Delivery UX Polish — Design Spec

**Date:** 2026-07-26 · Advisor-designed follow-up to the shipped+LIVE createprofile/reduced-flow. From on-device owner feedback (IMG_0924–0929) on `orders.lamusa.hn`.
**Branch:** `feat/loggedin-delivery-polish` (off live `main` `2b56d21`). **Both forms** (`la-musa-orders` + `xpizza-orders`, account.js byte-identical past the ~20-line CONFIG block; index.html per-brand). Deploy: Netlify CLI per-folder.

## Goal
Five polish fixes to the LOGGED-IN complete-profile delivery experience. One is a real bug against the reduced-flow spec (the s2 delivery map isn't hidden); the other four are visual. Guest byte-identical; the shipped money path (createprofile hard-block, PixelPay, restore guards) must not regress.

## Context (the live reduced flow, as shipped)
For a logged-in COMPLETE-profile user, `refreshDeliveryUI()` (account.js ~L2215) renders the 2-step reduced flow: `renderS1CompactSummary` (s1 "Entregar a" line), `renderS2RichSummary` (the "Entregar a" card atop s2 payment), `relabelSteps(true)`, and `hideRawAndAddrSection()`. The order's lat/lng/address come from the saved address via `establishCheckoutFromAddress` + `populateOrderFieldsFromAddress` (the submit fields are populated then hidden).

## Codex design-gate: R1 REVISE (5 findings, all accepted) → this revision
Folded in: (F4/F5) a single centralized `setReducedDeliveryChromeVisible(show)` helper drives BOTH the s2 map/banner/locinfo AND the `#btn-continuar` label, called from EVERY show/hide branch; (F1) explicit new-address fresh-pin policy for Cambiar; (F2) the thumbnail fails-closed on a HANG (onload-reveal + JS timeout, not onerror-only); (F3) the chip bump uses a logged-in-only selector so the guest "Entrar" chip is byte-identical. **Prereq status:** Maps Static API confirmed ENABLED on the `X Pizza Delivery` project + present in the Maps key's API-restriction list (owner screenshot 2026-07-26); referrers already cover the app origins.

## Centralized visibility helper (codex F4 + F5) — the backbone of #1 and #2
Add ONE function `setReducedDeliveryChromeVisible(hide)` that is the single source of truth for the reduced-flow chrome:
- `hide === true` (reduced flow active): `display:none` on the s2 map wrapper (`document.getElementById('map')?.parentElement`), `document.querySelector('#s2 .zone-notice')`, `document.getElementById('locinfo')`; AND set `#btn-continuar` text to the reduced label (#2).
- `hide === false` (normal/guest/pickup/fail-open): **order-type-aware restore (codex R2)** — restore the map wrapper / `.zone-notice` / `#locinfo` to visible ONLY when `pageOrderType() === 'delivery'`; when `pageOrderType() === 'pickup'` LEAVE them hidden (the host form's native `setOrderType('pickup')` intentionally hides the delivery map/banner/loc card — re-showing them would surface an editable delivery map during pickup, incl. sign-out/delete while in pickup). The `#btn-continuar` label restores to its ORIGINAL text (captured once into a module-level `const _origContinuarText` at first run, never re-derived) REGARDLESS of order type.
Call `setReducedDeliveryChromeVisible(true)` ONLY from the reduced-flow success branch in `refreshDeliveryUI`/`initDeliveryStep` (right where `hideRawAndAddrSection()` is called). Call `setReducedDeliveryChromeVisible(false)` from EVERY branch that currently restores `#raw-name-phone`/`addrSection`: `revertToNormalFillable` (~L2198), `hidePickupDeliverySummary` (~L2252), the sign-out/delete revert (~L1827), the `refreshDeliveryUI` fail-open/guest branch (~L2218), and the selected-saved-address invariant-failure fall-through (`applyCreateProfileFlow` path). This guarantees no exit leaks the hidden chrome. (Base `setOrderType('delivery')` at index.html ~L3814 also restores map/banner/locinfo natively — the helper must be idempotent and not fight it.)

## The five changes

### 1. BUG — hide the redundant editable delivery map on s2 for complete-profile users
**Problem:** `hideRawAndAddrSection()` (account.js ~L2159) hides `#raw-name-phone` and the address `.section` (the `#address-detected`/`#address-details` fields), but leaves visible: the 220px editable `#map` (index.html s2 ~L1301, `<div onclick="openFullscreenMap()"><div id="map">…`), the `.zone-notice` banner ("Entregamos dentro de San Pedro Sula. Mové el pin…", ~L1344), and the `#locinfo` box ("Ubicación confirmada · Podés tocar el mapa para ajustar", ~L1348). So a logged-in user sees a full editable pin-map they have no reason to touch (their address is saved), then the "Entregar a" summary below it — redundant and confusing (owner: "That shouldn't be there since I'm already logged in").

**Fix:** In the reduced-flow success branch ONLY, call `setReducedDeliveryChromeVisible(true)` (the centralized helper above) alongside the existing `hideRawAndAddrSection()`. The order still submits the saved address's lat/lng (unchanged) — the map is purely visual for a complete user. Restore is the helper's `(false)` path, wired into every exit (see the helper section — this closes codex F4).

**Cambiar new-address fresh-pin policy (codex F1 — critical, money-path):** `openCambiarPanel()` (~L2272) jumps to s2 and can `initMap()` while `#map` is `display:none`; `enterEditMode(true)` (~L1071) clears fields + `__restorePos` but does NOT reset `lat`/`lng` or reposition `gmarker` — so "Usar una dirección nueva" can silently sit on the PREVIOUS saved coordinates → wrong pin submitted. The new-address path MUST:
1. Re-show the `#map` wrapper (helper `(false)` or an explicit reveal) BEFORE init.
2. **Reset the pin: null out `lat`/`lng`, remove the existing `gmarker` (`gmarker?.setMap(null)`), clear any `__restorePos`** so no stale coordinate carries over.
3. Establish a FRESH pin: geolocate (the existing GPS path) OR require the customer to confirm via the fullscreen map; do NOT allow submit until a new pin is placed (the existing `processPayment` lat/lng + zone checks enforce this as backstop).
4. Trigger `google.maps.event.trigger(gmap,'resize')` + recenter AFTER reveal (a map shown from `display:none` renders blank tiles otherwise).
Verify the resulting order carries the NEW pin, not the old default. (This tightens a latent pre-existing gap that #1 would otherwise expose.)

**Money-path invariant:** hiding the map must NOT change what `processPayment` reads (lat/lng/zone/address-details) — those come from the saved address and stay populated in the (already-hidden) submit fields. No change to `processPayment`, `openFullscreenMap`, `gmap`, or lat/lng handling.

### 2. Button label — "Confirmar ubicación" → "Continuar al pago" in the reduced flow
`#btn-continuar` (index.html s1 ~L1293) is a static `Continuar → Confirmar ubicación`. For a logged-in complete user there is no location to confirm → **"Continuar al pago"**. Implemented THROUGH the centralized helper (codex F5): the label is set by `setReducedDeliveryChromeVisible(true/false)`, so it relabels in the reduced flow and restores to `_origContinuarText` in ALL of revert / pickup / **sign-out** / **`refreshDeliveryUI` fail-open** / guest — not just `revertToNormalFillable`. Original text captured once, never hardcode-overwritten. No behavior change to `goToLocation()`.

### 3. Real map thumbnail on the saved-address card (replaces the fake CSS map; absorbs the pin ask)
**Problem:** `deliverCardHtml()` (account.js ~L989) renders a decorative FAKE map (`.acct-map` — CSS gradient + rotated `<i>` road-lines + `.acct-blk` blocks + an accent-colored `.acct-pin` teardrop). It's abstract, not the real location — reads as "weird" (owner). Owner also asked the pin match the real map's black balloon (`#1E1B18` circle-on-stick, index.html ~L2496).

**Fix:** Replace the `.acct-map` fake-map block with a **Google Static Maps thumbnail** of the address's actual `lat`/`lng`:
- URL: `https://maps.googleapis.com/maps/api/staticmap?center=<lat>,<lng>&zoom=16&size=<W>x84&scale=2&markers=color:0x1E1B18%7C<lat>,<lng>&key=<MAPS_KEY>` (dark marker to match the black balloon; `scale=2` for retina; height 84 to match the current strip; width sized to the card, e.g. 640). Reuse the SAME Maps JS API key already in index.html — do NOT introduce a new key. Extract it from the page (e.g. parse the existing `maps.googleapis.com/maps/api/js?...key=` script src) or a small shared getter; never hardcode a second copy.
- Render inside the card header where `.acct-map` was.
- **Fail-CLOSED, not just fail-on-error (codex F2):** the card renders in the **no-map layout by DEFAULT** (the map container starts hidden/zero-height). Create the `Image()`/`<img>` and reveal the container ONLY on `onload`. Remove/keep-hidden the container on `onerror` **AND** on a short JS **timeout** (~4s) — because a slow/hanging load never fires `onerror` and would otherwise leave an empty 84px strip indefinitely. Clear the timeout on load/error. NEVER a broken-image icon, never a persistent gap, never block the card. This is why the feature is safe regardless of API/network state — the card only ever GAINS a map when one actually loads in time.
- The tiny `ICON_PIN_SM` glyph next to the "CASA" label is a label icon, not a map pin — leave it (or optionally tint neutral); out of scope for the pin ask, which is satisfied by the thumbnail's dark marker.
- Used by BOTH mounts that call `deliverCardHtml` (`renderConfirmCard` s1-legacy + `renderS2RichSummary` s2). The address always has numeric lat/lng at these call sites (reduced-flow invariant guarantees it); if lat/lng are somehow missing, skip the img entirely (clean fallback), never emit a `staticmap` URL with empty coords.

**PREREQUISITE — DONE (owner-confirmed 2026-07-26):** **Maps Static API** is enabled on the `X Pizza Delivery` project and present in the Maps key's API-restriction list (screenshot). Referrers already cover the app origins (Maps JS loads there today). The fail-closed fallback (F2) keeps the card clean even if any residual restriction mismatch remains, so this is non-blocking regardless.

### 4. "Entregar a" card alignment (s1)
IMG_0924: the s1 "Entregar a" summary reads slightly misaligned. Tighten: match the `.acct-eyebrow` left inset to the card's content inset, and vertically center the avatar against the name/phone (the single-line compact variant `.acct-compact` and the full `.acct-drow` avatar `margin-top:1px` + `align-items:flex-start` can leave the avatar visually high against one line of text). Adjust to `align-items:center` for the compact line; keep the multi-line card balanced. Purely CSS in the injected account styles. No structural/behavior change.

### 5. Logged-in name chip too small (top-right) — logged-in-only (codex F3)
`.acct-chip .acct-nm`/`.acct-av` (account.js ~L54–56) style BOTH the logged-in name chip AND the guest "Entrar" chip (`injectChipStyles` runs from `renderChip()` on every load, guests included) — bumping them directly would change the guest chip → violates guest byte-identical. **Fix with a logged-in-only selector:** `renderChip()` already renders different chip variants (guest uses `.acct-chip--out`); scope the bump to the logged-in variant only — e.g. `.acct-chip:not(.acct-chip--out) .acct-nm { font-size:15px }` (and avatar ~30–32px), leaving the guest `.acct-chip--out` chip's name/avatar EXACTLY as today. Confirm the guest chip is byte-identical (same font-size/avatar) after the change. Keep within the top-right mount without overlapping the brand mark — verify at 360–414px widths.

## Non-negotiables (invariants)
- **Guest byte-identical** — none of these run on the guest path. #1/#2 restore-to-visible must leave the guest DOM/labels/handlers EXACTLY as today; #3 img only ever emitted inside the account card (marker-gated); #4/#5 are account-injected styles. Zero new Firebase SDK on guest load, zero index.html structural change to the guest flow.
- **Money path untouched** — no change to `processPayment`, `openFullscreenMap`/`fsMap`, `gmap`/`gmarker`/`lat`/`lng`/`__restorePos`, the createprofile hard-block (`_acctCreateProfileActive`/`deliverySubmitBlocked`), PixelPay, the R4/R5 restore guards, or `reducedFlowInvariantOk`. #1 only toggles `display` on three visual-only elements; the submit fields it relies on are already populated+hidden.
- **Both forms identical past CONFIG** — every account.js change lands in both; the Static Maps key is read from the page (per-form key), not hardcoded. index.html changes (if any) mirror per brand.
- **No cheap emoji** — reuse existing ICON_* / SVG constants; the black balloon marker via Static Maps `markers=color:0x1E1B18`.
- **Fail-open / graceful** — the thumbnail must degrade to a clean card on any load failure; hiding the s2 map must never leave a logged-in user unable to reach payment (payment is already shown for complete users; #1 doesn't touch payment visibility).

## Out of scope
Passkeys/biometric (future). Order history/reorder (P3). Any change to the createprofile-in-sheet pane or the account fullscreen map twin. Pickup flow (unchanged beyond #1's restore-on-pickup).

## Gate focus (for codex design-review)
1. **#1 restore completeness:** every exit from the reduced flow (revert/pickup/sign-out/Cambiar-new-address/"another order" reset) restores the map+banner+locinfo to visible — can a guest, pickup, or fail-open user ever be left WITHOUT the editable map? And can hiding it ever strand a complete user from payment or corrupt the submitted lat/lng?
2. **#1 Cambiar-new-address:** revealing the hidden `#map` for a new-pin drop renders correctly (resize trigger) and the resulting order carries the right pin.
3. **#3 fallback:** the Static Maps img fails-closed to a clean card on 403/timeout/offline — no broken image, no gap, no card breakage; the key is reused (not duplicated) and per-form.
4. **Guest byte-identical** under all five.
5. **Both forms identical past CONFIG.**
