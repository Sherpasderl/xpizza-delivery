'use strict';
/**
 * Parity tests for classifyHostedAttempt vs acquireHostedAttempt (KDS Phase 2b · Slice 4).
 * Run: `node hosted-classify-parity.test.js`
 *
 * The online intake availability gate uses the READ-ONLY classifyHostedAttempt to decide whether a
 * charge call would mint a FRESH payable checkout URL (⇒ gate the cart) vs resolve to a terminal /
 * already-issued outcome (⇒ BYPASS the gate — never re-reject a paid order). This test runs the SAME
 * fixtures through BOTH functions and asserts they can never drift:
 *   classify.willIssueFreshUrl === true   ⟺   acquireHostedAttempt outcome === 'claimed'
 *   classify.willIssueFreshUrl === false  ⟺   outcome ∈ {already_paid, conflict, closed, in_progress, reuse}
 * and that a terminal already_paid/closed order BYPASSES (willIssueFreshUrl:false).
 */
const assert = require('assert');
const { acquireHostedAttempt, classifyHostedAttempt, HOSTED_TTL_MS } = require('./pixelpay-hosted-charge');

// Same in-memory db model as pixelpay-hosted-charge.test.js (models the Admin SDK null-first tx call).
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

const NOW = 1_000_000_000;
const FP = 'fp-abc';
const PENDING = { order_id: 'O1', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', total: 299, total_cents: 29900 };
const seqIds = (...ids) => { let i = 0; return () => ids[i++]; };
const TERMINAL = new Set(['already_paid', 'conflict', 'closed', 'in_progress', 'reuse']);

// Each fixture: an initial db state + the fingerprint to classify against.
const FIXTURES = [
  { name: 'fresh create (no order)', init: {}, fp: FP },
  { name: 'live created checkout → reuse', fp: FP, init: {
    orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } },
    payment_attempts: { AT1: { order_id: 'O1', hosted_state: 'created', hosted_order_id: 'O1-AT1', hosted_expires_at: NOW + 10000, hosted_checkout_url: 'https://pay/X', poll_token: 'TOK1' } } } },
  { name: 'creating → in_progress', fp: FP, init: {
    orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } },
    payment_attempts: { AT1: { hosted_state: 'creating', hosted_order_id: 'O1-AT1' } } } },
  { name: 'confirmed order → already_paid', fp: FP, init: {
    orders: { O1: { ...PENDING, payment_status: 'confirmed', active_attempt_id: 'AT1', payment_fingerprint: FP } },
    payment_attempts: { AT1: { hosted_state: 'paid' } } } },
  { name: 'attempt paid → already_paid (order not yet confirmed)', fp: FP, init: {
    orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } },
    payment_attempts: { AT1: { hosted_state: 'paid' } } } },
  { name: 'fingerprint mismatch → conflict', fp: FP, init: {
    orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: 'OTHER' } },
    payment_attempts: { AT1: { hosted_state: 'created' } } } },
  { name: 'cancel_pending → closed', fp: FP, init: {
    orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } },
    payment_attempts: { AT1: { hosted_state: 'cancel_pending' } } } },
  { name: 'voided → closed', fp: FP, init: {
    orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } },
    payment_attempts: { AT1: { hosted_state: 'voided' } } } },
  { name: 'manual_reconciliation → closed', fp: FP, init: {
    orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } },
    payment_attempts: { AT1: { hosted_state: 'manual_reconciliation' } } } },
  { name: 'order refunded → closed', fp: FP, init: {
    orders: { O1: { ...PENDING, payment_status: 'refunded', active_attempt_id: 'AT1', payment_fingerprint: FP } },
    payment_attempts: { AT1: { hosted_state: 'created', hosted_expires_at: NOW + 10000, hosted_checkout_url: 'https://pay/X' } } } },
  { name: 'order cancelled → closed', fp: FP, init: {
    orders: { O1: { ...PENDING, status: 'cancelled', active_attempt_id: 'AT1', payment_fingerprint: FP } },
    payment_attempts: { AT1: { hosted_state: 'created', hosted_expires_at: NOW + 10000, hosted_checkout_url: 'https://pay/X' } } } },
  { name: 'expired created → rotate (fresh URL)', fp: FP, init: {
    orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } },
    payment_attempts: { AT1: { hosted_state: 'created', hosted_order_id: 'O1-AT1', hosted_expires_at: NOW - 1, hosted_checkout_url: 'https://pay/OLD' } } } },
  { name: 'created but no URL → rotate (fresh URL)', fp: FP, init: {
    orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } },
    payment_attempts: { AT1: { hosted_state: 'created', hosted_expires_at: NOW + 10000 } } } },
  { name: 'order exists, no active_attempt → install (fresh URL)', fp: FP, init: {
    orders: { O1: { ...PENDING } } } },
  { name: 'pointer set, attempt record gone → recover (fresh URL)', fp: FP, init: {
    orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } } } },
  { name: 'non-money terminal (failed_create) → rotate (fresh URL)', fp: FP, init: {
    orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } },
    payment_attempts: { AT1: { hosted_state: 'failed_create' } } } },
];

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  for (const fx of FIXTURES) {
    // classify on one db copy…
    const dbC = makeDb(fx.init);
    const cls = await classifyHostedAttempt(dbC, 'O1', fx.fp, NOW);
    // …acquire (the authoritative CAS + writes) on a fresh copy.
    const dbA = makeDb(fx.init);
    const acq = await acquireHostedAttempt(dbA, 'O1', PENDING, fx.fp, NOW, [], seqIds('ATx', 'ATy'), () => 'TOKx');

    const fresh = acq.outcome === 'claimed';
    assert.strictEqual(cls.willIssueFreshUrl, fresh,
      `${fx.name}: classify.willIssueFreshUrl=${cls.willIssueFreshUrl} but acquire outcome=${acq.outcome}`);
    if (!fresh) {
      assert.ok(TERMINAL.has(acq.outcome), `${fx.name}: unexpected non-fresh outcome ${acq.outcome}`);
    }
    ok(`${fx.name} — classify(${cls.willIssueFreshUrl ? 'fresh' : cls.outcome}) ⟺ acquire(${acq.outcome})`);
  }

  // Explicit BYPASS proof: a terminal already_paid/closed order does NOT issue a fresh URL (gate skipped).
  {
    const paid = makeDb({ orders: { O1: { ...PENDING, payment_status: 'confirmed' } } });
    assert.strictEqual((await classifyHostedAttempt(paid, 'O1', FP, NOW)).willIssueFreshUrl, false);
    const closed = makeDb({ orders: { O1: { ...PENDING, status: 'cancelled' } } });
    assert.strictEqual((await classifyHostedAttempt(closed, 'O1', FP, NOW)).willIssueFreshUrl, false);
    ok('terminal already_paid/closed ⇒ willIssueFreshUrl:false ⇒ gate BYPASSED (never re-reject a paid order)');
  }

  // ── TOCTOU close (Slice-4 fix): classify predicts REUSE (no fresh issuance) but by the time the
  // authoritative acquire runs, that live URL has EXPIRED → acquire ROTATES → would mint a FRESH payable
  // URL. For a 86'd cart, threading cartBlocked into acquire must ABORT that rotation with ZERO writes.
  const LIVE_INIT = {
    orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } },
    payment_attempts: { AT1: { order_id: 'O1', hosted_state: 'created', hosted_order_id: 'O1-AT1', hosted_expires_at: NOW + 10000, hosted_checkout_url: 'https://pay/X', poll_token: 'TOK1' } }
  };
  {
    const db = makeDb(LIVE_INIT);
    // 1) classify sees the live URL → predicts reuse (the UNRELIABLE signal the old gate trusted).
    const cls = await classifyHostedAttempt(db, 'O1', FP, NOW);
    assert.strictEqual(cls.willIssueFreshUrl, false);
    assert.strictEqual(cls.outcome, 'reuse');
    // 2) STATE DRIFT before the authoritative acquire: the checkout expires (models another actor / real
    //    wall-clock between the two reads — same NOW, so this is pure state drift, not clock drift).
    await db.ref('payment_attempts/AT1').update({ hosted_expires_at: NOW - 1 });
    // 3) acquire now ROTATES — but the cart is 86'd → item_unavailable, and NOTHING is written.
    const beforeOrders = JSON.stringify(db.getAt('orders'));
    const beforeAttempts = JSON.stringify(db.getAt('payment_attempts'));
    const acq = await acquireHostedAttempt(db, 'O1', PENDING, FP, NOW, ['Pizza Margherita'], seqIds('ATx', 'ATy'), () => 'TOKx');
    assert.strictEqual(acq.outcome, 'item_unavailable');
    assert.deepStrictEqual(acq.blocked, ['Pizza Margherita']);
    // ZERO writes — orders / payment_attempts / rate_limits byte-unchanged; no rotation occurred.
    assert.strictEqual(JSON.stringify(db.getAt('orders')), beforeOrders, 'orders must be byte-unchanged');
    assert.strictEqual(JSON.stringify(db.getAt('payment_attempts')), beforeAttempts, 'payment_attempts must be byte-unchanged');
    assert.strictEqual(db.getAt('rate_limits'), null, 'no rate_limits write');
    assert.strictEqual(db.getAt('orders/O1').active_attempt_id, 'AT1', 'active_attempt_id must NOT rotate');
    assert.strictEqual(db.getAt('payment_attempts/ATx'), null, 'no fresh attempt record created');
    ok('TOCTOU: classify(reuse) → acquire ROTATES on a 86\'d cart → item_unavailable, 0 writes (orders/payment_attempts/rate_limits)');
  }

  // Fail-open control: the SAME drifted (expired) state with an EMPTY cartBlocked (avail read found nothing
  // OR errored → []) → the CAS proceeds and rotates to a fresh attempt. A DB hiccup never blocks a sale.
  {
    const db = makeDb(LIVE_INIT);
    await db.ref('payment_attempts/AT1').update({ hosted_expires_at: NOW - 1 });
    const acq = await acquireHostedAttempt(db, 'O1', PENDING, FP, NOW, [], seqIds('ATy'), () => 'TOKy');
    assert.strictEqual(acq.outcome, 'claimed');
    assert.strictEqual(acq.attempt_id, 'ATy');
    assert.strictEqual(db.getAt('orders/O1').active_attempt_id, 'ATy', 'rotated to the fresh attempt');
    ok('fail-open: expired state + empty cartBlocked → rotate → claimed (sale never blocked by a read miss)');
  }

  // Genuine reuse of a STILL-LIVE URL proceeds even with a non-empty cartBlocked (plan §7 accepted race:
  // that URL is already out). acquire returns 'reuse' BEFORE the cartBlocked check → not blocked.
  {
    const db = makeDb(LIVE_INIT);
    const acq = await acquireHostedAttempt(db, 'O1', PENDING, FP, NOW, ['Pizza Margherita'], seqIds('ATz'), () => 'TOKz');
    assert.strictEqual(acq.outcome, 'reuse');
    assert.strictEqual(acq.checkout_url, 'https://pay/X');
    ok('reuse of a live URL proceeds despite a non-empty cartBlocked (§7 accepted post-issue race)');
  }

  console.log(`\nAll ${pass} classify/acquire parity checks passed.`);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
