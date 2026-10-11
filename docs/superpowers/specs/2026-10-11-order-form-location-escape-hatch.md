# Order-form location escape hatch (Phase 1) — spec + handback

**Date:** 2026-10-11 · **Surface:** `la-musa-orders/index.html` + `xpizza-orders/index.html` (customer order forms; Netlify git-CD from main). **Base:** REBASED onto `origin/main` @ `ccc4fcf` (was 59fd064; PB-1 Add-Product Phase B landed). **Branch:** `feat/order-form-location-escape-hatch`.

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

## REVISE round 3 (re-gate on 0819172 — PRODUCTION CODE BLESSED; 3 test-vacuity fixes only)

The re-gate confirmed the production form fix is clean (both races closed, no `__locPicking` lockout, happy path byte-identical, all invariants intact). Production JS left EXACTLY as-is; only `order-form-location-escape.test.js` changed:

1. **Concurrency test was structurally skippable.** The invocation-count asserts sat after `await pick2`; if serialization were removed, `pick2` would await an unresolved details fetch and Node could exit 0 before the asserts ran. Fix: assert the counts SYNCHRONOUSLY right after calling the 2nd pick, THEN `await pick2`. Proven non-vacuous by mutation (removing `locPickPred`'s `if(__locPicking) return` makes the 2nd pick invoke a details fetch → the sync assert fails).
2. **Moved-pin recovery now proven in-context.** Replaced the fresh-harness positive control with a SUBSEQUENT pick through the SAME harness after the moved-pin cancel — asserts its details invocation + placement, proving `__locPicking` was released on the cancel path.
3. **Resumed search now settled.** After the pick, the resumed request is resolved and the rendered rows asserted (not left pending).

Test now 30/30; all three guards (unconditional-clear, debounce-cancel/suppress, pick-serialize) proven non-vacuous by mutation. No production change, so the forms remain byte-identical to the already-green 0819172.

## REVISE round 4 (REBASE onto real main ccc4fcf — 2 codex P1 found against PB-1; both fixed)

origin/main had moved to `ccc4fcf` (PB-1 Add-Product Phase B server code, dormant). A full review on the REAL main found 2 P1 blockers the earlier isolated gate (off stale 59fd064, stubbed submit) missed. Rebased (package.json test-chain resolved as a union — 265 steps) and fixed both, diff kept tight to the location code:

1. **P1-1 🔴 checkout could submit the fallback coords mid-pick.** `locPickPred` awaits `place.fetchFields` with `__locPicking=true`, but `processPayment` never checked it — a Confirmar tap during the details fetch shipped the pre-pick default 15.5003,-88.025. FIX: `locPickPred` sets `__locPickPromise` (resolved in `finally`, every exit); `processPayment` awaits it at the top of its try so checkout waits for the pin to settle. Null on the GPS-OK path → byte-identical. Confined to the search flow. See memory [[client-interaction-guard-misses-submit-path]].
2. **P1-2 🔴 telemetry fields fail-closed PB-1's reward fast path.** `catalog/charge-inputs.js` `chargeInputsFingerprint` returns null on ANY unclassified body field; `client_user_agent`/`client_referrer` are unclassified → their presence nulled the fingerprint, disabling reward bound-checkout reuse (and they persist nowhere). FIX: REMOVED both fields from `buildOrder` in both forms; reverted the cart-identity-order golden + the harness referrer param. Telemetry re-scoped as a future slice (persist + classify together). See memories [[order-field-must-be-classified-in-charge-inputs]], [[phase1-telemetry-no-server-sink]].

New tests (both wired into the chain, union-by-count → 265):
- `charge-inputs-form-bodies.guard.test.mjs` — captures the REAL createOrder/chargeOnlineOrder/quote bodies from both forms and asserts `chargeInputsFingerprint` is non-null; FAILS if any new form field is unclassified (stops a P1-2 repeat). 2/2.
- `location-pick-submit-sync.test.mjs` — drives the REAL `processPayment` on both forms, cash AND card, with a HELD details promise: asserts nothing is submitted during the pick, then that createOrder/chargeOnlineOrder carry the PICKED lat/lng, not the fallback. 8/8.
- `order-form-location-escape.test.js` — telemetry assertions removed (now 28). cart-identity-order + form-harness reverted to main (no telemetry).

Observation (NOT this feature; pre-existing, flagged to the advisor): X.Pizza `placePin` has an UNGUARDED `document.getElementById('btnConfirm').disabled=false` and no element with that id exists — it throws (swallowed in the async geolocation callback) on every pin placement. Out of scope here (placePin byte-unchanged); worth a separate fix.

## REVISE round 5 (gate on 47ffd81 — original P1s closed; the P1-1 fix introduced 1 new P1 + 2 test gaps)

1. **NEW P1 🔴 — the mid-pick wait was UNBOUNDED (could lock checkout forever).** `locPickPred` awaited `place.fetchFields` with no timeout; a hung socket (the flaky-webview case this feature targets) → `finally` never runs → `__locPickPromise` never resolves → `processPayment` awaits forever. FIX: `locPickPred` now RACES `fetchFields` against a timeout (`window.__LOC_PICK_TIMEOUT_MS || 8000`); on timeout/reject it ABANDONS the pick — does NOT place (card stays "aproximada"), the late result is discarded by the race (never wired to `placePin`, so it can't move the pin or feed a later submit), and it sets `__locPickFailed`. `processPayment` bounds its own wait (defense) and, if `__locPickFailed`, REFUSES the submit — calls no createOrder/chargeOnlineOrder, shows "No pudimos ubicar esa dirección. Elegila de nuevo o ajustá el mapa.", leaves the search open. So: no hang AND no silent fallback submit. Narrow + search-flow-confined (not the owner-declined universal confirm gate); null on GPS-OK → byte-identical. See memory [[client-interaction-guard-misses-submit-path]].
2. **TEST — charge-inputs guard was vacuous on the quote path** (skipped undefined, only required cash-create + card-charge). FIX: now REQUIRES a real `quoteOrder` body per form (asserts captured, not undefined) before fingerprinting; dropped the two-create premise.
3. **TEST — real-submit test accepted either charge OR create on the card path.** FIX: assert cash → `createOrder` and card → `chargeOnlineOrder` INDEPENDENTLY (the hosted-card flow issues no client createOrder). Added 2 cells per form: a HUNG details fetch → checkout REFUSED (no submit, card "aproximada", message) + a LATE result post-timeout is inert and a subsequent clean pick submits its own coords. `location-pick-submit-sync` now 12/12; the await-removal negative control is retained (processPayment-submits-during-pick assertion fails without the guard — mutation-verified).

byte-identical across forms (locPickPred + the processPayment guard block diff-clean); happy path byte-identical.

## Separate (surfaced to owner — NOT in this diff)

Telemetry (#3) transmits `client_user_agent`/`client_referrer` but the server does NOT persist them (`createOrder` / `create-order-build.js` writes only known fields), so Phase-1 telemetry currently measures nothing — even "later". Delivering its purpose needs a small additive functions change (persist the 2 fields onto the order node) with its own gate + deploy. Held as an owner call; the transmission code is correct, it just has no sink yet. See memory [[phase1-telemetry-no-server-sink]].

## Handback

Executor built + ran non-codex tests + self-reviewed. Branch `feat/order-form-location-escape-hatch` off `origin/main` 59fd064. → advisor runs the single codex gate (fidelity-to-mockup + no-regression).
