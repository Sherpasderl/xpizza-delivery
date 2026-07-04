'use strict';

// Emulator F-matrix for the Step-3 shadow predictor core (ready-time-predict-core.js).
// Run: JAVA_HOME=/opt/homebrew/opt/openjdk firebase emulators:exec --only database --project demo-xpizza \
//        "node test/ready-time-predict.emulator.test.js"
// Drives REAL transactions and proves the load-bearing PURE-SHADOW guarantee + every idempotency/fallback/
// quarantine path (PHASE1_STEP3_SHADOW_PREDICTOR.md rev-3 §Build shape).
const assert = require('assert');
const admin = require('firebase-admin');
const F = require('../ready-time-features');
const { ACTIVE_MODEL_VERSIONS, coldStartMin } = require('../ready-time-predict');
const { runPrediction, runLabelAndUpdate } = require('../ready-time-predict-core');

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) { console.error('MUST run under firebase emulators:exec --only database'); process.exit(1); }
admin.initializeApp({ databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza` });
const db = admin.database();
const V1 = ACTIVE_MODEL_VERSIONS[0];

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const val = async (p) => (await db.ref(p).once('value')).val();
const T0 = Date.UTC(2024, 0, 2, 2, 30, 0); // → UTC−6 hour 20 (dinner)
const evRow = (o) => ({ from: null, to: 'new', at: T0, restaurant_id: 'x_pizza', kitchen_load_ahead: 4, drivers_available: 1, drivers_on_shift: 3, ...o });

// A db wrapper recording the path of every MUTATING call (the denylist API-spy).
function spyDb(real, sink) {
  return { ref(p) { const r = real.ref(p); for (const m of ['set', 'update', 'remove', 'transaction', 'push']) { const orig = r[m].bind(r); r[m] = (...a) => { sink.push(p); return orig(...a); }; } return r; } };
}
// Seed a full eligible x_pizza lifecycle (order_events + /orders + order_timelines). readyAt 15 min after new.
async function seedEligible(id, over = {}) {
  const newAt = over.newAt || T0, kla = over.kla ?? 4, restaurant = over.restaurant || 'x_pizza';
  const items = over.items === undefined ? [{ n: 'p1' }, { n: 'p2' }] : over.items;
  await db.ref(`order_events/${id}`).set({ e1: evRow({ at: newAt, restaurant_id: restaurant, kitchen_load_ahead: kla }) });
  await db.ref(`orders/${id}`).set({ order_id: id, restaurant_id: restaurant, customer_phone: '99998888', ...(items ? { items } : {}) });
  await db.ref(`order_timelines/${id}`).set({ new_at: newAt, preparing_at: over.preparingAt ?? (newAt + 2 * 60000), ready_at: over.readyAt ?? (newAt + 15 * 60000), ...(over.ofd ? { out_for_delivery_at: over.ofd } : {}) });
}
const eligCfg = { epoch_start_ms: { x_pizza: 0, la_musa: 0 }, max_plausible_prep_ms: 3 * 3600000, excluded_phones: {}, excluded_orders: {} };

(async () => {
  // ── 1. Prediction: cold-start + immutable/idempotent on event bounce ──
  await db.ref('/').set(null); await db.ref('ready_time_config').set(eligCfg);
  await db.ref('orders/O1').set({ order_id: 'O1', restaurant_id: 'x_pizza', items: [{ n: 'a' }, { n: 'b' }] });
  await runPrediction({ db, now: 1000 }, { orderId: 'O1', event: evRow() });
  let p = await val(`order_predictions/O1/${V1}`);
  assert.strictEqual(p.source, 'cold_start'); assert.strictEqual(p.predicted_prep_min, coldStartMin('x_pizza')); assert.strictEqual(p.new_at, T0); ok('1: prediction cold_start on empty model (prep=18, new_at=event.at)');
  assert.strictEqual(p.predicted_ready_at, T0 + coldStartMin('x_pizza') * 60000); assert.strictEqual(p.features_snapshot.item_bucket, '2-3'); ok('1: predicted_ready_at + features_snapshot correct');
  await runPrediction({ db, now: 5000 }, { orderId: 'O1', event: evRow() });   // bounce
  assert.strictEqual((await val(`order_predictions/O1/${V1}`)).created_at, 1000); ok('1: event bounce → create-if-absent aborts, node immutable (created_at unchanged)');

  // ── 2. Denylist API-spy: ZERO writes outside order_predictions/prediction_logs/ready_time_model ──
  await db.ref('/').set(null); await db.ref('ready_time_config').set(eligCfg);
  // seed the sentinels the shadow must never touch
  for (const [pth, v] of [['orders/O2', { restaurant_id: 'x_pizza', items: [{ n: 'a' }, { n: 'b' }] }], ['order_tracking/TK', { s: 1 }], ['tasks/O2_delivery', { s: 1 }], ['drivers/d1', { s: 1 }], ['dispatcher_alerts/a1', { s: 1 }], ['config/ready_time/x_pizza/prep_threshold_min', 25], ['notifications/nn', { s: 1 }]]) await db.ref(pth).set(v);
  await seedEligible('O2');
  const mutated = [];
  const sdb = spyDb(db, mutated);
  await runPrediction({ db: sdb, now: 2000 }, { orderId: 'O2', event: evRow() });
  await runLabelAndUpdate({ db: sdb, now: 2000 }, { orderId: 'O2', readyAt: T0 + 15 * 60000 });
  const ALLOW = ['order_predictions/', 'prediction_logs/', 'ready_time_model/'];
  const bad = mutated.filter((pth) => !ALLOW.some((a) => pth.startsWith(a)));
  assert.deepStrictEqual(bad, [], `illegal mutating writes: ${JSON.stringify(bad)}`); ok(`2: API-spy — every mutating write under order_predictions/ prediction_logs/ ready_time_model/ (${mutated.length} writes, 0 illegal)`);

  // ── 3. Hierarchical fallback: exact → daypart → restaurant → cold_start ──
  await db.ref('/').set(null); await db.ref('ready_time_config').set(eligCfg);
  await db.ref('orders/O3').set({ restaurant_id: 'x_pizza', items: [{ n: 'a' }, { n: 'b' }] });
  const exactKey = F.bucketKeyExact(T0, 4, 2), daypartKey = F.bucketKeyDaypart(T0, 4);
  await db.ref(`ready_time_model/x_pizza/${V1}/restaurant`).set({ p50: 22, sample_count: 5 });
  await runPrediction({ db, now: 3000 }, { orderId: 'O3', event: evRow() });
  assert.deepStrictEqual([(await val(`order_predictions/O3/${V1}`)).source, (await val(`order_predictions/O3/${V1}`)).predicted_prep_min], ['restaurant', 22]); ok('3: only restaurant ring ≥ MIN → source restaurant (22)');
  await db.ref(`ready_time_model/x_pizza/${V1}/daypart/${daypartKey}`).set({ p50: 16, sample_count: 5 });
  await db.ref('order_predictions/O3b').remove(); await db.ref('orders/O3b').set({ restaurant_id: 'x_pizza', items: [{ n: 'a' }, { n: 'b' }] });
  await runPrediction({ db, now: 3000 }, { orderId: 'O3b', event: evRow() });
  assert.strictEqual((await val(`order_predictions/O3b/${V1}`)).source, 'daypart'); ok('3: daypart ring present → source daypart (beats restaurant)');
  await db.ref(`ready_time_model/x_pizza/${V1}/exact/${exactKey}`).set({ p50: 12, sample_count: 5 });
  await db.ref('orders/O3c').set({ restaurant_id: 'x_pizza', items: [{ n: 'a' }, { n: 'b' }] });
  await runPrediction({ db, now: 3000 }, { orderId: 'O3c', event: evRow() });
  assert.strictEqual((await val(`order_predictions/O3c/${V1}`)).source, 'exact'); ok('3: exact ring present → source exact (beats daypart)');

  // ── 4. Label + model update: eligible x_pizza maintains ALL THREE rings, keyed by orderId ──
  await db.ref('/').set(null); await db.ref('ready_time_config').set(eligCfg);
  await seedEligible('O4');
  await runLabelAndUpdate({ db, now: 4000 }, { orderId: 'O4', readyAt: T0 + 15 * 60000 });
  const exK = F.bucketKeyExact(T0, 4, 2), dpK = F.bucketKeyDaypart(T0, 4);
  for (const [lvl, ring] of [['exact', await val(`ready_time_model/x_pizza/${V1}/exact/${exK}`)], ['daypart', await val(`ready_time_model/x_pizza/${V1}/daypart/${dpK}`)], ['restaurant', await val(`ready_time_model/x_pizza/${V1}/restaurant`)]]) {
    assert.strictEqual(ring.p50, 15); assert.ok(ring.samplesByOrder.O4 && ring.samplesByOrder.O4.prep_min === 15, `${lvl} ring`);
  }
  ok('4: eligible x_pizza → all 3 rings (exact/daypart/restaurant) updated, samplesByOrder[O4]=15');
  const log = await val(`prediction_logs/O4/${V1}`);
  assert.strictEqual(log.prep_new_min, 15); assert.strictEqual(log.prediction_missing, true); ok('4: log written with actual (prep_new_min=15) + prediction_missing (A never ran) — join-safe, no backfill');

  // ── 5. Ring retry-idempotency: re-run same order → no dup sample, p50 unchanged ──
  await runLabelAndUpdate({ db, now: 4001 }, { orderId: 'O4', readyAt: T0 + 15 * 60000 });
  const ringAfter = await val(`ready_time_model/x_pizza/${V1}/restaurant`);
  assert.strictEqual(ringAfter.sample_count, 1); assert.strictEqual(Object.keys(ringAfter.samplesByOrder).length, 1); ok('5: re-run same orderId → ring still ONE sample (retry-idempotent)');
  // 5b. log write-once
  await db.ref(`prediction_logs/O4/${V1}/logged_at`).once('value'); const beforeLog = await val(`prediction_logs/O4/${V1}`);
  await runLabelAndUpdate({ db, now: 9999 }, { orderId: 'O4', readyAt: T0 + 15 * 60000 });
  assert.strictEqual((await val(`prediction_logs/O4/${V1}`)).logged_at, beforeLog.logged_at); ok('5b: prediction_logs write-once (second run aborts, logged_at unchanged)');

  // ── 6. Quarantine on timeline violation → log flagged, NO ring update ──
  await db.ref('/').set(null); await db.ref('ready_time_config').set(eligCfg);
  await seedEligible('O6', { preparingAt: T0 + 20 * 60000 }); // preparing_at (20m) > ready_at (15m) → sanity violation
  await runLabelAndUpdate({ db, now: 6000 }, { orderId: 'O6', readyAt: T0 + 15 * 60000 });
  const q = await val(`prediction_logs/O6/${V1}`);
  assert.strictEqual(q.quarantined, true); assert.ok(q.quarantine_reason.includes('timeline_sanity')); ok('6: timeline violation → log quarantined:true + reason');
  assert.strictEqual(await val(`ready_time_model/x_pizza/${V1}/restaurant`), null); ok('6: quarantined → NO model ring update (ready_time_model empty)');

  // ── 7. la_musa: log-only + constant, NO bucket model ──
  await db.ref('/').set(null); await db.ref('ready_time_config').set(eligCfg);
  await db.ref('orders/OL').set({ restaurant_id: 'la_musa' }); // external_pos: no items
  await runPrediction({ db, now: 7000 }, { orderId: 'OL', event: evRow({ restaurant_id: 'la_musa' }) });
  const pl = await val(`order_predictions/OL/${V1}`);
  assert.strictEqual(pl.source, 'cold_start'); assert.strictEqual(pl.predicted_prep_min, coldStartMin('la_musa')); ok('7: la_musa prediction → cold_start constant (20)');
  await seedEligible('OL', { restaurant: 'la_musa', items: null });
  await runLabelAndUpdate({ db, now: 7000 }, { orderId: 'OL', readyAt: T0 + 15 * 60000 });
  assert.ok(await val(`prediction_logs/OL/${V1}`)); assert.strictEqual(await val('ready_time_model/la_musa'), null); ok('7: la_musa → log written but ZERO ring writes (no bucket model)');

  // ── 8. v1/v2 coexist: both versions get a prediction + a log ──
  ACTIVE_MODEL_VERSIONS.push('v2-shadow-test');
  try {
    await db.ref('/').set(null); await db.ref('ready_time_config').set(eligCfg);
    await seedEligible('O8');
    await runPrediction({ db, now: 8000 }, { orderId: 'O8', event: evRow() });
    await runLabelAndUpdate({ db, now: 8000 }, { orderId: 'O8', readyAt: T0 + 15 * 60000 });
    assert.ok(await val(`order_predictions/O8/${V1}`) && await val('order_predictions/O8/v2-shadow-test')); ok('8: v1 + v2 predictions both written (ACTIVE_MODEL_VERSIONS fan-out)');
    assert.ok(await val(`prediction_logs/O8/${V1}`) && await val('prediction_logs/O8/v2-shadow-test')); ok('8: v1 + v2 logs both written');
  } finally { ACTIVE_MODEL_VERSIONS.pop(); }

  console.log(`\n${n} passed`);
  process.exit(0);
})().catch((e) => { console.error('F-MATRIX FAILED:', e); process.exit(1); });
