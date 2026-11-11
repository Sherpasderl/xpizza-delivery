// «Envío» step 1 (PLAN-portal-envio-step1 r2 §4 + build condition C3) — the map site's geometry. Pure: no DOM, no google.maps.
//
// The rings must sit where the SERVER prices. The server measures a delivery with haversine on a 6,371,000 m sphere
// (xpizza-functions/delivery/delivery-pricing.js haversineKm), so every ring vertex, the outside hole and the label anchors come
// from ONE destination() on that same sphere — never google.maps.Circle, whose 6,378,137 m radius sits ~11 m off at 10 km.
// A ring is a closed 256-vertex polygon: its worst chord falls 0.75 m inside the ring at 10 km.
//
// The approved mockup draws 24 units per km in a 640×520 viewBox with the picked pin at (320, 270). For a box W px wide that is
// 24·W/640 px per km. Google's Web Mercator spans 256 px at zoom 0 around a sphere it treats as 2π·6,378,137 m — but our points
// are placed on the 6,371,000 m sphere, so the scale constant that turns SERVER metres into pixels is 2π·6,371,000/256.
// The initial / reset view only: the owner may zoom and pan after it.

export const EARTH_M = 6371000;
export const RING_SEGMENTS = 256;
export const MOCK = Object.freeze({ w: 640, h: 520, cx: 320, cy: 270, unitsPerKm: 24 });
const M_PER_PX_Z0 = (2 * Math.PI * EARTH_M) / 256;   // ≈ 156367.86559 server metres per px at zoom 0, at the equator

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const okHub = (h) => !!h && Number.isFinite(h.lat) && Number.isFinite(h.lng) && Math.abs(h.lat) <= 90 && Math.abs(h.lng) <= 180;

// the point `metres` from `hub` on the initial bearing `bearingDeg` (0 = north, 90 = east), on the server's sphere
export function destination(hub, bearingDeg, metres) {
  if (!okHub(hub)) throw new Error('envio geometry: bad hub');
  if (!(Number.isFinite(metres) && metres >= 0)) throw new Error('envio geometry: bad distance');
  const d = metres / EARTH_M, t = rad(bearingDeg), p1 = rad(hub.lat), l1 = rad(hub.lng);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: deg(p2), lng: ((deg(l2) + 540) % 360) - 180 };
}

// the closed ring at `km` around `hub`: RING_SEGMENTS vertices, clockwise from north (the first is not repeated)
export function ringPath(hub, km) {
  if (!(Number.isFinite(km) && km > 0)) throw new Error('envio geometry: bad km');
  const out = new Array(RING_SEGMENTS);
  for (let i = 0; i < RING_SEGMENTS; i++) out[i] = destination(hub, (i * 360) / RING_SEGMENTS, km * 1000);
  return out;
}

export function pixelsPerKm(width) {
  if (!(Number.isFinite(width) && width > 0)) throw new Error('envio geometry: bad width');
  return (MOCK.unitsPerKm * width) / MOCK.w;
}

// the fractional zoom at which one SERVER km spans pixelsPerKm(width) px at latitude `lat` (Web Mercator's cos(lat) scale)
export function zoomFor(width, lat) {
  const mPerPx = 1000 / pixelsPerKm(width);
  return Math.log2((M_PER_PX_Z0 * Math.cos(rad(lat))) / mPerPx);
}

// the camera centre that puts the hub where the mockup draws its pin: (MOCK.cy − MOCK.h/2) units below the box centre,
// i.e. that many mockup units of distance NORTH of the hub
export function cameraCenter(hub) {
  const units = MOCK.cy - MOCK.h / 2;
  return destination(hub, 0, (units / MOCK.unitsPerKm) * 1000);
}

// a ring label's anchor: on the ring, 45° (NE) for a band, 225° (SW) for a refused band — the mockup's diagonal
export function labelAnchor(hub, km, refused) {
  return destination(hub, refused ? 225 : 45, km * 1000);
}
