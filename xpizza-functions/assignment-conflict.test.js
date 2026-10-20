'use strict';
// RELEASE RACE (PLAN-release-race r2.1) — the healer's assignment_conflict alert helper: create-only (never overwrites), carries
// order_id, and BOUNDED (a rejected or never-settling write resolves within the timeout, logged; it never throws into the sweep).
// Run: node assignment-conflict.test.js
const assert = require('assert');
const { alertAssignmentConflict, ALERT_TIMEOUT_MS } = require('./assignment-conflict');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const quiet = { error: () => {} };
function fakeDb(init = {}, mode = null) {
  const data = { ...init }; const paths = [];
  return {
    data, paths,
    ref: (p) => ({
      transaction: (fn) => {
        paths.push(p);
        if (mode === 'reject') return Promise.reject(new Error('down'));
        if (mode === 'throw') throw new Error('sync throw');
        if (mode === 'hang') return new Promise(() => {});
        const real = p in data ? data[p] : null;
        let next = fn(null); if (next !== undefined && real !== null) next = fn(real);
        if (next === undefined) return Promise.resolve({ committed: false });
        data[p] = next; return Promise.resolve({ committed: true });
      },
    }),
  };
}

(async () => {
  assert.strictEqual(ALERT_TIMEOUT_MS, 3000, 'the bound is 3 s');
  const db = fakeDb();
  assert.strictEqual(await alertAssignmentConflict(db, { orderId: 'o1', deliveryDriverId: 'dB', pickupDriverId: 'dA', now: 5 }, { log: quiet }), 'written');
  assert.deepStrictEqual(db.paths, ['dispatcher_alerts/assignment_conflict_o1']);
  assert.deepStrictEqual(db.data['dispatcher_alerts/assignment_conflict_o1'], { type: 'assignment_conflict', order_id: 'o1', delivery_driver_id: 'dB', pickup_driver_id: 'dA', created_at: 5 }, 'the alert carries order_id + both stranded owners');
  ok('writes ONE keyed alert carrying order_id + both stranded owners');

  const PRE = { type: 'assignment_conflict', order_id: 'o2', sentinel: 'pre' };
  const db2 = fakeDb({ 'dispatcher_alerts/assignment_conflict_o2': PRE });
  await alertAssignmentConflict(db2, { orderId: 'o2', deliveryDriverId: null, pickupDriverId: 'dA', now: 9 }, { log: quiet });
  assert.deepStrictEqual(db2.data['dispatcher_alerts/assignment_conflict_o2'], PRE, 'an existing alert is never overwritten');
  ok('create-only: an existing (distinguishable) alert is left byte-identical');

  for (const mode of ['reject', 'throw']) {
    const errs = []; const r = await alertAssignmentConflict(fakeDb({}, mode), { orderId: 'o3', now: 1 }, { log: { error: (m) => errs.push(m) } });
    assert.deepStrictEqual([r, errs.length], ['failed', 1], `${mode}: resolves 'failed', logged once, never throws`);
  }
  ok('a rejected / synchronously-throwing write resolves "failed" (logged) — never throws into the sweep');

  const errs = []; const t0 = Date.now();
  const r = await alertAssignmentConflict(fakeDb({}, 'hang'), { orderId: 'o4', now: 1 }, { timeoutMs: 50, log: { error: (m) => errs.push(m) } });
  assert.deepStrictEqual([r, errs.length], ['timeout', 1]);
  assert.ok(Date.now() - t0 < 1000, 'bounded');
  ok('a NEVER-SETTLING write resolves "timeout" at the bound (logged)');

  const late = { ref: () => ({ transaction: () => new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 80)) }) };
  let unhandled = 0; const onU = () => { unhandled++; }; process.on('unhandledRejection', onU);
  await alertAssignmentConflict(late, { orderId: 'o5', now: 1 }, { timeoutMs: 20, log: quiet });
  await new Promise((res) => setTimeout(res, 150));
  process.off('unhandledRejection', onU);
  assert.strictEqual(unhandled, 0, 'a write that rejects AFTER the timeout raises no unhandled rejection');
  ok('a write rejecting after the bound leaves no unhandled rejection');

  console.log(`\nassignment-conflict: OK (${n})`);
})().catch((e) => { console.error('assignment-conflict FAILED:', e); process.exit(1); });
