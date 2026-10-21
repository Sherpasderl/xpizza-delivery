// BRAND-AGNOSTIC SERVER (PLAN-brand-agnostic-server r3 §A) — the return-base invariant at the REAL writers, against the RTDB
// emulator: startDriverShift (clock-in) and endDriverShift (clock-out) record a non-null prior current_restaurant_id as
// return_restaurant_id in their own multi-path update, and the syncDriverHub trigger's clear does the same; a null prior
// never erases a stored value; a forced shift end (dispatch SDK — it touches neither the task nor the hub) leaves the rid for
// the next clock-in to copy. Run: npm run test:driver-return-shift
require('./_emulator-required')('database');
const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const app = require('../index.js');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
Object.getPrototypeOf(getAuth()).getUser = async (uid) => ({ uid, disabled: false, tokensValidAfterTime: null });
const db = getDatabase();
assert.match(db.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost)/);

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const v = async (p) => (await db.ref(p).once('value')).val();
const snap = (x) => ({ val: () => (x === undefined ? null : JSON.parse(JSON.stringify(x))), exists: () => x !== null && x !== undefined });
const U = 'u_return_a000000000000000';
const call = (fn, data = { platform: 'pwa' }) => app[fn].run({ auth: { uid: U, token: { uid: U } }, data, rawRequest: { headers: {} } });
const reset = async (driver) => {
  await db.ref().set(null);
  await db.ref(`driver_accounts/${U}`).set({ enabled: true });
  await db.ref(`drivers/${U}`).set({ name: 'Ana', status: 'off_shift', active: false, ...driver });
};
const trigger = (before, after) => app.syncDriverHub.run({ params: { uid: U }, data: { before: snap(before), after: snap(after) } });

(async () => {
  // ── clock-in ──
  await reset({ current_restaurant_id: 'tb_centro', current_hub_lat: 15.51, current_hub_lng: -88.03 });
  await call('startDriverShift');
  assert.strictEqual(await v(`drivers/${U}/current_restaurant_id`), null, 'clock-in clears the hub snapshot (unchanged)');
  assert.strictEqual(await v(`drivers/${U}/return_restaurant_id`), 'tb_centro', 'clock-in records the rid it clears');
  assert.strictEqual(await v(`drivers/${U}/status`), 'available');
  ok('clock-in (startDriverShift) after a forced end that left current_restaurant_id tb_centro → return tb_centro, in the same batch');

  await reset({ current_restaurant_id: null, return_restaurant_id: 'tb_norte' });
  await call('startDriverShift');
  assert.strictEqual(await v(`drivers/${U}/return_restaurant_id`), 'tb_norte', 'a null prior preserves the stored value');
  ok('clock-in with a null current_restaurant_id preserves the stored return_restaurant_id');

  await reset({ current_restaurant_id: null });
  const r = await call('startDriverShift', { platform: 'native' });
  assert.ok(r.ingest_token, 'the native path still mints a token');
  assert.strictEqual(await v(`drivers/${U}/return_restaurant_id`), null, 'a driver with no history gets no return base');
  ok('clock-in with no history writes no return_restaurant_id (native path: token minted as before)');

  // ── clock-out ──
  await reset({ current_restaurant_id: 'tb_norte', status: 'available', active: true, current_shift_id: 's1' });
  await call('endDriverShift');
  assert.strictEqual(await v(`drivers/${U}/current_restaurant_id`), null);
  assert.strictEqual(await v(`drivers/${U}/return_restaurant_id`), 'tb_norte', 'clock-out records the rid it clears');
  assert.strictEqual(await v(`drivers/${U}/status`), 'off_shift');
  ok('clock-out (endDriverShift) with current_restaurant_id tb_norte → return tb_norte, in the same update');

  await reset({ current_restaurant_id: null, return_restaurant_id: 'tb_centro', status: 'available', active: true, current_shift_id: 's1' });
  await call('endDriverShift');
  assert.strictEqual(await v(`drivers/${U}/return_restaurant_id`), 'tb_centro', 'a null prior preserves the stored value');
  ok('clock-out with a null current_restaurant_id preserves the stored return_restaurant_id');

  // ── the syncDriverHub trigger: delivered / cancelled / unassigned → current_task_id null → clear ──
  await reset({ current_restaurant_id: 'tb_centro', current_hub_lat: 15.51, current_hub_lng: -88.03, current_hub_task_id: 'o1_delivery', current_task_id: null, status: 'returning', active: true });
  await trigger('o1_delivery', null);
  assert.strictEqual(await v(`drivers/${U}/current_restaurant_id`), null, 'the clear runs as before');
  assert.strictEqual(await v(`drivers/${U}/return_restaurant_id`), 'tb_centro', 'the task end records the restaurant just served');
  await trigger(null, null);
  assert.strictEqual(await v(`drivers/${U}/return_restaurant_id`), 'tb_centro', 'a second (empty) clear preserves it');
  ok('syncDriverHub clear (task ended) → return tb_centro; a second empty clear preserves it');

  await reset({ current_restaurant_id: 'tb_centro', current_hub_lat: 15.51, current_hub_lng: -88.03, current_task_id: 'o2_pickup', status: 'assigned', active: true, return_restaurant_id: 'tb_norte' });
  await trigger(null, null);   // a stale event: current_task_id has already advanced to o2_pickup
  assert.strictEqual(await v(`drivers/${U}/return_restaurant_id`), 'tb_norte', 'a diverged (stale) event writes nothing');
  assert.strictEqual(await v(`drivers/${U}/current_restaurant_id`), 'tb_centro');
  ok('a stale (diverged) clear event writes nothing — return_restaurant_id and the snapshot untouched');

  await db.ref().set(null);
  console.log(`\ndriver-return-shift.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('driver-return-shift.emulator FAILED:', e); process.exit(1); });
