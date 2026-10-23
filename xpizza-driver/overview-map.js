/**
 * Slice-2 driver-app refresh — the in-app OVERVIEW MAP (SVG reference schematic). PURE: no DOM, no
 * Firebase, no globals, no writers, no network; it takes already-resolved client coordinates and returns
 * an SVG markup string. Unit-tested with `node overview-map.test.js` (no framework, repo idiom).
 *
 * It is a MAP DE REFERENCIA, never navigation: turn-by-turn stays in Waze/Maps (the nav button). It plots
 * the driver, the restaurant hub(s), and the numbered customer stop(s) from their REAL lat/lng, projected
 * honestly:
 *   - equirectangular with longitude scaled by cos(latitude) so bearings/distances are not stretched,
 *   - NORTH UP (larger latitude → higher on screen),
 *   - a SINGLE scale on both axes (aspect preserved),
 *   - a plain background with a straight-line reference connector from the driver to the current target
 *     (OWNER RULING 2026-10-20: no decorative street grid, no fake roads — only the real-coordinate layer),
 *   - finite/range validation on every point; a missing point is omitted with a "sin ubicación" note,
 *   - coincident points nudged apart so they stay visible, degenerate bounds centered at a fixed zoom.
 *
 * Freshness is the caller's concern (it passes `stale`, derived from drivers/<uid>/last_location_ts, NOT
 * last_ping — see index.html SLICE2:MAP-LIFECYCLE): when stale, the driver dot dims and never animates.
 * Brand-agnostic + Sola-subtle ([[sherpa-brand-sola-logo]]): the driver dot carries the Sola compass needle.
 */

/** viewBox + the inner drawing box (margins leave room for pin tips drawn upward + the driver halo). */
export const VIEWBOX = { w: 358, h: 150 };
const BOX = { x0: 30, y0: 34, x1: 328, y1: 120 };   // inner area the projected points fill

/** Default map-aging threshold (ms): a fix older than this → the driver position is shown STALE (dimmed). */
export const STALE_MS = 90 * 1000;   // 90 s — tolerates a few missed ~30 s heartbeats before dimming

/**
 * Normalize a driver fix timestamp to epoch MILLISECONDS. The verified writer unit is ms: the native
 * sender's `last_location_ts` is `final.ts = coerceTs(p.ts)` (xpizza-functions/driver-ingest.js), and
 * coerceTs ALWAYS yields epoch ms — an ISO-8601 string via `Date.parse`, a numeric Transistorsoft value
 * passed through (configured to ms), null for anything else (then dropped by selectIngestPoints). The
 * seconds branch here is DEFENSE-ONLY for a legacy/garbled value: a finite positive number too small to
 * be a plausible ms timestamp (< 1e11 ms = before 1973-03) is read as epoch SECONDS and scaled — this
 * never misfires on a real ms timestamp (~1.7e12). Missing / zero / non-finite → NaN (⇒ treated stale).
 */
export function normalizeFixTs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return n < 1e11 ? n * 1000 : n;
}

/**
 * Is the driver's position STALE? CONSERVATIVE: a missing / zero / non-finite fix ts ⇒ stale; a
 * non-finite clock ⇒ stale; otherwise stale iff the fix is older than `thresholdMs`. `nowMs` is injected
 * (the call site's clock) so this stays pure, and age is measured on the SAME device that wrote the fix
 * (the driver's own record), so the comparison is clock-consistent.
 */
export function isStaleFix(last_location_ts, nowMs, thresholdMs = STALE_MS) {
  const ts = normalizeFixTs(last_location_ts);
  if (!Number.isFinite(ts)) return true;
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return true;
  return (now - ts) >= thresholdMs;
}

/** A coordinate is projectable only if finite AND in real lat/lng range. */
export function isFiniteCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/**
 * Project an array of {lat,lng} geo points into viewBox pixels. Returns an array aligned with the input:
 * {x,y} for a projectable point, null for a missing/out-of-range one. Equirectangular (cos-lat on
 * longitude), north up, single shared scale (aspect-preserving), centered in `box`; degenerate bounds
 * (one distinct point) center at a fixed position; coincident pixels are nudged apart.
 */
export function projectGeo(pts, box = BOX) {
  const W = box.x1 - box.x0, H = box.y1 - box.y0;
  const bx = (box.x0 + box.x1) / 2, by = (box.y0 + box.y1) / 2;

  const valid = pts.map((p) => (p && isFiniteCoord(p.lat, p.lng)) ? p : null);
  const present = valid.filter(Boolean);
  if (present.length === 0) return pts.map(() => null);

  // cos(latitude) longitude scaling, from the mean latitude of the present points (clamped off zero).
  const meanLat = present.reduce((a, p) => a + p.lat, 0) / present.length;
  const cosLat = Math.max(0.01, Math.cos(meanLat * Math.PI / 180));

  // Raw projected plane: x grows east (lng·cosLat), y grows SOUTH (−lat) so north is up.
  const raw = valid.map((p) => p ? { rx: p.lng * cosLat, ry: -p.lat } : null);
  const rp = raw.filter(Boolean);
  const xs = rp.map((r) => r.rx), ys = rp.map((r) => r.ry);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX, spanY = maxY - minY;

  // One scale for both axes → no stretch. Degenerate (zero span) → fixed centered placement.
  let scale;
  if (spanX <= 0 && spanY <= 0) {
    scale = 1;
  } else {
    const sX = spanX > 0 ? W / spanX : Infinity;
    const sY = spanY > 0 ? H / spanY : Infinity;
    scale = Math.min(sX, sY);
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const out = raw.map((r) => r ? { x: bx + (r.rx - cx) * scale, y: by + (r.ry - cy) * scale } : null);

  // Coincident-point separation: nudge any marker landing within EPS px of an earlier one.
  const EPS = 7, seen = [];
  for (const o of out) {
    if (!o) continue;
    let guard = 0;
    while (seen.some((s) => Math.hypot(s.x - o.x, s.y - o.y) < EPS) && guard < 8) {
      o.x += 6; o.y -= 6; guard += 1;
    }
    seen.push({ x: o.x, y: o.y });
  }
  return out;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The driver dot: white halo + marino disc + the Sola compass needle (celeste north / white south), rotated by heading. */
function driverDot(x, y, heading, stale) {
  const rot = Number.isFinite(heading) ? heading : 0;
  return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})" class="om-drv"${stale ? ' opacity="0.45"' : ''}>`
    + `<circle r="15" fill="#fff" opacity="0.92"/>`
    + `<circle r="11.5" fill="#14306B"/>`
    + `<g transform="rotate(${rot.toFixed(1)})">`
    + `<path d="M0 -7 L3.4 2 L-3.4 2 Z" fill="#8EC0FF"/>`
    + `<path d="M0 6.5 L3.4 2 L-3.4 2 Z" fill="#fff"/>`
    + `<circle r="1.5" fill="#14306B"/>`
    + `</g></g>`;
}

/** The restaurant/hub marker (a rounded store glyph); `on` = current pickup target (marino), else dim. */
function hubMarker(x, y, on) {
  return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})" class="om-hub"${on ? '' : ' opacity="0.65"'}>`
    + `<rect x="-11" y="-11" width="22" height="22" rx="7" fill="${on ? '#14306B' : 'var(--surface, #fff)'}" stroke="${on ? '#fff' : 'var(--line, #D7DEEA)'}" stroke-width="2"/>`
    + `<g transform="translate(-7 -7) scale(.58)" fill="none" stroke="${on ? '#fff' : 'var(--muted, #6B7687)'}" stroke-width="2.4" stroke-linejoin="round">`
    + `<path d="M4 10l1.5-5h13L20 10"/><path d="M4 10a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0"/><path d="M5 12v8h14v-8M10 20v-5h4v5"/>`
    + `</g></g>`;
}

/** A numbered customer stop pin; `on` = active stop (marino/white number), else dim/grey. */
function stopPin(x, y, n, on) {
  const fill = on ? '#14306B' : 'var(--surface, #fff)';
  const stroke = on ? '#fff' : 'var(--line, #D7DEEA)';
  // Queued-pin NUMBER must stay AA. The pin SHAPE is dimmed (opacity on the PATH only), but the number is drawn
  // at FULL opacity in a dark ink (`--text-soft` #546078 ≈ 6:1 on the pin fill) so it never composites below AA.
  // The old group-wide opacity="0.8" pulled `--muted` #6B7687 down to ~3.2:1 (Codex r1 P2-8).
  const txt = on ? '#fff' : 'var(--text-soft, #546078)';
  return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})" class="om-stop">`
    + `<path d="M0 0c-6-7-9-11-9-16a9 9 0 1 1 18 0c0 5-3 9-9 16z" fill="${fill}" stroke="${stroke}" stroke-width="2"${on ? '' : ' opacity="0.8"'}/>`
    + `<text x="0" y="-12.5" text-anchor="middle" font-family="Red Hat Display, sans-serif" font-weight="800" font-size="11" fill="${txt}">${esc(n)}</text>`
    + `</g>`;
}

/**
 * Build the overview-map markup.
 *   driver: {lat,lng,heading} | null                 the driver's own live position (drivers/<uid>)
 *   hubs:   [{lat,lng, on?}]  (or a single {lat,lng}) the restaurant(s) — `on` marks the current pickup hub
 *   stops:  [{lat,lng, n, on?}]                       numbered customer stops — `on` marks the active stop
 *   phase:  'pickup' | 'delivery'                     which point the straight connector targets
 *   stale:  boolean                                   true → dim the driver dot, no motion
 * Returns a `<div class="map">…</div>` string: an SVG reference field + a "de referencia" caption, plus a
 * "sin ubicación" note when a needed point is missing. No tiles, no key, no network.
 */
export function overviewMapSvg({ driver = null, hubs = [], stops = [], phase = 'delivery', stale = false } = {}) {
  const hubList = Array.isArray(hubs) ? hubs : (hubs ? [hubs] : []);
  const stopList = Array.isArray(stops) ? stops : [];

  // Project driver + hubs + stops together so they share one honest projection.
  const geo = [driver, ...hubList, ...stopList];
  const proj = projectGeo(geo);
  const pDriver = proj[0];
  const pHubs = proj.slice(1, 1 + hubList.length);
  const pStops = proj.slice(1 + hubList.length);

  // The connector targets the phase-correct current point: pickup → the active (or only) hub; delivery →
  // the active (or first) stop. Draw the straight line only when both the driver and that target projected.
  let target = null;
  if (phase === 'pickup') {
    const i = hubList.findIndex((h) => h && h.on);
    const k = i >= 0 ? i : (pHubs.length ? 0 : -1);
    target = k >= 0 ? pHubs[k] : null;
  } else {
    const i = stopList.findIndex((s) => s && s.on);
    const k = i >= 0 ? i : (pStops.length ? 0 : -1);
    target = k >= 0 ? pStops[k] : null;
  }

  // Missing-point notes (what the driver should know is absent, not a failure of the cards).
  const notes = [];
  if (!pDriver) notes.push('tu ubicación');
  if (hubList.length && pHubs.every((p) => !p)) notes.push('el restaurante');
  const missingStops = pStops.filter((p) => !p).length;
  if (missingStops) notes.push(missingStops === 1 ? 'una parada' : `${missingStops} paradas`);

  const parts = [];
  // 1. straight reference connector (driver → current target), drawn first so markers sit on top.
  if (pDriver && target) {
    parts.push(`<path class="om-route" d="M${pDriver.x.toFixed(1)} ${pDriver.y.toFixed(1)} L${target.x.toFixed(1)} ${target.y.toFixed(1)}" fill="none" stroke="var(--p, #2F5FB8)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`);
  }
  // 2. hubs, 3. stops, 4. driver on top.
  hubList.forEach((h, i) => { if (pHubs[i]) parts.push(hubMarker(pHubs[i].x, pHubs[i].y, !!h.on && phase === 'pickup')); });
  stopList.forEach((s, i) => { if (pStops[i]) parts.push(stopPin(pStops[i].x, pStops[i].y, s.n != null ? s.n : (i + 1), !!s.on && phase !== 'pickup')); });
  if (pDriver) parts.push(driverDot(pDriver.x, pDriver.y, driver && driver.heading, stale));

  // Driver-only (the common GPS-warming case): a natural sentence. Any other / combined missing point keeps the
  // composed "Sin ubicación de X y Y" form. (Owner copy: «Tu ubicación no está disponible».)
  const noteHtml = notes.length
    ? `<div class="map-note">${(!pDriver && notes.length === 1) ? 'Tu ubicación no está disponible' : 'Sin ubicación de ' + notes.join(' y ')}</div>`
    : '';

  return `<div class="map${stale ? ' stale' : ''}" role="img" aria-label="Mapa de referencia${notes.length ? ' (ubicación incompleta)' : ''}">`
    + `<svg viewBox="0 0 ${VIEWBOX.w} ${VIEWBOX.h}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`
    + `<div class="map-cap">Mapa de referencia · navega con el botón</div>`
    + noteHtml
    + `</div>`;
}
