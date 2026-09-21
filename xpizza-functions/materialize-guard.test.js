'use strict';

/**
 * Paid-after-close materialize guard — grace window + idempotent auto-refund + fail-safe fallback.
 * Deps-injected (no Firebase). Money-critical: a past-close order is auto-refunded EXACTLY once
 * (CAS claim), a refund failure falls back to manual_review + alert (never strands), and a re-entry
 * on an already-resolved order is a no-op. Run: node materialize-guard.test.js
 */
const assert = require('assert');
const { holdIfClosedAtMaterialize, recoverRefundingDecision } = require('./materialize-guard');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// Tuesday 2026-01-06, hours 17:00–20:45 (UTC−6). Reuse the file's real hours shape.
const L = (h, m) => Date.UTC(2026, 0, 6, h + 6, m);
const HOURS = { sun: { open: false }, mon: { open: false },
  tue: { open: true, start: '17:00', end: '20:45' }, wed: { open: true, start: '17:00', end: '20:45' },
  thu: { open: true, start: '17:00', end: '20:45' }, fri: { open: true, start: '17:00', end: '20:45' },
  sat: { open: true, start: '17:00', end: '20:45' } };
const OPEN = L(19, 0), GRACE = L(20, 50), PAST = L(21, 0);   // open / within-15m-grace / past-grace

// Minimal nested-tree RTDB mock (mirrors confirm-active-recheck.test.js) + push().
function makeDb(initial = {}) {
  const root = JSON.parse(JSON.stringify(initial));
  let pushSeq = 0;
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const getAt = (p) => { if (!p) return root; let nn = root; for (const k of p.split('/')) { if (nn == null) return null; nn = nn[k]; } return nn === undefined ? null : nn; };
  const setAt = (p, val) => { const parts = p.split('/'); let nn = root; for (let i = 0; i < parts.length - 1; i++) { const k = parts[i]; if (nn[k] == null || typeof nn[k] !== 'object') nn[k] = {}; nn = nn[k]; } const last = parts[parts.length - 1]; if (val === null) delete nn[last]; else nn[last] = val; };
  const ref = (p = '') => ({
    async once() { return { val: () => clone(getAt(p)) }; },
    async transaction(fn) {
      const real = clone(getAt(p));
      let next = fn(null);
      if (next === undefined) return { committed: false, snapshot: { val: () => real } };
      if (real !== null) { next = fn(clone(real)); if (next === undefined) return { committed: false, snapshot: { val: () => real } }; }
      setAt(p, clone(next));
      return { committed: true, snapshot: { val: () => clone(getAt(p)) } };
    },
    async update(patch) { setAt(p, Object.assign({}, getAt(p) || {}, clone(patch))); },
    async push(val) { const k = `k${++pushSeq}`; setAt(`${p}/${k}`, clone(val)); return { key: k }; },
  });
  return { ref, _get: getAt };
}

const ORDER = () => ({ restaurant_id: 'x_pizza', payment_status: 'confirmed', active_attempt_id: 'A1', total_cents: 69900, customer_phone: '50499', redemption: null });
// db seed: the order + its CAPTURED attempt (payment_uuid present — the guard reverses THIS uuid).
const DB0 = () => ({ orders: { O1: ORDER() }, payment_attempts: { A1: { payment_uuid: 'PU-1', status: 'captured' } } });

// Deps factory — records calls so scenarios assert on side effects.
function mkDeps(db, over = {}) {
  const calls = { void: 0, send: 0, release: 0, alerts: [] };
  const deps = {
    db,
    getIdentity: async () => ({ hours: HOURS }),
    getGraceMinutes: async () => 15,
    voidOrRefund: async () => { calls.void++; return { voided: true, ref: 'REFUND-REF' }; },   // confirmed reversal
    sendPaidAfterCloseRefund: async () => { calls.send++; },
    releaseRewardHold: async () => { calls.release++; },
    alert: async (k, d) => { calls.alerts.push([k, d]); },
    ...over,
  };
  return { deps, calls };
}

(async () => {
  // A) open now → false, NO writes
  {
    const db = makeDb(DB0());
    const { deps, calls } = mkDeps(db);
    const held = await holdIfClosedAtMaterialize(deps, 'O1', ORDER(), OPEN);
    assert.equal(held, false, 'A: open → materialize (false)');
    assert.equal(db._get('orders/O1').payment_status, 'confirmed', 'A: no order write');
    assert.equal(calls.void, 0, 'A: no refund'); ok('A: open now → false, no writes');
  }

  // B) within grace (closed <15m) → false, NO writes
  {
    const db = makeDb(DB0());
    const { deps, calls } = mkDeps(db);
    const held = await holdIfClosedAtMaterialize(deps, 'O1', ORDER(), GRACE);
    assert.equal(held, false, 'B: within grace → materialize (false)');
    assert.equal(db._get('orders/O1').payment_status, 'confirmed', 'B: no order write');
    assert.equal(calls.void, 0, 'B: no refund'); ok('B: within grace → false, no writes');
  }

  // C) past grace, refund OK → true; refunded once; order cancelled+refunded; audit + send + release
  {
    const db = makeDb(DB0());
    const { deps, calls } = mkDeps(db);
    const held = await holdIfClosedAtMaterialize(deps, 'O1', ORDER(), PAST);
    assert.equal(held, true, 'C: past grace → held (true)');
    const o = db._get('orders/O1');
    assert.equal(o.payment_status, 'refunded', 'C: payment_status refunded');
    assert.equal(o.status, 'cancelled', 'C: status cancelled');
    assert.equal(o.blocked_reason, 'refunded_paid_after_close', 'C: blocked_reason');
    assert.equal(calls.void, 1, 'C: voidOrRefund once');
    assert.equal(calls.send, 1, 'C: customer message once');
    assert.equal(calls.release, 1, 'C: reward hold released');
    assert.ok(db._get('paid_after_close_audit'), 'C: audit pushed');
    ok('C: past grace, refund OK → refunded once + audit + message + release');
  }

  // D) past grace, refund THROWS with NO reversal in flight (attempt still 'captured') → manual_reconciliation
  {
    const db = makeDb(DB0());   // attempt A1 status 'captured'
    const { deps, calls } = mkDeps(db, { voidOrRefund: async () => { throw new Error('pixelpay down'); } });
    const held = await holdIfClosedAtMaterialize(deps, 'O1', ORDER(), PAST);
    assert.equal(held, true, 'D: refund fail → still held (true, never materialize)');
    const o = db._get('orders/O1');
    assert.equal(o.payment_status, 'manual_reconciliation', 'D: threw, no reversal in flight → manual_reconciliation (resolvable)');
    assert.equal(o.blocked_reason, 'refund_failed_paid_after_close', 'D: fallback blocked_reason');
    assert.deepEqual(calls.alerts.map((a) => a[0]), ['refund_failed_paid_after_close'], 'D: alert fired');
    assert.equal(calls.send, 0, 'D: no customer refund message on failure');
    ok('D: refund throws (no reversal in flight) → manual_reconciliation + alert, no message');
  }

  // E) already refunded (re-entry) → true; voidOrRefund NOT called
  {
    const done = { ...ORDER(), payment_status: 'refunded', status: 'cancelled', blocked_reason: 'refunded_paid_after_close' };
    const db = makeDb({ orders: { O1: done } });
    const { deps, calls } = mkDeps(db);
    const held = await holdIfClosedAtMaterialize(deps, 'O1', done, PAST);
    assert.equal(held, true, 'E: re-entry on refunded → held (true)');
    assert.equal(calls.void, 0, 'E: NO second refund (idempotent)');
    assert.equal(calls.send, 0, 'E: no second message'); ok('E: already refunded re-entry → no-op');
  }

  // F) config/hours read throws → false (fail-open, never strand captured money)
  {
    const db = makeDb(DB0());
    const { deps, calls } = mkDeps(db, { getIdentity: async () => { throw new Error('config down'); } });
    const held = await holdIfClosedAtMaterialize(deps, 'O1', ORDER(), PAST);
    assert.equal(held, false, 'F: config outage → fail-open (materialize)');
    assert.equal(calls.void, 0, 'F: no refund on config outage'); ok('F: config read throws → false (fail-open)');
  }

  // G) scheduled_for present → false (scheduled path owns its hold)
  {
    const db = makeDb(DB0());
    const { deps, calls } = mkDeps(db);
    const held = await holdIfClosedAtMaterialize(deps, 'O1', { ...ORDER(), scheduled_for: PAST + 3600000 }, PAST);
    assert.equal(held, false, 'G: scheduled → guard is ASAP-only (false)');
    assert.equal(calls.void, 0, 'G: no refund for scheduled'); ok('G: scheduled_for → false (unchanged)');
  }

  // H) CAS idempotency — two guard passes on the SAME closed order refund EXACTLY once (no double message)
  {
    const db = makeDb(DB0());
    const { deps, calls } = mkDeps(db);
    const [h1, h2] = await Promise.all([
      holdIfClosedAtMaterialize(deps, 'O1', ORDER(), PAST),
      holdIfClosedAtMaterialize(deps, 'O1', ORDER(), PAST),
    ]);
    assert.equal(h1, true); assert.equal(h2, true);
    assert.equal(calls.void, 1, 'H: exactly ONE refund across two passes');
    assert.equal(calls.send, 1, 'H: exactly ONE customer message across two passes');
    ok('H: two concurrent passes → refund + message exactly once (tight CAS)');
  }

  // I) refund IN FLIGHT (voided:false → attempt refund_pending) → refund_pending, NO button, NO false-refund/message
  {
    const db = makeDb(DB0());
    const { deps, calls } = mkDeps(db, { voidOrRefund: async () => { calls.void++; await db.ref('payment_attempts/A1').update({ status: 'refund_pending' }); return { voided: false, outcome: 'refund_pending', message: 'in_flight' }; } });
    const held = await holdIfClosedAtMaterialize(deps, 'O1', ORDER(), PAST);
    assert.equal(held, true, 'I: refund_pending → still held');
    const o = db._get('orders/O1');
    assert.equal(o.payment_status, 'refund_pending', 'I: reversal in flight → refund_pending (reconciler owns, no button)');
    assert.equal(o.blocked_reason, 'refund_pending_paid_after_close', 'I: refund_pending sentinel');
    assert.notEqual(o.payment_status, 'refunded', 'I: never marks refunded on refund_pending');
    assert.deepEqual(calls.alerts.map((a) => a[0]), ['refund_pending_paid_after_close'], 'I: refund_pending alert');
    assert.equal(calls.send, 0, 'I: no "refunded" message when refund only pending');
    ok('I: refund_pending (attempt in flight) → refund_pending route, reconciler owns');
  }

  // J) captured order missing payment_uuid → manual_reconciliation + alert; voidOrRefund NEVER called
  {
    const db = makeDb({ orders: { O1: ORDER() }, payment_attempts: { A1: { status: 'captured' } } });   // no payment_uuid
    const { deps, calls } = mkDeps(db);
    const held = await holdIfClosedAtMaterialize(deps, 'O1', ORDER(), PAST);
    assert.equal(held, true, 'J: missing uuid → still held');
    assert.equal(db._get('orders/O1').payment_status, 'manual_reconciliation', 'J: manual_reconciliation (resolvable, no reversal)');
    assert.equal(calls.void, 0, 'J: voidOrRefund NOT called with a null uuid (would falsely succeed)');
    assert.deepEqual(calls.alerts.map((a) => a[0]), ['refund_failed_paid_after_close'], 'J: alert fired');
    ok('J: captured order w/o payment_uuid → manual_reconciliation, no fake reversal');
  }

  // K) REVISE-4: guard CAS only claims a CONFIRMED order (defensive) — a non-confirmed order → no claim, no refund
  {
    const db = makeDb({ orders: { O1: { ...ORDER(), payment_status: 'pending' } }, payment_attempts: { A1: { payment_uuid: 'PU-1', status: 'captured' } } });
    const { deps, calls } = mkDeps(db);
    const held = await holdIfClosedAtMaterialize(deps, 'O1', { ...ORDER(), payment_status: 'pending' }, PAST);
    assert.equal(held, true, 'K: not-confirmed past grace → held (no materialize)');
    assert.equal(db._get('orders/O1').payment_status, 'pending', 'K: CAS refused (not confirmed) — order untouched');
    assert.equal(calls.void, 0, 'K: no refund on a non-confirmed order');
    ok('K: guard CAS requires confirmed — non-confirmed order not claimed/refunded');
  }

  // ── recoverRefundingDecision (REVISE-5 stale-recovery) ──
  const STALE = 5 * 60 * 1000;
  const refunding = (over = {}) => ({ payment_status: 'refunding_paid_after_close', refunding_at: 0, active_attempt_id: 'A1', ...over });
  assert.equal(recoverRefundingDecision(refunding(), { status: 'refunded' }, STALE + 1, STALE).action, 'finalize_refunded'); ok('recover: attempt refunded → finalize_refunded');
  assert.equal(recoverRefundingDecision(refunding(), { status: 'voided' }, STALE + 1, STALE).action, 'finalize_refunded'); ok('recover: attempt voided → finalize_refunded');
  assert.equal(recoverRefundingDecision(refunding(), { status: 'refund_pending' }, STALE + 1, STALE).action, 'refund_pending'); ok('recover: attempt refund_pending → refund_pending');
  assert.equal(recoverRefundingDecision(refunding(), { status: 'reversing' }, STALE + 1, STALE).action, 'refund_pending'); ok('recover: attempt reversing → refund_pending');
  assert.equal(recoverRefundingDecision(refunding(), { status: 'captured' }, STALE + 1, STALE).action, 'manual_reconciliation'); ok('recover: attempt captured (no reversal) → manual_reconciliation');
  assert.equal(recoverRefundingDecision(refunding(), null, STALE + 1, STALE).action, 'manual_reconciliation'); ok('recover: no attempt → manual_reconciliation');
  assert.equal(recoverRefundingDecision(refunding({ refunding_at: 100 }), { status: 'refunded' }, 100 + STALE - 1, STALE).action, 'none'); ok('recover: fresh (< staleMs) → none');
  assert.equal(recoverRefundingDecision({ payment_status: 'confirmed' }, { status: 'refunded' }, STALE + 1, STALE).action, 'none'); ok('recover: not stuck (not refunding) → none');

  // REVISE-2: also finalize refund_pending + refund_pending_paid_after_close orders (silent-refund fix)
  const refundPending = (over = {}) => ({ payment_status: 'refund_pending', blocked_reason: 'refund_pending_paid_after_close', refunding_at: 0, active_attempt_id: 'A1', ...over });
  assert.equal(recoverRefundingDecision(refundPending(), { status: 'refunded' }, STALE + 1, STALE).action, 'finalize_refunded'); ok('recover(pending): attempt now refunded → finalize_refunded (silent-refund fix)');
  assert.equal(recoverRefundingDecision(refundPending(), { status: 'refund_pending' }, STALE + 1, STALE).action, 'refund_pending'); ok('recover(pending): attempt still in flight → refund_pending (leave, reconciler owns)');
  assert.equal(recoverRefundingDecision(refundPending(), { status: 'captured' }, STALE + 1, STALE).action, 'manual_reconciliation'); ok('recover(pending): attempt captured (no reversal) → manual_reconciliation');
  assert.equal(recoverRefundingDecision(refundPending({ refunding_at: 100 }), { status: 'refunded' }, 100 + STALE - 1, STALE).action, 'none'); ok('recover(pending): fresh → none');
  // a GENERIC refund_pending (not paid-after-close) is never touched
  assert.equal(recoverRefundingDecision({ payment_status: 'refund_pending', refunding_at: 0 }, { status: 'refunded' }, STALE + 1, STALE).action, 'none'); ok('recover: generic refund_pending (no paid-after-close reason) → none');

  /* ── 🔴 THE COMBINATION: A PARKED ORDER MUST NEVER BE TOLD ITS REFUND IS COMING ─────────────
     main's paid-after-close NOTIFY work (v3/v4/v4.1) guarantees the customer a message when the
     AUTOMATIC path refunds. This branch's park fix is the MANUAL path: it REFUSES to refund and parks
     for a human instead. They are adjacent, and adjacency is where this programme keeps finding
     defects — so the question is whether any notify path can fire "your refund is on its way" for an
     order that was parked rather than refunded. A truthful sent-marker on a refund that never
     happened would be worse than the silence we started with.
     It cannot, and the reason is structural rather than incidental: every send site is gated on a
     state the park path never writes. Driven here through the REAL predicate rather than by reading:
       · materialize-guard sends only inside its confirmed-reversal branch (voided === true), and the
         park path returns before it;
       · the sweep's notification recovery requires payment_status 'refunded' AND blocked_reason
         'refunded_paid_after_close';
       · the stale-refunding recovery requires 'refunding_paid_after_close', or 'refund_pending' with
         its own paid-after-close reason.
     A parked order is manual_reconciliation / manual_refund_required_paid_after_close, with its
     attempt still `captured` — it matches none of them. */
  {
    const { needsRefundNotifyRecovery } = require('./paid-after-close-notify');
    const NOW = 1700000000000, STALE_MS = 2 * 60 * 1000;
    const phone = '50488887777';
    // Exactly the shape the park fix writes (asserted in test/resolve-manual.emulator.test.js).
    const parked = { payment_status: 'manual_reconciliation', blocked_reason: 'manual_refund_required_paid_after_close',
      customer_phone: phone, refunded_at: NOW - 10 * 60 * 1000 };
    assert.equal(needsRefundNotifyRecovery(parked, NOW, STALE_MS), false,
      '🔴 A PARKED ORDER WAS SELECTED FOR THE REFUND MESSAGE — the customer would be told their refund is on its way for a refund that was deliberately NOT performed, which is worse than the silence this fix replaced');

    /* SENSITIVITY — a genuinely refunded order IS selected, so the assertion above is not satisfied by
       a predicate that says no to everything. */
    const refunded = { payment_status: 'refunded', blocked_reason: 'refunded_paid_after_close',
      customer_phone: phone, refunded_at: NOW - 10 * 60 * 1000 };
    assert.equal(needsRefundNotifyRecovery(refunded, NOW, STALE_MS), true,
      '🔴 SENSITIVITY: a genuinely refunded order is not selected either — the check above passes for the wrong reason');

    /* And the near-miss that would matter most: the park's own blocked_reason with a refunded status,
       or the refunded reason with the park's status. Neither is a state either path writes, but they
       are the two one-field slips that would turn the guard above into a coincidence. */
    assert.equal(needsRefundNotifyRecovery({ ...refunded, payment_status: 'manual_reconciliation' }, NOW, STALE_MS), false,
      'the refunded reason alone does not select — the status is checked too');
    assert.equal(needsRefundNotifyRecovery({ ...parked, payment_status: 'refunded' }, NOW, STALE_MS), false,
      'the refunded status alone does not select — the reason is checked too');
    ok('a PARKED paid-after-close order is never selected for the refund message; a genuinely refunded one is');
  }

  console.log(`\n${n} passed`);
})();
