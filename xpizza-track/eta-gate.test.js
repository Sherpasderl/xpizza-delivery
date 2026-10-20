'use strict';
// F4 — eta-gate.js (BUILD-tracker-F4 §4, T2): when the tracker may show minutes. Run: node xpizza-track/eta-gate.test.js
const assert = require('assert');
const { etaGate, etaMinutesText } = require('./eta-gate.js');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// the tracker's own distance (driver-eta.js), evaluated from source (ESM → plain)
const fs = require('fs'); const path = require('path');
const etaSrc = fs.readFileSync(path.join(__dirname, 'driver-eta.js'), 'utf8').replace(/^export\s+/gm, '');
const distanceMeters = new Function(`${etaSrc}; return distanceMeters;`)();

// O2 — the route time rounded UP, no added dwell; ≤ 45 s → "está llegando"
assert.strictEqual(etaMinutesText(60), 'Llega en ~1 min');
assert.strictEqual(etaMinutesText(61), 'Llega en ~2 min');
assert.strictEqual(etaMinutesText(380), 'Llega en ~7 min');
assert.strictEqual(etaMinutesText(45), 'Tu pedido está llegando');
assert.strictEqual(etaMinutesText(46), 'Llega en ~1 min');
ok('minutes = ceil(travel/60) with no +2; 45 s or less → "Tu pedido está llegando"');

const T = 1_800_000_000_000;
const LOC = { lat: 15.5, lng: -88.02 };
const DEST = { lat: 15.51, lng: -88.03 };
const base = (over = {}) => ({
  active: true, loc: { ...LOC, at: T }, dest: DEST, latestReqId: 3, nowLocal: T, serverOffset: 0, dist: distanceMeters,
  result: { reqId: 3, atLocal: T, origin: { ...LOC }, dest: { ...DEST }, travelSec: 380 },
  ...over,
});

assert.deepStrictEqual(etaGate(base()), { show: true, text: 'Llega en ~7 min', remainingMs: 90000 });
ok('all rules hold → minutes, with the time until the first expiry');

// location age — SERVER domain, strict
assert.strictEqual(etaGate(base({ nowLocal: T + 89999, result: { reqId: 3, atLocal: T + 89999, origin: { ...LOC }, dest: { ...DEST }, travelSec: 380 } })).show, true);
assert.strictEqual(etaGate(base({ nowLocal: T + 90000, result: { reqId: 3, atLocal: T + 90000, origin: { ...LOC }, dest: { ...DEST }, travelSec: 380 } })).show, false);
ok('location: 89 999 ms fresh, 90 000 ms stale (strict)');

// result age — LOCAL domain, strict
assert.strictEqual(etaGate(base({ loc: { ...LOC, at: T + 119999 }, nowLocal: T + 119999 })).show, true);
assert.strictEqual(etaGate(base({ loc: { ...LOC, at: T + 120000 }, nowLocal: T + 120000 })).show, false);
ok('route answer: 119 999 ms usable, 120 000 ms not (strict)');

// clock domains: a sample measured "now" by the server, with the page's clock 60 s BEHIND (offset +60 s)
{
  const g = etaGate(base({ loc: { ...LOC, at: T + 60000 }, serverOffset: 60000 }));
  assert.strictEqual(g.show, true); assert.strictEqual(g.remainingMs, 90000, 'expires after 90 s of LOCAL time, not 150');
  const g2 = etaGate(base({ loc: { ...LOC, at: T - 60000 }, serverOffset: -60000 }));
  assert.strictEqual(g2.show, true); assert.strictEqual(g2.remainingMs, 90000, 'negative offset: also 90 s');
  // the result's limit can come first, in its own domain
  const g3 = etaGate(base({ result: { reqId: 3, atLocal: T - 100000, origin: { ...LOC }, dest: { ...DEST }, travelSec: 380 } }));
  assert.strictEqual(g3.remainingMs, 20000, 'the answer expires first (120 − 100 s), measured locally');
}
ok('ages stay in their own clock domain (offset ±60 s); remainingMs is a duration');

assert.strictEqual(etaGate(base({ serverOffset: undefined })).show, false);
ok('no server offset yet → no minutes');

// latest request, same destination, origin within 200 m (strict)
assert.strictEqual(etaGate(base({ latestReqId: 4 })).show, false);
assert.strictEqual(etaGate(base({ dest: { lat: 15.52, lng: -88.03 } })).show, false);
const north = (m) => ({ lat: LOC.lat + m / 111195, lng: LOC.lng });
const at199 = north(199.9), at200 = north(200.05);
assert.ok(distanceMeters(LOC, at199) < 200 && distanceMeters(LOC, at200) >= 200, 'premise: the probe points straddle 200 m');
assert.strictEqual(etaGate(base({ loc: { ...at199, at: T } })).show, true);
assert.strictEqual(etaGate(base({ loc: { ...at200, at: T } })).show, false);
ok('a superseded request, a changed destination, or a sample ≥ 200 m from the answer\'s origin → no minutes');
// the exact 200 m boundary (codex build r1, optional): an injected distance of exactly 200 is NOT usable, 199.999 is
assert.strictEqual(etaGate(base({ dist: () => 200 })).show, false, 'exactly 200 m → no minutes (strict, aligned with the ≥ 200 m request trigger)');
assert.strictEqual(etaGate(base({ dist: () => 199.999 })).show, true, '199.999 m → minutes');
ok('exactly 200 m from the answer\'s origin is not usable; 199.999 m is');

assert.strictEqual(etaGate(base({ active: false })).show, false);
assert.strictEqual(etaGate(base({ loc: { lat: 'x', lng: 1, at: T } })).show, false);
assert.strictEqual(etaGate(base({ result: null })).show, false);
ok('inactive, a malformed location, or no answer → no minutes');

console.log(`\neta-gate: OK (${n})`);
