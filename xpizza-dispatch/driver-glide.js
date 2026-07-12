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

    // stale (caller-forced) / implausible jump / no real move → snap, never glide
    if (opts.snap || dist > SNAP_M || dist < 0.5) {
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
