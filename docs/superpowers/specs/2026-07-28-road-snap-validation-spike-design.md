# Road-Snap Validation Spike — Design

**Date:** 2026-07-28
**Status:** Draft for review → advisor gate → execute
**Owner area:** Driver Tracking Program (dispatch smooth glide)
**Type:** Measurement spike (GO/NO-GO), not a build

---

## 1. Purpose & the decision it gates

Today the dispatch driver marker glides in a **straight line** between GPS pings (`driver-glide.js` → `lerpLatLng`), so on turns it cuts diagonally across blocks. We want to explore **street-locking** the glide — snapping the animated path to the real roads the driver drove — for Uber-grade realism.

When smooth tracking was first built we deliberately **did not** street-lock, on the assumption that San Pedro Sula (SPS) street data might be unreliable. Xavier now believes Google's SPS road map is accurate enough to reconsider.

This spike answers one question with data, before any engine code is written:

> **Does Google's SPS road data + the Roads API "Snap to Roads" produce a faithful, street-locked path from a real driver's GPS trace?**

Output is a **GO / CONDITIONAL / NO-GO** verdict that gates the full road-snapping glide design. We prove or kill the premise on **our own SPS tracks** — not on assumption, in either direction.

## 2. Hypothesis

SPS Google road coverage is now accurate enough that Snap-to-Roads traces a real driver's path onto the correct streets, rounding corners correctly, without gross wrong-street placements or cross-block jumps — cleanly better than today's straight-line interpolation.

## 3. Current state (verified from source)

- **Glide is straight-line.** `driver-glide.js` interpolates point→point with `lerpLatLng`; only guardrail is an implausible-jump snap at `SNAP_M` (500 m).
- **Maps client already loaded.** Dispatch loads the Google Maps JS **`geometry`** library and uses **`DirectionsService`** (for the single-delivery ETA, `driver-eta.js`). We have client-side Maps access + polyline decoding.
- **No Roads API usage anywhere.** Snap-to-Roads is a *separate* Google API that must be enabled on the `x-pizza-delivery` Maps project and is billed per request.
- **We store only `last_location`** (the latest point per driver, overwritten each post — `driver-ingest.js`). There is **no breadcrumb/trail history** to replay, so the spike must capture raw tracks.

## 4. Scope & non-goals

**In scope**
- Capture a handful of real SPS driver GPS traces.
- Run each through Roads API Snap-to-Roads.
- Visually + quantitatively compare snapped path vs raw points vs today's straight-line, against ground truth.
- Verify Roads API is enabled and estimate production cost at fleet scale.
- Produce a GO/NO-GO memo.

**Non-goals (explicitly out)**
- No change to `driver-glide.js` or any production glide behavior.
- No dispatch UI change, no functions deploy.
- No driver-app change (capture is read-only, dispatcher-side).
- Not the road-snapping engine design — that is the *next* spec, unlocked only by a GO.

## 5. Method

### 5.1 Capture real tracks (read-only, zero-write)

Because we keep only `last_location`, capture a live trace with a **read-only sampler** — no app change, no deploy, no production write:

- A small script (or dispatch dev-console snippet) reads `drivers/<uid>/last_location` on a timer **~every 4 s** (faster than the app's ~10 s post cadence, so no distinct update is missed), **dedupes on the location timestamp**, and appends `{lat, lng, ts, accuracy}` to a **local** JSON file.
- Run it for the full duration of a test/real delivery (restaurant → customer).
- The result is the exact ~10 s-resolution trace the glide actually sees in production.

Capture **2–3 tracks** chosen to stress the question:
1. **Dense downtown grid** (many closely-spaced parallel streets — the hardest case for snapping).
2. **Curvier / peripheral route** (boulevards, non-grid).
3. **A known-tricky spot** (e.g. a colonia with poor addressing, a divided avenue, or an overpass).

For each track, record **ground truth**: the driver/dispatcher states the actual streets driven ("bajé por la 4ª avenida, doblé en la 7ª calle…") at capture time, while it's fresh.

> Alternative (higher-res, heavier — NOT the default): temporarily append each post to a trail node in `driver-ingest`. Rejected for the spike: it's a write-path change + deploy for a throwaway test. Use the read-only sampler.

### 5.2 Snap

For each raw track, call **Roads API Snap-to-Roads** with `interpolate=true`:
- Endpoint: `roads.googleapis.com/v1/snapToRoads?path=lat,lng|lat,lng|…&interpolate=true&key=…`
- Max **100 points/request**; chunk longer tracks with a few points of **overlap** and stitch.
- Keep the raw response: `snappedPoints[]` each with `location`, `originalIndex`, `placeId`.

### 5.3 Render & compare

A local `snap-review.html` (Google Maps JS, existing key) plots, per track:
- **Raw GPS points** (red dots).
- **Snapped path** (blue polyline).
- **Today's straight-line glide** (grey polyline) — the baseline we must beat.

Side-by-side so the improvement (or mis-snap) is obvious against the actual streets.

### 5.4 Ground-truth comparison

Overlay each rendered track against the driver's stated route and the visible Google street layer. Mark, per segment: correct-street / rounded-corner-correctly / wrong-street / cross-block-jump / dropped.

## 6. Evaluation criteria & GO/NO-GO thresholds

Measured across all test tracks (total distance D, segment count S):

| Metric | Definition |
|---|---|
| **Street-match %** | share of snapped distance on the correct street per ground truth |
| **Gross mis-snaps** | count of snapped points on a *parallel/other* street or teleported across a block |
| **Corner fidelity** | corners rounded on the real road vs cut |
| **Confidence gaps** | segments with missing/low-confidence snap (placeId gaps) |
| **vs baseline** | is snapped materially closer to ground truth than straight-line? |

**Verdict:**
- **GO** — street-match ≥ **90 %**, **0** gross mis-snaps, corners correct, and cost acceptable (§7). Build street-locked glide.
- **CONDITIONAL** — street-match **80–90 %** or occasional *recoverable* mis-snaps → build **with straight-line fallback + confidence gating** (snap only when confident, else lerp).
- **NO-GO** — street-match < **80 %** or frequent gross mis-snaps → keep straight-line glide; revisit if SPS data improves.

Thresholds are the decision rule, set before looking at results, to keep the call honest.

## 7. Cost verification (part of the deliverable)

- Confirm **Roads API is enabled** on the `x-pizza-delivery` project (it is not used today).
- Verify **current Snap-to-Roads pricing** from Google's live pricing page (do **not** quote from memory).
- Estimate **production cost** under the intended production shape: snap **only active `out_for_delivery` driver(s)** (typically 1–3, not the whole fleet), points **batched** per request, snap **pipelined** one segment ahead of the glide. Produce a $/day and $/1000-deliveries figure.

## 8. Deliverable

A short **GO/NO-GO memo** containing:
- The rendered overlays (raw / snapped / straight-line) for each track.
- The metrics table (§6) and the verdict.
- The cost estimate (§7).
- If GO/CONDITIONAL: a one-paragraph sketch of what the engine change entails (see §10).

This memo feeds the **advisor gate** for the full road-snapping design.

## 9. Guardrails

- **Zero production writes.** Capture is read-only sampling of `last_location`; no writes to `/orders`, `/drivers`, or any live node.
- **No production behavior change.** `driver-glide.js`, dispatch UI, and functions are untouched.
- **No driver-app change.** No deploy of any kind for the spike.
- **PII / location data.** Raw GPS traces are movement data — keep captures **local**, do **not** commit raw tracks to the repo, scrub any customer-identifiable endpoint before sharing the memo.
- **API key hygiene.** Use the existing Maps key with Roads API enabled; do not embed a new key in committed files.

## 10. What a GO unlocks (forward pointer, not in scope here)

A GO/CONDITIONAL leads to a separate design where the glide engine extends from **point→point** interpolation to **interpolation along a snapped polyline**, keeping its pure/injected/unit-testable shape, with **straight-line as the fallback path** when a snap is unavailable or low-confidence (fail-open). Production snapping is scoped to active-delivery drivers, batched, and pipelined one segment ahead so there is no perceived lag. That design gets its own advisor gate and codex-on-diff.

## 11. Effort

Small: a read-only sampler snippet + a snap/render HTML + 2–3 captured deliveries + the memo. On the order of a few hours of work plus the delivery capture windows.
