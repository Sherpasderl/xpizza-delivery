/**
 * Unit tests for acquireHostedAttempt (Stage H2). Run: `node pixelpay-hosted-charge.test.js`.
 * In-memory db models the Admin SDK's null-first transaction call (uses the 2nd call's result).
 */
const assert = require('assert');
const { acquireHostedAttempt, HOSTED_TTL_MS } = require('./pixelpay-hosted-charge');

function makeDb(initial = {}) {
  const root = JSON.parse(JSON.stringify(initial));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const getAt = (p) => { if (!p) return root; let n = root; for (const k of p.split('/')) { if (n == null) return null; n = n[k]; } return n === undefined ? null : n; };
  const setAt = (p, val) => { const a = p.split('/'); let n = root; for (let i = 0; i < a.length - 1; i++) { if (n[a[i]] == null || typeof n[a[i]] !== 'object') n[a[i]] = {}; n = n[a[i]]; } const l = a[a.length - 1]; if (val === null) delete n[l]; else n[l] = val; };
  const ref = (p = '') => ({
    async once() { return { val: () => clone(getAt(p)) }; },
    async transaction(fn) {
      fn(null);                                   // model Admin SDK first (uncached) null call
      const cur = clone(getAt(p));
      const nx = fn(cur);                         // 2nd call with the real value decides
      if (nx === undefined) return { committed: false, snapshot: { val: () => cur } };
      setAt(p, clone(nx));
      return { committed: true, snapshot: { val: () => clone(getAt(p)) } };
    },
    async update(patch) { if (!p) { for (const [k, v] of Object.entries(patch)) setAt(k, clone(v)); return; } setAt(p, Object.assign({}, getAt(p) || {}, clone(patch))); }
  });
  return { ref, getAt };
}

const NOW = 1_000_000_000;
const FP = 'fp-abc';
const PENDING = { order_id: 'O1', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', total: 299, total_cents: 29900 };
const seqIds = (...ids) => { let i = 0; return () => ids[i++]; };

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  // 1. fresh create → claimed, with the deterministic hosted_order_id pre-persisted
  {
    const db = makeDb({});
    const r = await acquireHostedAttempt(db, 'O1', PENDING, FP, NOW, [], seqIds('AT1'), () => 'TOK1');
    assert.strictEqual(r.outcome, 'claimed');
    assert.strictEqual(r.attempt_id, 'AT1');
    assert.strictEqual(r.hosted_order_id, 'O1-AT1');
    assert.strictEqual(r.expires_at, NOW + HOSTED_TTL_MS);
    const att = db.getAt('payment_attempts/AT1');
    assert.strictEqual(att.hosted_state, 'creating');
    assert.strictEqual(att.hosted_order_id, 'O1-AT1');   // persisted BEFORE the PixelPay call (I7/R2-1)
    assert.strictEqual(att.poll_token, 'TOK1');
    assert.strictEqual(db.getAt('orders/O1').active_attempt_id, 'AT1');
    assert.strictEqual(db.getAt('orders/O1').payment_fingerprint, FP);
    ok('create → claimed; hosted_order_id + poll_token persisted, order locked');
  }

  // 2. live created checkout → reuse the SAME url (one-live-checkout, I10)
  {
    const db = makeDb({
      orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } },
      payment_attempts: { AT1: { order_id: 'O1', hosted_state: 'created', hosted_order_id: 'O1-AT1', hosted_expires_at: NOW + 10000, hosted_checkout_url: 'https://pay/X', poll_token: 'TOK1' } }
    });
    const r = await acquireHostedAttempt(db, 'O1', PENDING, FP, NOW, [], seqIds('AT2'), () => 'TOK2');
    assert.strictEqual(r.outcome, 'reuse');
    assert.strictEqual(r.checkout_url, 'https://pay/X');
    assert.strictEqual(r.attempt_id, 'AT1');
    ok('created + live → reuse existing checkout URL (no 2nd payable checkout)');
  }

  // 3. creating → in_progress (no 2nd create)
  {
    const db = makeDb({ orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } }, payment_attempts: { AT1: { hosted_state: 'creating', hosted_order_id: 'O1-AT1' } } });
    const r = await acquireHostedAttempt(db, 'O1', PENDING, FP, NOW);
    assert.strictEqual(r.outcome, 'in_progress');
    ok('creating → in_progress');
  }

  // 4. paid → already_paid (never a new checkout)
  {
    const db = makeDb({ orders: { O1: { ...PENDING, payment_status: 'confirmed', active_attempt_id: 'AT1', payment_fingerprint: FP } }, payment_attempts: { AT1: { hosted_state: 'paid' } } });
    const r = await acquireHostedAttempt(db, 'O1', PENDING, FP, NOW);
    assert.strictEqual(r.outcome, 'already_paid');
    ok('confirmed order → already_paid');
  }

  // 5. fingerprint mismatch → conflict
  {
    const db = makeDb({ orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: 'OTHER' } }, payment_attempts: { AT1: { hosted_state: 'created' } } });
    const r = await acquireHostedAttempt(db, 'O1', PENDING, FP, NOW);
    assert.strictEqual(r.outcome, 'conflict');
    ok('fingerprint mismatch → conflict');
  }

  // 6. closed states (cancel_pending / voided / manual_reconciliation) → no new checkout
  {
    for (const st of ['cancel_pending', 'voided', 'refund_pending', 'manual_reconciliation']) {
      const db = makeDb({ orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } }, payment_attempts: { AT1: { hosted_state: st } } });
      const r = await acquireHostedAttempt(db, 'O1', PENDING, FP, NOW);
      assert.strictEqual(r.outcome, 'closed', `state ${st}`);
    }
    ok('cancel_pending/voided/refund_pending/manual → closed (no new checkout)');
  }

  // 7. expired created (TTL passed, never paid) → rotate to a fresh attempt
  {
    const db = makeDb({
      orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } },
      payment_attempts: { AT1: { hosted_state: 'created', hosted_order_id: 'O1-AT1', hosted_expires_at: NOW - 1, hosted_checkout_url: 'https://pay/OLD' } }
    });
    const r = await acquireHostedAttempt(db, 'O1', PENDING, FP, NOW, [], seqIds('AT2'), () => 'TOK2');
    assert.strictEqual(r.outcome, 'claimed');
    assert.strictEqual(r.attempt_id, 'AT2');
    assert.strictEqual(db.getAt('orders/O1').active_attempt_id, 'AT2');  // rotated
    assert.strictEqual(db.getAt('payment_attempts/AT2').hosted_state, 'creating');
    ok('expired created → rotate to a fresh attempt (old checkout dead)');
  }

  console.log(`\nAll ${pass} acquireHostedAttempt tests passed.`);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
