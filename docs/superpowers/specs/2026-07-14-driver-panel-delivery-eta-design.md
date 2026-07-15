# Driver Control Panel + Delivery ETA — Design Spec

**Date:** 2026-07-14 · **Owner (build):** dispatch session · **Gate:** advisor before build.
**Status:** design-approved with Xavier across the research thread; ready for the advisor gate.

---

## 0. One-line

Turn the dispatch driver from a *pin you look at* into a *panel you act on* — anchored by a **live delivery ETA** — with every number on the board grounded in **data, never a guess.**

## 1. Goal & governing principle

- **Goal:** click a driver → a compact panel with the info + actions a dispatcher actually needs, headlined by a real delivery ETA (Waze-grade), including honest handling of your ≤2-order stacks.
- **Governing principle (Xavier, non-negotiable):** *build on data, not guessing.* Concretely, every ETA on the board is derived from present-tense, measured inputs (live GPS, a real routing engine, a committed/computed sequence, and a **validated** prep signal) — we never fabricate a number we can't stand behind.

This principle is the spine of the whole spec; §5 is where it's enforced.

## 2. Where the platform stands (benchmark scorecard)

From the industry benchmark (Onfleet, Bringg, Tookan, Shipday, Detrack, Circuit, Routific, GetSwift, Samsara, Verizon, Meituan, DoorDash):

| Table stake | Status |
|---|---|
| Live location + status, current task, assign/reassign, driver status | ✅ have |
| **Delivery ETA (on-time / arrival)** | ❌ — *the #1 gap; every delivery leader has it* (this spec's anchor) |
| Dispatcher→driver 1:1 message | ❌ (Phase 3, net-new channel) |
| Deactivate/suspend | ❌ (later) |

The **ETA is the one near-universal capability we lack** and the highest-leverage single add — it's what turns the console from *tracking* into *managing*.

## 3. Scope & non-goals

**In scope (v1):** a per-driver panel on `xpizza-dispatch/index.html` (client), anchored by a live single-delivery ETA, plus cheap per-driver actions; then a 2-order cascading stacked ETA that consumes the ready-time predictor.

**Non-goals / deliberately dropped (with reasons):**
- **Dispatch-to-nearest** — that's an *order-side* action (choose a driver *for an order*), not something you do *to* one driver. Belongs on the unassigned-order flow. *Separate future feature.*
- **N>2 stacking ETA** — needs a committed route-planning layer ("Meituan-lite"); out of scope because your max stack is **2** (see §5.3, which is tractable precisely because of that ceiling).
- **A trained ETA/travel-time model (DeepETA-style)** — unnecessary at your scale; Google/Waze is the routing baseline and a static dwell buffer is the "residual." *Cut.*
- **`AdvancedMarkerElement`** — would need a `mapId` that disables the inline `DARK_MAP_STYLE`. *Cut (as in Item A).*

## 4. The driver panel (enrich the existing expand — no new drawer)

The driver row **already expands** to show that driver's orders (`renderDriverNode` → `renderTaskRow`). Upgrade that expansion to three parts:

1. **Info card:** name · status + GPS-liveness dot (have) · last-known location "hace N" (have) · *(Phase 2: phone battery)*.
2. **Order rows — the anchor:** each active order shows its **ETA** (see §5): `llega ≈ 12 min · ~7:42 PM`. Before pickup: a stage label ("en cocina" / "en restaurante"), no ETA.
3. **Actions row** (§6): Llamar · Ver última ubicación · Reasignar pedido · Sacar de turno.

Reuses the existing `showActionMenu` component and the existing expand/pan behavior.

## 5. The ETA model (the heart)

### 5.1 Two legs, one number

> **customer ETA = kitchen leg + delivery leg**
> = `ready_at` (prep) + `travel(pickup → customer)` + `dwell`

- **Kitchen leg** = the **ready-time predictor** (predicts `ready_at`). Already built — as **pure shadow** (writes only `order_predictions`/`prediction_logs`/`ready_time_model`, never `/orders`; `index.js:2935–2961`). This is exactly the `P_i` (prep-remaining) input.
- **Delivery leg** = **Google routing**, client-side via `google.maps.DirectionsService` (same Maps key already loaded; traffic-aware via `departureTime: now`). This is new.
- **Dwell** = `S_customer` (find door / apartment / handoff) + `S_merchant` (grab bag) — **static config buffers**, with an apartment-vs-house refinement later (the DeepETA "residual," done deterministically).

### 5.2 Single-delivery ETA — data-certain, **no predictor needed**

**Shown only once the order is `out_for_delivery`.** By then prep is *done*: the KDS **"Listo"** was tapped (your ops-enforced ready ground truth) and the driver physically has the food. So the kitchen leg is in the past and:

> `ETA = now + Directions(driver → customer) + S_customer`

Every input is present-tense and measured. **No prediction, no promise, no guess.** This is the common case and the v1 anchor.

### 5.3 2-order cascading stacked ETA — brute-force, not guess

Your **max stack is 2**, which collapses the hard part: instead of *inferring* a sequence (a guess), you **enumerate the ≤2 valid delivery orderings, compute each with real data, and commit the optimal.** That converts "guess" → "compute."

Cascading timeline (same-restaurant stack, both picked up; `D(A→B)` = Directions road time):

```
Sequence α:  ETA_C1 = now + D(driver→C1) + S_cust
             ETA_C2 = ETA_C1 + D(C1→C2) + S_cust
Sequence β:  (drop C2 first, symmetric)
Commit argmin over {α, β} of a delay objective (e.g., min of max-lateness),
then show each customer their ETA from the committed sequence.
```

- **Not-yet-ready leg:** if one order is still cooking when computed, its node includes a prep wait `max(0, ready_atᵢ − arrival)` — and `ready_atᵢ` comes from §5.4, not a guess.
- **Cross-restaurant stack** (X Pizza + La Musa, 2 pickups): a few more precedence-valid orderings — still a small finite set, still brute-forced.
- **Committed sequence:** to stay fully data-honest the committed order should be surfaced to the driver so they *follow* it. For 2 orders, deviation impact is one leg (bounded); committing/driver-following is the hardening (§8 fast-follow).

### 5.4 The prep input & the fallback ladder (the predictor wiring)

`ready_atᵢ` for a not-yet-ready order is sourced **top-down, first available wins** — data before guess:

1. **"Listo" tapped** → prep is *done*; `ready_at` = the Listo timestamp (fact). *Preferred whenever available.*
2. **Ready-time predictor** (`order_predictions/<orderId>` shadow output) → **used only if its shadow accuracy passes a quality gate** (a config threshold, e.g. MAE ≤ N min over a recent window, read from `ready-time-quality` outputs). This is the moment the shadow predictor **graduates into a live consumer** — the step the roadmap deferred, done *on measured accuracy*, exactly as "shadow-then-wire" intended.
3. **Static prep buffer** (config) → fallback when neither above is available/trusted.

**Integration note:** exposing `order_predictions` to the dispatch client requires either an RTDB-rules read grant on that path or a thin function that stamps a consumable `predicted_ready_at`. This is a **Phase 1b** concern only — **Phase 1a (single-delivery ETA) never touches the predictor** (prep already done via Listo).

### 5.5 Data-honesty invariants (enforced, testable)

1. **No ETA without a certain destination.** Single delivery, or a stack **once the committed sequence is computed**. Otherwise show the stage, not a number.
2. **No fabricated sequence.** Stacked ETA only from the brute-forced committed order (≤2 → always computable). Never an inferred "you're probably in the middle."
3. **Prep from data, not faith.** `ready_at` = Listo-actual → quality-gated prediction → buffer. The predictor is trusted only after its shadow accuracy is checked.
4. **Everything marked `≈`** and refreshed live; no static promise clock (the flat-45 idea is explicitly rejected).

## 6. Actions row (Phase 1 — cheap wiring over existing server ops)

All 🟢 — server ops + phone already exist; this is dispatch wiring:
- **Llamar** — `tel:` on the stored driver `phone` (same pattern as customer-call).
- **Ver última ubicación** — pan + drop a dim, timestamped "última ubicación" pin (`lat/lng` persist after clock-out).
- **Reasignar pedido** — `reassignOrder`.
- **Sacar de turno** — `endShift` (the dispatcher kill-switch; Onfleet's "Force off duty").

## 7. Implementation notes

- **Routing:** client-side `DirectionsService` (multi-leg handles single = 0 waypoints and 2-stack = waypoints uniformly). Same key/project as the loaded Maps JS.
- **API enable (operational, not code):** **Directions API** must be enabled on the Google Cloud project. Metered (~cents at your volume); client-only, no server/env.
- **Refresh cadence:** recompute on driver-location updates but **throttle to ~once/30s per active delivery** (stable number, cheap API).
- **Dwell config:** `S_customer`, `S_merchant` constants (per-restaurant if useful); apartment-vs-house refinement later.
- **Honduras routing:** viable — Waze/Google navigation is accurate locally (Xavier-confirmed); still eyeball one real delivery's ETA vs reality post-deploy.

## 8. Phasing

- **Phase 1a — panel + single-delivery ETA (client-only, no predictor).** Enrich the expand; add the 4 actions; live ETA for `out_for_delivery` singles via Directions + dwell. *Ships the anchor with zero prediction dependency.*
- **Phase 1b — 2-order cascading stacked ETA.** Brute-forced sequence + cascading timeline; prep input via the §5.4 ladder → **surfaces + quality-gates the shadow predictor**. Needs the predictor-output exposure (§5.4 note).
- **Fast-follows (each its own gate):** committed-sequence + driver-following (makes stacked ETA fully data-honest); pre-pickup ETA; graduate the predictor fully into assignment (the roadmap's Phase 3); the *stacking-decision* guardrail (reject a 2-stack whose delay breaks an acceptable-delay threshold → split to a second driver); phone battery in the card; dispatch-to-nearest (order-side); 1:1 messaging.

## 9. Acceptance criteria

- Clicking a driver shows the panel; single-delivery `out_for_delivery` orders show a live `≈`-ETA that updates as the driver moves; pre-pickup shows a stage, not a number.
- A 2-stack shows a per-order ETA derived from the committed brute-forced sequence; a not-yet-ready order's prep comes from Listo/predictor/buffer per the ladder; nothing shows a fabricated sequence position.
- The predictor is consulted **only** when its shadow accuracy passes the quality gate; otherwise the fallback is used — verifiable in code + a test.
- The 4 actions work; dark map intact (no `mapId`); no regression to markers/glide/GPS-dark row/alerts.
- Client-only for 1a; 1b's only server-touch is exposing `predicted_ready_at` (no functions-logic change, zero-prune, complete `.env` if touched).

## 10. Open decisions for the advisor gate

1. **Prep quality-gate metric & threshold** — what accuracy bar (metric + minutes) graduates `predicted_ready_at` into live ETAs? (Read from `ready-time-quality`.)
2. **Predictor exposure mechanism** — RTDB-rules read grant on `order_predictions` vs a thin `predicted_ready_at` stamp function. (Money/rules-adjacent → advisor's call.)
3. **Stacked ETA in 1b vs deferred** — spec includes it; confirm it ships right after 1a vs waiting.
4. **Dwell defaults** — `S_customer`/`S_merchant` starting values; per-restaurant or flat.

## 11. Industry grounding (why this shape)

- **Meituan (INFORMS 2024):** stacked ETA = each order's arrival read off a **committed, optimized route**; sequence is a *solved output*, not a guess. We shrink this to brute-force at N≤2.
- **DoorDash eng:** *order-ready-time prediction is the essential input* to avoid lateness — validates wiring the predictor as the prep leg.
- **Uber DeepETA:** ETA = routing baseline + a correction layer. For us the correction is a **static dwell buffer**, not ML.
- **Keskin/Scott/Swinney (Order Stacking):** without route data you fall back to an *expected-position guess* (`d(L-1)/2`) — the very thing we refuse; also the "stack near, direct far" policy lever.
- Your own **ready-time predictor** (shadow) is the prep half, already built from this same corpus.

## 12. Risk

Low. 1a is client-only and reversible. 1b's server touch is read-exposure only (no logic change). API cost trivial. Main watch-item: the predictor quality gate (don't surface an unvalidated prep prediction as a confident ETA — the ladder + gate prevent this).
