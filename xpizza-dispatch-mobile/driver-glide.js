/**
 * Smooth driver-pin tracking for the dispatch board.
 *
 * Pure, dependency-free glide state machine — NO google.maps, NO DOM, NO globals.
 * It is injected with now/raf/caf/apply so the whole thing (esp. the supersede
 * logic) is deterministically unit-testable in Node with a fake clock + fake rAF.
 *
 * Item A of the Driver Tracking Program. Interpolates each driver marker between
 * the native service's ~10s location pings so pins glide instead of teleporting.
 * The legacy google.maps.Marker is kept on purpose (an AdvancedMarkerElement needs
 * a mapId, which silently disables the dispatch map's inline DARK_MAP_STYLE).
 */

export function lerpLatLng(start, target, t) {
  return {
    lat: start.lat + (target.lat - start.lat) * t,
    lng: start.lng + (target.lng - start.lng) * t,
  };
}

// Equirectangular approximation — accurate to well under a metre at city scale,
// which is all the snap / no-move thresholds need.
export function distanceMeters(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * R;
}

/**
 * @param now   () => number   ms clock (performance.now in the browser)
 * @param raf   (cb) => id     requestAnimationFrame
 * @param caf   (id) => void   cancelAnimationFrame
 * @param apply (uid, {lat,lng}) => void   sink that moves the real marker
 * @param options { minDurationMs=1000, maxDurationMs=12000, snapThresholdMeters=500 }
 */
export function createGlideEngine({ now, raf, caf, apply, options = {} }) {
  const MIN = options.minDurationMs ?? 1000;
  const MAX = options.maxDurationMs ?? 15000;         // headroom so the margin isn't clamped (was 12000)
  const SNAP_M = options.snapThresholdMeters ?? 500;
  const NOMOVE_M = options.noMoveMeters ?? 0.5;       // target-moved threshold: below this = same sample (no-op)
  const MARGIN = options.marginFactor ?? 1.15;        // duration = real inter-target interval × MARGIN (tunable)
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

    // ★ TARGET-KEYED TIMING (root-cause fix): the app also calls update() on a 5s label-refresh tick
    // (and on any other driver's ping) with THIS driver's UNCHANGED position. Such stale calls MUST be
    // true no-ops — otherwise they reset lastUpdateTime, truncating the next real move's measuredDt →
    // too-short duration → the marker rushes to the sample then idles (the "stop-and-go" beat). Only a
    // genuinely-MOVED target advances the clock. Compare to the target we're gliding toward (s.targetPos),
    // NOT the displayed position (which is mid-glide, behind the target — why the snap below misses it).
    if (!opts.snap && distanceMeters(target, s.targetPos) < NOMOVE_M) return;

    const from = displayedPos(s, t);
    const measuredDt = t - s.lastUpdateTime;
    s.lastUpdateTime = t;
    const dist = distanceMeters(from, target);

    // stale (caller-forced) / implausible jump / already-at-target → snap, never glide
    if (opts.snap || dist > SNAP_M || dist < 0.5) {
      settle(s, uid, target, t);
      return;
    }

    if (s.rafId != null) { caf(s.rafId); s.rafId = null; } // supersede any in-flight glide
    s.startPos = from;
    s.targetPos = target;
    s.startTime = t;
    // Duration ≈ the REAL inter-target interval (measuredDt is now clean — no-op'd ticks don't advance
    // the clock), inflated by MARGIN so each glide slightly overshoots the interval and is still moving
    // when the next ping lands (kills jitter/missed-ping micro-stops). Cost: the marker keeps gliding
    // ~1-2s past a stop before resting. MARGIN is tunable (see the createGlideEngine call).
    s.duration = Math.max(MIN, Math.min(measuredDt * MARGIN, MAX));

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
