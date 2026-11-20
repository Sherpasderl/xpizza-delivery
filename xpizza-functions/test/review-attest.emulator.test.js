'use strict';
// «Marcar como revisado» (owner 11-19, option B) — on the RTDB emulator, the REAL writers: two already-cancelled orders parked by the
// REAL cancel (captured money, no payment id) 7 h ago, each episode stamped by the trigger's body; ONE is attested (its episode) through the REAL
// attestManualReview — the closure lives in manual_review_closures, never on the order. The REAL reconcilePayments then:
//   RAE-DAILY   raises aged_manual_review for the OPEN review only — never for the closed one
//   RAE-PRUNE   its prune dismisses the closed (cancelled) order's alerts, and keeps the open one's
// Run: npm run test:review-attest
require('./_emulator-required')('database');
const assert = require('assert');
process.env.PIXELPAY_MODE = 'sandbox';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const app = require('../index.js');
const { getDatabase } = require('firebase-admin/database');
const { cancelOrderCore } = require('../cancel-order-core');
const { attestManualReview, onPaymentStatus } = require('../payments/review-attest');
const { paymentAlert } = require('../lib/payment-alert');
const db = getDatabase();
let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('review-attest(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const H = 3600000;
(async () => {
  const url = db.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: ${url}`);
  await db.ref().remove();
  const now = Date.now();
  const park = async (oid, aid, claimId) => {
    await db.ref(`orders/${oid}`).set({ order_id: oid, order_type: 'pickup', status: 'cancelled', payment_status: 'confirmed', payment_method: 'online', total: 299, total_cents: 29900,
      customer_name: 'T', items_text: 'x', restaurant_id: 'x_pizza', active_attempt_id: aid, created_at: now - 7 * H });
    await db.ref(`payment_attempts/${aid}`).set({ order_id: oid, hosted_state: 'paid', hosted_callback_verified: true });
    await cancelOrderCore({ db, voidOrRefund: async () => { throw new Error('must not void'); }, alert: (k, d) => paymentAlert(db, k, d), serverTimestamp: 0 }, { orderId: oid, actor: 'disp@tb', reason: 'customer', now, claimId });
    assert.strictEqual((await db.ref(`orders/${oid}/payment_status`).once('value')).val(), 'manual_review', `premise: ${oid} parked by the real cancel`);
    await onPaymentStatus(db, { orderId: oid, before: 'confirmed', after: 'manual_review', eventTime: now });   // the episode trigger's body (the database emulator runs no functions)
  };
  await park('RAE1', 'c0ffee00c0ffee11', 'CLA1');   // will be CLOSED
  await park('RAE2', 'c0ffee00c0ffee22', 'CLA2');   // stays OPEN (control)
  const r = await attestManualReview(db, { orderId: 'RAE1', episode: now, outcome: 'refunded_in_pixelpay', amountCents: 29900, note: 'anulado', actor: 'disp@tb', now });
  assert.strictEqual(r.status, 200, `premise: the real attestation closed RAE1 (${JSON.stringify(r.body)})`);
  await app.reconcilePayments.run({});
  const all = Object.values((await db.ref('dispatcher_alerts').once('value')).val() || {});
  const breachKinds = (oid) => all.filter((a) => a && a.type === 'payment_reconcile_breaches').flatMap((a) => ((a.detail && a.detail.breaches) || []).filter((b) => b && b.orderId === oid).map((b) => b.kind));
  assert.ok(breachKinds('RAE2').includes('aged_manual_review'), 'RAE-DAILY premise: the OPEN review is still re-raised');
  assert.ok(!breachKinds('RAE1').includes('aged_manual_review'), '🔴 RAE-DAILY: the CLOSED review is never re-raised');
  ok('RAE-DAILY: the real reconcilePayments re-raises the open review only, never the closed one');
  const cancelAlerts = (oid) => all.filter((a) => a && a.type === 'payment_cancel_manual_review' && a.detail && a.detail.orderId === oid).length;
  assert.strictEqual(cancelAlerts('RAE1'), 0, '🔴 RAE-PRUNE: the closed (cancelled) order\'s cancel alert is pruned');
  assert.strictEqual(cancelAlerts('RAE2'), 1, 'RAE-PRUNE: the open review\'s cancel alert is kept');
  ok('RAE-PRUNE: the real prune dismisses the closed order\'s alert and keeps the open one\'s');
  FINISHED = true;
  console.log(`review-attest(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
