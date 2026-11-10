'use strict';
// S2 B2 (D4c-grill/item-s1/S2-DESIGN.md §2 r1 B2; OWNER RULING 2026-11-10 «keep held until resolved»; Codex S2 code r1 P1-1 →
// advisor: fall back to TODAY) — a FRESH card attempt that a fresh-only gate refuses NEVER releases a reward hold it REUSED (a
// retry of the same order), whatever the earlier attempt's state: an early release cannot be made safe, because the hold
// (user_rewards) and the attempts / order (payment_attempts, orders) are separate RTDB paths, so «no other attempt is payable or
// in flight» cannot be checked atomically with the release — a concurrent retry can claim a NEW attempt and issue its checkout
// against the same hold before attaching to it (Codex's A2→A3 race). The hold stays held; the sweep or reconciliation resolves it.
// Runs the REAL decision (resolveAndIssueHostedCheckout) against the REAL reservation transactions.
// Run: node hosted-refusal-reused-hold.test.js
const assert = require('assert');
const { resolveAndIssueHostedCheckout } = require('./hosted-charge-flow');
const { reserveRedemption } = require('./rewards-reserve');
const { REDEMPTION_CONFIG_VERSION } = require('./rewards-redeem-config');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('hosted-refusal-reused-hold: FAILED — exited without completing'); process.exitCode = 1; } });
const QUIET = { log() {}, warn() {}, error() {} };

// an in-memory RTDB: the reward doc (transactions) + the order record (reads)
const mk = (order) => {
  const store = { user_rewards: { U1: { x_pizza: { balance: 500, reserved: 0 } } }, orders: order === undefined ? {} : { 'ORD-1': order } };
  const at = (path) => path.split('/').reduce((o, k) => (o == null ? undefined : o[k]), store);
  const commit = (nx) => { store.user_rewards.U1.x_pizza = nx; return { committed: true, snapshot: { val: () => nx } }; };
  return { store, ref: (path) => ({
    get: async () => ({ val: () => { const v = at(path); return v === undefined ? null : v; } }),
    once: async () => ({ val: () => { const v = at(path); return v === undefined ? null : v; } }),
    transaction: async (fn) => { const cur = at(path); const nx = fn(cur === undefined ? null : cur);
      if (nx === undefined) return { committed: false };
      if (nx === null) { const a = fn(cur === undefined ? null : cur); return a == null ? { committed: false } : commit(a); }
      return commit(nx); },
  }) };
};
const reserve = (db) => reserveRedemption(db, { uid: 'U1', rid: 'x_pizza', orderId: 'ORD-1', cost: 100,
  canonical: 'free_pizza', orderFingerprint: 'FP', configVersion: REDEMPTION_CONFIG_VERSION, now: 1_000_000, hostedExpiresAt: 1_900_000 });
const hold = (db) => db.store.user_rewards.U1.x_pizza.reservations['ORD-1'];
const reservedPts = (db) => db.store.user_rewards.U1.x_pizza.reserved;

// the lifecycle: the earlier attempt reserved (owned then); this retry RE-reserves → 'reused' (not owned); acquire rotated the
// ended checkout into a fresh CLAIM; a fresh-only gate refuses it
async function lifecycle(order, { refuse = true } = {}) {
  const db = mk(order);
  const first = await reserve(db);
  assert.ok(first.ok && first.action === 'created', 'premise: the earlier attempt created the hold');
  const again = await reserve(db);
  assert.deepStrictEqual([again.ok, again.action], [true, 'reused'], 'premise: the retry REUSES the hold (classify-reuse)');
  const owned = again.action === 'created' || again.action === 're_reserved';   // index.js: redemptionOwnsHold
  const calls = { checkout: 0, retire: [], ownedRelease: 0 };
  const out = await resolveAndIssueHostedCheckout({
    acq: { outcome: 'claimed', attempt_id: 'A2', expires_at: 2_900_000 }, orderId: 'ORD-1', attemptId: 'A2', log: QUIET,
    totalCents: 10000, toLempiras: (c) => (c / 100).toFixed(2),
    chargeRequest: { pixelpayOrderId: 'ORD-1-A2', firstName: 'Ana', lastName: 'Paz', email: 'a@b.co' },
    releaseHold: async () => { if (owned) calls.ownedRelease += 1; },                       // the owned-only release (a no-op here)
    retireAttempt: async (id, reason) => { calls.retire.push({ id, reason }); },
    stampProvenance: async () => {}, attachReservation: async () => {},
    createCheckout: async () => { calls.checkout += 1; return { ok: true, url: 'https://pay/new' }; },
    persistCreated: async () => {},
    runGate: async () => (refuse ? { refuse: { status: 409, body: { ok: false, error: 'pickup_only_item', item_key: 'K' } } } : { provenance: null }),
  });
  return { db, out, calls };
}

// ── (a) the earlier attempt is DEFINITIVELY not captured (payment failed) → the reused hold is released now ──
{
  (async () => {
    for (const [order, label] of [[{ payment_status: 'failed', status: 'pending_payment', active_attempt_id: 'A1' }, 'failed'], [{ payment_status: 'pending', status: 'cancelled', active_attempt_id: 'A1' }, 'cancelled']]) {
      const a = await lifecycle(order);
      assert.strictEqual(a.out.respond.status, 409, `B2-A ${label}: the fresh attempt is refused`);
      assert.strictEqual(a.calls.checkout, 0, `B2-A ${label}: zero checkouts`);
      assert.deepStrictEqual(a.calls.retire.map((r) => r.id), ['A2'], `B2-A ${label}: the claimed attempt is retired`);
      assert.strictEqual(hold(a.db).state, 'reserved', `B2-A-HELD ${label}: even a definitively-uncaptured earlier attempt does NOT release the reused hold early (today)`);
      assert.strictEqual(reservedPts(a.db), 100, `B2-A-HELD ${label}: the points stay reserved for the sweep`);
    }
    ok('(a) earlier attempt definitively not captured → still held (no early release: it cannot be made race-safe), zero checkouts');

    // ── (b) the earlier attempt is UNKNOWN (expired with no bank callback; possibly paid) → held, as today ──
    for (const [order, label] of [[{ payment_status: 'pending', status: 'pending_payment', active_attempt_id: 'A1' }, 'pending'],
      [{ payment_status: 'manual_reconciliation', status: 'pending_payment', active_attempt_id: 'A1' }, 'manual_reconciliation']]) {
      const b = await lifecycle(order);
      assert.strictEqual(b.out.respond.status, 409, `B2-B ${label}: refused`);
      assert.strictEqual(b.calls.checkout, 0, `B2-B ${label}: zero checkouts`);
      assert.strictEqual(hold(b.db).state, 'reserved', `B2-B-HELD ${label}: an earlier attempt that MAY have been paid keeps the hold (owner: keep held until resolved)`);
      assert.strictEqual(reservedPts(b.db), 100, `B2-B-HELD ${label}: the points stay reserved`);
    }
    ok('(b) earlier attempt unknown → the hold stays reserved, exactly as today');

    // ── an ACCEPTED fresh attempt keeps the hold for its own checkout ──
    const acc = await lifecycle({ payment_status: 'failed', status: 'pending_payment', active_attempt_id: 'A1' }, { refuse: false });
    assert.strictEqual(hold(acc.db).state, 'reserved', 'B2-ACCEPT the hold backs the new checkout');
    assert.strictEqual(acc.calls.checkout, 1, 'B2-ACCEPT premise: a checkout was issued');
    ok('an accepted fresh attempt keeps the hold for its own checkout');

    // ── the PRODUCTION wiring carries no early release of a reused hold (the flow and the handler) ──
    const flowSrc = require('fs').readFileSync(require('path').join(__dirname, 'hosted-charge-flow.js'), 'utf8');
    const idxSrc = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
    assert.ok(!/releaseReused/.test(flowSrc) && !/releaseReused|rewards-reuse-release/.test(idxSrc), 'B2-NO-EARLY-RELEASE neither the fresh-gate flow nor chargeOnline wires an early release of a reused hold');
    assert.ok(!require('fs').existsSync(require('path').join(__dirname, 'rewards-reuse-release.js')), 'B2-NO-EARLY-RELEASE the early-release module is gone');
    ok('the production card path never releases a reused hold early');
    FINISHED = true;
    console.log(`\nhosted-refusal-reused-hold: OK (${n})`);
  })().catch((e) => { console.error(e); process.exit(1); });
}
