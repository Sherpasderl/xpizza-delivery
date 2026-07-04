'use strict';

/**
 * Emulator integration proof for the Step-1b data-quality runner (ready-time-quality-run.js).
 * Run (this machine's authority):
 *   JAVA_HOME=/opt/homebrew/opt/openjdk firebase emulators:exec --only functions,database \
 *     --project demo-xpizza "node test/ready-time-quality-run.emulator.test.js"
 *
 * Proves the SIDE EFFECTS the pure golden tests can't (PHASE1_STEP1B_QUALITY_RUNNER.md rev-3 §5):
 *   5a — API-spy: the ONLY mutating prefix is ready_time_quality/ ; /orders, /order_tracking, /tasks,
 *        /notifications byte-identical before/after (a same-value write can't hide from the spy).
 *   5b — fresh-app rerun: create-only transaction sees [null → existingNode], committed===false, the
 *        immutable run node byte-identical (the a679797 landmine, proven for real); a changed join
 *        (late ready_at → new input_hash) yields a NEW runId, the first untouched.
 *   5c — abort overwrites `latest`, never leaves stale-green: a config_invalid invocation writes no
 *        runs/ child but repoints latest to the failure → isFreshAuthoritativeRun ⇒ run_not_ok.
 */
const assert = require('assert');
const admin = require('firebase-admin');
const runner = require('../ready-time-quality-run');
const { hashConfig } = runner;

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  console.error('MUST run under firebase emulators:exec --only database (no FIREBASE_DATABASE_EMULATOR_HOST)');
  process.exit(1);
}
const NS = 'demo-xpizza';
admin.initializeApp({ databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${NS}` });
const db = admin.database();

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const snap = async (p) => JSON.stringify((await db.ref(p).once('value')).val());
const val = async (p) => (await db.ref(p).once('value')).val();

// A signed, deliberately-lax threshold config (this test proves I/O, not verdict math).
const CONFIG = () => ({
  active_restaurants: ['x_pizza', 'la_musa'],
  epoch_start_ms: { x_pizza: 1000, la_musa: 1000 },
  settle_lag_ms: 100,
  cleanup_paths: [], read_budget: { max_rows: 1000 },
  critical_segments: { x_pizza: [{ segment: '18', scope: 'in' }], la_musa: [{ segment: '18', scope: 'in' }] },
  quality_thresholds: {
    version: 't1', approved_at: 1, min_segment_n: 1, min_bucket_n: 1, min_tap_rate: 0.5, min_rush_bias: 0.5,
    min_top_tap_rate: 0.5, max_impossible_rate: 0.9, max_unknown_load_share: 0.9, max_new_at_missingness: 0.9, max_non_kitchen_path_share: 0.9,
  },
});
const EVENTS = (load) => ({
  e1: { from: null, to: 'new', at: 2000, kitchen_load_ahead: load },
  e2: { from: 'new', to: 'preparing', at: 2100, kitchen_load_ahead: load },
  e3: { from: 'preparing', to: 'out_for_delivery', at: 2300, kitchen_load_ahead: load },
});

async function seed() {
  await db.ref('/').set(null);
  await db.ref('ready_time_config').set(CONFIG());
  await db.ref('orders').set({
    A: { restaurant_id: 'x_pizza', order_id: 'A', customer_phone: '99998888' },
    L: { restaurant_id: 'la_musa', order_id: 'L', customer_phone: '99998888' },
  });
  await db.ref('order_events').set({ A: EVENTS(1), L: EVENTS(2) });
  await db.ref('order_timelines').set({
    A: { new_at: 2000, preparing_at: 2100, ready_at: 2200, out_for_delivery_at: 2300 }, // tapped
    L: { new_at: 2000, preparing_at: 2100, out_for_delivery_at: 2300 },                 // missed tap
  });
  // sentinels the runner must NEVER touch
  await db.ref('order_tracking').set({ TOK: { status: 'new', order_id: 'A' } });
  await db.ref('tasks').set({ A_delivery: { status: 'pending', assigned_driver_id: null } });
  await db.ref('notifications').set({ N1: { seen: false } });
}

// A db wrapper that records the path of every MUTATING call (5a).
function spyDb(real, sink) {
  return {
    ref(p) {
      const r = real.ref(p);
      for (const m of ['set', 'update', 'remove', 'transaction', 'push']) {
        const orig = r[m].bind(r);
        r[m] = (...args) => { sink.push(p); return orig(...args); };
      }
      return r;
    },
  };
}

(async () => {
  // ── 5a — no mutating write outside ready_time_quality/ ──
  await seed();
  // Let any function triggered by the SEED's /orders writes (autoAssign, materialize, factura) settle,
  // so the before/after snapshots bracket ONLY the runner's execution — the runner triggers nothing
  // (it writes only ready_time_quality/, which has no trigger), so any drift here would be a seed artifact.
  await new Promise((r) => setTimeout(r, 3000));
  const before = { orders: await snap('orders'), tracking: await snap('order_tracking'), tasks: await snap('tasks'), notif: await snap('notifications') };
  const mutated = [];
  const res = await runner.main({ db: spyDb(db, mutated), now: 5000, mode: 'authoritative' });
  assert.strictEqual(res.status, 'ok'); ok(`5a: authoritative run → status ok (runId ${res.runId})`);
  assert.ok(mutated.length > 0 && mutated.every((p) => p.startsWith('ready_time_quality/')), `mutating paths: ${JSON.stringify(mutated)}`);
  ok('5a: EVERY mutating call was under ready_time_quality/ (API spy)');
  assert.strictEqual(await snap('orders'), before.orders); ok('5a: /orders byte-identical');
  assert.strictEqual(await snap('order_tracking'), before.tracking); ok('5a: /order_tracking byte-identical');
  assert.strictEqual(await snap('tasks'), before.tasks); ok('5a: /tasks byte-identical');
  assert.strictEqual(await snap('notifications'), before.notif); ok('5a: /notifications byte-identical');

  const runId = res.runId;
  const node1 = await val(`ready_time_quality/runs/${runId}`);
  assert.strictEqual(node1.computed_at, 5000); ok('5a: run node persisted with computed_at=5000');
  assert.strictEqual((await val('ready_time_quality/latest')).runId, runId); ok('5a: latest beacon points at the run, status ok');

  // ── 5b — fresh-app rerun exercises the null-first create-only path (a679797 landmine) ──
  const app2 = admin.initializeApp({ databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${NS}` }, 'rerun');
  const db2 = app2.database();
  const w = await runner.writeRunCreateOnly(db2, 'authoritative', runId, { computed_at: 9999, marker: 'SHOULD_NOT_WRITE' });
  assert.strictEqual(w.committed, false); ok('5b: create-only transaction on existing runId → committed===false (callback saw [null→existingNode])');
  assert.strictEqual((await val(`ready_time_quality/runs/${runId}`)).computed_at, 5000); ok('5b: immutable run node byte-identical (no overwrite, computed_at still 5000)');

  // changed join (late ready_at on L) → new input_hash → new runId; first run untouched
  await db.ref('order_timelines/L/ready_at').set(2250);
  const res2 = await runner.main({ db, now: 6000, mode: 'authoritative' });
  assert.notStrictEqual(res2.runId, runId); ok('5b: late ready_at changed the join → NEW runId (no stale no-op)');
  assert.ok(await val(`ready_time_quality/runs/${runId}`)); assert.ok(await val(`ready_time_quality/runs/${res2.runId}`)); ok('5b: both immutable runs coexist; first untouched');
  assert.strictEqual((await val('ready_time_quality/latest')).runId, res2.runId); ok('5b: latest repointed to the newer run');

  // ── 5c — abort overwrites latest, never leaves stale-green ──
  const runsBefore = Object.keys((await val('ready_time_quality/runs')) || {}).length;
  await db.ref('ready_time_config/active_restaurants').set([]); // → config_invalid
  const res3 = await runner.main({ db, now: 7000, mode: 'authoritative' });
  assert.strictEqual(res3.status, 'config_invalid'); ok('5c: config_invalid config → abort status');
  assert.strictEqual(Object.keys((await val('ready_time_quality/runs')) || {}).length, runsBefore); ok('5c: no new runs/ child written on abort');
  assert.strictEqual((await val('ready_time_quality/latest')).status, 'config_invalid'); ok('5c: latest beacon overwritten to the failure (no stale green)');
  const fresh = await runner.readFreshAuthoritativeRun(db, { now: 7000, config_hash: hashConfig(await val('ready_time_config')), coverage: { from_ms: 1000, to_ms: 2500 }, max_age_ms: 1e12 });
  assert.strictEqual(fresh.fresh, false); assert.ok(fresh.reasons.includes('run_not_ok')); ok('5c: isFreshAuthoritativeRun → NOT fresh (run_not_ok) — C1/C2 read the failure, not the last green');

  console.log(`\n${n} passed`);
  process.exit(0);
})().catch((e) => { console.error('EMULATOR TEST FAILED:', e); process.exit(1); });
