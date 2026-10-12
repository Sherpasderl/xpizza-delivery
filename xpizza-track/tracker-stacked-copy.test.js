'use strict';
// RUNTIME-REAL tracker test for the out_for_delivery driver-card rendering (the is_active_drop 3-way).
// Instead of regex-matching the HTML (blind to runtime), we SLICE the real driver-card rendering sub-block
// out of xpizza-track/index.html and EXECUTE it against a fake DOM for each of the three data shapes, then
// assert the rendered `driver-eta` copy and which side effects (map / countdown) fired.
//
// What this guards:
//   • the EXPLICIT stacked-waiting branch (is_active_drop === false) renders the OWNER'S EXACT copy, and
//     fires NEITHER the live map NOR the naive countdown (no customer watches the driver visit someone else,
//     no ETA ticking toward ~1 min while the driver is at another door);
//   • ⛔ NO-REGRESSION: the ACTIVE drop and the NEUTRAL (absent is_active_drop) branches — the single /
//     non-stacked experience — render their today's copy and fire their today's effects, unchanged.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// Slice the real sub-block: from `const driverName = data.driver_name;` through the close of the
// if/else-if/else chain (its last line is the neutral branch's `'En ruta a tu dirección';`).
const START = 'const driverName = data.driver_name;';
const END_ANCHOR = ": 'En ruta a tu dirección';";
const startIdx = html.indexOf(START);
assert.ok(startIdx !== -1, 'slice START marker present (driver-card rendering found)');
const endAnchorIdx = html.indexOf(END_ANCHOR, startIdx);
assert.ok(endAnchorIdx !== -1, 'slice END anchor present (neutral branch found)');
// include up to and including the `}` that closes the else-chain, just after the anchor
const closeIdx = html.indexOf('}', endAnchorIdx);
assert.ok(closeIdx !== -1, 'else-chain close brace found');
const slice = html.slice(startIdx, closeIdx + 1);

// Owner's exact copy for the stacked-waiting branch — any drift from this verbatim string fails the test.
const OWNER_WAITING_COPY = 'Tu repartidor tiene una parada rápida en camino a la tuya, luego va directo hacia vos.';
// The superseded copy must be gone (prove the swap actually happened, not just that the new string exists).
assert.ok(!html.includes('está terminando una entrega que queda en camino'),
  'superseded stacked-waiting copy removed from the tracker');

// Build + run the sliced block against a fake DOM for one data shape; return the rendered text + effects.
function render(data) {
  const texts = {};
  const document = {
    getElementById(id) {
      return { set textContent(v) { texts[id] = v; }, get textContent() { return texts[id]; } };
    },
  };
  const calls = { refreshDriverEta: 0, updateDriverMap: 0, computeEta: 0 };
  let etaIsActive = false;
  const refreshDriverEta = () => { calls.refreshDriverEta++; };
  const updateDriverMap = () => { calls.updateDriverMap++; };
  const computeEta = (d) => { calls.computeEta++; return d.__eta; };
  // eslint-disable-next-line no-new-func
  const fn = new Function('data', 'document', 'refreshDriverEta', 'updateDriverMap', 'computeEta',
    `let etaIsActive = false; ${slice}; return etaIsActive;`);
  etaIsActive = fn(data, document, refreshDriverEta, updateDriverMap, computeEta);
  return { name: texts['driver-name'], eta: texts['driver-eta'], etaIsActive, calls };
}

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── ACTIVE drop (single/active): is_active_drop true + a real location → live map + armed ETA, today's copy.
const active = render({
  driver_name: 'Marco', is_active_drop: true,
  driver_location: { lat: 15.5, lng: -88.0 },
});
assert.equal(active.name, 'Marco está en camino'); ok('ACTIVE: name "… está en camino" (unchanged)');
assert.equal(active.etaIsActive, true); ok('ACTIVE: etaIsActive armed (unchanged)');
assert.equal(active.calls.updateDriverMap, 1); ok('ACTIVE: live map drawn (unchanged)');
assert.equal(active.calls.refreshDriverEta, 1); ok('ACTIVE: tightening ETA refreshed (unchanged)');

// ── EXPLICIT stacked-waiting: is_active_drop === false → owner copy, NO map, NO countdown.
const waiting = render({ driver_name: 'Marco', is_active_drop: false });
assert.equal(waiting.eta, OWNER_WAITING_COPY); ok('WAITING: owner’s exact "parada rápida" copy');
assert.equal(waiting.name, 'Marco'); ok('WAITING: bare driver name (no "está en camino")');
assert.equal(waiting.calls.updateDriverMap, 0); ok('WAITING: NO live map (driver is at someone else’s door)');
assert.equal(waiting.calls.refreshDriverEta, 0); ok('WAITING: NO ETA refresh');
assert.equal(waiting.calls.computeEta, 0); ok('WAITING: NO naive countdown computed');
assert.equal(waiting.etaIsActive, false); ok('WAITING: ETA writes stay disarmed');

// ── NEUTRAL (absent is_active_drop): the single-order seconds before the first GPS mirror → today's copy.
const neutralEta = render({ driver_name: 'Marco', __eta: 7 });
assert.equal(neutralEta.name, 'Marco está en camino'); ok('NEUTRAL: name "… está en camino" (unchanged)');
assert.equal(neutralEta.eta, 'Llega en ~7 min'); ok('NEUTRAL: "Llega en ~N min" countdown (unchanged)');
assert.equal(neutralEta.calls.updateDriverMap, 0); ok('NEUTRAL: no map yet (unchanged)');
const neutralNoEta = render({ driver_name: 'Marco', __eta: null });
assert.equal(neutralNoEta.eta, 'En ruta a tu dirección'); ok('NEUTRAL (no eta): "En ruta a tu dirección" (unchanged)');

// The waiting branch must NOT share the neutral/active "está en camino" phrasing.
assert.ok(!/está en camino/.test(waiting.name + ' ' + (waiting.eta || '')),
  'WAITING branch never uses the "está en camino" phrasing'); ok('WAITING: distinct from the en-camino branches');

console.log(`tracker-stacked-copy: OK (${n} cases)`);
