'use strict';
// ---------------------------------------------------------------------------
// 1C Task 5 — THE REWARD HOLD ACROSS refuse → re-quote → retry.
//
// The gate refusal releases the hold. That is only half an answer: the question that decides whether a
// refusal is recoverable is what happens to the customer's POINTS when they re-quote and resubmit. Two
// failures are possible and neither is visible from the gate's own tests — a hold left stranded so the
// points stay debited, and a second debit on the retry. Both are run here against the real
// reserve/release transactions rather than argued from reading them.
// ---------------------------------------------------------------------------
const assert = require('assert');
const { reserveRedemption, releaseRedemption } = require('./rewards-reserve');
const { REDEMPTION_CONFIG_VERSION } = require('./rewards-redeem-config');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// A minimal RTDB stand-in: enough for .get() and .transaction() at one path, which is the entire surface
// reserveRedemption/releaseRedemption touch.
function memDb(initial) {
  const store = JSON.parse(JSON.stringify(initial));
  const at = (path) => path.split('/').reduce((o, k) => (o == null ? undefined : o[k]), store);
  return {
    store,
    ref: (path) => ({
      get: async () => ({ val: () => { const v = at(path); return v === undefined ? null : v; } }),
      transaction: async (fn) => {
        const cur = at(path);
        const next = fn(cur === undefined ? null : cur);
        if (next === undefined) return { committed: false };
        if (next === null) {                       // null-first probe → re-run against "server" data
          const again = fn(cur === undefined ? null : cur);
          if (again === undefined || again === null) return { committed: false };
          return commit(again);
        }
        return commit(next);
      },
    }),
  };
  function commit(next) {
    const parts = 'user_rewards/U1/x_pizza'.split('/');
    let o = store; for (const k of parts.slice(0, -1)) o = o[k];
    o[parts[parts.length - 1]] = next;
    return { committed: true, snapshot: { val: () => next } };
  }
}

const UID = 'U1', RID = 'x_pizza', ORDER = 'ORD-77', COST = 100;
const base = () => ({ user_rewards: { U1: { x_pizza: { balance: 500, reserved: 0 } } } });
const rec = (db) => (db.store.user_rewards.U1.x_pizza.reservations || {})[ORDER];
const resv = (db) => Number(db.store.user_rewards.U1.x_pizza.reserved) || 0;
const reserve = (db, fp, now) => reserveRedemption(db, {
  uid: UID, rid: RID, orderId: ORDER, cost: COST, canonical: 'free_pizza',
  orderFingerprint: fp, configVersion: REDEMPTION_CONFIG_VERSION, now, hostedExpiresAt: now + 900000,
});

(async () => {
  // ── 1. SAME CART, SAME PRICE: refuse → release → retry re-reserves EXACTLY ONCE ─────────────────
  // The realistic recoverable refusal: a stale/absent token on an otherwise unchanged cart. The retry
  // must get its hold back, and the points must be debited once, not twice.
  {
    const db = memDb(base());
    const r1 = await reserve(db, 'FP-A', 1000);
    assert.strictEqual(r1.action, 'created');
    assert.strictEqual(resv(db), COST, 'the first reserve debits once');

    await releaseRedemption(db, { uid: UID, rid: RID, orderId: ORDER, now: 1100 });   // ← what the gate refusal does
    assert.strictEqual(rec(db).state, 'released', '🔴 a refusal must not leave the hold reserved');
    assert.strictEqual(resv(db), 0, '🔴 the points must come back — a stranded hold is a silent debit');

    const r2 = await reserve(db, 'FP-A', 1200);
    assert.strictEqual(r2.action, 're_reserved', 'the retry gets its hold back');
    assert.strictEqual(resv(db), COST, '🔴 ONE debit after a full refuse→retry cycle, not two');
    assert.strictEqual(rec(db).state, 'reserved');
    assert.ok(rec(db).seq > 1, 'the re-reserve is a new sequence, so the ledger can tell them apart');
    ok('refuse → release → retry on an unchanged cart: hold returns, points debited exactly once');
  }

  // ── 2. NO STRANDED held_paid ────────────────────────────────────────────────────────────────────
  // held_paid means money moved. A gate refusal happens strictly BEFORE createHostedCharge, so it can
  // never produce one — and release refuses to act on any state but 'reserved', so even a mis-sequenced
  // call cannot drag a paid hold backwards.
  {
    const db = memDb(base());
    await reserve(db, 'FP-A', 1000);
    db.store.user_rewards.U1.x_pizza.reservations[ORDER].state = 'held_paid';
    const rel = await releaseRedemption(db, { uid: UID, rid: RID, orderId: ORDER, now: 1100 });
    assert.strictEqual(rel.ok, false, 'release must refuse a paid hold');
    assert.strictEqual(rec(db).state, 'held_paid', '🔴 a paid hold is never released by a gate refusal');
    ok('a held_paid hold is untouchable by the refusal path');
  }

  // ── 3. 🔴 THE TRAP: A RE-QUOTE THAT CHANGES THE AMOUNT CANNOT REUSE THIS ORDER'S HOLD ───────────
  // The fingerprint binds the amount, and the fp mismatch is checked BEFORE the released-state branch
  // (rewards-reserve.js). So after a price-INCREASE refusal — the one refusal that necessarily changes
  // the price — resubmitting the SAME order_id with the new amount is a reservation_conflict, and it
  // fails CLOSED: no debit, an explicit 409, points intact. That is the correct safety choice, but it
  // means the recovery is "a new order", not "retry this one". Asserted here so the behaviour is
  // recorded rather than discovered, and flagged to the owner in the handback.
  {
    const db = memDb(base());
    await reserve(db, 'FP-A', 1000);
    await releaseRedemption(db, { uid: UID, rid: RID, orderId: ORDER, now: 1100 });
    const r2 = await reserve(db, 'FP-B-newprice', 1200);
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.reason, 'reservation_conflict');
    assert.strictEqual(resv(db), 0, '🔴 a conflicted retry takes NO debit — the points stay the customer\'s');
    assert.strictEqual(rec(db).state, 'released', 'and the released hold stays released');
    ok('a re-quote at a NEW amount conflicts on the same order_id, fails closed, and debits nothing');
  }

  // ── 4. A DOUBLE SUBMIT WHILE THE HOLD IS LIVE REUSES IT, NEVER RE-DEBITS ───────────────────────
  {
    const db = memDb(base());
    await reserve(db, 'FP-A', 1000);
    const again = await reserve(db, 'FP-A', 1050);
    assert.strictEqual(again.action, 'reused', 'a live hold is reused');
    assert.strictEqual(resv(db), COST, '🔴 a double submit must never debit twice');
    ok('a double submit against a live hold reuses it and debits nothing further');
  }

  console.log(`\nreward-hold-lifecycle: ${n} checks passed`);
})().catch((e) => { console.error('reward-hold-lifecycle FAILED:', e && e.message); process.exit(1); });
