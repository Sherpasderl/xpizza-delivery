// Pure overview-map helpers — run: `node overview-map.test.js` (no framework, repo idiom).
import assert from 'node:assert/strict';
import { isFiniteCoord, projectGeo, overviewMapSvg, VIEWBOX, normalizeFixTs, isStaleFix, STALE_MS } from './overview-map.js';

let passed = 0;
function t(name, fn) { fn(); passed += 1; }
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

// Tegucigalpa-ish real coords (Honduras ~14°N, -87°W) so cos(lat) scaling is exercised honestly.
const O = { lat: 14.08, lng: -87.20 };
const E = { lat: 14.08, lng: -87.10 };   // +0.10° longitude from O
const N = { lat: 14.18, lng: -87.20 };   // +0.10° latitude  from O

// ---------- isFiniteCoord ----------
t('isFiniteCoord: valid HN coord', () => assert.equal(isFiniteCoord(14.08, -87.2), true));
t('isFiniteCoord: NaN rejected', () => assert.equal(isFiniteCoord(NaN, -87.2), false));
t('isFiniteCoord: out-of-range lat rejected', () => assert.equal(isFiniteCoord(91, 0), false));
t('isFiniteCoord: out-of-range lng rejected', () => assert.equal(isFiniteCoord(0, 181), false));
t('isFiniteCoord: null-ish rejected', () => assert.equal(isFiniteCoord(undefined, -87), false));

// ---------- projectGeo: north up ----------
t('projectGeo: higher latitude projects higher on screen (smaller y)', () => {
  const [hi, lo] = projectGeo(deepFreeze([{ lat: 14.10, lng: -87.20 }, { lat: 14.05, lng: -87.20 }]));
  assert.ok(hi.y < lo.y, `north-up: ${hi.y} should be < ${lo.y}`);
});

// ---------- projectGeo: aspect-preserving equirectangular (cos-lat on longitude) ----------
t('projectGeo: longitude is scaled by cos(latitude) vs latitude (aspect preserved)', () => {
  const [o, e, n] = projectGeo(deepFreeze([O, E, N]));
  const dxE = Math.abs(e.x - o.x);     // 0.10° lng  → 0.10·cosLat·scale
  const dyN = Math.abs(n.y - o.y);     // 0.10° lat  → 0.10·scale
  const meanLat = (O.lat + E.lat + N.lat) / 3;
  const cosLat = Math.cos(meanLat * Math.PI / 180);
  assert.ok(Math.abs(dxE / dyN - cosLat) < 1e-6, `ratio ${dxE / dyN} ≈ cosLat ${cosLat}`);
});

// ---------- projectGeo: degenerate single point centers ----------
t('projectGeo: a single distinct point lands at the box center', () => {
  const [p] = projectGeo(deepFreeze([O]));
  // box center = ((30+328)/2, (34+120)/2) = (179, 77)
  assert.ok(Math.abs(p.x - 179) < 0.001 && Math.abs(p.y - 77) < 0.001, `center ${p.x},${p.y}`);
});
t('projectGeo: all-identical points do not divide by zero', () => {
  const out = projectGeo(deepFreeze([O, { ...O }, { ...O }]));
  assert.ok(out.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)));
});

// ---------- projectGeo: coincident points nudged apart ----------
t('projectGeo: two coincident points are separated so both stay visible', () => {
  // Add a far third point so the box is non-degenerate, then two identical close points.
  const out = projectGeo(deepFreeze([O, { ...O }, N]));
  const d = Math.hypot(out[0].x - out[1].x, out[0].y - out[1].y);
  assert.ok(d >= 6, `coincident pair separated by ${d}px`);
});

// ---------- projectGeo: missing / out-of-range points → null, others still project ----------
t('projectGeo: a non-finite point is null; finite neighbours still project', () => {
  const out = projectGeo(deepFreeze([{ lat: NaN, lng: -87.2 }, O, N]));
  assert.equal(out[0], null);
  assert.ok(out[1] && out[2]);
});
t('projectGeo: empty / all-missing input → all null', () => {
  assert.deepEqual(projectGeo(deepFreeze([{ lat: NaN, lng: NaN }])), [null]);
});

// ---------- overviewMapSvg: active delivery (driver + dim hub + active stop) ----------
t('overviewMapSvg: delivery with driver+hub+active stop draws dot, hub, pin, connector', () => {
  const svg = overviewMapSvg(deepFreeze({
    driver: { lat: 14.08, lng: -87.20, heading: 90 },
    hubs: [{ lat: 14.10, lng: -87.22 }],
    stops: [{ lat: 14.06, lng: -87.16, n: 1, on: true }],
    phase: 'delivery', stale: false,
  }));
  assert.ok(svg.includes('om-drv'), 'driver dot');
  assert.ok(svg.includes('om-hub'), 'hub marker');
  assert.ok(svg.includes('om-stop'), 'stop pin');
  assert.ok(svg.includes('om-route'), 'connector');
  assert.ok(svg.includes('aria-label="Mapa de referencia"'), 'reference aria');
  assert.ok(!svg.includes('ubicación incompleta'), 'no missing note');
  assert.ok(svg.includes(`viewBox="0 0 ${VIEWBOX.w} ${VIEWBOX.h}"`), 'viewBox');
});

// ---------- overviewMapSvg: active + queued (two stops, numbered) ----------
t('overviewMapSvg: two stops render two numbered pins', () => {
  const svg = overviewMapSvg(deepFreeze({
    driver: { lat: 14.08, lng: -87.20, heading: 0 },
    hubs: [{ lat: 14.10, lng: -87.22 }],
    stops: [{ lat: 14.06, lng: -87.16, n: 1, on: true }, { lat: 14.12, lng: -87.10, n: 2 }],
    phase: 'delivery',
  }));
  assert.ok((svg.match(/om-stop/g) || []).length === 2, 'two pins');
  assert.ok(svg.includes('>1</text>') && svg.includes('>2</text>'), 'numbered 1 and 2');
});

// ---------- overviewMapSvg: stale → dimmed dot, no motion ----------
t('overviewMapSvg: stale dims the driver dot and marks the map stale', () => {
  const svg = overviewMapSvg(deepFreeze({
    driver: { lat: 14.08, lng: -87.20, heading: 10 },
    stops: [{ lat: 14.06, lng: -87.16, n: 1, on: true }],
    phase: 'delivery', stale: true,
  }));
  assert.ok(svg.includes('class="map stale"'), 'stale class');
  assert.ok(svg.includes('opacity="0.45"'), 'dimmed dot');
});

// ---------- overviewMapSvg: missing driver fix → no dot, no connector, note ----------
t('overviewMapSvg: missing driver fix omits the dot + connector and notes it', () => {
  const svg = overviewMapSvg(deepFreeze({
    driver: null,
    hubs: [{ lat: 14.10, lng: -87.22 }],
    stops: [{ lat: 14.06, lng: -87.16, n: 1, on: true }],
    phase: 'delivery',
  }));
  assert.ok(!svg.includes('om-drv'), 'no driver dot');
  assert.ok(!svg.includes('om-route'), 'no connector without a driver');
  assert.ok(svg.includes('Tu ubicación no está disponible'), 'driver-only note (owner copy)');
  assert.ok(svg.includes('ubicación incompleta'), 'aria flags incomplete');
});

// ---------- overviewMapSvg: missing stop coords → note "una parada" ----------
t('overviewMapSvg: a stop without coords is noted, cards still get a map', () => {
  const svg = overviewMapSvg(deepFreeze({
    driver: { lat: 14.08, lng: -87.20 },
    stops: [{ lat: NaN, lng: NaN, n: 1, on: true }],
    phase: 'delivery',
  }));
  assert.ok(svg.includes('Sin ubicación de una parada'), 'stop note');
  assert.ok(svg.includes('om-drv'), 'driver still drawn');
});

// ---------- overviewMapSvg: driver AND a stop missing → the driver-only sentence must NOT swallow the rest ----------
t('overviewMapSvg: driver + stop both missing keeps the composed "de … y …" form', () => {
  const svg = overviewMapSvg(deepFreeze({
    driver: null,
    hubs: [{ lat: 14.10, lng: -87.22 }],
    stops: [{ lat: NaN, lng: NaN, n: 1, on: true }],
    phase: 'delivery',
  }));
  assert.ok(svg.includes('Sin ubicación de tu ubicación y una parada'), 'both missing → composed form, not the driver-only sentence');
  assert.ok(!svg.includes('Tu ubicación no está disponible'), 'driver-only sentence is NOT used when more than one point is missing');
});

// ---------- overviewMapSvg: pickup phase targets the hub ----------
t('overviewMapSvg: pickup draws the connector to the hub (not the customer)', () => {
  const svg = overviewMapSvg(deepFreeze({
    driver: { lat: 14.08, lng: -87.20, heading: 45 },
    hubs: [{ lat: 14.10, lng: -87.22, on: true }],
    stops: [{ lat: 14.06, lng: -87.16, n: 1 }],
    phase: 'pickup',
  }));
  assert.ok(svg.includes('om-route'), 'connector present in pickup');
  assert.ok(svg.includes('om-hub') && svg.includes('om-stop'), 'both hub and customer shown');
});

// ---------- overviewMapSvg: nothing has coords → empty reference field, no throw ----------
t('overviewMapSvg: no coords at all renders an empty reference field with a note', () => {
  const svg = overviewMapSvg(deepFreeze({ driver: null, hubs: [], stops: [], phase: 'delivery' }));
  assert.ok(svg.includes('class="map"'), 'map container');
  assert.ok(svg.includes('Tu ubicación no está disponible'), 'note when driver missing (owner copy)');
});

// ---------- normalizeFixTs: verified writer unit is ms; seconds branch is defense-only ----------
t('normalizeFixTs: an epoch-ms value passes through unchanged', () => {
  assert.equal(normalizeFixTs(1760000000000), 1760000000000);
});
t('normalizeFixTs: a stray epoch-SECONDS value is scaled to ms (defense-only)', () => {
  assert.equal(normalizeFixTs(1760000000), 1760000000 * 1000);
});
t('normalizeFixTs: zero / negative / non-finite / missing → NaN', () => {
  for (const v of [0, -5, NaN, Infinity, null, undefined, 'x', {}]) assert.ok(Number.isNaN(normalizeFixTs(v)), `${String(v)} → NaN`);
});

// ---------- isStaleFix (Codex P1-3): conservative ----------
t('isStaleFix: a recent fix (fresh last_ping irrelevant) is NOT stale', () => {
  const now = 1760000000000;
  assert.equal(isStaleFix(now - 10 * 1000, now), false);
});
t('isStaleFix: a fix older than the threshold IS stale even with a fresh device-alive clock', () => {
  const now = 1760000000000;
  assert.equal(isStaleFix(now - (STALE_MS + 1000), now), true);
});
t('isStaleFix: missing / zero / non-finite last_location_ts ⇒ STALE (conservative)', () => {
  const now = 1760000000000;
  for (const v of [0, null, undefined, NaN, -1]) assert.equal(isStaleFix(v, now), true, `${String(v)} ⇒ stale`);
});
t('isStaleFix: a non-finite clock ⇒ STALE (cannot measure age)', () => {
  assert.equal(isStaleFix(1760000000000, NaN), true);
});
t('isStaleFix: seconds-valued fix ts is normalized before the age test', () => {
  const nowSec = 1760000000, now = nowSec * 1000;
  assert.equal(isStaleFix(nowSec - 10, now), false, 'recent seconds fix → fresh');
  assert.equal(isStaleFix(nowSec - (STALE_MS / 1000 + 5), now), true, 'old seconds fix → stale');
});

console.log(`overview-map.test.js: ${passed} passed`);
