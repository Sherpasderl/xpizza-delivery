/**
 * Unit tests for handleHostedCallback (Stage H3). Run: `node pixelpay-hosted-webhook.test.js`.
 * Uses real verifyPaymentHash/toCents/confirmAndMaterialize/buildMaterializeUpdates against an
 * in-memory db (PIXELPAY_MODE unset → sandbox creds: key 1234567890 / @s4ndb0x-…).
 */
const assert = require('assert');
const { handleHostedCallback } = require('./pixelpay-hosted-webhook');
const { paymentHash } = require('./pixelpay');
const { buildMaterializeUpdates } = require('./materialize');

const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
const RESTAURANT = { lat: 15.5, lng: -88.0, name: 'X Pizza', phone: '+50497952893' };
const NOW = 1700000000000;
const A = 'a1b2c3d4e5f6a7b8';   // 16-hex attempt id

function makeDb(initial = {}) {
  const root = JSON.parse(JSON.stringify(initial));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const getAt = (p) => { if (!p) return root; let n = root; for (const k of p.split('/')) { if (n == null) return null; n = n[k]; } return n === undefined ? null : n; };
  const setAt = (p, val) => { const a = p.split('/'); let n = root; for (let i = 0; i < a.length - 1; i++) { if (n[a[i]] == null || typeof n[a[i]] !== 'object') n[a[i]] = {}; n = n[a[i]]; } const l = a[a.length - 1]; if (val === null) delete n[l]; else n[l] = val; };
  const ref = (p = '') => ({
    async once() { return { val: () => clone(getAt(p)) }; },
    async transaction(fn) { fn(null); const cur = clone(getAt(p)); const nx = fn(cur); if (nx === undefined) return { committed: false, snapshot: { val: () => cur } }; setAt(p, clone(nx)); return { committed: true, snapshot: { val: () => clone(getAt(p)) } }; },
    async update(patch) { if (!p) { for (const [k, v] of Object.entries(patch)) setAt(k, clone(v)); return; } setAt(p, Object.assign({}, getAt(p) || {}, clone(patch))); }
  });
  return { ref, getAt };
}
const deps = (db, voidImpl) => ({ db, restaurant: RESTAURANT, buildMaterializeUpdates, alert: () => {}, genToken: () => 'TOK', client: {}, voidOrRefund: voidImpl || (async () => ({ voided: true })) });
const seed = (over = {}, attOver = {}) => ({
  orders: { O1: { order_id: 'O1', order_type: 'pickup', payment_method: 'online', payment_status: 'pending', status: 'pending_payment', total: 299, total_cents: 29900, customer_name: 'Test', items_text: 'Margherita', active_attempt_id: A, ...over } },
  payment_attempts: { [A]: { order_id: 'O1', hosted_state: 'created', hosted_order_id: `O1-${A}`, hosted_checkout_url: 'https://pay/x', ...attOver } }
});
const cb = (over = {}) => ({ order: `O1-${A}`, ref: 'PIXELPAY-INTERNAL-REF', status: 'paid', amount: 299, uuid: 'P-paid-1', transaction_id: 'TXN-1', payment_hash: paymentHash(`O1-${A}`, KEY, SECRET), ...over });

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  // 1. valid paid → materialize (binds on `order`, ignores junk `ref`)
  {
    const db = makeDb(seed());
    const r = await handleHostedCallback(deps(db), cb(), NOW);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.outcome, 'confirmed');
    assert.strictEqual(db.getAt('orders/O1').status, 'new');
    assert.strictEqual(db.getAt('orders/O1').payment_status, 'confirmed');
    assert.strictEqual(db.getAt(`payment_attempts/${A}`).hosted_state, 'paid');
    assert.strictEqual(db.getAt(`payment_attempts/${A}`).payment_uuid, 'P-paid-1');
    assert.ok(db.getAt('orders/O1').materialized_at);
    ok('valid paid → materialized (bound on `order`, not `ref`)');
  }

  // 2. idempotent: a 2nd identical callback does not re-materialize / double anything
  {
    const db = makeDb(seed());
    await handleHostedCallback(deps(db), cb(), NOW);
    const r2 = await handleHostedCallback(deps(db), cb(), NOW + 1000);
    assert.strictEqual(r2.code, 200);
    assert.strictEqual(r2.outcome, 'already_confirmed');
    ok('duplicate paid callback → already_confirmed (idempotent)');
  }

  // 3. amount mismatch → manual_reconciliation (200, not retried)
  {
    const db = makeDb(seed());
    const r = await handleHostedCallback(deps(db), cb({ amount: 1, payment_hash: paymentHash(`O1-${A}`, KEY, SECRET) }), NOW);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.outcome, 'manual_reconciliation');
    assert.strictEqual(db.getAt('orders/O1').payment_status, 'manual_reconciliation');
    assert.notStrictEqual(db.getAt('orders/O1').status, 'new'); // NOT materialized
    ok('amount mismatch → manual_reconciliation, not materialized');
  }

  // 4. bad payment_hash → manual_reconciliation
  {
    const db = makeDb(seed());
    const r = await handleHostedCallback(deps(db), cb({ payment_hash: 'deadbeefdeadbeefdeadbeefdeadbeef' }), NOW);
    assert.strictEqual(r.outcome, 'manual_reconciliation');
    ok('bad payment_hash → manual_reconciliation');
  }

  // 5. non-paid status → telemetry only (ignored), order untouched
  {
    const db = makeDb(seed());
    const r = await handleHostedCallback(deps(db), cb({ status: 'failed' }), NOW);
    assert.strictEqual(r.code, 200);
    assert.ok(r.outcome.startsWith('ignored_status'));
    assert.strictEqual(db.getAt('orders/O1').status, 'pending_payment'); // unchanged
    ok('non-paid callback → telemetry-only ignore (order untouched, I12)');
  }

  // 6. cancel_pending → auto-void, never materialize
  {
    const db = makeDb(seed({}, { cancel_pending: true }));
    let voidedArgs = null;
    const r = await handleHostedCallback(deps(db, async (_d, a) => { voidedArgs = a; return { voided: true }; }), cb(), NOW);
    assert.strictEqual(r.outcome, 'cancelled_voided');
    assert.strictEqual(db.getAt('orders/O1').status, 'cancelled');
    assert.strictEqual(db.getAt('orders/O1').payment_status, 'refunded');
    assert.strictEqual(db.getAt(`payment_attempts/${A}`).hosted_state, 'voided');
    assert.strictEqual(voidedArgs.paymentUuid, 'P-paid-1');
    assert.notStrictEqual(db.getAt('orders/O1').status, 'new');
    ok('cancel_pending + paid callback → auto-void (refunded), never materialized (I9)');
  }

  // 7. unknown order/attempt → ignored
  {
    const db = makeDb({});
    const r = await handleHostedCallback(deps(db), cb(), NOW);
    assert.strictEqual(r.outcome, 'ignored_unknown');
    ok('unknown order/attempt → ignored');
  }

  console.log(`\nAll ${pass} handleHostedCallback tests passed.`);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
