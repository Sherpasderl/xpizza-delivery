'use strict';
/**
 * OWNER/ADVISOR-RUN emulator test — paid-after-close REFUND-notification reliability (COMPOSITION).
 *
 *   firebase emulators:exec --only database --project demo-xpizza \
 *     "node test/paid-after-close-notify.emulator.test.js"
 * (Owner-run: needs Java + the Firebase RTDB emulator, like the repo's other *.emulator.test.js files.
 *  Everything ELSE — the pure decision core + isSendConfirmed — runs here via paid-after-close-notify.test.js
 *  and whatsapp-config.test.js in the standard `npm test` chain.)
 *
 * The pure predicates (paid-after-close-notify.js) and isSendConfirmed (whatsapp.js) are unit-tested elsewhere.
 * This proves the COMPOSITION against the real RTDB emulator with a MOCKED provider: the REAL sender
 * (app.sendPaidAfterCloseRefund, the finalize-path call) + the REAL sweep (app.refundReconciler.run) together
 * honor AT-LEAST-ONCE with a TRUTHFUL sent-marker. Money is untouched (materialize-guard is not exercised here;
 * we seed the post-finalize terminal state a crash-before-send leaves behind).
 *
 * Covers (each assertion names what makes it red):
 *   1. finalize → crash-before-send → sweep recovers, sends EXACTLY once; a later sweep does NOT re-send (dedupe).
 *   2. UNCONFIRMED provider body ({}) → sent_at UNSET + unresolved marker; the NEXT sweep RE-DRIVES (the blocking
 *      defect: a truthy-but-unconfirmed {} must never stamp sent_at). Then a confirmed send closes it, dedupe holds.
 *   3. null / thrown send → sent_at UNSET, sweep re-drives; a confirmed send then closes it.
 *   4. sent-marker WRITE failure → send happened but sent_at didn't land → next sweep re-drives (at-least-once
 *      self-heal); once the write succeeds, sent_at lands and dedupe holds.
 *   5. no customer_phone → un-sendable marker recorded, NO send; the sweep never selects it (no churn).
 *   6. whatsapp disabled (global kill switch) → no send, sent_at unset; re-enable → the sweep delivers (self-heal).
 */
const assert = require('assert');
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'test-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

// 🔴 FAIL-CLOSED emulator-host guard — this harness clears the database ROOT (reset() → db.ref('/').set(null)).
// It MUST run under `firebase emulators:exec --only database` (which sets FIREBASE_DATABASE_EMULATOR_HOST so
// firebase-admin routes to the emulator). Run directly with prod creds it would WIPE PRODUCTION, so REFUSE here —
// BEFORE requiring ../index.js (whose admin.initializeApp binds the configured, possibly-PRODUCTION, DB URL).
if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  console.error('\n🔴 REFUSED — FIREBASE_DATABASE_EMULATOR_HOST is not set.\n' +
    'This is a DESTRUCTIVE harness (it clears the database root). Run it only via:\n' +
    '  npm run test:paid-after-close-notify\n' +
    '  (firebase emulators:exec --only database --project demo-xpizza "node test/paid-after-close-notify.emulator.test.js")\n');
  process.exit(1);
}

const app = require('../index.js');       // initializes admin against the emulator + registers triggers/exports
const whatsapp = require('../whatsapp');  // SAME module instance the sender uses → the spy takes effect
const { getDatabase } = require('firebase-admin/database');
const db = getDatabase();

// ---- sendMessage spy: record calls, force the provider outcome ----
//   'ok'          → a genuine UltraMsg accept  (isSendConfirmed → true)  → sender stamps sent_at
//   'unconfirmed' → HTTP-200 with unreadable body {} (isSendConfirmed → false) → the BLOCKING-defect case
//   'null'        → provider error / bad phone (sendMessage returns null)
//   'throw'       → provider threw
let sends = [];
let sendMode = 'ok';
whatsapp.sendMessage = async (phone, body, restaurantId) => {
  sends.push({ phone, body, restaurantId });
  if (sendMode === 'throw') throw new Error('injected provider failure');
  if (sendMode === 'null') return null;
  if (sendMode === 'unconfirmed') return {};                 // truthy but NOT accepted
  return { sent: 'true', message: 'ok', id: 'MSG-' + sends.length };
};
function resetSpy(mode = 'ok') { sends = []; sendMode = mode; }

const FIVE_MIN = 5 * 60 * 1000;
// The post-finalize terminal state a crash-before-send leaves: refunded + paid-after-close, refunded long enough
// ago to be stale (age > the sweep's 2-min gate), sendable (has a phone), and NOT yet confirmed-sent.
const finalized = (o = {}) => ({
  payment_status: 'refunded', status: 'cancelled', blocked_reason: 'refunded_paid_after_close',
  restaurant_id: 'x_pizza', customer_phone: '99990000', customer_name: 'Ana', total: 500,
  refunded_at: Date.now() - FIVE_MIN, ...o,
});
const seed = (id, o) => db.ref(`orders/${id}`).set(finalized(o));
const field = async (id, f) => (await db.ref(`orders/${id}/${f}`).once('value')).val();
const sweep = () => app.refundReconciler.run({});
async function reset() {
  await db.ref('/').set(null);
  await db.ref('config/whatsapp_enabled').set(true);
}

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  // ── 1. crash-before-send → sweep recovers EXACTLY once; a later sweep does NOT re-send (dedupe) ──
  await reset(); resetSpy('ok');
  {
    await seed('A', {});
    assert.strictEqual(await field('A', 'paid_after_close_refund_sent_at'), null, 'precondition: no sent_at (crash before send)');
    await sweep();
    assert.strictEqual(sends.length, 1, 'sweep recovered the un-notified refund → exactly ONE send (red if the notify branch is dropped)');
    assert.strictEqual(sends[0].phone, '99990000');
    assert.ok(sends[0].body.includes('reembolsamos'), 'the refund message body was sent (red if wrong template/routing)');
    assert.ok(await field('A', 'paid_after_close_refund_sent_at'), 'sent_at stamped after a CONFIRMED send (red if a confirmed send does not persist the marker)');
    await sweep();
    assert.strictEqual(sends.length, 1, 'a later sweep does NOT re-send once sent_at is set (red if dedupe fails → duplicate)');
    ok('1. crash-before-send → sweep recovers exactly once; later sweep no-ops (dedupe)');
  }

  // ── 2. UNCONFIRMED {} → sent_at UNSET + unresolved marker; NEXT sweep re-drives; a confirmed send then closes it ──
  await reset(); resetSpy('unconfirmed');
  {
    await seed('B', {});
    await sweep();
    assert.strictEqual(sends.length, 1, 'send attempted');
    assert.strictEqual(await field('B', 'paid_after_close_refund_sent_at'), null,
      'THE BLOCKING DEFECT: a truthy-but-unconfirmed {} must NOT stamp sent_at (red if the caller gates on res!=null instead of isSendConfirmed)');
    assert.ok(await field('B', 'paid_after_close_refund_send_unresolved_at'), 'unresolved marker recorded (durable, visible)');
    await sweep();
    assert.strictEqual(sends.length, 2, 'still unconfirmed → the NEXT sweep RE-DRIVES (at-least-once; red if the unconfirmed send were treated as done)');
    resetSpy('ok');
    await sweep();
    assert.strictEqual(sends.length, 1, 'now confirmed → one more send, then...');
    assert.ok(await field('B', 'paid_after_close_refund_sent_at'), 'sent_at lands on the confirmed send');
    await sweep();
    assert.strictEqual(sends.length, 1, 'dedupe holds after the confirmed send (no further re-drive)');
    ok('2. unconfirmed {} → sent_at unset + re-drive; confirmed send closes it, dedupe holds');
  }

  // ── 3. null / thrown send → sent_at UNSET, sweep re-drives; a confirmed send then closes it ──
  for (const mode of ['null', 'throw']) {
    await reset(); resetSpy(mode);
    await seed('C', {});
    await sweep();
    assert.strictEqual(sends.length, 1, `${mode}: send attempted`);
    assert.strictEqual(await field('C', 'paid_after_close_refund_sent_at'), null, `${mode}: no sent_at on a failed send (red if a failure stamps sent_at)`);
    assert.ok(await field('C', 'paid_after_close_refund_send_unresolved_at'), `${mode}: unresolved marker recorded`);
    resetSpy('ok');
    await sweep();
    assert.ok(await field('C', 'paid_after_close_refund_sent_at'), `${mode}: a later confirmed send delivers + stamps sent_at (self-heal)`);
  }
  ok('3. null / thrown send → sent_at unset + unresolved marker; later confirmed send self-heals');

  // ── 4. sent-marker WRITE failure → next sweep re-drives (at-least-once self-heal), then dedupe once it lands ──
  await reset(); resetSpy('ok');
  {
    await seed('D', {});
    const RefProto = Object.getPrototypeOf(db.ref('x'));
    const origSet = RefProto.set;
    RefProto.set = function (...a) {
      if (this.key === 'paid_after_close_refund_sent_at') return Promise.reject(new Error('injected: sent_at write failed'));
      return origSet.apply(this, a);
    };
    try {
      await sweep();
      assert.strictEqual(sends.length, 1, 'confirmed send happened');
      assert.strictEqual(await field('D', 'paid_after_close_refund_sent_at'), null, 'sent_at did NOT land (write injected-failed)');
      await sweep();
      assert.strictEqual(sends.length, 2, 'marker never landed → next sweep RE-DRIVES (at-least-once; a rare duplicate is accepted, both messages true)');
    } finally {
      RefProto.set = origSet;   // restore before asserting the heal
    }
    await sweep();
    assert.ok(await field('D', 'paid_after_close_refund_sent_at'), 'once the marker write succeeds, sent_at lands');
    const n = sends.length;
    await sweep();
    assert.strictEqual(sends.length, n, 'dedupe holds after the marker finally lands (no further re-drive)');
    ok('4. sent-marker write failure → sweep re-drives (self-heal); dedupe holds once the marker lands');
  }

  // ── 5. no customer_phone → sender records the un-sendable marker; the SELECTOR skips it before sender entry ──
  await reset(); resetSpy('ok');
  {
    // 5a. Direct finalize-path call on a phone-less order → records the un-sendable marker, sends nothing.
    const order = finalized({ customer_phone: null });
    await db.ref('orders/E').set(order);
    await app.sendPaidAfterCloseRefund(db, { orderId: 'E', order });
    assert.strictEqual(sends.length, 0, 'no phone → no send (red if a phone-less order is sent to the provider)');
    assert.ok(await field('E', 'paid_after_close_refund_unsendable_at'), 'sender recorded the un-sendable marker (ops-visible)');
    assert.strictEqual(await field('E', 'paid_after_close_refund_unsendable_reason'), 'no_customer_phone', 'reason recorded');

    // 5b. NON-VACUOUS selector proof. A FRESH phone-less order the sender was NEVER called on, with NO marker yet.
    // Entering the sender is the ONLY thing that stamps paid_after_close_refund_unsendable_at — and the sweep only
    // enters the sender for orders the SELECTOR (needsRefundNotifyRecovery) picks. So "no marker after the sweep"
    // observes a property ONLY the selector controls: it flips RED if the selector loses its `!order.customer_phone`
    // guard (the sweep would then enter the sender for G and stamp the marker). A call-count check alone would NOT —
    // the sender independently rejects phone-less orders, so it would pass even with the selector guard removed.
    resetSpy('ok');
    await db.ref('orders/G').set(finalized({ customer_phone: null }));
    assert.strictEqual(await field('G', 'paid_after_close_refund_unsendable_at'), null, 'precondition: G has no un-sendable marker (sender was never called on it)');
    await sweep();
    assert.strictEqual(sends.length, 0, 'phone-less order → the sweep sends nothing');
    assert.strictEqual(await field('G', 'paid_after_close_refund_unsendable_at'), null,
      'the sweep did NOT ENTER the sender for G → no un-sendable marker written → the SELECTOR filtered it (RED if needsRefundNotifyRecovery drops its phone guard)');
    assert.strictEqual(await field('G', 'paid_after_close_refund_sent_at'), null, 'G still never marked sent (can never be)');
    ok('5. no customer_phone → sender marks un-sendable; the SELECTOR skips it before sender entry (non-vacuous, no churn)');
  }

  // ── 6. whatsapp disabled → no send; re-enable → the sweep delivers (self-heal, no permanent skip) ──
  await reset(); resetSpy('ok');
  {
    await db.ref('config/whatsapp_enabled').set(false);
    await seed('F', {});
    await sweep();
    assert.strictEqual(sends.length, 0, 'disabled → no send');
    assert.strictEqual(await field('F', 'paid_after_close_refund_sent_at'), null, 'disabled → sent_at unset (nothing was delivered)');
    await db.ref('config/whatsapp_enabled').set(true);
    await sweep();
    assert.strictEqual(sends.length, 1, 're-enabled → the sweep delivers (disabled is a TEMPORARY skip, not a permanent one; red if a disabled pass poisoned recovery)');
    assert.ok(await field('F', 'paid_after_close_refund_sent_at'), 're-enabled → sent_at lands');
    ok('6. whatsapp disabled → no send; re-enable → sweep delivers (self-heal)');
  }

  console.log(`\nAll ${pass} paid-after-close-notify composition assertions passed.`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
