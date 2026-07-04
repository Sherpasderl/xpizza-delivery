/**
 * Unit tests for voidOrRefund (Stage 6) — over a nested-tree RTDB mock.
 * Run: `node pixelpay-cancel.test.js`.
 */
const assert = require('assert');
const { voidOrRefund } = require('./pixelpay-cancel');

function makeDb(initial = {}) {
  const root = JSON.parse(JSON.stringify(initial));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const getAt = (p) => { if (!p) return root; let n = root; for (const k of p.split('/')) { if (n == null) return null; n = n[k]; } return n === undefined ? null : n; };
  const setAt = (p, val) => { const a = p.split('/'); let n = root; for (let i = 0; i < a.length - 1; i++) { if (n[a[i]] == null || typeof n[a[i]] !== 'object') n[a[i]] = {}; n = n[a[i]]; } const l = a[a.length - 1]; if (val === null) delete n[l]; else n[l] = val; };
  return {
    getAt,
    ref: (p = '') => ({
      async once() { return { val: () => clone(getAt(p)) }; },
      async set(v) { setAt(p, clone(v)); },
      async update(patch) { setAt(p, Object.assign({}, getAt(p) || {}, clone(patch))); },
      // RTDB-like transaction (fn runs speculative-null then real; undefined → abort) for the Fix-B reversal CAS.
      async transaction(fn) { fn(null); const cur = clone(getAt(p)); const nx = fn(cur); if (nx === undefined) return { committed: false, snapshot: { val: () => cur } }; setAt(p, clone(nx)); return { committed: true, snapshot: { val: () => clone(getAt(p)) } }; }
    })
  };
}

function mkClient({ voidOk = true, voidThrows = false, msg = 'Transacción anulada exitosamente' } = {}) {
  const calls = { void: 0 };
  return { calls, async voidTransaction() { calls.void++; if (voidThrows) throw new Error('net'); return { ok: voidOk, message: msg }; } };
}

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  const base = { 'payment_attempts': { A: { order_id: 'O1', status: 'captured', payment_uuid: 'S-u' } } };

  // 1. Successful void → refunded + immutable audit + attempt refunded.
  {
    const db = makeDb(base);
    const client = mkClient({ voidOk: true });
    const r = await voidOrRefund({ db, client, alert: () => {} }, { orderId: 'O1', attemptId: 'A', pixelpayOrderId: 'O1-A', paymentUuid: 'S-u', reason: 'cancel', now: 1000 });
    assert.strictEqual(r.outcome, 'refunded');
    assert.strictEqual(db.getAt('payment_attempts/A').status, 'refunded');
    assert.strictEqual(db.getAt('payment_attempts/A').refunded_at, 1000);
    assert.ok(db.getAt('refund_attempts/A-1000'), 'immutable audit record written');
    assert.strictEqual(db.getAt('refund_attempts/A-1000').voided, true);
    assert.strictEqual(client.calls.void, 1);
    ok('successful void → refunded + audit record');
  }

  // 2. Void fails → refund_pending + alert, money tracked (I6, never silently lost).
  {
    const db = makeDb(base);
    const client = mkClient({ voidOk: false, msg: 'rechazado' });
    let alerted = null;
    const r = await voidOrRefund({ db, client, alert: (k, d) => { alerted = k; } }, { orderId: 'O1', attemptId: 'A', pixelpayOrderId: 'O1-A', paymentUuid: 'S-u', reason: 'cancel', now: 2000 });
    assert.strictEqual(r.outcome, 'refund_pending');
    assert.strictEqual(db.getAt('payment_attempts/A').status, 'refund_pending');
    assert.strictEqual(db.getAt('refund_attempts/A-2000').voided, false);
    assert.strictEqual(alerted, 'refund_pending');
    ok('failed void → refund_pending + alert (tracked, not lost)');
  }

  // 3. Void throws → refund_pending (caught, tracked).
  {
    const db = makeDb(base);
    const client = mkClient({ voidThrows: true });
    const r = await voidOrRefund({ db, client, alert: () => {} }, { orderId: 'O1', attemptId: 'A', pixelpayOrderId: 'O1-A', paymentUuid: 'S-u', reason: 'cancel', now: 3000 });
    assert.strictEqual(r.outcome, 'refund_pending');
    ok('void network error → refund_pending (caught)');
  }

  // 4. No payment_uuid (nothing captured) → refunded no-op (nothing owed).
  {
    const db = makeDb(base);
    const client = mkClient();
    const r = await voidOrRefund({ db, client, alert: () => {} }, { orderId: 'O1', attemptId: 'A', pixelpayOrderId: 'O1-A', paymentUuid: null, reason: 'cancel', now: 4000 });
    assert.strictEqual(r.outcome, 'refunded');
    assert.strictEqual(client.calls.void, 0, 'no void call when nothing to reverse');
    assert.strictEqual(db.getAt('refund_attempts/A-4000').message, 'no_payment_to_void');
    ok('no payment to reverse → refunded no-op (no void call)');
  }

  console.log(`\nAll ${pass} voidOrRefund tests passed.`);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
