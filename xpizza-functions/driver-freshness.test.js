'use strict';
// Unit tests for the driver-freshness reconcile core (Driver Tracking C1). Run: node driver-freshness.test.js
// Proves: on-shift + silent-past-threshold → raise; off-shift never alerts; fresh/never-pinged → no alert;
// dedupe (one per episode); auto-clear on recovery/clock-off/disappear; other alert types untouched;
// config threshold respected; boundary is strict '>'.
const assert = require('assert');
const { computeFreshnessAlerts, isOnShift, ALERT_PREFIX, ALERT_TYPE } = require('./driver-freshness');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const NOW = 1_000_000_000_000;               // fixed server-now
const THRESH = 180 * 1000;                   // 180s default
const key = (uid) => `${ALERT_PREFIX}${uid}`;
// on-shift driver silent for `sec` seconds
const drv = (sec, extra = {}) => ({ status: 'available', last_ping: NOW - sec * 1000, ...extra });
const run = (drivers, existingAlerts = {}, thresholdMs = THRESH) =>
  computeFreshnessAlerts({ drivers, existingAlerts, now: NOW, thresholdMs, createdAt: 'STAMP' });

// ── 1. on-shift, silent > threshold, no existing → RAISE (exact shape) ──
{
  const u = run({ d1: drv(200, { name: 'hermez' }) });
  assert.deepStrictEqual(u, {
    [key('d1')]: { type: ALERT_TYPE, driver_id: 'd1', driver_name: 'hermez', last_ping: NOW - 200000, silent_sec: 200, created_at: 'STAMP' },
  });
  ok('on-shift silent 200s (>180) → raise with {type,driver_id,driver_name,last_ping,silent_sec,created_at}');
}

// ── 2. off-shift silent → NO alert ──
{
  const u = run({ d1: { status: 'off_shift', last_ping: NOW - 9999 * 1000 } });
  assert.deepStrictEqual(u, {});
  ok('off-shift driver silent → no alert (off-shift never alerts)');
}

// ── 3. on-shift but FRESH (< threshold) → no alert ──
{
  assert.deepStrictEqual(run({ d1: drv(60) }), {});
  ok('on-shift fresh 60s → no alert');
}

// ── 4. on-shift but never pinged (missing / 0 / non-number last_ping) → no alert ──
{
  assert.deepStrictEqual(run({ d1: { status: 'available' } }), {}, 'missing last_ping');
  assert.deepStrictEqual(run({ d1: { status: 'available', last_ping: 0 } }), {}, 'zero last_ping');
  assert.deepStrictEqual(run({ d1: { status: 'available', last_ping: null } }), {}, 'null last_ping');
  ok('on-shift never-pinged (missing/0/null last_ping) → no alert (can\'t measure silence)');
}

// ── 5. dedupe — already alerted + still stale → NO re-raise (empty updates) ──
{
  const u = run({ d1: drv(300) }, { [key('d1')]: { type: ALERT_TYPE, driver_id: 'd1' } });
  assert.deepStrictEqual(u, {});
  ok('already-alerted + still stale → no re-raise (exactly one alert per episode)');
}

// ── 6. auto-clear on RECOVERY — existing alert + driver now fresh → remove ──
{
  const u = run({ d1: drv(30) }, { [key('d1')]: { type: ALERT_TYPE } });
  assert.deepStrictEqual(u, { [key('d1')]: null });
  ok('recovered (pings resumed) → alert cleared (null)');
}

// ── 7. auto-clear on CLOCK-OFF — existing alert + driver now off_shift → remove ──
{
  const u = run({ d1: { status: 'off_shift', last_ping: NOW - 300 * 1000 } }, { [key('d1')]: { type: ALERT_TYPE } });
  assert.deepStrictEqual(u, { [key('d1')]: null });
  ok('clocked off while alerted → alert cleared');
}

// ── 8. auto-clear on DISAPPEAR — existing alert + driver gone from /drivers → remove ──
{
  const u = run({}, { [key('gone')]: { type: ALERT_TYPE } });
  assert.deepStrictEqual(u, { [key('gone')]: null });
  ok('driver removed from /drivers while alerted → alert cleared');
}

// ── 9. threshold boundary is strict '>' ──
{
  assert.deepStrictEqual(run({ d1: drv(180) }), {}, 'exactly at threshold → not stale');
  assert.deepStrictEqual(Object.keys(run({ d1: { status: 'available', last_ping: NOW - THRESH - 1 } })), [key('d1')], 'just over → stale');
  ok('boundary: silence == threshold → no alert; threshold+1ms → alert (strict >)');
}

// ── 10. other alert types in the node are NEVER touched ──
{
  const existing = { some_push_id: { type: 'no_drivers_available' }, factura_PZX1: { kind: 'factura_failed' } };
  assert.deepStrictEqual(run({ d1: drv(30) }, existing), {}, 'no driver_stale_ keys involved');
  // and a stale driver alongside an unrelated alert → only the driver key is added
  const u = run({ d1: drv(300) }, existing);
  assert.deepStrictEqual(Object.keys(u), [key('d1')]);
  ok('unrelated alerts (no_drivers_available / factura_*) untouched — only driver_stale_ keys are reconciled');
}

// ── 11. config threshold is respected (tunable) ──
{
  assert.deepStrictEqual(run({ d1: drv(200) }, {}, 300 * 1000), {}, '200s silence under a 300s threshold → no alert');
  assert.deepStrictEqual(Object.keys(run({ d1: drv(120) }, {}, 90 * 1000)), [key('d1')], '120s under a 90s threshold → alert');
  ok('config threshold respected — same silence alerts or not depending on thresholdMs');
}

// ── 12. empty / null drivers → no crash, no updates ──
{
  assert.deepStrictEqual(run(null), {});
  assert.deepStrictEqual(run({}), {});
  assert.deepStrictEqual(computeFreshnessAlerts({ drivers: null, existingAlerts: null, now: NOW, thresholdMs: THRESH, createdAt: 'S' }), {});
  ok('null/empty drivers + null existingAlerts → {} (no crash)');
}

// ── 13. driver_name fallback: display_name > name > uid ──
{
  assert.strictEqual(run({ d1: drv(200, { display_name: 'Hermez', name: 'hermeztalavera' }) })[key('d1')].driver_name, 'Hermez');
  assert.strictEqual(run({ d1: drv(200, { name: 'hermeztalavera' }) })[key('d1')].driver_name, 'hermeztalavera');
  assert.strictEqual(run({ d1: drv(200) })[key('d1')].driver_name, 'd1');
  ok('driver_name fallback: display_name → name → uid');
}

// ── 14. mixed fleet in ONE pass: raise + clear + hold + ignore-off-shift, all at once ──
{
  const drivers = {
    raiseMe: drv(400, { name: 'A' }),                                  // newly stale → raise
    holdMe: drv(400, { name: 'B' }),                                   // stale + already alerted → hold (no update)
    recovered: drv(10, { name: 'C' }),                                 // was alerted, now fresh → clear
    offNow: { status: 'off_shift', last_ping: NOW - 999 * 1000 },      // was alerted, now off → clear
    freshUnknown: drv(20, { name: 'D' }),                              // fresh, no alert → nothing
    onBreakStale: { status: 'on_break', last_ping: NOW - 400 * 1000, name: 'E' }, // on_break is on-shift → raise
  };
  const existing = { [key('holdMe')]: { type: ALERT_TYPE }, [key('recovered')]: { type: ALERT_TYPE }, [key('offNow')]: { type: ALERT_TYPE } };
  const u = run(drivers, existing);
  assert.strictEqual(u[key('raiseMe')].driver_name, 'A', 'raiseMe raised');
  assert.strictEqual(u[key('onBreakStale')].driver_name, 'E', 'on_break (on-shift) raised');
  assert.strictEqual(u[key('recovered')], null, 'recovered cleared');
  assert.strictEqual(u[key('offNow')], null, 'clocked-off cleared');
  assert.ok(!(key('holdMe') in u), 'held (no re-raise)');
  assert.ok(!(key('freshUnknown') in u), 'fresh untouched');
  assert.strictEqual(Object.keys(u).length, 4, 'exactly 4 updates: 2 raise + 2 clear');
  ok('mixed fleet one pass: raise(2, incl on_break) + clear(2) + hold + ignore-fresh — 4 updates');
}

// isOnShift direct
assert.strictEqual(isOnShift({ status: 'available' }), true);
assert.strictEqual(isOnShift({ status: 'off_shift' }), false);
assert.strictEqual(isOnShift({}), false);
assert.strictEqual(isOnShift(null), false);
ok('isOnShift: available→true, off_shift→false, no-status→false, null→false');

console.log(`\ndriver-freshness: OK (${n} cases)`);
