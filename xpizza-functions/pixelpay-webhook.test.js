/**
 * Unit tests for the webhook-extraction + sweep-classification helpers (sub-stage 3).
 * Run: `node pixelpay-webhook.test.js`.
 */
const assert = require('assert');
const { extractWebhookNudge, classifySweepCandidate } = require('./pixelpay-webhook');

const ORDER = 'PZX-260610-120000-ABCD1234';
const ATTEMPT = 'a1b2c3d4e5f60718'; // 16 hex
const PXO = `${ORDER}-${ATTEMPT}`;

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// ---- extractWebhookNudge ----
{
  // top-level fields
  let n = extractWebhookNudge({ order_id: PXO, payment_uuid: 'S-uuid', id: 'evt1' });
  assert.strictEqual(n.pixelpayOrderId, PXO);
  assert.strictEqual(n.orderId, ORDER, 'strips the 16-hex attempt suffix');
  assert.strictEqual(n.paymentUuid, 'S-uuid');
  assert.strictEqual(n.eventId, 'evt1');
  ok('extract: top-level order_id/payment_uuid/id');

  // nested under data / order
  n = extractWebhookNudge({ data: { order: { id: PXO }, payment_uuid: 'S-2' } });
  assert.strictEqual(n.pixelpayOrderId, PXO);
  assert.strictEqual(n.orderId, ORDER);
  assert.strictEqual(n.paymentUuid, 'S-2');
  assert.strictEqual(n.eventId, PXO, 'event id falls back to the order id when no transaction_id/uuid/id');
  ok('extract: nested data.order.id + data.payment_uuid');

  // bare order id (no attempt suffix) passes through
  n = extractWebhookNudge({ order_id: ORDER });
  assert.strictEqual(n.orderId, ORDER);
  ok('extract: bare order id (no suffix) passes through');

  // PixelPay's REAL order_callback shape (captured live): order id in `ref`, payment in `uuid`
  // (P-scope), event id from transaction_id.
  n = extractWebhookNudge({ ref: PXO, uuid: 'P-a1fd', status: 'paid', payment_hash: 'h', transaction_id: 'TX-7' });
  assert.strictEqual(n.pixelpayOrderId, PXO, 'reads order id from `ref`');
  assert.strictEqual(n.orderId, ORDER, 'strips attempt suffix off ref');
  assert.strictEqual(n.paymentUuid, 'P-a1fd', 'reads payment uuid');
  assert.strictEqual(n.eventId, 'TX-7', 'event id from transaction_id (unique per event, not ref)');
  ok('extract: REAL order_callback shape (ref + uuid + transaction_id)');

  // Subscription webhook fallback: order id in `order`.
  n = extractWebhookNudge({ uuid: 'P-x', order: PXO, status: 'paid' });
  assert.strictEqual(n.orderId, ORDER, 'still reads `order` (subscription webhook)');
  ok('extract: subscription webhook shape (order) still works');

  // garbage → all null
  n = extractWebhookNudge(null);
  assert.strictEqual(n.orderId, null);
  assert.strictEqual(n.paymentUuid, null);
  ok('extract: null/garbage → nulls (no throw)');
}

// ---- classifySweepCandidate ----
{
  const NOW = 10_000_000;
  const mk = (over, extra = {}) => ({ status: 'pending_payment', payment_status: 'pending', created_at: NOW - over, ...extra });

  // has uuid + past confirm TTL → confirm
  assert.strictEqual(classifySweepCandidate(mk(200000), { payment_uuid: 'S', status: 'active' }, NOW), 'confirm');
  ok('sweep: uuid + past confirm TTL → confirm');

  // stuck capturing claim past TTL → confirm (recover)
  assert.strictEqual(classifySweepCandidate(mk(200000), { status: 'capturing' }, NOW), 'confirm');
  ok('sweep: stuck capturing past TTL → confirm');

  // no uuid, very old → abandon
  assert.strictEqual(classifySweepCandidate(mk(2_000_000), { status: 'active' }, NOW), 'abandon');
  ok('sweep: no uuid + past abandon TTL → abandon (auth expired)');

  // recent → leave
  assert.strictEqual(classifySweepCandidate(mk(1000), { payment_uuid: 'S', status: 'active' }, NOW), 'leave');
  ok('sweep: recent → leave');

  // no uuid but not yet abandon-old → leave
  assert.strictEqual(classifySweepCandidate(mk(200000), { status: 'active' }, NOW), 'leave');
  ok('sweep: no uuid, before abandon TTL → leave');

  // terminal/other states → skip
  for (const ps of ['confirmed', 'manual_reconciliation', 'failed', 'refund_pending']) {
    assert.strictEqual(classifySweepCandidate(mk(9_000_000, { payment_status: ps }), { payment_uuid: 'S' }, NOW), 'skip');
  }
  assert.strictEqual(classifySweepCandidate({ status: 'new', created_at: 0 }, null, NOW), 'skip');
  ok('sweep: confirmed/manual/failed/refund_pending/non-pending → skip');
}

console.log(`\nAll ${pass} webhook/sweep helper tests passed.`);
