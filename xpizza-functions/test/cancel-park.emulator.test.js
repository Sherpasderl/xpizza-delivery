'use strict';
// PLAN-5f-cancel-park r1 option A — on the RTDB emulator, the REAL writers: a refused money cancel (captured money, no payment id) PARKS
// the order (payment_status 'manual_review' + blocked_reason + cancel_parked_at); after 6 h the REAL
// reconcilePayments raises it daily as aged_manual_review in its reconcile_breaches alert; a retried cancel meets the gate.
//   CPE-PARK    the real cancelOrderCore parks the refused order
//   CPE-DAILY   the real reconcilePayments re-raises it (aged_manual_review) once it is older than 6 h
// Run: npm run test:cancel-park
require('./_emulator-required')('database');
const assert = require('assert');
process.env.PIXELPAY_MODE = 'sandbox';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const app = require('../index.js');
const { getDatabase } = require('firebase-admin/database');
const { cancelOrderCore } = require('../cancel-order-core');
const { paymentAlert } = require('../lib/payment-alert');
const db = getDatabase();
let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('cancel-park(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const H = 3600000;
(async () => {
  const url = db.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: ${url}`);
  await db.ref().remove();
  const now = Date.now(); const OID = 'CPE1'; const AID = 'c0ffee00c0ffee88';
  await db.ref(`orders/${OID}`).set({ order_id: OID, order_type: 'pickup', status: 'new', payment_status: 'confirmed', payment_method: 'online', total: 299, total_cents: 29900,
    customer_name: 'T', items_text: 'x', restaurant_id: 'x_pizza', active_attempt_id: AID, created_at: now - 7 * H });
  await db.ref(`payment_attempts/${AID}`).set({ order_id: OID, hosted_state: 'paid', hosted_callback_verified: true });   // captured, no payment id
  const r = await cancelOrderCore({ db, voidOrRefund: async () => { throw new Error('must not void'); }, alert: (k, d) => paymentAlert(db, k, d), serverTimestamp: 0 },
    { orderId: OID, actor: 'disp@tb', reason: 'customer', now, claimId: 'CLE1' });
  assert.deepStrictEqual([r.status, r.body.outcome], [409, 'manual_review'], 'premise: the real cancel refuses');
  const o = (await db.ref(`orders/${OID}`).once('value')).val();
  assert.deepStrictEqual([o.payment_status, o.blocked_reason, o.cancel_parked_at, o.cancel_claim_id || null], ['manual_review', 'cancel_captured_no_uuid', now, null], '🔴 CPE-PARK: the refused order is parked');
  ok('CPE-PARK: the REAL cancelOrderCore parks a refused captured-no-uuid order (manual_review), the claim released');
  await app.reconcilePayments.run({});
  const breaches = Object.values((await db.ref('dispatcher_alerts').once('value')).val() || {}).filter((a) => a && a.type === 'payment_reconcile_breaches');
  const kinds = breaches.flatMap((a) => ((a.detail && a.detail.breaches) || []).filter((b) => b && b.orderId === OID).map((b) => b.kind));
  assert.ok(kinds.includes('aged_manual_review'), `🔴 CPE-DAILY: the real reconcilePayments raises aged_manual_review for the parked order (${JSON.stringify(kinds)})`);
  ok('CPE-DAILY: the REAL reconcilePayments re-raises the parked order (aged_manual_review)');
  FINISHED = true;
  console.log(`cancel-park(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
