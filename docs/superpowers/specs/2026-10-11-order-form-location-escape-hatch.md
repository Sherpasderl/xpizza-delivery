# Order-form location escape hatch (Phase 1) — spec + handback

**Date:** 2026-10-11 · **Surface:** `la-musa-orders/index.html` + `xpizza-orders/index.html` (customer order forms; Netlify git-CD from main). **Base:** `origin/main` @ `59fd064`. **Branch:** `feat/order-form-location-escape-hatch`.

Client-only (two static forms). **No** server / functions / RTDB / money / pricing / factura change. Additive; the GPS-OK happy path is byte-identical to today (the hard owner constraint).

## Why (owner-reported trigger)

La Musa order PZX-261010-173439 (Marco Cerrato) submitted at lat/lng **exactly 15.5003,-88.025** — the form's hardcoded default/fallback center. `navigator.geolocation` failed (likely an Instagram in-app webview: the map renders but geolocation dies), and the only reposition affordance discoverable in that state left him stranded at the default pin. See memory [[orderform-default-pin-geoloc-fail]].

## What shipped (owner ruling: OPTION A — "Zero friction and we do not break what already works")

Three changes, both forms, strictly additive:

1. **#1 inline tap-to-place — DROPPED (was inert).** The spec originally called for `gmap.addListener('click', …placePin)`. Verified on the LIVE forms: the inline `#map` is `pointer-events:none` and its wrapper is `onclick="openFullscreenMap()"` — tapping the inline map opens the fullscreen center-pin editor; a `gmap` 'click' never fires (`elementFromPoint` at the map centre resolves to the openFullscreenMap wrapper). So the listener was dead code on both forms and was removed. Repositioning stays the EXISTING fullscreen editor — unchanged. See memory [[order-form-inline-map-is-preview]].

2. **#2 fail-state address SEARCH (the real new escape hatch).** A search box + our own predictions dropdown, revealed **only** when `updateLocInfo(fallback=true)` (i.e. geolocation failed). Works with no GPS / inside a webview. Picking a prediction reuses `placePin(lat,lng,false)` — the SAME write path as GPS/drag (no new order/write path) — which flips the loc-card to the green "Ubicación capturada" state and runs `checkDeliveryRadius`. On the GPS-OK happy path `#loc-search-wrap` stays `display:none` → byte-identical to today.
   - Modern Places API (`AutocompleteSuggestion.fetchAutocompleteSuggestions` + `Place.fetchFields(['location'])`) with a per-session `AutocompleteSessionToken` (reset after each details fetch — correct billing).
   - Scoped to **this restaurant's delivery zone** via `locationRestriction` derived from the form's own `RESTAURANT_LAT/LNG` + `DELIVERY_RADIUS_KM` (padded ×1.4) — brand-agnostic, no hardcoded SPS box; prevents a customer pinning another city (the soft `locationBias` was too weak — "escuela americana" returned the Tegucigalpa school).
   - Prediction text rendered via `textContent` (never `innerHTML`) so an attacker-controlled place name can't inject markup. Fails **quiet**: if Places errors/returns nothing, the map→fullscreen editor still works.
   - Fail-state loc-card copy: *"Ubicación aproximada — No detectamos tu GPS. Buscá arriba, o tocá el mapa para abrir el ajuste."* (line warning-triangle icon; no emoji). Fail-state map hint chip: *"Tocá el mapa para ajustarlo"* (tap opens the existing fullscreen editor — no inline placement implied). Both touched **only** when `fallback=true`, so the happy-path chip/card stay byte-identical.

3. **#3 UA + referrer telemetry.** `client_user_agent: navigator.userAgent` + `client_referrer: document.referrer` added to the submit payload (invisible; nothing reads them yet) to diagnose in-app-webview GPS failures. `createOrder`/`validateOrderPayload` tolerate extra fields (no unknown-field rejection).

**Brand parity:** the search machinery (CSS block, HTML, JS block, `updateLocInfo` additions) is **byte-identical** across both forms; only the two additive brand tokens differ in value (`--gold-ring`, `--pred-hot`). Grep + diff verified.

## Places pre-check (owner/GCP dependency — PASSED)

Verified in a real browser on the LIVE origin `https://orders.lamusa.hn` with the existing key (`AIzaSyAuzSLAELV…`): autocomplete returns predictions (status OK) AND `Place`/geometry resolves to lat/lng (e.g. "Mall Multiplaza…" → 15.49388,-88.03420), on both the modern and legacy APIs. `locationRestriction` + `sessionToken` accepted; `mainText`/`secondaryText` present. The key's referrer allowlist includes the live origin and Places billing is active.

## No-regression proof

- `order-form-location-escape.test.js` — **14/14** (new, wired into the npm chain after `form-load-execution.test.js`). Includes a **runtime** transition test: the REAL `updateLocInfo` + escape-hatch JS is sliced from each form and executed against a jsdom DOM — `fallback=true` reveals the search + sets the aviso/chip; a prediction pick calls `placePin(lat,lng,false)`; `fallback=false` hides the search + flips to the green confirmed card. Also: inert listener gone, `placePin` body byte-unchanged vs origin/main, telemetry present, machinery parity.
- `cart-identity-order.test.mjs` (complete-golden form-reader) — updated to handle the 2 telemetry fields: asserts each payload carries its window's **live** `navigator.userAgent`/`document.referrer`, then freezes them like the `order_id`/`timestamp` nonces (env-derived, not order content — baking a jsdom UA string into the golden would assert nothing). Green.
- Full `xpizza-functions` `npm test`: green through the chain **except** the pre-existing `tools/emulator-ports.guard.test.js` (step 239/262) — proven to fail byte-identically on a pristine `origin/main` worktree in this emulator-less session (env class, zero of my changes). See memory [[npm-test-emulator-ports-guard-env-red]]. The 23 chain steps **after** the guard were run individually → **23/23 green**.

## Mockup fidelity (Option A comp — https://claude.ai/artifact/NtD5NcL73RnshqJSk92r83)

Search box above the map (cream bg, 1.5px `--border2`, gold `:focus-within` ring `0 0 0 3px var(--gold-ring)`, monochrome line search icon); our own predictions dropdown (white, `--border` rows, line map-pin in `--gold`, bold `.t` + muted `.s`, first row `--pred-hot`); fail-state loc-card with the warning-triangle icon + copy; fail-state chip copy. GPS-OK = byte-identical to today.

## Out of scope (owner declined)

Universal "confirmá tu ubicación" gate; center-fixed-pin redesign; making the inline map directly interactive; forcing users out of the webview. (Phase 2 may revisit the pin redesign per the telemetry.)

## REVISE round 1 (codex gate on 1f3a2ac — hard gate PASSED; these contained to the new async search)

1. **Stale/race on predictions (🔴).** Added a monotonic request-generation guard (`__locReqSeq`): every input change and every new fetch bumps it; a response renders only if its captured generation is still current, so a late/out-of-order older response can never repopulate over a newer query. Old rows are now CLEARED on every error AND Places-unavailable path (`locHidePreds()` in the `catch` and the unavailable branch) — a stale, wrong result can no longer stay visible + selectable.
2. **Selection + token lifecycle (🔴).** `locPickPred` now: serializes (`__locPicking` guard — a second pick mid-flight is ignored); retires the session token in `finally` (any outcome, including a rejected `fetchFields` — Google ends the session on a details fetch); and refuses to clobber a point the customer set WHILE the details fetch was in flight (captures lat/lng before `await`, bails if they moved — a map tap/drag wins over a late pick).
3. **Tests.** `order-form-location-escape.test.js` now 22/22 — adds runtime race coverage (populate-then-clear-on-reject, populate-then-clear-on-unavailable, late/out-of-order response ignored, token-retired-on-reject, concurrent-pick serialized, pin-moved-meanwhile guard + positive control), driven through the REAL sliced source with a hand-controlled mock Places. `cart-identity-order.test.mjs` now loads the form with a NON-EMPTY referrer (`https://l.instagram.com/`) so the `client_referrer === document.referrer` assertion is non-vacuous (a hardcoded `''` would now fail); `form-harness.mjs` gained an optional `referrer` param (additive; default behavior unchanged for all other callers).
4. **Minor fidelity.** Prediction title `.loc-pred .t` weight 500 → 700 (bold) to match the mockup.

Still byte-identical across both forms (JS block diff-clean; only `--gold-ring`/`--pred-hot` values differ). Happy path untouched.

## REVISE round 2 (re-gate on c2dc3ff — hard gate re-proven; two residual races closed)

1. **Already-rendered rows stayed clickable during the next query (🔴).** Bumping `__locReqSeq` invalidated the pending RESPONSE but left the on-screen rows (and their click handlers) live through the next debounce+fetch. Fix: `locSearchInput` now calls `locHidePreds()` on EVERY input change (not only below threshold), so a stale row can't be clicked while the next query resolves.
2. **Debounce survived a pick / searches ran during the details fetch (🔴).** Fix: `locPickPred` now `clearTimeout(__locSearchTimer)` on accept (cancels a queued debounce), and `locSearchInput` returns early while `__locPicking` is true (no search mid-selection); the session resumes after the `finally` settles (fresh token).
3. **Tests hardened.** `order-form-location-escape.test.js` now 30/30 with a CONTROLLABLE debounce timer (the stub now captures + fires callbacks, so the debounce path is actually exercised) and a details-fetch invocation counter: adds unconditional-clear-on-query-change, below-threshold invalidation, both response orderings (older-last AND newest-first/older-late), exactly-one-details-invocation + recovery-after-reject, and pick-cancels-debounce + no-search-during-pick. Non-vacuity proven by mutation: removing the unconditional clear fails the #1 case; removing the debounce-cancel/suppress fails the #2 case.

Still byte-identical across both forms (JS block 74 lines, diff-clean). Happy path untouched.

## Separate (surfaced to owner — NOT in this diff)

Telemetry (#3) transmits `client_user_agent`/`client_referrer` but the server does NOT persist them (`createOrder` / `create-order-build.js` writes only known fields), so Phase-1 telemetry currently measures nothing — even "later". Delivering its purpose needs a small additive functions change (persist the 2 fields onto the order node) with its own gate + deploy. Held as an owner call; the transmission code is correct, it just has no sink yet. See memory [[phase1-telemetry-no-server-sink]].

## Handback

Executor built + ran non-codex tests + self-reviewed. Branch `feat/order-form-location-escape-hatch` off `origin/main` 59fd064. → advisor runs the single codex gate (fidelity-to-mockup + no-regression).
