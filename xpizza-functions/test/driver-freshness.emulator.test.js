'use strict';
/**
 * OWNER-RUN emulator test — driverFreshnessMonitor (Driver Tracking C1).
 *
 *   firebase emulators:exec --only database --project demo-xpizza \
 *     "node test/driver-freshness.emulator.test.js"
 *
 * The reconcile LOGIC is exhaustively unit-tested in driver-freshness.test.js. This proves the WIRING of the
 * onSchedule handler (invoked via its v2 .run()) against the RTDB emulator: config read (default + tunable),
 * drivers + dispatcher_alerts reads, the keyed multi-path write, dedupe + auto-clear ACROSS ticks, and that
 * other alert types are left untouched.
 */
const assert = require('assert');
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'test-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

const app = require('../index.js');
const { getDatabase } = require('firebase-admin/database');
const db = getDatabase();

const tick = () => app.driverFreshnessMonitor.run({});          // the handler ignores the scheduled event
const alert = async (uid) => (await db.ref(`dispatcher_alerts/driver_stale_${uid}`).once('value')).val();
const seedDriver = (uid, silentSec, extra = {}) =>
  db.ref(`drivers/${uid}`).set({ status: 'available', last_ping: Date.now() - silentSec * 1000, name: uid, ...extra });
const reset = () => db.ref('/').set(null);

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  // ── 1. on-shift silent > default 180s → alert raised at driver_stale_<uid> (shape + server created_at) ──
  await reset();
  await seedDriver('d1', 240, { display_name: 'Hermez' });
  await tick();
  {
    const a = await alert('d1');
    assert.ok(a, 'alert raised');
    assert.strictEqual(a.type, 'driver_freshness_stale');
    assert.strictEqual(a.driver_id, 'd1');
    assert.strictEqual(a.driver_name, 'Hermez');
    assert.ok(a.silent_sec >= 240 && a.silent_sec < 265, `silent_sec ~240 (got ${a.silent_sec})`);
    assert.ok(typeof a.created_at === 'number' && a.created_at > 0, 'created_at server-stamped');
    ok('on-shift silent >180s (default) → alert raised at driver_stale_<uid> (shape + server created_at)');
  }

  // ── 2. dedupe across ticks — run again while still stale → same alert, created_at UNCHANGED ──
  {
    const before = await alert('d1');
    await new Promise((r) => setTimeout(r, 25));
    await tick();
    const after = await alert('d1');
    assert.strictEqual(after.created_at, before.created_at, 'created_at unchanged (not re-raised)');
    ok('second tick while still stale → same alert, created_at unchanged (exactly one per episode)');
  }

  // ── 3. recovery — pings resume (last_ping = now) → next tick CLEARS the alert ──
  {
    await db.ref('drivers/d1/last_ping').set(Date.now());
    await tick();
    assert.strictEqual(await alert('d1'), null, 'alert cleared on recovery');
    ok('pings resume → alert auto-cleared');
  }

  // ── 4. off-shift never alerts ──
  await reset();
  await seedDriver('d2', 999, { status: 'off_shift' });
  await tick();
  assert.strictEqual(await alert('d2'), null, 'off-shift → no alert');
  ok('off-shift driver silent → never alerts');

  // ── 5. config threshold is tunable without a redeploy ──
  await reset();
  await db.ref('config/driver_freshness_alert_sec').set(300);
  await seedDriver('d3', 200);
  await tick();
  assert.strictEqual(await alert('d3'), null, '200s silence under a 300s config → no alert');
  await db.ref('config/driver_freshness_alert_sec').set(90);
  await tick();
  assert.ok(await alert('d3'), '200s silence over a 90s config → alert');
  ok('config/driver_freshness_alert_sec tunable — same silence alerts or not by threshold');

  // ── 6. other alert types untouched ──
  await reset();
  await db.ref('config/driver_freshness_alert_sec').set(180);
  const pushRef = await db.ref('dispatcher_alerts').push({ type: 'no_drivers_available', order_id: 'PZX-1', created_at: Date.now() });
  await seedDriver('d4', 240);
  await tick();
  assert.ok(await alert('d4'), 'driver alert raised');
  assert.ok((await db.ref(`dispatcher_alerts/${pushRef.key}`).once('value')).val(), 'no_drivers_available alert untouched');
  ok('unrelated dispatcher_alerts (no_drivers_available) untouched while a driver alert is raised');

  // ── 7. default threshold applies when config node is absent ──
  await reset();
  await seedDriver('d5', 240);
  await tick();
  assert.ok(await alert('d5'), 'default 180s applies when config absent');
  ok('no config node → default 180s threshold applies');

  console.log(`\nAll ${pass} driver-freshness emulator assertions passed.`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
