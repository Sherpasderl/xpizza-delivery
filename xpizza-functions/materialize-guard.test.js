'use strict';

/**
 * Paid-after-close materialize guard — grace window + idempotent auto-refund + fail-safe fallback.
 * Deps-injected (no Firebase). Money-critical: a past-close order is auto-refunded EXACTLY once
 * (CAS claim), a refund failure falls back to manual_review + alert (never strands), and a re-entry
 * on an already-resolved order is a no-op. Run: node materialize-guard.test.js
 */
const assert = require('assert');
const { holdIfClosedAtMaterialize } = require('./materialize-guard');

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

  // D) past grace, refund THROWS → true; manual_review + alert; no message
  {
    const db = makeDb(DB0());
    const { deps, calls } = mkDeps(db, { voidOrRefund: async () => { throw new Error('pixelpay down'); } });
    const held = await holdIfClosedAtMaterialize(deps, 'O1', ORDER(), PAST);
    assert.equal(held, true, 'D: refund fail → still held (true, never materialize)');
    const o = db._get('orders/O1');
    assert.equal(o.payment_status, 'manual_review', 'D: fallback manual_review');
    assert.equal(o.blocked_reason, 'refund_failed_paid_after_close', 'D: fallback blocked_reason');
    assert.deepEqual(calls.alerts.map((a) => a[0]), ['refund_failed_paid_after_close'], 'D: alert fired');
    assert.equal(calls.send, 0, 'D: no customer refund message on failure');
    ok('D: refund throws → manual_review + alert, no message');
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

  // I) refund NOT confirmed (voided:false, refund_pending) → manual_review + alert, NO false-refund, NO message
  {
    const db = makeDb(DB0());
    const { deps, calls } = mkDeps(db, { voidOrRefund: async () => { calls.void++; return { voided: false, outcome: 'refund_pending', message: 'in_flight' }; } });
    const held = await holdIfClosedAtMaterialize(deps, 'O1', ORDER(), PAST);
    assert.equal(held, true, 'I: refund_pending → still held');
    const o = db._get('orders/O1');
    assert.equal(o.payment_status, 'manual_review', 'I: NOT falsely refunded — manual_review');
    assert.notEqual(o.payment_status, 'refunded', 'I: never marks refunded on refund_pending');
    assert.deepEqual(calls.alerts.map((a) => a[0]), ['refund_failed_paid_after_close'], 'I: alert fired');
    assert.equal(calls.send, 0, 'I: no "refunded" message when refund only pending');
    ok('I: refund_pending (voided:false) → manual_review, never falsely refunded/messaged');
  }

  // J) captured order missing payment_uuid → manual_review + alert; voidOrRefund NEVER called (no fake reversal)
  {
    const db = makeDb({ orders: { O1: ORDER() }, payment_attempts: { A1: { status: 'captured' } } });   // no payment_uuid
    const { deps, calls } = mkDeps(db);
    const held = await holdIfClosedAtMaterialize(deps, 'O1', ORDER(), PAST);
    assert.equal(held, true, 'J: missing uuid → still held');
    assert.equal(db._get('orders/O1').payment_status, 'manual_review', 'J: manual_review (never falsely refunded)');
    assert.equal(calls.void, 0, 'J: voidOrRefund NOT called with a null uuid (would falsely succeed)');
    assert.deepEqual(calls.alerts.map((a) => a[0]), ['refund_failed_paid_after_close'], 'J: alert fired');
    ok('J: captured order w/o payment_uuid → manual_review, no fake reversal');
  }

  console.log(`\n${n} passed`);
})();
