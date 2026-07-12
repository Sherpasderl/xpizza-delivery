# Driver Tracking Program — Per-Slice Handoff Briefs

**Gated + distributed by:** advisor session, 2026-07-10. Companion to `DRIVER_TRACKING_PROGRAM_PLAN.md`.
Each brief is self-contained — a receiving session shouldn't need the full plan. Gate rulings are baked in.

**Cross-cutting rule (applies to any functions deploy — B, C1):** deploy functions **zero-prune** (compare `firebase functions:list` to source exports first) and **from the current tree with the complete `.env`** (env was reconciled to prod parity 2026-07-10 — a stale-tree/`.env` deploy would STRIP live payments + La Musa WhatsApp env; a NEW function created without a `.env` present gets NO env). Verify env with `gcloud run services describe <fn-lowercase> --region us-central1 --project xpizza-delivery --format="value(spec.template.spec.containers[0].env[].name)"`.

**Sequencing:** **A + C1 run in parallel first** (independent, different sessions, both high-value) → **B** (housekeeping, before native work) → **C2 / D** (native track). Anchor to SYMBOLS, not line numbers — the plan's line refs drift ~200 lines from current `main`.

---

## BRIEF A — Smooth dispatch tracking
**To:** dispatch session · **File:** `xpizza-dispatch/index.html` (client only) · **Status:** ✅ cleared to build now.

**Goal:** driver pins **glide** instead of teleport, animating over the native service's clean ~10s cadence. Internal dispatcher polish; not customer-facing.

**Approach (LOCKED, advisor source-verified):** interpolate the existing `google.maps.Marker` with a Lerp + `requestAnimationFrame` engine. Do **NOT** migrate to `AdvancedMarkerElement` — the dispatch map is created with inline `styles: DARK_MAP_STYLE` (verified `~:2048`); `AdvancedMarkerElement` requires a `mapId`, and a `mapId` **silently disables inline `styles`** → wipes the dark board, for **zero** smoothness gain.

**Anchor to these symbols (line numbers drift):**
- `updateDriverMarkers()` — the update loop. Teleport = `driverMarkers[uid].setPosition({lat,lng})` + `.setIcon(icon)`.
- Leave UNTOUCHED: the `reachable`/`stale`/`d.status` color branch, the `SymbolPath.CIRCLE` icon, `zIndex`, the click→`InfoWindow` handler, the removal loop, and `XPD.isStalePing(d.last_ping)`.

**Four behaviors:**
1. **Duration = measured Δt** between this update and the previous one for that `uid`, clamped to ~[1s, 12s]. Self-tunes to the ~10s stream. **Do NOT hardcode 3000ms** (the earlier proposals' fatal assumption).
2. **Stale mid-glide:** if the driver crosses the 90s stale threshold (`XPD.isStalePing`), stop animating + hand to the existing amber/gray logic. Never glide a dead pin.
3. **Removed mid-glide:** `cancelAnimationFrame` when the removal loop drops a marker — no rAF leaks over a multi-hour shift.
4. **Teleport threshold:** a large position delta (GPS glitch, reconnect, first fix) → **SNAP**, don't slide across the map.

**★ THE build-gate item (advisor-elevated):** the rAF loop and `updateDriverMarkers` both mutate `driverMarkers[uid]`. A fresh update mid-glide **MUST `cancelAnimationFrame` + restart cleanly** — no leaked frames, no two animations fighting over one marker. This is the primary correctness risk; test it explicitly.

**Out of scope:** bearing/rotation (CIRCLE is rotationally symmetric, heading often null); `AdvancedMarkerElement`; map-matching (A1 — deferred behind a Honduras road-coverage spike-test; do not start without passing it).

**Acceptance:** pins glide smoothly; colors/labels/stale-graying/click→InfoWindow/z-order behave exactly as before; **no rAF leak** (removed markers → frames cancelled); large jumps snap; **dark map intact** (proof no `mapId` was introduced); an open InfoWindow tracks the gliding marker (marker-anchored — should be automatic).

**Risk:** low — client-only, fully reversible, no driver/fleet impact. Deploys via the dispatch Netlify site (`xpizzadispatch`, `--site ac3fa94a-564a-4df4-9428-34e6cb41f778`) after merge to main.

---

## BRIEF C1 — Server-side freshness alerting
**To:** functions session · **Status:** ✅ cleared; **run in parallel with A** (the missing safety net — highest-value reliability item).

**Gap:** tracking is excellent but there is **no alarm when a driver actually goes dark.** If a freeze slips through (new OEM, revoked permission, dead battery), dispatch only notices by staring at pins.

**Design:** a **scheduled** check (`onSchedule`, ~every 1 min, `America/Tegucigalpa`) over on-shift drivers' `drivers/<uid>/last_location_ts`. An on-shift driver whose last fix ages past the threshold raises a dispatch alert in the **existing floating-alerts panel** (same channel as "no drivers available"). **Verify the field + the "on-shift" definition in source first** — dispatch stales a pin via `XPD.isStalePing(d.last_ping)`; confirm `last_location_ts` and `last_ping` are the same source, and how an active shift is represented (driver status / shift record).

**DECISION (advisor-ruled): threshold = ~3 min continuous silence on an active shift.** Dispatch already ambers at 90s; the ALARM sits higher so it fires on genuine freezes/dead phones, not routine GPS gaps (else dispatchers learn to ignore it). **Make it a CONFIG constant** — e.g. `config/driver_freshness_alert_sec` (default 180) — tunable without a redeploy.

**Acceptance:** an on-shift driver silent > threshold → **exactly ONE** dispatch alert (dedupe — not a per-tick storm); clears when pings resume; off-shift drivers never alert; threshold is config-driven.

**Gate:** new function ⇒ deploy zero-prune (37 → 38) from the current tree with the complete `.env` (cross-cutting rule). It likely needs **no** env (RTDB reads + an alert write) — confirm. Idempotent alert-per-episode (don't re-alert every minute during one silence).

---

## BRIEF B — Merge v2.4.0 driver source → main
**To:** driver / ops session · **Status:** ⚠️ approved IN PRINCIPLE (housekeeping); **merge GATED on a diff-inspection**.

**What:** merge branch `add-driver-jose-staff` (driver source `7b8e8b1`) into `main` so `main`'s `xpizza-driver/native-location.js` reflects the shipped self-contained ShiftKeepAlive path, not the stale Transistorsoft version.

**GATE CONDITIONS (advisor — satisfy BEFORE merging):**
1. **Inspect the FULL diff vs main.** `add-driver-jose-staff` is a *general* feature branch, not a clean topic branch — confirm it carries ONLY the intended v2.4.0 driver source and nothing unwanted.
2. **If it touches `functions/`** (esp. `index.js`): the follow-on deploy must be **zero-prune** AND from the current tree with the complete `.env` (cross-cutting rule — a stale deploy strips live env). If it's **client/native-only**, it's git-CD safe (no functions deploy).
3. Confirm the driver-app version/build stays consistent (v2.4.0/vc21) and nothing regresses the shipped fleet build.

**No design decisions** — the verification + rollout this once gated are already cleared (v2.4.0 on-device verified on battery; 2.3.x→2.4.0 in-place update path verified 2026-07-10; fleet rollout gate CLEARED).

---

## BRIEF C2 — Driver onboarding prompts
**To:** Sherpa driver session (native repo `~/Projects/sherpa-driver-app`) · **Status:** ✅ approved as scoped.

**What:** on first native launch, walk the driver through the two residual OEM settings that HARDEN the permanent FGS (the FGS is the load-bearing fix; these harden it, per the 2026-07-03 note):
- Battery usage → **"Sin restricciones" / unrestricted**.
- Honor/Huawei **"App launch" → auto-launch allowlist**.

Detect-and-prompt with deep-links to the OEM settings intents; skip where not applicable. **Non-blocking** (informational, dismissible).

**Acceptance:** a fresh driver is guided through both once; no nagging on subsequent launches; graceful no-op on non-Honor devices.

**Notes:** rides with the driver-side native track (B, D). Low risk — additive onboarding UX; does NOT touch the FGS.

---

## BRIEF D — Adaptive ping frequency
**To:** Sherpa driver session (native, `ShiftLocationService.java`, repo `~/Projects/sherpa-driver-app`, **physical Honor device required**) · **Status:** model RULED; **BUILD gated on a baseline measurement**.

**Goal:** cut battery from the fixed 10s stream — fast when moving, slow when idle — **without ever dropping the foreground service**.

**DECISION (advisor-ruled):**
- **Model = motion-based.** Interval keys off speed/movement from `FusedLocationProvider` (moving → ~5s; stationary → ~20–30s). The service stays "dumb" — **no** order/task-state pipe (keeps changes minimal on the module that took a hard fight to stabilize). **REJECTED state-based** (not worth threading task-state into native now; the "stopped at a light" case is transient and well within the C1 budget).
- **BUILD GATE = a baseline battery measurement FIRST.** D is a battery *optimization* with **no data yet** proving fixed-10s is a real problem. Measure the fixed-10s drain over a real shift first (measure-before-optimize, like A1's spike-gate + the ready-time shadow predictor). If the baseline is acceptable → **defer D indefinitely (YAGNI).** Build motion-based ONLY if it proves a real drain.

**HARD CONSTRAINT (non-negotiable):** the FGS + its permanent notification **must NEVER be dropped** for any interval state — the freeze fix depends on the process staying non-cached; only the cadence changes. Any design that stops/restarts the FGS is rejected.

**Acceptance (if built):** measurable battery reduction vs fixed 10s over a real shift; **re-run the freeze gate** (4 min locked + stationary, **on battery, unplugged** → pin stays fresh, slow tier well under the C1 180s budget); dispatch freshness never worse than the C1 alert threshold in any interval state.

---

## Program Status — 2026-07-12 (final)

**Net: A ✅ / B ✅ / C1 ✅ / C2 ✅ / D ⏳ (measure gate).** The program is complete except the optional, YAGNI-gated D. Both session relays folded in below for the record.

| Item | State | Where |
|------|-------|-------|
| **A** Smooth dispatch tracking | ✅ LIVE | client `xpizza-dispatch/driver-glide.js` + 4 edits; dispatch git-CDs from `main` |
| **B** Driver source → `main` | ✅ DONE | `main` carries driver **2.4.2**, FGS path current (superseded the original v2.4.0 merge) |
| **C1** Server freshness alerting | ✅ LIVE | `driverFreshnessMonitor`, **38 fns** zero-pruned, `onSchedule` 1-min Tegucigalpa |
| **C2** OEM onboarding prompts | ✅ SHIPPED | driver **2.4.2 / vc24**; monorepo `2f60e9a`, native `640851a`; Play internal testing |
| **D** Adaptive ping frequency | ⏳ MEASURE GATE | baseline battery measure pending → defer-YAGNI **or** build motion-based + re-gate |

### Relay — driver-native track (B / C2 / D)
- **B ✅** — main is current at driver **2.4.2**; no branch to re-merge.
- **C2 ✅ SHIPPED (2.4.2 / vc24).** Advisor diff-gate APPROVED (source-verified: new `OemSettingsPlugin` only; `ShiftLocationService` + `ShiftKeepAlivePlugin` FGS **untouched**; no functions/`.env` surface). On-device Honor verified: first-launch sheet, **actionable-only** cards (battery card correctly skipped when already Doze-whitelisted), working deep-links, dismissible, once-only. Commits: monorepo `2f60e9a` → `origin/main` (fetched-confirmed at tip), native `640851a`; AAB vc24 published to Play internal testing.
  - **Advisory (config-only, prod go-live):** manifest now declares `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` → needs a Play permission declaration/justification at **production** submission (delivery-GPS core-function qualifies; fine on internal testing). Logged in the Play-submission checklist.
  - **Advisory (deferred nit):** the `openBatterySettings` catch-fallback is effectively unreachable (inner `start()` returns a boolean instead of throwing); harmless — the primary intent is universal on API 23+. Fold `if (!start(i))` gating into a later build if D happens. Not worth a re-gate.
- **D ⏳ MEASURE GATE.** Held at the ruling: baseline measurement first (`batterystats --reset` → real unplugged shift → app %/hour). Acceptable → **defer indefinitely (YAGNI)**; proven drain → build **motion-based** (service stays dumb, FGS never dropped) + re-run the freeze gate + route the diff back to advisor.

### Relay — functions track (C1)
- **C1 ✅ FULLY LIVE end-to-end.** `driverFreshnessMonitor` deployed **38 fns, zero pruned**, from the current tree with the reconciled 25-key `.env` (payments + La Musa WhatsApp env intact). `onSchedule` every 1 min America/Tegucigalpa, scheduler enabled. Loop: sweeps on-shift drivers → keyed `dispatcher_alerts/driver_stale_<uid>` when `last_ping` ages past **`config/driver_freshness_alert_sec` (default 180s)** → dispatch renders "*&lt;driver&gt; sin señal GPS · hace N min…*" → auto-clears on ping. Dedupe one-per-episode; off-shift never alerts.
  - **Source facts (do not re-litigate):** freshness field = `last_ping` (server `ServerValue.TIMESTAMP`, clock-consistent with the fn's `Date.now()`), **not** `last_location_ts` (device time). On-shift = `status && status !== 'off_shift'`.
- **The 180s freshness budget is now D's acceptance anchor** — if D is built, its slow tier must keep dispatch freshness under 180s in every interval state, re-proven on the freeze gate.
- **No functions work queued.** D is native (`ShiftLocationService.java`) and doesn't touch `functions/`. Any future functions deploy: **zero-prune, current tree, complete `.env`**, and `git fetch` + confirm `origin/main` first.
