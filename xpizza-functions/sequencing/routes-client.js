'use strict';
// BUILD-stacked-seq-server r5 T3 — the Routes client: ONE computeRouteMatrix call per decision.
//
// origins [hub, I, N] × destinations [I, N], DRIVE, TRAFFIC_AWARE, departureTime = departAt when it is in the future. The four
// needed legs are HI (0,0), HN (0,1), IN (1,1) and NI (2,0); the two self pairs are ignored. A needed element is accepted
// ONLY on the traffic contract: no error status (code 0 / absent), condition ROUTE_EXISTS, NO fallbackInfo (a fallback is not
// traffic-aware), a positive "Ns" duration. Anything else → traffic_unverified (D3 → single).
//
// The deadline aborts the fetch AND the body read (both run under one AbortController), and the whole call is also raced
// (bounded), so a transport that ignores the signal cannot hold the writer either.
// 🔴 The key travels in a header only. Nothing here logs or returns an error MESSAGE or a response BODY — either could echo it.
const { bounded, isDeadline } = require('./bounded');

const ROUTES_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const FIELD_MASK = 'originIndex,destinationIndex,status,condition,duration,fallbackInfo';
const NEEDED = { HI: [0, 0], HN: [0, 1], IN: [1, 1], NI: [2, 0] };
const DURATION_RE = /^(\d+(?:\.\d+)?)s$/;

const wp = (p) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
const idx = (v) => (v === undefined ? 0 : v);   // proto3 JSON omits a 0 index
const fail = (reason, why) => { console.warn(`stackseq routes: ${reason} (${why})`); return { ok: false, reason }; };

function legsOf(elements) {
  if (!Array.isArray(elements)) return null;
  const legs = {};
  for (const [leg, [o, d]] of Object.entries(NEEDED)) {
    const hits = elements.filter((e) => e && typeof e === 'object' && idx(e.originIndex) === o && idx(e.destinationIndex) === d);
    if (hits.length !== 1) return null;
    const e = hits[0];
    if (e.status !== undefined && !(e.status && typeof e.status === 'object' && idx(e.status.code) === 0)) return null;
    if (e.condition !== 'ROUTE_EXISTS' || e.fallbackInfo !== undefined) return null;
    const m = typeof e.duration === 'string' ? DURATION_RE.exec(e.duration) : null;
    const s = m ? Number(m[1]) : NaN;
    if (!(Number.isFinite(s) && s > 0)) return null;
    legs[leg] = s;
  }
  return legs;
}

async function computeMatrix({ fetchImpl = globalThis.fetch, key, hub, I, N, departAt, nowMs = Date.now(), deadlineMs = 3000 }) {
  if (typeof key !== 'string' || key === '') return { ok: false, reason: 'no_key' };
  const body = { origins: [wp(hub), wp(I), wp(N)], destinations: [wp(I), wp(N)], travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE' };
  if (Number.isFinite(departAt) && departAt > nowMs) body.departureTime = new Date(departAt).toISOString();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deadlineMs);
  try {
    const { status, okHttp, text } = await bounded((async () => {
      const res = await fetchImpl(ROUTES_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK }, body: JSON.stringify(body), signal: ac.signal });
      return { status: res.status, okHttp: !!res.ok, text: await res.text() };   // the body read is inside the same timer
    })(), deadlineMs);
    if (!okHttp) return fail('traffic_unverified', `http ${Number(status) || 'unknown'}`);
    let parsed; try { parsed = JSON.parse(text); } catch (_) { return fail('traffic_unverified', 'malformed json'); }
    const legs = legsOf(parsed);
    return legs ? { ok: true, legs } : fail('traffic_unverified', 'element contract');
  } catch (e) {
    if (isDeadline(e) || ac.signal.aborted) return fail('deadline', 'aborted');
    return fail('traffic_unverified', 'transport error');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { computeMatrix, ROUTES_URL, FIELD_MASK };
