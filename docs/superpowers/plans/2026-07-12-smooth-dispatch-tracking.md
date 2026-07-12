# Smooth Dispatch Tracking (Item A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Driver pins on the dispatch board glide smoothly between the native service's ~10s location pings instead of teleporting, with no rendering regressions.

**Architecture:** Extract a pure, dependency-free animation state machine (`driver-glide.js`, ESM) that interpolates positions with Lerp + `requestAnimationFrame`, injected with `now`/`raf`/`caf`/`apply` so it is unit-testable in Node. Wire it into the existing `updateDriverMarkers()` in `xpizza-dispatch/index.html`, replacing only the `setPosition` teleport and adding a `cancel()` in the removal loop. The legacy `google.maps.Marker` stays (an `AdvancedMarkerElement` would need a `mapId`, which silently disables the inline `DARK_MAP_STYLE`). Everything else — color branch, `SymbolPath.CIRCLE`, `zIndex`, `setIcon`/`setLabel`, click→InfoWindow, removal loop, `isStalePing` — is untouched.

**Tech Stack:** Vanilla ESM JavaScript, Google Maps JS API (`google.maps.Marker`), `requestAnimationFrame`, Node built-in `node:assert` test runner (pattern: `node file.test.js`, matching `xpizza-functions/driver-ingest.test.js`).

---

## File Structure

- **Create** `xpizza-dispatch/driver-glide.js` — pure ESM module. No `google.maps`, no DOM, no globals. Exports `distanceMeters`, `lerpLatLng`, `createGlideEngine`. Single responsibility: the per-driver glide state machine (duration from measured Δt, snap-vs-glide decision, supersede/cancel, cleanup).
- **Create** `xpizza-dispatch/driver-glide.test.js` — ESM Node test. Injects a fake clock + fake rAF queue to deterministically test every behavior, especially supersede-mid-glide (the build-gate).
- **Modify** `xpizza-dispatch/index.html` — inside the `<script type="module">`: import the engine, instantiate one `glide` wired to real `performance.now`/`requestAnimationFrame`/`cancelAnimationFrame` and a `setPosition` sink; in `updateDriverMarkers()` replace `driverMarkers[uid].setPosition(...)` with `glide.update(uid, target, { snap: stale })`; add `glide.cancel(uid)` in the removal loop. Anchor by SYMBOL (`updateDriverMarkers`, `driverMarkers[uid].setPosition`, the removal loop) — line numbers drift.

### Engine interface (contract used by every task)

```js
// createGlideEngine({ now, raf, caf, apply, options }) → { update, cancel, has, _state }
//   now()            → number   (ms; performance.now in browser, fake clock in tests)
//   raf(cb)          → id       (requestAnimationFrame; fake queue in tests)
//   caf(id)          → void     (cancelAnimationFrame)
//   apply(uid, pos)  → void     (sink: set the marker's position — {lat,lng})
//   options: { minDurationMs=1000, maxDurationMs=12000, snapThresholdMeters=500 }
//
//   update(uid, target, opts?) — target {lat,lng}; opts.snap=true forces an immediate jump.
//        First sighting of a uid → apply immediately, no animation.
//        opts.snap OR distance(current,target) > snapThresholdMeters → cancel frame, apply immediately.
//        distance < 0.5m (no real move, e.g. a status-only snapshot) → apply, no animation.
//        else → cancel any in-flight frame, glide from CURRENT displayed pos to target over
//               clamp(measuredΔt, min, max).
//   cancel(uid) — cancel the in-flight frame (if any) and drop all state for uid.
//   has(uid)    → boolean.  _state(uid) → internal state object (TEST HOOK ONLY).
```

---

### Task 1: Pure math helpers (`lerpLatLng`, `distanceMeters`)

**Files:**
- Create: `xpizza-dispatch/driver-glide.js`
- Test: `xpizza-dispatch/driver-glide.test.js`

- [ ] **Step 1: Write the failing test**

```js
// xpizza-dispatch/driver-glide.test.js
import assert from 'node:assert';
import { lerpLatLng, distanceMeters } from './driver-glide.js';

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// lerp midpoint
{
  const m = lerpLatLng({ lat: 0, lng: 0 }, { lat: 10, lng: 20 }, 0.5);
  assert.strictEqual(m.lat, 5);
  assert.strictEqual(m.lng, 10);
  ok('lerpLatLng midpoint');
}
// lerp endpoints
{
  assert.deepStrictEqual(lerpLatLng({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, 0), { lat: 1, lng: 2 });
  assert.deepStrictEqual(lerpLatLng({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, 1), { lat: 3, lng: 4 });
  ok('lerpLatLng endpoints');
}
// distance: ~0 for same point, ~111m for ~0.001 deg lat
{
  assert.ok(distanceMeters({ lat: 15.5, lng: -88 }, { lat: 15.5, lng: -88 }) < 0.001);
  const d = distanceMeters({ lat: 15.5, lng: -88 }, { lat: 15.501, lng: -88 });
  assert.ok(d > 100 && d < 125, `expected ~111m, got ${d}`);
  ok('distanceMeters sanity');
}

console.log(`\n${pass} passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node xpizza-dispatch/driver-glide.test.js`
Expected: FAIL — `Cannot find module './driver-glide.js'` (or `lerpLatLng is not a function`).

- [ ] **Step 3: Write minimal implementation**

```js
// xpizza-dispatch/driver-glide.js
// Pure, dependency-free glide state machine for dispatch driver markers.
// No google.maps, no DOM — injected with now/raf/caf/apply so it is unit-testable.

export function lerpLatLng(start, target, t) {
  return {
    lat: start.lat + (target.lat - start.lat) * t,
    lng: start.lng + (target.lng - start.lng) * t,
  };
}

// Equirectangular approximation — accurate to well under a metre at city scale,
// which is all the snap/no-move thresholds need.
export function distanceMeters(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * R;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node xpizza-dispatch/driver-glide.test.js`
Expected: PASS — `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add xpizza-dispatch/driver-glide.js xpizza-dispatch/driver-glide.test.js
git commit -m "feat(dispatch): pure lerp + distance helpers for driver glide"
```

---

### Task 2: Engine + first-sighting snap (no animation on first fix)

**Files:**
- Modify: `xpizza-dispatch/driver-glide.js`
- Test: `xpizza-dispatch/driver-glide.test.js`

- [ ] **Step 1: Add the test harness + first-sighting test** (append to the test file, above the final `console.log`)

```js
// --- deterministic harness: fake clock + fake rAF queue ---
import { createGlideEngine } from './driver-glide.js';

function harness(options) {
  let t = 0;
  let nextId = 1;
  let frames = [];           // { id, cb } pending frames
  const applied = [];        // { uid, pos }
  const cancelled = [];      // ids passed to caf
  const engine = createGlideEngine({
    now: () => t,
    raf: (cb) => { const id = nextId++; frames.push({ id, cb }); return id; },
    caf: (id) => { cancelled.push(id); frames = frames.filter((f) => f.id !== id); },
    apply: (uid, pos) => applied.push({ uid, pos: { lat: pos.lat, lng: pos.lng } }),
    options,
  });
  return {
    engine,
    at: (v) => { t = v; },              // set absolute time (ms)
    tick: () => {                        // fire all currently-queued frames once
      const batch = frames; frames = [];
      batch.forEach((f) => f.cb());
    },
    pending: () => frames.length,
    applied, cancelled,
    lastApplied: () => applied[applied.length - 1],
  };
}

const A = { lat: 15.500, lng: -88.000 };
const B = { lat: 15.500, lng: -88.001 };   // ~107m east of A (glide range)

// first sighting snaps: applied once, no frame scheduled
{
  const h = harness();
  h.at(0);
  h.engine.update('u1', A);
  assert.strictEqual(h.applied.length, 1);
  assert.deepStrictEqual(h.applied[0], { uid: 'u1', pos: A });
  assert.strictEqual(h.pending(), 0, 'first sighting must not schedule an animation');
  assert.ok(h.engine.has('u1'));
  ok('first sighting snaps, no animation');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node xpizza-dispatch/driver-glide.test.js`
Expected: FAIL — `createGlideEngine is not a function`.

- [ ] **Step 3: Implement the engine skeleton with first-sighting** (append to `driver-glide.js`)

```js
export function createGlideEngine({ now, raf, caf, apply, options = {} }) {
  const MIN = options.minDurationMs ?? 1000;
  const MAX = options.maxDurationMs ?? 12000;
  const SNAP_M = options.snapThresholdMeters ?? 500;
  const state = new Map(); // uid -> { rafId, startPos, targetPos, startTime, duration, lastUpdateTime }

  // Where the pin visually is right now, given its animation state.
  function displayedPos(s, t) {
    if (!s.duration) return s.targetPos;
    const p = Math.min((t - s.startTime) / s.duration, 1);
    return lerpLatLng(s.startPos, s.targetPos, p);
  }

  function settle(s, uid, pos, t) {
    if (s.rafId != null) { caf(s.rafId); s.rafId = null; }
    apply(uid, pos);
    s.startPos = pos; s.targetPos = pos; s.duration = 0; s.startTime = t;
  }

  function update(uid, target, opts = {}) {
    const t = now();
    let s = state.get(uid);

    if (!s) { // first sighting — place immediately, no glide
      s = { rafId: null, startPos: target, targetPos: target, startTime: t, duration: 0, lastUpdateTime: t };
      state.set(uid, s);
      apply(uid, target);
      return;
    }

    const from = displayedPos(s, t);
    const measuredDt = t - s.lastUpdateTime;
    s.lastUpdateTime = t;
    const dist = distanceMeters(from, target);

    if (opts.snap || dist > SNAP_M || dist < 0.5) { // stale / implausible jump / no real move
      settle(s, uid, target, t);
      return;
    }

    if (s.rafId != null) { caf(s.rafId); s.rafId = null; } // supersede any in-flight glide
    s.startPos = from;
    s.targetPos = target;
    s.startTime = t;
    s.duration = Math.max(MIN, Math.min(measuredDt, MAX));

    const step = () => {
      const tt = now();
      const p = Math.min((tt - s.startTime) / s.duration, 1);
      apply(uid, lerpLatLng(s.startPos, s.targetPos, p));
      if (p < 1) { s.rafId = raf(step); }
      else { s.rafId = null; s.startPos = s.targetPos; s.duration = 0; }
    };
    s.rafId = raf(step);
  }

  function cancel(uid) {
    const s = state.get(uid);
    if (s && s.rafId != null) caf(s.rafId);
    state.delete(uid);
  }

  return {
    update,
    cancel,
    has: (uid) => state.has(uid),
    _state: (uid) => state.get(uid), // test hook only
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node xpizza-dispatch/driver-glide.test.js`
Expected: PASS — `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add xpizza-dispatch/driver-glide.js xpizza-dispatch/driver-glide.test.js
git commit -m "feat(dispatch): glide engine skeleton + first-sighting snap"
```

---

### Task 3: Glide over measured Δt + duration clamp

**Files:**
- Test: `xpizza-dispatch/driver-glide.test.js` (engine already complete)

- [ ] **Step 1: Add glide-progression + clamp tests** (append above final `console.log`)

```js
// glides A->B over the measured 10s gap, reaching B at t=10s
{
  const h = harness();
  h.at(0);      h.engine.update('u1', A);        // first sighting
  h.at(10000);  h.engine.update('u1', B);        // measuredDt = 10000 -> duration 10000
  const s = h.engine._state('u1');
  assert.strictEqual(s.duration, 10000, 'duration = clamped measured Δt');
  assert.strictEqual(h.pending(), 1, 'exactly one animation frame queued');

  h.at(10000); h.tick();                          // p=0 -> ~A
  assert.ok(distanceMeters(h.lastApplied().pos, A) < 0.5, 'starts at A');
  h.at(15000); h.tick();                          // p=0.5 -> midpoint
  const mid = lerpLatLng(A, B, 0.5);
  assert.ok(distanceMeters(h.lastApplied().pos, mid) < 0.5, 'midpoint at half time');
  h.at(20000); h.tick();                          // p=1 -> B, animation ends
  assert.ok(distanceMeters(h.lastApplied().pos, B) < 0.5, 'reaches B');
  assert.strictEqual(h.pending(), 0, 'no frame left after completion');
  assert.strictEqual(h.engine._state('u1').duration, 0, 'state settled');
  ok('glides A->B over measured 10s, settles at B');
}
// duration clamps to [MIN, MAX]
{
  const h = harness();
  h.at(0);     h.engine.update('u1', A);
  h.at(200);   h.engine.update('u1', B);          // 200ms gap -> clamp up to MIN 1000
  assert.strictEqual(h.engine._state('u1').duration, 1000, 'clamps up to MIN');

  const h2 = harness();
  h2.at(0);      h2.engine.update('u2', A);
  h2.at(30000);  h2.engine.update('u2', B);        // 30s gap -> clamp down to MAX 12000
  assert.strictEqual(h2.engine._state('u2').duration, 12000, 'clamps down to MAX');
  ok('duration clamps to [1s, 12s]');
}
```

- [ ] **Step 2: Run tests**

Run: `node xpizza-dispatch/driver-glide.test.js`
Expected: PASS — `6 passed`.

- [ ] **Step 3: Commit**

```bash
git add xpizza-dispatch/driver-glide.test.js
git commit -m "test(dispatch): glide progression + duration clamp"
```

---

### Task 4: ★ Build-gate — supersede mid-glide (no leaked frames, single animation)

**Files:**
- Test: `xpizza-dispatch/driver-glide.test.js`

- [ ] **Step 1: Add the supersede test** (append above final `console.log`)

```js
const C = { lat: 15.5005, lng: -88.001 };   // within glide range of the A->B path

// A fresh update mid-glide cancels the prior frame, keeps ONE animation, restarts from the displayed pos
{
  const h = harness();
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', B);       // glide #1 begins
  h.at(13000);  h.tick();                        // advance to p=0.3, frame reschedules
  const firstFrameId = h.engine._state('u1').rafId;

  h.at(13000);  h.engine.update('u1', C);        // fresh update mid-glide -> supersede
  assert.ok(h.cancelled.includes(firstFrameId), 'superseded frame was cancelled');
  assert.strictEqual(h.pending(), 1, 'exactly ONE frame after supersede (no leak, no fight)');

  const expectedFrom = lerpLatLng(A, B, 0.3);    // where the pin was displayed at t=13000
  const s = h.engine._state('u1');
  assert.ok(distanceMeters(s.startPos, expectedFrom) < 0.5, 'new glide starts from displayed pos, not A or B');
  assert.deepStrictEqual(s.targetPos, C, 'new glide targets C');
  ok('supersede mid-glide: one frame, cancels prior, restarts from displayed pos');
}
// Repeated supersedes never accumulate frames (leak guard over a long shift)
{
  const h = harness();
  h.at(0); h.engine.update('u1', A);
  for (let i = 1; i <= 20; i++) {
    h.at(i * 1000);
    h.engine.update('u1', i % 2 ? B : C);
    assert.ok(h.pending() <= 1, `never more than one pending frame (iter ${i}, got ${h.pending()})`);
  }
  ok('repeated supersedes never leak frames');
}
```

- [ ] **Step 2: Run tests**

Run: `node xpizza-dispatch/driver-glide.test.js`
Expected: PASS — `8 passed`.

- [ ] **Step 3: Commit**

```bash
git add xpizza-dispatch/driver-glide.test.js
git commit -m "test(dispatch): build-gate — supersede mid-glide, no frame leak"
```

---

### Task 5: Snap paths — stale, large jump, no-move; and removal cancel

**Files:**
- Test: `xpizza-dispatch/driver-glide.test.js`

- [ ] **Step 1: Add snap + cancel tests** (append above final `console.log`)

```js
const FAR = { lat: 15.60, lng: -88.10 };   // >10km from A -> implausible jump

// stale -> snap (never glide a dead pin)
{
  const h = harness();
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', B);        // glide begins
  h.at(11000);  h.engine.update('u1', C, { snap: true }); // stale flag mid-glide
  assert.strictEqual(h.pending(), 0, 'stale snap cancels the glide');
  assert.deepStrictEqual(h.lastApplied().pos, C, 'snapped to last-known pos');
  ok('stale mid-glide snaps, no animation');
}
// large delta -> snap (GPS glitch / reconnect)
{
  const h = harness();
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', FAR);
  assert.strictEqual(h.pending(), 0, 'implausible jump does not slide across the map');
  assert.deepStrictEqual(h.lastApplied().pos, FAR);
  ok('large delta snaps');
}
// no real move (status-only snapshot) -> apply, no animation
{
  const h = harness();
  h.at(0);      h.engine.update('u1', A);
  const n = h.applied.length;
  h.at(3000);   h.engine.update('u1', { lat: A.lat, lng: A.lng }); // identical pos
  assert.strictEqual(h.pending(), 0, 'identical position must not spawn a 1s glide');
  assert.strictEqual(h.applied.length, n + 1, 'still applied once (idempotent)');
  ok('identical position does not animate');
}
// removed mid-glide -> cancelAnimationFrame + state dropped
{
  const h = harness();
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', B);        // glide in flight
  const id = h.engine._state('u1').rafId;
  h.engine.cancel('u1');
  assert.ok(h.cancelled.includes(id), 'removal cancels the in-flight frame');
  assert.strictEqual(h.engine.has('u1'), false, 'state dropped');
  assert.strictEqual(h.pending(), 0, 'no leaked frame after removal');
  ok('removed mid-glide cancels frame + drops state');
}
```

- [ ] **Step 2: Run tests**

Run: `node xpizza-dispatch/driver-glide.test.js`
Expected: PASS — `12 passed`.

- [ ] **Step 3: Commit**

```bash
git add xpizza-dispatch/driver-glide.test.js
git commit -m "test(dispatch): snap on stale/jump/no-move + removal cancel"
```

---

### Task 6: Wire the engine into `updateDriverMarkers()` (index.html)

**Files:**
- Modify: `xpizza-dispatch/index.html` (inside `<script type="module">`)

- [ ] **Step 1: Add the import** — next to the existing `import * as XPD from './xpizza-delivery.js?v=16';`

```js
import { createGlideEngine } from './driver-glide.js?v=1';
```

- [ ] **Step 2: Instantiate one engine** — place it right after the `let driverMarkers = {};` declaration (so the sink can see `driverMarkers`).

```js
// Smooth interpolation of driver pins between the native service's ~10s pings.
// The engine is pure; here we wire it to the real clock, rAF, and marker sink.
const glide = createGlideEngine({
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
  apply: (uid, pos) => { const m = driverMarkers[uid]; if (m) m.setPosition(pos); },
});
```

- [ ] **Step 3: Replace the teleport in the update branch.** In `updateDriverMarkers()`, the existing branch reads:

```js
    if (driverMarkers[uid]) {
      driverMarkers[uid].setPosition({ lat: d.lat, lng: d.lng });
      driverMarkers[uid].setIcon(icon);
      driverMarkers[uid].setLabel({ text: initial, color: '#fff', fontFamily: 'Plus Jakarta Sans', fontSize: '11px', fontWeight: '700' });
    } else {
```

Change ONLY the `setPosition` line to route through the engine (icon/label stay immediate — color must not lag):

```js
    if (driverMarkers[uid]) {
      glide.update(uid, { lat: d.lat, lng: d.lng }, { snap: stale });
      driverMarkers[uid].setIcon(icon);
      driverMarkers[uid].setLabel({ text: initial, color: '#fff', fontFamily: 'Plus Jakarta Sans', fontSize: '11px', fontWeight: '700' });
    } else {
```

(`stale` is already computed above as `const stale = XPD.isStalePing(d.last_ping);` — reuse it; do not recompute.)

- [ ] **Step 4: Cancel on removal.** In the removal loop, add `glide.cancel(uid)` before unmounting:

```js
  for (const uid of Object.keys(driverMarkers)) {
    if (!seen.has(uid)) {
      glide.cancel(uid);
      driverMarkers[uid].setMap(null);
      delete driverMarkers[uid];
    }
  }
```

- [ ] **Step 5: Sanity-check the file parses** (no test runner for the browser bundle; this catches syntax slips)

Run: `node --check xpizza-dispatch/driver-glide.js && node -e "import('./xpizza-dispatch/driver-glide.js').then(m=>{if(typeof m.createGlideEngine!=='function')process.exit(1);console.log('module OK')})"`
Expected: `module OK`

- [ ] **Step 6: Commit**

```bash
git add xpizza-dispatch/index.html
git commit -m "feat(dispatch): glide driver pins between pings (wire engine into updateDriverMarkers)"
```

---

### Task 7: Diff-level acceptance proof (dark map intact, nothing else touched)

**Files:** none (verification only). This is the hard, automatable half of the acceptance gate; the visual "glides smoothly" is validated post-deploy on the live board.

- [ ] **Step 1: Prove no `mapId` / `AdvancedMarkerElement` was introduced and the map/color/removal blocks are untouched**

Run:
```bash
cd /Users/xavierlacayo/Downloads/xpizza-delivery
git diff main -- xpizza-dispatch/index.html | grep -E '^\+' | grep -Ei 'mapId|AdvancedMarker' && echo 'REGRESSION: map identity changed' || echo 'OK: no mapId / AdvancedMarker introduced'
grep -n 'styles: DARK_MAP_STYLE' xpizza-dispatch/index.html   # still present, unchanged
```
Expected: `OK: no mapId / AdvancedMarker introduced`, and `styles: DARK_MAP_STYLE` still present.

- [ ] **Step 2: Confirm the diff is minimal** — only the import, the `glide` instance, the one `setPosition`→`glide.update` line, and the `glide.cancel(uid)` line changed in `index.html`; the color branch, `SymbolPath.CIRCLE`, `zIndex`, `setIcon`/`setLabel`, and click→InfoWindow are byte-identical.

Run: `git diff main -- xpizza-dispatch/index.html`
Expected: review shows only the 4 intended edits; no change to the color branch, icon, label, zIndex, or InfoWindow handler.

- [ ] **Step 3: Full test suite green**

Run: `node xpizza-dispatch/driver-glide.test.js`
Expected: `12 passed`.

- [ ] **Step 4: Hand off to the advisor session to gate** (dark-map + no-leak + supersede-mid-glide), per Brief A. Do NOT merge/deploy until the advisor clears it. After clearance: merge to `main`, then `npx netlify deploy --prod --dir xpizza-dispatch --site ac3fa94a-564a-4df4-9428-34e6cb41f778` (bump the `?v=` on the `driver-glide.js` import if the module changes after first deploy, to bust cache).

---

## Self-Review

**1. Spec coverage (Brief A four behaviors + build-gate + acceptance):**
- Duration = measured Δt, clamped [1s,12s], not hardcoded → Task 3 (asserts `duration===10000`, clamp to 1000/12000). ✅
- Stale mid-glide → stop + hand to amber/gray → Task 5 stale-snap test; wiring passes `{ snap: stale }`, icon/label still applied immediately (color logic untouched). ✅
- Removed mid-glide → cancelAnimationFrame → Task 5 removal test + Task 6 Step 4 wiring. ✅
- Large delta → snap → Task 5 large-delta test. ✅
- ★ Supersede-mid-glide (build-gate) → Task 4 (cancels prior frame, one frame, restarts from displayed pos; 20-iteration leak guard). ✅
- Dark map intact / no `mapId` / no `AdvancedMarkerElement` → Task 7 Step 1. ✅
- Color branch / CIRCLE / zIndex / InfoWindow untouched → Task 6 changes only `setPosition`; Task 7 Step 2 verifies. ✅
- InfoWindow tracks gliding marker → automatic (marker-anchored `infoWindow.open(map, marker)`; `setPosition` moves it). No code needed; noted in Brief acceptance as "should be automatic." ✅

**2. Placeholder scan:** none — every step has real code/commands and expected output.

**3. Type consistency:** `createGlideEngine`/`update`/`cancel`/`has`/`_state`/`lerpLatLng`/`distanceMeters` names identical across Tasks 1–7 and the wiring. `apply(uid,pos)` sink signature matches the engine's internal `apply` calls. `{ snap }` option used in Task 5 tests and Task 6 wiring. `_state(uid).duration/startPos/targetPos/rafId` fields referenced in tests match the engine's state object. ✅

**Note on Node version:** tests rely on Node's ESM-in-`.js` auto-detection (verified on the local v24). If ever run on Node < 22, rename the two files to `.mjs` — no code change. The browser is unaffected (`<script type="module">` loads `.js` ESM natively, same as `xpizza-delivery.js`).
