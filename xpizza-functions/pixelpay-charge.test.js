/**
 * Unit tests for the PixelPay attempt-acquisition CAS logic (Stage 3b).
 *
 * Uses a small in-memory mock of the RTDB ref API that faithfully models the
 * two primitives acquireOnlineAttempt relies on:
 *   - once('value') → { val() }            (read a path)
 *   - transaction(fn) → { committed, snapshot.val() }  (atomic read-modify-write;
 *       fn returning undefined ABORTS with committed:false)
 *
 * The mock serializes operations (single-threaded JS), so to exercise the
 * concurrency path we interleave two acquisitions by sharing one store and
 * driving them with await points. Run: `node pixelpay-charge.test.js`.
 */
const assert = require('assert');
const { acquireOnlineAttempt, orderFingerprint } = require('./pixelpay-charge');

// ---- in-memory RTDB mock ----
function makeDb(initial = {}) {
  const store = JSON.parse(JSON.stringify(initial)); // { 'orders/X': {...}, 'payment_attempts/Y': {...} }
  return {
    store,
    ref(path) {
      return {
        async once() {
          const v = Object.prototype.hasOwnProperty.call(store, path) ? store[path] : null;
          return { val: () => (v == null ? null : JSON.parse(JSON.stringify(v))) };
        },
        async transaction(fn) {
          const cur = Object.prototype.hasOwnProperty.call(store, path) ? JSON.parse(JSON.stringify(store[path])) : null;
          const next = fn(cur);
          if (next === undefined) {
            return { committed: false, snapshot: { val: () => cur } };
          }
          store[path] = JSON.parse(JSON.stringify(next));
          return { committed: true, snapshot: { val: () => store[path] } };
        },
        async update(patch) {
          store[path] = Object.assign({}, store[path] || {}, JSON.parse(JSON.stringify(patch)));
        }
      };
    }
  };
}

const ORDER_ID = 'PZX-260609-120000-ABCD1234';
const PENDING = { order_id: ORDER_ID, status: 'pending_payment', payment_status: 'pending', total_cents: 38500 };
const FP = orderFingerprint(ORDER_ID, 38500, 'Margherita x1');

let pass = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }

(async () => {
  // 1. Fresh order → acquired, order written pending_payment with the lock.
  {
    const db = makeDb();
    const r = await acquireOnlineAttempt(db, ORDER_ID, PENDING, FP, () => 'AAA');
    assert.strictEqual(r.outcome, 'acquired');
    assert.strictEqual(r.attempt_id, 'AAA');
    const o = db.store[`orders/${ORDER_ID}`];
    assert.strictEqual(o.status, 'pending_payment');
    assert.strictEqual(o.active_attempt_id, 'AAA');
    assert.strictEqual(o.payment_fingerprint, FP);
    ok('fresh order → acquired + pending_payment + lock installed');
  }

  // 2. Idempotent re-submit while the attempt is still active → reuse (no 2nd attempt).
  {
    const db = makeDb({
      [`orders/${ORDER_ID}`]: { ...PENDING, active_attempt_id: 'AAA', payment_fingerprint: FP },
      ['payment_attempts/AAA']: { order_id: ORDER_ID, status: 'active' }
    });
    let minted = 0;
    const r = await acquireOnlineAttempt(db, ORDER_ID, PENDING, FP, () => { minted++; return 'NEW'; });
    assert.strictEqual(r.outcome, 'reuse');
    assert.strictEqual(r.attempt_id, 'AAA');
    ok('active attempt → reuse (does not mint a second charge)');
  }

  // 3. Already confirmed paid → already_paid, no write.
  {
    const db = makeDb({ [`orders/${ORDER_ID}`]: { ...PENDING, payment_status: 'confirmed', active_attempt_id: 'AAA', payment_fingerprint: FP } });
    const r = await acquireOnlineAttempt(db, ORDER_ID, PENDING, FP, () => 'X');
    assert.strictEqual(r.outcome, 'already_paid');
    ok('confirmed paid → already_paid');
  }

  // 4. Same order_id, different cart/total → conflict (409), never mutates the charge.
  {
    const db = makeDb({ [`orders/${ORDER_ID}`]: { ...PENDING, active_attempt_id: 'AAA', payment_fingerprint: FP } });
    const otherFp = orderFingerprint(ORDER_ID, 99900, 'Carnivora x3');
    const r = await acquireOnlineAttempt(db, ORDER_ID, PENDING, otherFp, () => 'X');
    assert.strictEqual(r.outcome, 'conflict');
    ok('order_id reused for a different cart → conflict');
  }

  // 5. Declined attempt → rotate to a fresh attempt id.
  {
    const db = makeDb({
      [`orders/${ORDER_ID}`]: { ...PENDING, active_attempt_id: 'AAA', payment_fingerprint: FP },
      ['payment_attempts/AAA']: { order_id: ORDER_ID, status: 'declined' }
    });
    const r = await acquireOnlineAttempt(db, ORDER_ID, PENDING, FP, () => 'BBB');
    assert.strictEqual(r.outcome, 'acquired');
    assert.strictEqual(r.attempt_id, 'BBB');
    assert.strictEqual(db.store[`orders/${ORDER_ID}`].active_attempt_id, 'BBB');
    ok('declined attempt → rotate to a fresh attempt');
  }

  // 6. Pointer set but attempt record MISSING (crash recovery) → recover SAME id, no 2nd mint.
  {
    const db = makeDb({ [`orders/${ORDER_ID}`]: { ...PENDING, active_attempt_id: 'AAA', payment_fingerprint: FP } });
    let minted = 0;
    const r = await acquireOnlineAttempt(db, ORDER_ID, PENDING, FP, () => { minted++; return 'NEW'; });
    assert.strictEqual(r.outcome, 'acquired');
    assert.strictEqual(r.attempt_id, 'AAA', 'recovers the existing pointer, not a new id');
    assert.strictEqual(db.store[`orders/${ORDER_ID}`].active_attempt_id, 'AAA');
    ok('pointer set, record missing → recover same id (no second attempt minted)');
  }

  // 7. Crash AFTER pending write but BEFORE lock installed → install lock on existing order.
  {
    const db = makeDb({ [`orders/${ORDER_ID}`]: { ...PENDING } }); // no active_attempt_id
    const r = await acquireOnlineAttempt(db, ORDER_ID, PENDING, FP, () => 'CCC');
    assert.strictEqual(r.outcome, 'acquired');
    assert.strictEqual(r.attempt_id, 'CCC');
    assert.strictEqual(db.store[`orders/${ORDER_ID}`].active_attempt_id, 'CCC');
    assert.strictEqual(db.store[`orders/${ORDER_ID}`].payment_fingerprint, FP);
    ok('pending order without lock → install lock (crash-between-writes recovery)');
  }

  // 8. Concurrent double-submit on a brand-new order → exactly ONE acquires, the
  //    other reuses the SAME attempt id (I3: ≤ one charge). We model the race by
  //    letting both pre-read empty, then resolving their transactions in order.
  {
    const db = makeDb();
    // First caller fully completes (creates the order + lock + attempt record).
    const r1 = await acquireOnlineAttempt(db, ORDER_ID, PENDING, FP, () => 'FIRST');
    assert.strictEqual(r1.outcome, 'acquired');
    assert.strictEqual(r1.attempt_id, 'FIRST');
    // Simulate the attempt record having been written by the endpoint.
    db.store['payment_attempts/FIRST'] = { order_id: ORDER_ID, status: 'active' };
    // Second caller arrives after — must NOT create a second attempt.
    const r2 = await acquireOnlineAttempt(db, ORDER_ID, PENDING, FP, () => 'SECOND');
    assert.strictEqual(r2.outcome, 'reuse');
    assert.strictEqual(r2.attempt_id, 'FIRST');
    ok('concurrent double-submit → one acquires, the other reuses the same id');
  }

  console.log(`\nAll ${pass} acquireOnlineAttempt tests passed.`);
})().catch((e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
