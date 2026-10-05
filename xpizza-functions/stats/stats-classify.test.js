'use strict';
// Merchant STATS — classification (PLAN-stats rev 4 §S1.1 + advisor rulings Q-A/Q-B/Q-C/C1, 2026-10-05).
// Run: node stats/stats-classify.test.js
const assert = require('assert');
const { CLASS, ROWS, isSale, isFulfilled, classifyOrder, decidingRow } = require('./stats-classify');
const { facturaSaleEligible } = require('../factura/eligibility');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ABSENT = undefined;

/* ── 1. THE REACHABLE-COMBINATION CENSUS ─────────────────────────────────────────────────────────────
   Every (payment_method, status, payment_status|ABSENT) an order can be observed in at rest, sourced
   from the writers (file:line, enumerated 2026-10-05 at ba29282). Each entry states its EXPECTED class
   independently of the implementation; the table must agree, and every row must be exercised. A
   combination NOT listed here that classifyOrder sends to the fall-through is, by construction, one a
   reviewer must add — see cell 2. */
const NON_ONLINE = ['cash', 'card_delivery', '', 'card'];   // '' = index.js:524-525; 'card' = pre-9633689 legacy (Q-A)
const LIVE = ['new', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'completed'];
const C = [];
const add = (pm, st, ps, cls, src) => C.push({ pm, st, ps, cls, src });

for (const pm of NON_ONLINE) {
  for (const st of LIVE) add(pm, st, ABSENT, CLASS.SALE, 'create-order-build.js:43 → KDS card-model.js:56-57 / driver xpizza-delivery.js:561,1005 / KDS index.html:2173');
  add(pm, 'scheduled', ABSENT, CLASS.SALE, 'create-order-build.js:146 (cash scheduled = Sale from creation)');
  add(pm, 'releasing', ABSENT, CLASS.SALE, 'scheduled-release-core.js:29');
  add(pm, 'cancelled', ABSENT, CLASS.CANCELLED, 'cancel-order-core.js:48 (payment_status null for non-online, cancel-order.js:123)');
}
add('online', 'pending_payment', 'pending', CLASS.EXCLUDED, 'index.js:1582-1584');
add('online', 'pending_payment', 'confirmed', CLASS.EXCLUDED, 'pixelpay-confirm.js:244 transient window');
add('online', 'pending_payment', 'failed', CLASS.EXCLUDED, 'pixelpay-confirm.js:87/142/169/176 (C1)');
add('online', 'pending_payment', 'manual_reconciliation', CLASS.UNRESOLVED, 'pixelpay-confirm.js:97,369; materialize-guard.js:84…');
for (const a of ['materialize', 'refund', 'abandon', 'close_fulfilled']) add('online', 'pending_payment', `resolving_${a}`, CLASS.UNRESOLVED, 'manual-resolve.js:49');
add('online', 'pending_payment', 'refunding_paid_after_close', CLASS.REFUND_PENDING, 'materialize-guard.js:149 (Q-C)');
add('online', 'pending_payment', 'refund_pending', CLASS.REFUND_PENDING, 'pixelpay-confirm.js:191; materialize-guard.js:195; index.js:3137');
add('online', 'pending_payment', 'manual_review', CLASS.UNRESOLVED, 'pixelpay-confirm.js:272');
for (const st of LIVE) add('online', st, 'confirmed', CLASS.SALE, 'materialize.js:37-41 → KDS/driver');
add('online', 'completed', 'confirmed', CLASS.SALE, 'resolve-manual.js:221-222 close_fulfilled');
add('online', 'scheduled', 'confirmed', CLASS.SALE, 'pixelpay-confirm.js:292; resolve-manual.js:53 (Sale from capture)');
add('online', 'releasing', 'confirmed', CLASS.SALE, 'scheduled-release-core.js:29');
add('online', 'cancelled', 'refunded', CLASS.REFUNDED, 'resolve-manual.js:271; materialize-guard.js:178; index.js:3132');
add('online', 'cancelled', 'refund_pending', CLASS.REFUND_PENDING, 'pixelpay-confirm.js:216; webhook.js:142; cancel-order-core.js:50');
add('online', 'cancelled', 'abandoned', CLASS.EXCLUDED, 'resolve-manual.js:146');
add('online', 'cancelled', 'manual_review', CLASS.UNRESOLVED, 'resolve-manual.js:262,296');
add('online', 'cancelled', 'pending', CLASS.EXCLUDED, 'cancel-order-core.js:48 dispatcher cancel of unpaid (Q-B)');
add('online', 'cancelled', 'failed', CLASS.EXCLUDED, 'cancel-order-core.js:48 after declined capture (Q-B)');
for (const st of LIVE) add('online', st, 'manual_review', CLASS.UNRESOLVED, 'cancel-order-core.js:209 (status unchanged)');
for (const st of LIVE) add('online', st, 'manual_reconciliation', CLASS.UNRESOLVED, 'pixelpay-hosted-webhook.js:71 (no status guard)');

{
  const usedRows = new Set();
  for (const c of C) {
    const o = { payment_method: c.pm, status: c.st, ...(c.ps === ABSENT ? {} : { payment_status: c.ps }) };
    const got = classifyOrder(o);
    assert.strictEqual(got, c.cls, `${JSON.stringify(o)} → ${got}, expected ${c.cls} (${c.src})`);
    const row = decidingRow(o);
    assert.notStrictEqual(row, 'fallthrough', `${JSON.stringify(o)} reached the fall-through — an UNCOVERED reachable combination (${c.src})`);
    usedRows.add(row);
  }
  ok(`${C.length} reachable combinations classified as expected; none reaches the fall-through`);
  for (const [label] of ROWS) assert(usedRows.has(label), `row "${label}" is exercised by no reachable combination`);
  ok(`every decision-table row (${ROWS.length}) is exercised by a reachable combination`);
}

// 2. The fall-through is real and safe: an unknown combination is UNRESOLVED, never a Sale.
{
  for (const o of [
    { payment_method: 'online', status: 'new', payment_status: 'something_new' },
    { payment_method: 'online', status: 'weird_status', payment_status: 'confirmed' },
    { payment_method: 'cash', status: 'weird_status' },
    { payment_method: 'cash', status: 'new', payment_status: 'confirmed' },   // non-online never carries one
    { payment_method: 'online', status: 'new' },                              // online with ABSENT payment_status
    null, 'x',
  ]) {
    assert.strictEqual(classifyOrder(o), CLASS.UNRESOLVED, JSON.stringify(o));
  }
  ok('unknown / malformed combinations → UNRESOLVED (fall-through), never SALE');
}

// 3. Row PRECEDENCE: a combination matching several rows takes the first.
{
  assert.strictEqual(classifyOrder({ payment_method: 'online', status: 'cancelled', payment_status: 'refunded' }), CLASS.REFUNDED);   // 1 over 5
  assert.strictEqual(decidingRow({ payment_method: 'online', status: 'cancelled', payment_status: 'refund_pending' }), '2 refund pending');   // 2 over 5
  assert.strictEqual(decidingRow({ payment_method: 'online', status: 'cancelled', payment_status: 'manual_review' }), '3 manual/resolving/review');   // 3 over 5
  assert.strictEqual(decidingRow({ payment_method: 'online', status: 'new', payment_status: 'manual_review' }), '3 manual/resolving/review');   // 3 over 6
  assert.strictEqual(decidingRow({ payment_method: 'online', status: 'cancelled', payment_status: 'abandoned' }), '4 abandoned / never paid pending_payment');
  assert.strictEqual(decidingRow({ payment_method: 'online', status: 'cancelled', payment_status: 'pending' }), '4b cancelled never-paid online');   // 4b BEFORE 5
  assert.strictEqual(decidingRow({ payment_method: 'cash', status: 'cancelled' }), '5 cancelled');
  ok('row precedence: refunded > refund_pending > unresolved > abandoned/never-paid > never-paid-cancel > cancelled > sale');
}

/* ── 4. isSale AGREES WITH facturaSaleEligible AT ENTRY ONLY ─────────────────────────────────────────
   Orders from the REAL writers (stats-fixtures.js → create-order-build / materialize), not hand-built. */
const F = require('./stats-fixtures');
const CUTOFF = 0;
const T0 = 1760000000000;
{
  for (const pm of ['cash', 'card_delivery', '']) {
    const o = F.cashOrder({ rid: 'r_test', pm, now: T0, phone: '88887777', totalCents: 29900 });
    assert.strictEqual(o.status, 'new'); assert.strictEqual(o.payment_status, undefined);
    assert.strictEqual(isSale(o), facturaSaleEligible(o, CUTOFF), `entry agreement for ${JSON.stringify(pm)}`);
    assert.strictEqual(isSale(o), true);
  }
  const pending = F.onlinePending({ rid: 'r_test', now: T0, phone: '88887777', totalCents: 29900 });
  assert.strictEqual(isSale(pending), false); assert.strictEqual(facturaSaleEligible(pending, CUTOFF), false);
  const captured = { ...pending, payment_status: 'confirmed', charged_at: T0 + 1 };   // pixelpay-confirm.js:244 CAS
  assert.strictEqual(isSale(captured), false, 'still pending_payment → not yet a Sale');
  const mat = F.materialize(captured, T0 + 2);
  assert.strictEqual(mat.status, 'new'); assert.strictEqual(mat.payment_status, 'confirmed');
  assert.strictEqual(isSale(mat), facturaSaleEligible(mat, CUTOFF), 'online entry agreement');
  assert.strictEqual(isSale(mat), true);
  ok("isSale == facturaSaleEligible at ENTRY for cash, card_delivery, '' and online (orders from the REAL writers)");
}

// 5. PERSISTENCE: a Sale STAYS a Sale through the lifecycle, where facturaSaleEligible (entry-only) says no.
{
  for (const pm of ['cash', 'card_delivery', 'online']) {
    const base = pm === 'online' ? { payment_method: pm, payment_status: 'confirmed' } : { payment_method: pm };
    for (const st of ['preparing', 'ready', 'out_for_delivery', 'delivered', 'completed']) {
      const o = { ...base, status: st, factura_status: 'issued', created_at: 1 };
      assert.strictEqual(isSale(o), true, `${pm}/${st}`);
      assert.strictEqual(facturaSaleEligible(o, CUTOFF), false, 'the oracle is entry-only — which is why it cannot judge history');
      assert.strictEqual(classifyOrder(o), CLASS.SALE);
    }
  }
  ok('Sale persists through preparing / ready / out_for_delivery / delivered / completed (oracle is entry-only)');
}

// 6. REMOVAL: cancellation or refund removes it.
{
  assert.strictEqual(isSale({ payment_method: 'cash', status: 'cancelled' }), false);
  assert.strictEqual(isSale({ payment_method: 'online', status: 'cancelled', payment_status: 'refunded' }), false);
  assert.strictEqual(isSale({ payment_method: 'online', status: 'cancelled', payment_status: 'refund_pending' }), false);
  assert.strictEqual(classifyOrder({ payment_method: 'online', status: 'preparing', payment_status: 'refunded' }), CLASS.REFUNDED);
  ok('cancellation or refund removes the Sale');
}

// 7. close_fulfilled (resolve-manual.js:194, :221): confirmed + completed is a Sale, and fulfilled.
{
  const o = { payment_method: 'online', status: 'completed', payment_status: 'confirmed' };
  assert.strictEqual(classifyOrder(o), CLASS.SALE); assert.strictEqual(isFulfilled(o), true);
  ok('close_fulfilled (confirmed + completed) → SALE and fulfilled');
}

// 8. Scheduled: cash from CREATION (real writer), online from CAPTURE (incl. the confirmed hold).
{
  const sched = F.scheduledCashOrder({ rid: 'r_test', pm: 'cash', now: T0, phone: '88887777', scheduledFor: T0 + 6 * 86400000 });
  assert.strictEqual(sched.status, 'scheduled');
  assert.strictEqual(classifyOrder(sched), CLASS.SALE);
  assert.strictEqual(classifyOrder({ payment_method: 'online', status: 'scheduled', payment_status: 'pending' }), CLASS.UNRESOLVED, 'an unpaid online hold is not reachable at rest; if seen it is not a Sale');
  assert.strictEqual(classifyOrder({ payment_method: 'online', status: 'scheduled', payment_status: 'confirmed' }), CLASS.SALE);
  assert.strictEqual(classifyOrder({ payment_method: 'online', status: 'releasing', payment_status: 'confirmed' }), CLASS.SALE);
  ok('scheduled: cash Sale from creation (real writer); online Sale from capture incl. scheduled/releasing hold');
}

// 9. Fulfillment is orthogonal to the sales rule.
{
  assert.strictEqual(isFulfilled({ status: 'delivered' }), true);
  assert.strictEqual(isFulfilled({ status: 'new' }), false);
  assert.strictEqual(classifyOrder({ payment_method: 'cash', status: 'new' }), CLASS.SALE, 'unfulfilled can still be a Sale');
  ok('fulfillment (delivered/completed) reported separately, not the sales rule');
}

console.log(`\nstats-classify: ${n} cells passed`);
