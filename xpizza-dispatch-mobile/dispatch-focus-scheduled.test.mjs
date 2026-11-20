import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// CTA audit #3 — «Ver en mapa» must resolve SCHEDULED orders too.
// A scheduled (Programado) order lives in STORE.scheduled, NOT STORE.orders, and has no delivery task.
// Before the fix __focusOrderOnMap read only `STORE.orders[orderId]`, so tapping «Ver en mapa» on a
// scheduled order found nothing: order was undefined → dest null → no pan, no pin (silent dead-end).
// This extracts the REAL __focusOrderOnMap arrow from index.html and drives it over a google.maps shim;
// the ONLY thing that makes a scheduled order pan is reading STORE.scheduled as the fallback.

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');

// Brace-match the real `window.__focusOrderOnMap = async (orderId) => { ... }` out of the source.
function arrowAssignment(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('marker not found: ' + marker);
  let d = 0, started = false;
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(at, j + 1); }
  }
  throw new Error('unbalanced braces for ' + marker);
}
const focusSrc = arrowAssignment(html, 'window.__focusOrderOnMap = async (orderId) =>');
assert.ok(focusSrc.includes('clearFocus()') && focusSrc.includes('focusLayer') && focusSrc.includes("order?.order_type === 'pickup'"),
  'extracted the real __focusOrderOnMap');

function build(store) {
  const pans = [], markers = [], zooms = [];
  const google = { maps: {
    Marker: class { constructor(o) { markers.push(o); } setMap() {} },
    DirectionsService: class { route() {} },
    DirectionsRenderer: class { setMap() {} setDirections() {} },
    TravelMode: { DRIVING: 'DRIVING' },
  } };
  const map = { panTo: (p) => pans.push(p), setZoom: (z) => zooms.push(z) };
  const win = { __onMapaShown: async () => {} };
  const focusLayer = { markers: [], line: null, route: null };
  const $ = () => ({ classList: { add() {}, remove() {} } });
  const HUBS = { x_pizza: { lat: 1, lng: 1 }, la_musa: { lat: 2, lng: 2 } };
  const XPD = { isStalePing: () => false };
  const make = new Function('window', 'mapReady', 'clearFocus', 'STORE', '$', 'HUBS', 'google', 'dirService', 'focusLayer', 'XPD', 'map',
    focusSrc + '\n; return window.__focusOrderOnMap;');
  const focus = make(win, true, () => {}, store, $, HUBS, google, null, focusLayer, XPD, map);
  return { focus, pans, markers, zooms };
}

test('#3 «Ver en mapa» pans to a SCHEDULED order destination (STORE.scheduled fallback)', async () => {
  const store = { orders: {}, scheduled: { s1: { order_type: 'delivery', lat: 14.08, lng: -87.20 } }, tasks: {}, drivers: {} };
  const { focus, pans } = build(store);
  await focus('s1');
  assert.equal(pans.length, 1, 'the map panned to the scheduled order destination');
  assert.deepEqual(pans[0], { lat: 14.08, lng: -87.20 });
});

test('#3 regression: a live order in STORE.orders still focuses', async () => {
  const store = { orders: { o1: { order_type: 'delivery', lat: 15.5, lng: -88.0 } }, scheduled: {}, tasks: {}, drivers: {} };
  const { focus, pans } = build(store);
  await focus('o1');
  assert.equal(pans.length, 1, 'live order still pans');
  assert.deepEqual(pans[0], { lat: 15.5, lng: -88.0 });
});

test('#3 regression: a scheduled PICKUP focuses its restaurant hub', async () => {
  const store = { orders: {}, scheduled: { s2: { order_type: 'pickup', restaurant_id: 'la_musa' } }, tasks: {}, drivers: {} };
  const { focus, pans } = build(store);
  await focus('s2');
  assert.equal(pans.length, 1, 'scheduled pickup pans to the hub');
  assert.deepEqual(pans[0], { lat: 2, lng: 2 });
});
