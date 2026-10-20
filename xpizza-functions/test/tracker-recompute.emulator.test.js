'use strict';
// TRACKER FIXES T3 — recomputeOrderTracker + driverFanout + the flag, on the RTDB emulator (Admin SDK, as in production).
//  (1) stacked A,B for O, pointer A → A live, B waiting; legacy encoding; claims granted
//  (2) per-order seq: a recompute HELD before its node transaction, overtaken by a newer one → the held one aborts
//  (3) terminal + deleted tasks → terminal, never regressed by a later lower-seq writer
//  (4) reassign A away (both legs) → A neutral for the new owner (awaiting), O's claim TOMBSTONED, owner hint cleared
//  (5) fan-out discovers an order reassigned away via the claims hint (not the task query) and prunes the hint
//  (6) codex r4: a held s=1 grant released after the s=2 terminal tombstone → no live claim
//  (7) the flag: default OFF, ON after set (cached), a timed-out refresh → OFF
//  (8) E1: live recompute writes mx.pins from the order; a fenced ingest keeps them; leaving live clears them
// Run: npm run test:tracker-recompute
require('./_emulator-required')('database');
const assert = require('assert');
const admin = require('firebase-admin');
const { recomputeOrderTracker } = require('../tracking/recompute');
const { driverFanout, driverOrderIds } = require('../tracking/fanout');
const flag = require('../tracking/flag');
const { makeIngestUpdater } = require('../tracking/ingest-txn');
const { tagOf } = require('../tracking/tag');

const app = admin.initializeApp({ projectId: 'demo-tracker-recompute', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-tracker-recompute` }, 'tr');
const db = app.database();
const SECRET = 'test-secret';
const O = 'u_owner_tr', P2 = 'u_other_tr';
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const v = async (p) => (await db.ref(p).once('value')).val();
const deps = (extra = {}) => ({ secret: SECRET, resolveName: async (_db, uid) => (uid === O ? 'Uno' : 'Dos'), ...extra });

async function seedStack() {
  await db.ref('/').set(null);
  const t = (oid, type, status, owner, created) => ({ order_id: oid, type, status, assigned_driver_id: owner, created_at: created, restaurant_id: 'tb_centro' });
  await db.ref().update({
    [`drivers/${O}`]: { name: 'uno', active: true, current_shift_id: 'sh1', current_task_id: 'A_delivery' },
    [`drivers/${P2}`]: { name: 'dos', active: true, current_shift_id: 'sh9', current_task_id: null },
    'orders/A': { status: 'out_for_delivery', tracking_token: 'TA', picked_up_at: 11, restaurant_id: 'tb_centro' },
    'orders/B': { status: 'out_for_delivery', tracking_token: 'TB', picked_up_at: 12, restaurant_id: 'tb_centro' },
    'order_tracking/TA': { order_id: 'A', status: 'ready' }, 'order_tracking/TB': { order_id: 'B', status: 'ready' },
    'tasks/A_pickup': t('A', 'pickup', 'completed', O, 1), 'tasks/A_delivery': t('A', 'delivery', 'in_progress', O, 1),
    'tasks/B_pickup': t('B', 'pickup', 'completed', O, 2), 'tasks/B_delivery': t('B', 'delivery', 'accepted', O, 2),
  });
}

(async () => {
  const watchdog = setTimeout(() => { console.error('tracker-recompute: FAIL — timed out'); process.exit(1); }, 180000);
  // (1)
  await seedStack();
  const ra = await recomputeOrderTracker(db, 'A', deps());
  const rb = await recomputeOrderTracker(db, 'B', deps());
  const A1 = await v('order_tracking/TA'), B1 = await v('order_tracking/TB');
  assert.strictEqual(A1.mx.mode, 'live'); assert.strictEqual(B1.mx.mode, 'waiting');
  assert.strictEqual(A1.status, 'out_for_delivery'); assert.strictEqual(A1.picked_up_at, 11, 'status/timestamps from the current order');
  assert.strictEqual(A1.is_active_drop === undefined || A1.is_active_drop === null, true, 'live without location → legacy null');
  assert.strictEqual(B1.is_active_drop, false); assert.strictEqual(B1.driver_name, 'Uno');
  assert.deepStrictEqual(await v(`tracker_claims/${O}/A`), { seq: ra.s, gone: false, at: (await v(`tracker_claims/${O}/A`)).at });
  assert.strictEqual((await v('tracker_claims_owner/B')).uid, O);
  ok('stacked A,B for O, pointer A: A live (legacy null, no location yet), B waiting (false + name); status from the order; claims granted');

  // (2) a held recompute overtaken by a newer one aborts
  const g = gate();
  const held = recomputeOrderTracker(db, 'A', deps({ hold: async (name) => { if (name === 'node-tx') await g.p; } }));
  await new Promise((r) => setTimeout(r, 200));
  await db.ref('drivers/' + O + '/active').set(false);   // truth changes → the newer recompute derives neutral
  const newer = await recomputeOrderTracker(db, 'A', deps());
  g.open();
  const heldRes = await held;
  assert.ok(heldRes.s < newer.s, 'the held recompute took the lower seq');
  assert.strictEqual(heldRes.committed, false, 'the held (lower-seq) recompute aborts at commit');
  assert.strictEqual((await v('order_tracking/TA/mx')).mode, 'neutral', 'the newer truth stands');
  ok(`per-order seq: a recompute held before its node transaction (s=${heldRes.s}) is overtaken (s=${newer.s}) and ABORTS — no stale revival`);
  await db.ref('drivers/' + O + '/active').set(true);

  // (2b) seq BEFORE truth, on a NON-terminal transition (a terminal one would be masked by the terminal guard):
  // the order is 'ready'; a recompute is held right after reading it; the pickup lands (→ out_for_delivery); a newer recompute
  // commits live. The held one read the OLD status — with seq taken first it has the LOWER seq and must abort.
  await db.ref('orders/A/status').set('ready');
  await recomputeOrderTracker(db, 'A', deps());
  const g2 = gate();
  const heldRead = recomputeOrderTracker(db, 'A', deps({ hold: async (name) => { if (name === 'read:order') await g2.p; } }));
  await new Promise((r) => setTimeout(r, 200));
  await db.ref('orders/A/status').set('out_for_delivery');
  const after = await recomputeOrderTracker(db, 'A', deps());
  g2.open();
  const hr = await heldRead;
  assert.strictEqual(after.mode, 'live');
  assert.strictEqual((await v('order_tracking/TA/mx')).mode, 'live', `the recompute that read the pre-pickup order never overwrites the newer live state (held: ${JSON.stringify(hr)})`);
  assert.strictEqual(await v('order_tracking/TA/status'), 'out_for_delivery');
  ok('seq before truth: a recompute held right after reading the pre-pickup order cannot overwrite the post-pickup live state');

  // (3) terminal + deleted tasks
  await db.ref().update({ 'orders/A/status': 'delivered', 'orders/A/delivered_at': 99, 'tasks/A_pickup': null, 'tasks/A_delivery': null });
  const rt = await recomputeOrderTracker(db, 'A', deps());
  const A3 = await v('order_tracking/TA');
  assert.strictEqual(A3.mx.mode, 'terminal'); assert.strictEqual(A3.status, 'delivered'); assert.strictEqual(A3.delivered_at, 99);
  assert.strictEqual(A3.driver_location === undefined || A3.driver_location === null, true);
  assert.strictEqual((await v(`tracker_claims/${O}/A`)).gone, true, 'O\'s claim on A tombstoned at terminal');
  assert.strictEqual(rt.mode, 'terminal');
  ok('delivered with tasks already deleted → terminal (status + delivered_at from the order), O\'s claim tombstoned');

  // (4) reassign B away (both legs) to P2, who has it awaiting acceptance
  await db.ref().update({ 'tasks/B_pickup/assigned_driver_id': P2, 'tasks/B_delivery/assigned_driver_id': P2, 'tasks/B_delivery/status': 'assigned', 'tasks/B_pickup/status': 'completed' });
  await recomputeOrderTracker(db, 'B', deps());
  const B4 = await v('order_tracking/TB');
  assert.strictEqual(B4.mx.mode, 'neutral', 'the new owner has it awaiting → neutral');
  assert.strictEqual(B4.mx.name, 'Dos', 'the name follows the new owner');
  assert.strictEqual(B4.driver_name ?? null, null, 'neutral → legacy name null/absent (no gen-1 countdown)');
  assert.strictEqual((await v(`tracker_claims/${O}/B`)).gone, true, 'O\'s claim on B tombstoned');
  assert.strictEqual((await v('tracker_claims_owner/B')).uid ?? null, null, 'owner hint cleared (uid null/absent)');
  ok('reassign B away: neutral for the new owner (awaiting), name follows the owner, O\'s claim tombstoned, owner hint cleared');

  // (5) fan-out discovers an order via the claims hint only
  await seedStack();
  await recomputeOrderTracker(db, 'A', deps());
  await db.ref().update({ 'tasks/A_pickup/assigned_driver_id': P2, 'tasks/A_delivery/assigned_driver_id': P2 });   // moved; no recompute yet
  const ids = await driverOrderIds(db, O);
  assert.ok(ids.includes('A') && ids.includes('B'), `fan-out finds A via the hint (tasks no longer list it) and B via tasks (${ids})`);
  await driverFanout(db, O, deps());
  assert.strictEqual((await v(`tracker_claims/${O}/A`)).gone, true, 'the stale hint is pruned');
  assert.ok(!(await driverOrderIds(db, O)).includes('A'), 'and no longer discovered');
  ok('fan-out discovers an order reassigned away via the claims hint, recomputes it, prunes the hint');

  // (6) codex r4: held s=1 grant vs s=2 terminal tombstone
  await seedStack();
  const g6 = gate();
  const first = recomputeOrderTracker(db, 'A', deps({ hold: async (name) => { if (name === 'claims') await g6.p; } }));
  await new Promise((r) => setTimeout(r, 300));
  await db.ref('orders/A/status').set('delivered');
  const term = await recomputeOrderTracker(db, 'A', deps());
  g6.open();
  const f = await first;
  assert.ok(f.s < term.s);
  const claim = await v(`tracker_claims/${O}/A`);
  assert.ok(claim && claim.gone === true && claim.seq >= term.s, `no live claim after all delayed writers complete (${JSON.stringify(claim)})`);
  ok(`codex r4: a live grant (s=${f.s}) held before its claims write, then the terminal recompute (s=${term.s}) → after release: tombstone stands, no live claim`);

  // (B, PLAN r2.10.1 §8.3) the fan-out ignores TERMINAL task rows unless a LIVE claims hint exists
  await db.ref('/').set(null);
  const row = (oid, type, status) => ({ order_id: oid, type, status, assigned_driver_id: O, created_at: 1 });
  await db.ref().update({
    'tasks/TD_pickup': row('TD', 'pickup', 'completed'), 'tasks/TD_delivery': row('TD', 'delivery', 'completed'),     // terminal, no hint → out
    'tasks/TC_pickup': row('TC', 'pickup', 'cancelled'), 'tasks/TC_delivery': row('TC', 'delivery', 'cancelled'),     // terminal, gone hint → out
    [`tracker_claims/${O}/TC`]: { seq: 4, gone: true, at: 1 },
    'tasks/TH_pickup': row('TH', 'pickup', 'completed'), 'tasks/TH_delivery': row('TH', 'delivery', 'completed'),     // terminal + LIVE hint → in
    [`tracker_claims/${O}/TH`]: { seq: 5, gone: false, at: 1 },
    'tasks/LM_pickup': row('LM', 'pickup', 'completed'), 'tasks/LM_delivery': row('LM', 'delivery', 'in_progress'),   // mixed → in
    'tasks/LP_pickup': row('LP', 'pickup', 'accepted'),                                                                 // one live row → in
  });
  assert.deepStrictEqual(await driverOrderIds(db, O), ['LM', 'LP', 'TH'], 'terminal-only orders are dropped unless a LIVE hint names them');
  ok('(B) driverOrderIds: terminal-only orders (no hint / a gone hint) are dropped; a terminal order WITH a live hint, a mixed order and an order with one live row are kept');

  // (7) flag
  flag._resetForTest();
  assert.strictEqual(await flag.trackerFixesEnabled(db), false, 'default OFF (missing)');
  await db.ref(flag.FLAG_PATH).set(true); flag._resetForTest();
  assert.strictEqual(await flag.trackerFixesEnabled(db), true);
  await db.ref(flag.FLAG_PATH).set(false);
  assert.strictEqual(await flag.trackerFixesEnabled(db), true, 'cached within the TTL');
  flag._resetForTest();
  const hang = { ref: () => ({ once: () => new Promise(() => {}) }) };
  assert.strictEqual(await flag.trackerFixesEnabled(hang), false, 'a refresh that does not answer within 500 ms → OFF');
  flag._resetForTest();
  const boom = { ref: () => ({ once: () => Promise.reject(new Error('down')) }) };
  assert.strictEqual(await flag.trackerFixesEnabled(boom), false, 'a failed refresh → OFF');
  ok('flag: missing → OFF; true → ON (cached for the TTL); timed-out or failed refresh → OFF');

  // (8) E1
  await seedStack();
  await db.ref('orders/A').update({ hub_lat: 15.5, hub_lng: -88.02, lat: 15.52, lng: -88.01 });
  await recomputeOrderTracker(db, 'A', deps());
  const P8 = { hub: { lat: 15.5, lng: -88.02 }, dest: { lat: 15.52, lng: -88.01 } };
  const mx8 = await v('order_tracking/TA/mx');
  assert.strictEqual(mx8.mode, 'live'); assert.deepStrictEqual(mx8.pins, P8, 'E1: live → pins');
  assert.strictEqual(await v('order_tracking/TA/driver_location'), null, 'E1: pins arrive BEFORE any location');
  const ing = await db.ref('order_tracking/TA').transaction(makeIngestUpdater({ uidTag: tagOf(SECRET, O), shiftId: 'sh1', epoch: mx8.epoch, sample: { lat: 15.51, lng: -88.015, measured_at: Date.now() }, dest: { lat: 15.52, lng: -88.01 } }));
  assert.strictEqual(ing.committed, true, 'the fenced ingest commits');
  assert.deepStrictEqual(await v('order_tracking/TA/mx/pins'), P8, 'E1: an ingest keeps the pins');
  await db.ref('orders/A/status').set('delivered');
  await recomputeOrderTracker(db, 'A', deps());
  assert.strictEqual(await v('order_tracking/TA/mx/pins'), null, 'E1: leaving live (terminal) clears the pins');
  ok('E1: a live recompute writes mx.pins (before any location); a fenced ingest keeps them; leaving live clears them');

  clearTimeout(watchdog);
  await app.delete();
  console.log(`tracker-recompute: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('tracker-recompute: FAIL\n', e); process.exit(1); });
