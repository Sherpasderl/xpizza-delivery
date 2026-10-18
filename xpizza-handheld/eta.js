// H1b T5 — the driver's arrival at the restaurant (advisor Q-D correction), client-side and traffic-aware like the customer tracker
// (DirectionsService, drivingOptions.departureTime = now, duration_in_traffic else duration). No dwell is added:
// this is arrival at the restaurant, not the customer hand-off.
//   watch(orderId, fetchState, onEta) runs now and every ~60 s while the detail / ready card is visible, and returns unwatch()
//   (hidden, picked up, branch change). fetchState() → merchantOrderState ({driver_location, pickup_location}); onEta(ms | null).
//   ANY failure or missing input → null: the UI shows the name only, never a guessed time. A result landing after unwatch is dropped.
export const ETA_INTERVAL_MS = 60000;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const point = (p) => (p && isNum(p.lat) && isNum(p.lng) ? { lat: p.lat, lng: p.lng } : null);

export function travelSeconds(res, status) {
  if (status !== 'OK' || !res || !Array.isArray(res.routes) || !res.routes[0] || !res.routes[0].legs || !res.routes[0].legs[0]) return null;
  const leg = res.routes[0].legs[0];
  const v = (leg.duration_in_traffic && leg.duration_in_traffic.value) || (leg.duration && leg.duration.value);
  return isNum(v) && v >= 0 ? v : null;
}

// The browser route adapter over the Maps JS API (loaded by index.html when a key is configured). Never throws.
export function googleRoute(source) {
  const G = typeof source === 'function' ? source : () => source;   // a getter: the Maps global may load after the adapter is made
  let svc = null;
  return (origin, destination) => new Promise((resolve) => {
    try {
      const g = G();
      if (!(g && g.maps && g.maps.DirectionsService)) { resolve(null); return; }
      if (!svc) svc = new g.maps.DirectionsService();
      svc.route({ origin, destination, travelMode: g.maps.TravelMode.DRIVING, drivingOptions: { departureTime: new Date() } },
        (res, status) => { try { resolve(travelSeconds(res, status)); } catch (_) { resolve(null); } });
    } catch (_) { resolve(null); }
  });
}

export function createEta({ route, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = ETA_INTERVAL_MS }) {
  const loops = new Map();                            // orderId → {active, timer}
  async function once(loop, fetchState, onEta) {
    let eta = null;
    try {
      const s = await fetchState();
      const from = s && s.driver_assigned === true ? point(s.driver_location) : null;
      const to = s ? point(s.pickup_location) : null;
      if (from && to) {
        const sec = await route(from, to);
        if (isNum(sec) && sec >= 0) eta = now() + sec * 1000;
      }
    } catch (_) { eta = null; }
    if (loop.active) onEta(eta);
  }
  return {
    watch(orderId, fetchState, onEta) {
      if (loops.has(orderId)) return loops.get(orderId).stop;
      const loop = { active: true, timer: null };
      const run = async () => { await once(loop, fetchState, onEta); if (loop.active) loop.timer = setTimer(run, intervalMs); };
      loop.stop = () => { loop.active = false; if (loop.timer) clearTimer(loop.timer); loops.delete(orderId); };
      loops.set(orderId, loop);
      void run();
      return loop.stop;
    },
    stopAll() { for (const l of [...loops.values()]) l.stop(); },
  };
}
