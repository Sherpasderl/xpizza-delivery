# Driver Tracking Program — Roadmap & Handoff Plan

**Date:** 2026-07-10
**Author:** dispatch session (brainstormed with Xavier)
**Audience:** advisor/auditor session — **this is a roadmap for you to gate and distribute**, not a build order.
**Deliverable status:** design-approved at roadmap altitude. Item A fully specced; B/C/D scoped with the key decisions surfaced.

---

## 0. Purpose & workflow

Xavier wants (1) rock-solid perpetual driver location pinging and (2) Uber-style smooth driver tracking on the dispatch board. During brainstorming we discovered **phase 1 (perpetual pinging) is already built, on-device verified, and shipped** — so this program is the follow-on work, decomposed into four independently shippable items.

**Routing (advisor distributes execution):**

| Item | What | Owner |
|------|------|-------|
| **A** | Smooth dispatch tracking (client interpolation) | **dispatch session** (`xpizza-dispatch/`) |
| **B** | Merge v2.4.0 driver source → `main` (housekeeping) | driver session / ops |
| **C** | Reliability hardening (server freshness alerting + driver onboarding prompts) | **split**: C1 functions, C2 driver session |
| **D** | Adaptive ping frequency (battery) | **driver session** (native, repo `~/Projects/sherpa-driver-app`) |

Each item below is written to be gated and handed off on its own. Sequence in §6.

---

## 1. Current state (verified from source + second brain, 2026-07-10)

**Phase 1 — perpetual pinging: DONE.** Driver **v2.4.0 / vc21** ships a self-contained native foreground service:

- `ShiftLocationService.java` — a permanent-notification Android **foreground service** running the whole shift. Because a live FGS is freeze-exempt, it defeats the Honor/Huawei `Pged-Freezer` (and Xiaomi-class OEM freezers) that killed the prior Transistorsoft approach when backgrounded + screen-locked + stationary.
- `FusedLocationProviderClient` @ **fixed 10s** → native `HttpURLConnection` POST to `ingestDriverLocation` as `{locations:[{ts,lat,lng,accuracy,heading,speed}]}`, header `x-driver-token`. Zero WebView JS, no motion-adaptive drop.
- **On-device verified on the real Play build, on battery, unplugged:** 4 min locked + stationary → stayed fresh (~11s), continuous ~10s stream, 0 failures.
- **2.3.x → 2.4.0 in-place update path verified 2026-07-10:** `disableLingeringTransistorsoft()` guard defeats the Transistorsoft-resurrection bug — existing drivers auto-updating via Play get the fix cleanly. **Fleet rollout gate CLEARED.**
- Transistorsoft kept installed but **dormant** (license retained as a per-device fallback).

Commits: driver source `7b8e8b1` (monorepo, branch `add-driver-jose-staff`), native project `2c4a641`.

**Implication:** the only reason "phase 1" appears in this plan at all is the **source drift** — `main` still carries the *old* Transistorsoft `native-location.js`; the shipped v2.4.0 source lives on a branch. That is item **B**, and it is pure housekeeping (the risk it once gated is already retired).

---

## 2. Item A — Smooth dispatch tracking

**Owner:** dispatch session · **File:** `xpizza-dispatch/index.html` (client only) · **Status:** ready to build.

### Goal
Driver pins **glide** instead of teleport, animating over the native service's clean ~10s cadence. Situational-awareness polish for the dispatcher — internal tool, not customer-facing.

### Approach (LOCKED): interpolate the existing `google.maps.Marker` — do **NOT** migrate to `AdvancedMarkerElement`.

Rationale, verified in source:
- The dispatch map is created with inline `styles: DARK_MAP_STYLE` (`index.html:2000`). `AdvancedMarkerElement` requires a `mapId`, and **a `mapId` silently disables inline `styles`** — it would wipe the dark board. The migration is pure deprecation hygiene and buys **zero** smoothness.
- Current teleport is `driverMarkers[uid].setPosition({lat,lng})` inside `updateDriverMarkers()` (`index.html:3315`, setPosition at `:3351`).

So: add a small Lerp + `requestAnimationFrame` engine and animate `setPosition` between updates. **Every other line stays untouched** — the `reachable`/`stale`/`d.status` color branch (`:3323–3348`), the initial label, `zIndex:1000` (`:3361`), the click→InfoWindow handler (`:3367`), and the removal loop (`:3379`).

### Four behaviors to implement (the real design content)
1. **Duration = measured Δt** between the current update and the previous one for that `uid`, clamped to ~[1s, 12s]. Self-tunes to the ~10s native stream; no hardcoded window. (Do **not** hardcode 3000ms — the earlier proposals' fatal assumption.)
2. **Stale mid-glide:** if a driver crosses the 90s stale threshold (`XPD.isStalePing`), stop animating and hand off to the existing amber/gray logic — never glide a dead pin.
3. **Removed mid-glide:** `cancelAnimationFrame` when the removal loop drops a marker, so no rAF leaks against a detached marker over a multi-hour shift.
4. **Teleport threshold:** if the position delta is large (GPS glitch, reconnect, first fix), **snap** instead of sliding the pin across the map.

### Explicitly out of scope
- **Bearing/rotation** — the marker is a `SymbolPath.CIRCLE` (`:3341`, rotationally symmetric) and `heading` is frequently null from Android GPS. No value.
- **`AdvancedMarkerElement` migration** — see above.
- **Map-matching / snap-to-roads** — deferred; see §5.

### Acceptance criteria
- Pins glide smoothly on the live board; colors, labels, stale-graying, click→InfoWindow, and z-order all behave exactly as before.
- No rAF leak over a long shift (verify: markers removed → their animation frames cancelled).
- Large jumps snap rather than slide.
- Dark map theme intact (proof that no `mapId` was introduced).

### Risks
- Low. Client-only, fully reversible, no driver/fleet impact. Main watch-item: ensure the animation loop reads/writes the *same* `driverMarkers[uid]` the update loop manages, and that a fresh update mid-glide cleanly supersedes the in-flight animation (cancel + restart).

---

## 3. Item B — Merge v2.4.0 driver source → `main`

**Owner:** driver session / ops · **Status:** housekeeping only.

- Merge branch `add-driver-jose-staff` (driver source `7b8e8b1`) into `main`, so `main`'s `xpizza-driver/native-location.js` reflects the shipped self-contained `ShiftKeepAlive` path instead of the stale Transistorsoft version.
- **No design decisions.** The verification and rollout this once gated are already cleared (§1).
- Advisor: confirm nothing else on that branch is unwanted before merging (it's a general feature branch, not a clean topic branch — inspect the diff).

---

## 4. Item C — Reliability hardening

Two independent pieces.

### C1 — Server-side freshness alerting `[owner: functions]`
**Gap:** tracking is excellent, but there is **no alarm when a driver actually goes dark.** If a freeze ever slips through (new OEM, revoked permission, dead battery), dispatch only notices by staring at pins.

**Design:** a scheduled/triggered check on `drivers/<uid>/last_location_ts`. An **on-shift** driver whose last fix ages past the threshold raises a dispatch alert, surfaced in the existing floating-alerts panel (same channel as "no drivers available").

**Open decision C1-threshold (advisor to confirm):**
> **Recommendation: alert at ~3 min of continuous silence on an active shift.** Dispatch already flips a pin amber at 90s stale; the *alarm* should sit higher so it fires on genuine freezes/dead phones, not routine GPS gaps — otherwise dispatchers learn to ignore it. Tighten only if field data shows real freezes lasting <3 min.

**Acceptance:** an on-shift driver going silent > threshold produces exactly one dispatch alert (not a per-tick storm); recovers/clears when pings resume; off-shift drivers never alert.

### C2 — Driver onboarding prompts `[owner: driver session]`
On first native launch, walk the driver to the two residual OEM settings the 2026-07-03 note flags as hardening (the permanent FGS is the load-bearing fix; these harden it):
- Battery usage → **"Sin restricciones" / unrestricted**.
- Honor/Huawei **"App launch" → auto-launch allowlist**.

Detect-and-prompt with deep-links to the OEM settings intents; skip on devices/paths where not applicable. Non-blocking (informational, dismissible).

**Acceptance:** a fresh driver is guided through both settings once; no nagging on subsequent launches; graceful no-op on non-Honor devices.

---

## 5. Item D — Adaptive ping frequency

**Owner:** driver session (native) · **File:** `ShiftLocationService.java` (repo `~/Projects/sherpa-driver-app`) · **Status:** design decision open.

### Goal
Cut battery from the fixed 10s stream by going Uber-style — fast when it matters, slow when idle — **without ever dropping the foreground service** (the FGS is what beat the freezer; only the *interval* changes, so freeze-safety is fully preserved).

### Open decision D-model (advisor to confirm) — the key choice
> **Recommendation: motion-based.** Interval keys off speed/movement from `FusedLocationProvider` (moving → ~5s; stationary → ~20–30s). The native service stays "dumb" — it needs **no** order/task-state pipe, which keeps changes minimal on the module that took a hard debugging fight to stabilize. Freeze-safe because the FGS never drops.
>
> **Alternative — delivery-state-based:** interval keys off the driver's task state (`en_route_delivery`/`assigned` → fast; `available`/idle → slow). More precise (a driver stopped at a light mid-delivery still pings fast), but requires feeding current task state into native, which it does not have today. Save as a later refinement if battery data justifies it.
>
> **Minimal alternative — defer D:** just tune the fixed `INTERVAL_MS` to a good constant and skip adaptivity entirely. Valid YAGNI path if the battery cost of a well-chosen fixed interval is acceptable.

### Hard constraint (non-negotiable)
The foreground service and its permanent notification **must never be dropped** for any interval state. The freeze fix depends on the process staying non-cached; adaptivity changes cadence only. Any design that stops/restarts the FGS is rejected.

### Acceptance criteria
- Measurable battery reduction vs fixed 10s over a real shift.
- **Re-run the freeze gate:** 4 min locked + stationary, **on battery, unplugged** → pin stays fresh (interval may be the slow tier, but must not exceed the freshness/alert budget from C1).
- Dispatch freshness never worse than the C1 alert threshold in any interval state.

---

## 6. Sequencing

1. **A — Smooth dispatch tracking** — first. Fully independent, client-only, reversible, no device needed; the original ask; dispatch session can take it end-to-end now.
2. **B — Merge → main** — housekeeping; do before/around the native work (C2, D) so they build on clean `main`.
3. **C — Reliability hardening** — C1 (functions) is independent and high-value (the missing safety net); C2 rides with driver-side work.
4. **D — Adaptive frequency** — last. A battery *optimization* on an already-working system; the only item hard-requiring the native repo + a physical Honor device + an on-battery re-test.

Natural split: **A is do-now, dispatch-side; B/C2/D are a driver/native track needing the device + native repo; C1 is standalone functions work.**

---

## 7. Decision log

| # | Decision | Status |
|---|----------|--------|
| A-approach | Keep `google.maps.Marker` + lerp; no AdvancedMarkerElement (mapId would kill dark map) | **LOCKED** (source-verified) |
| A1 | Straight-line lerp now; map-matching deferred, gated on a Honduras coverage spike-test | **LOCKED by Xavier** |
| C1-threshold | Server freshness alert at ~3 min silence on active shift | **Recommended — advisor to confirm** |
| D-model | Motion-based adaptivity (vs state-based vs defer) | **Recommended — advisor to confirm** |

### Map-matching — deferred-future note (for A1)
True road-snapping (pin follows streets instead of straight-lining/corner-cutting over the ~10s window) is a **separate, later** enhancement. Realistic path = **Google Roads API "Snap to Roads"** on a sliding window of recent fixes + animate-along-polyline + straight-line fallback (~a few days *if* coverage is good). **Entry gate before any build: a Honduras coverage spike-test** — snap real driver traces from actual delivery zones and eyeball whether they land on the correct roads. Local road-data gaps would make snapping *worse* than straight lines (pin on the wrong parallel street reads as a bug). Do not start without passing that gate. Self-hosted matchers (OSRM/Valhalla) are out of scope (weeks + ops).
