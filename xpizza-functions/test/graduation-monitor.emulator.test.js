'use strict';
/**
 * OWNER-RUN emulator test — readyTimeGraduationMonitor wiring (Phase 1b-i).
 *
 *   firebase emulators:exec --only database --project demo-xpizza \
 *     "node test/graduation-monitor.emulator.test.js"
 *
 * The stats CORE is exhaustively unit-tested in ready-time-graduation.test.js. This proves the MONITOR wiring
 * against the real RTDB emulator (via .run()):
 *  - the EXECUTOR-CORRECTED two-level query — prediction_logs.orderByChild('<v>/new_at') deep-path range —
 *    windows the join base correctly (in-window orders included, out-of-window excluded) using the synced
 *    .indexOn;
 *  - the order_predictions read is bounded to the windowed orderIds (plan-gate #3);
 *  - verdicts write to ready_time_graduation/{v}/{restaurant}/{source}/{bucket_key} + _meta/active_config_hash;
 *  - UNSIGNED config ⇒ mode:'preview' ⇒ graduated:false (nothing graduates during the bake);
 *  - the SHADOW BOUNDARY holds: NOTHING is written to /orders, order_predictions, or prediction_logs.
 */
const assert = require('assert');
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'test-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

const app = require('../index.js');
const { getDatabase } = require('firebase-admin/database');
const db = getDatabase();

const V = 'v1-hier-ringmed-30';       // ACTIVE_MODEL_VERSIONS[0]
const WINDOW_MS = 14 * 24 * 3600 * 1000;

const GT = {
  window_ms: WINDOW_MS, min_samples: 30, margin: 1, margin_bkt: 1, q_fdr: 0.1, coverage_cap: 0.2, excl_cap: 0.2,
  late_cap: 0.15, p90_cap: 5, within_floor: 0.6, bias_cap: 1, within_n_min: 5, ttl_ms: 216e5, bootstrap_resamples: 200,
  buffer_prep_min: 12,   // nested (Task-6 seed style) — computeGraduation falls back to this
  // UNSIGNED: no version / approved_at ⇒ isGraduationConfigSigned=false ⇒ preview
};

async function seed() {
  await db.ref('/').set(null);
  await db.ref('ready_time_config').set({ settle_lag_ms: 0, graduation_thresholds: GT });
  const now = Date.now();
  // 50 in-window matched orders, one strong bucket (spread actuals so buffer & bucket-median are poor).
  const updates = {};
  for (let i = 0; i < 50; i++) {
    const id = `ORD-${i}`;
    const actual = 10 + (i % 11);           // 10..20
    const err = (i % 3) * 0.2;              // 0,0.2,0.4 (all ≥0 → late_rate 0)
    const newAt = now - 3600 * 1000 - i;    // ~1h ago, in-window
    updates[`prediction_logs/${id}/${V}`] = { new_at: newAt, restaurant_id: 'x_pizza', model_version: V,
      error_min: err, predicted_prep_min: actual + err, prep_new_min: actual };
    updates[`order_predictions/${id}/${V}`] = { new_at: newAt, restaurant_id: 'x_pizza', model_version: V,
      source: 'exact', bucket_key: 'b1', predicted_prep_min: actual + err };
  }
  // 1 OUT-OF-WINDOW order (new_at older than the window) — must be excluded by the deep-path range query.
  updates[`prediction_logs/OLD/${V}`] = { new_at: now - WINDOW_MS - 3600 * 1000, restaurant_id: 'x_pizza',
    model_version: V, error_min: 0, predicted_prep_min: 15, prep_new_min: 15 };
  updates[`order_predictions/OLD/${V}`] = { new_at: now - WINDOW_MS - 3600 * 1000, restaurant_id: 'x_pizza',
    model_version: V, source: 'exact', bucket_key: 'b1', predicted_prep_min: 15 };
  await db.ref().update(updates);
  return now;
}

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  await seed();
  const ordersBefore = (await db.ref('orders').once('value')).val();
  const predsBefore = JSON.stringify((await db.ref('order_predictions').once('value')).val());
  const logsBefore = JSON.stringify((await db.ref('prediction_logs').once('value')).val());

  await app.readyTimeGraduationMonitor.run({});

  const grad = (await db.ref('ready_time_graduation').once('value')).val() || {};
  // ── verdicts written under {v}/{restaurant}/{source}/{bucket_key}, + the _meta pointer ──
  const verdict = grad[V] && grad[V].x_pizza && grad[V].x_pizza.exact && grad[V].x_pizza.exact.b1;
  assert.ok(verdict, 'verdict written at ready_time_graduation/<v>/x_pizza/exact/b1');
  assert.ok(grad._meta && typeof grad._meta.active_config_hash !== 'undefined', '_meta/active_config_hash written (fix 7\')');
  ok('verdict written at {v}/{restaurant}/{source}/{bucket_key} + _meta/active_config_hash pointer');

  // ── the deep-path range query windowed correctly: n counts only the 50 in-window orders (OLD excluded) ──
  assert.strictEqual(verdict.n, 50, `n=50 in-window (OLD out-of-window excluded); got ${verdict.n}`);
  ok('two-level deep-path query windowed correctly — 50 in-window, out-of-window OLD excluded');

  // ── UNSIGNED config ⇒ preview ⇒ graduated:false (even though the bucket is strong) ──
  assert.strictEqual(verdict.mode, 'preview', 'unsigned config → preview');
  assert.strictEqual(verdict.graduated, false, 'preview → graduated:false (nothing graduates during the bake)');
  assert.ok(verdict.vs_buffer && verdict.vs_bucketmed && verdict.predictor && verdict.coverage, 'verdict node shape (§5)');
  ok('unsigned config → mode:preview, graduated:false, verdict carries the reporting distributions');

  // ── SHADOW BOUNDARY: nothing written to /orders, order_predictions, or prediction_logs ──
  assert.deepStrictEqual((await db.ref('orders').once('value')).val(), ordersBefore, '/orders untouched');
  assert.strictEqual(JSON.stringify((await db.ref('order_predictions').once('value')).val()), predsBefore, 'order_predictions untouched');
  assert.strictEqual(JSON.stringify((await db.ref('prediction_logs').once('value')).val()), logsBefore, 'prediction_logs untouched');
  ok('shadow boundary held — wrote ONLY ready_time_graduation (no /orders, order_predictions, prediction_logs)');

  console.log(`\nAll ${pass} graduation-monitor emulator assertions passed.`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
