'use strict';
// D4-c5 phase 1 — the pure decision (PLAN-D4c5 rev 6 §1/§2 + the advisor's body-shape clarification).
// Run: node order-exists.test.js
//
// Every snapshot ORIGINATES FROM THE REAL WRITER: createOrder's own builder (buildCreateOrderUpdates) over the shared,
// hash-guarded intake combos — then moved to a terminal status the way the KDS / driver app do (a `status` write), and
// then given exactly ONE disqualifier per near-miss. A hand-built "safe" object would only prove the predicate agrees
// with the fixture's author.
const assert = require('assert');
const OE = require('./order-exists');
const { buildCreateOrderUpdates } = require('./create-order-build');
const { COMBOS } = require('./deploy/combo-validation');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('order-exists FAILED: exited without completing'); process.exitCode = 1; } });

const PLAN_DETAIL = 'Ya hay un pedido en curso con este número. Revisá tu pedido o pago anterior antes de volver a intentar.';
const PLAN_ABSENT = ['paid_during_resolve', 'active_attempt_id', 'payment_reference', 'cancel_claim_id', 'resolving_claim_id', 'payment_uuid', 'capture_verified', 'hosted_callback_verified'];
const ENUM = ['method', 'closed', 'cart', 'cart_unverifiable', 'binding_format_invalid', 'client_update_race', 'conflict'];

// the real writer's order records, one per intake combo, per terminal-safe method
const written = [];
for (const [key, combo] of Object.entries(COMBOS)) {
  for (const restaurantId of ['x_pizza', 'la_musa']) {   // both brands (the predicate must not care which)
    for (const method of ['cash', 'card_delivery']) {
      const fields = { ...combo.input.fields, payment_method: method };
      const updates = buildCreateOrderUpdates({ ...combo.input, restaurantId, fields, hubSnap: combo.snapshot, paymentFingerprint: 'fp-' + key });
      const rec = updates[`orders/${combo.input.orderId}`];
      assert.ok(rec && rec.payment_method === method && rec.status === 'new' && rec.restaurant_id === restaurantId, `${key}/${restaurantId}/${method}: the real writer produced the order`);
      written.push({ key: `${key}/${restaurantId}/${method}`, rec: JSON.parse(JSON.stringify(rec)) });   // RTDB-shaped (no undefined)
    }
  }
}
assert.ok(written.length >= 2, 'premise: the shared intake combos exist');
const terminal = (rec, status) => ({ ...rec, status });

try {
  // ── 1. the table, verbatim ────────────────────────────────────────────────────────────────────────────────────
  {
    assert.deepStrictEqual([...OE.MUST_BE_ABSENT], PLAN_ABSENT, 'the eight evidence/claim fields are exactly the plan §1 table');
    assert.deepStrictEqual([...OE.MUST_BE_UNDEFINED], ['payment_status', 'redemption'], 'payment_status + redemption must be ABSENT');
    assert.strictEqual(OE.ORDER_EXISTS_DETAIL, PLAN_DETAIL, 'the Spanish detail is the plan §1 string verbatim');
    assert.deepStrictEqual([...OE.ORDER_EXISTS_REASONS].sort(), [...ENUM].sort(), 'the reason enum is CLOSED and exactly the ruled set');
  }
  ok('the §1 table, the Spanish detail and the closed reason enum are pinned verbatim');

  // ── 2. terminal-safe controls KEEP the literal ─────────────────────────────────────────────────────────────────
  for (const { key, rec } of written) {
    assert.strictEqual(OE.isTerminalSafe(rec), false, `${key}: a LIVE ('new') order is never terminal-safe`);
    for (const status of ['delivered', 'completed', 'cancelled']) {
      const t = terminal(rec, status);
      assert.strictEqual(OE.isTerminalSafe(t), true, `${key}/${status}: the real writer's order, terminal, with no money/claim evidence → safe`);
      for (const k of PLAN_ABSENT) assert.strictEqual(OE.isTerminalSafe({ ...t, [k]: null }), true, `${key}/${status}: ${k}: null is ABSENT`);
      assert.deepStrictEqual(OE.decideCashExistingRefusal('closed', t), { legacy: true }, `${key}/${status}: closed + terminal-safe → today's literal`);
    }
  }
  ok(`terminal-safe controls (${written.length} real-writer records × delivered/completed/cancelled): safe, null evidence counts as absent, and \`closed\` keeps today's literal; the live record is not safe`);

  // ── 3. near-misses: EVERY single disqualifier refuses (a sensitivity partner per field) ──────────────────────────
  {
    let cells = 0;
    const refuse = (o, why) => { cells += 1; assert.strictEqual(OE.isTerminalSafe(o), false, `🔴 ${why} must refuse`); assert.deepStrictEqual(OE.decideCashExistingRefusal('closed', o), { legacy: false, reason: 'closed' }, `${why}: closed → order_exists`); };
    for (const { key, rec } of written) {
      for (const status of ['delivered', 'completed', 'cancelled']) {
        const t = terminal(rec, status);
        assert.strictEqual(OE.isTerminalSafe(t), true, 'partner premise');
        for (const m of ['online', 'Cash', 'cash ', 'card', '', undefined, null, 1]) refuse({ ...t, payment_method: m }, `${key}/${status} payment_method=${JSON.stringify(m)}`);
        for (const ps of ['confirmed', 'refunded', 'failed', 'pending', 'manual_review', '', null, false, 0]) refuse({ ...t, payment_status: ps }, `${key}/${status} payment_status=${JSON.stringify(ps)}`);
        for (const r of [{}, { cost: 1 }, 'x', null, false, 0]) refuse({ ...t, redemption: r }, `${key}/${status} redemption=${JSON.stringify(r)}`);
        for (const k of PLAN_ABSENT) for (const v of [false, '', 0, 'x', true, {}, 1]) refuse({ ...t, [k]: v }, `${key}/${status} ${k}=${JSON.stringify(v)}`);
      }
      for (const s of ['new', 'preparing', 'ready', 'out_for_delivery', 'confirmed', 'manual_review', 'pending_payment', 'scheduled', 'releasing', 'Delivered', '', undefined, null]) refuse(terminal(rec, s), `${key} status=${JSON.stringify(s)}`);
    }
    for (const bad of [null, undefined, [], [1], 'delivered', 1, true]) refuse(bad, `malformed snapshot ${JSON.stringify(bad)}`);
    // a non-plain container CARRYING every safe field is still malformed (kills "drop the array / object-type check")
    const safeFields = { payment_method: 'cash', status: 'delivered' };
    assert.strictEqual(OE.isTerminalSafe({ ...safeFields }), true, 'partner premise: the same fields on a plain object are safe');
    refuse(Object.assign([], safeFields), 'an ARRAY carrying the safe fields');
    refuse(Object.assign(function f() {}, safeFields), 'a FUNCTION carrying the safe fields');
    assert.ok(cells > 500, `premise: the near-miss grid ran (${cells})`);
  }
  ok('near-misses: each single disqualifier on a real-writer terminal record refuses — online/unknown method, ANY payment_status (incl. "" / null / false / 0), any redemption, each of the eight evidence/claim fields present as false/""/0/…, a live/unknown status, a malformed snapshot');

  // ── 4. precedence: restaurant and method ALWAYS refuse; only `closed` is tested; other reasons never self-heal ──
  {
    const safe = terminal(written[0].rec, 'delivered');
    assert.deepStrictEqual(OE.decideCashExistingRefusal('restaurant', safe), { legacy: false, reason: 'conflict' }, 'restaurant + terminal-safe snapshot → order_exists, neutral reason (no disclosure)');
    assert.deepStrictEqual(OE.decideCashExistingRefusal('method', safe), { legacy: false, reason: 'method' }, 'method + terminal-safe snapshot → order_exists');
    for (const r of ['cart', 'cart_unverifiable', 'binding_format_invalid']) {
      assert.deepStrictEqual(OE.decideCashExistingRefusal(r, safe), { legacy: false, reason: r }, `${r} never takes the terminal exception`);
    }
    assert.deepStrictEqual(OE.decideCashExistingRefusal('closed', { ...safe, status: 'manual_review' }), { legacy: false, reason: 'closed' });
  }
  ok('precedence: `restaurant` → order_exists/conflict and `method` → order_exists even on a terminal-safe snapshot; cart / cart_unverifiable / binding_format_invalid never self-heal; only `closed` + terminal-safe keeps the literal');

  // ── 5. the body: EXACT key set, closed enum, no order data ───────────────────────────────────────────────────────
  {
    for (const r of ENUM) {
      const b = OE.orderExistsBody(r, 'XP-123');
      assert.deepStrictEqual(Object.keys(b), ['error', 'reason', 'detail', 'order_id'], 'exactly these four keys, in this order');
      assert.deepStrictEqual(b, { error: 'order_exists', reason: r, detail: PLAN_DETAIL, order_id: 'XP-123' });
    }
    for (const r of ['restaurant', 'paid', 'confirmed', 'cancelled', 'la_musa', '', undefined, null]) {
      assert.strictEqual(OE.orderExistsBody(r, 'XP-1').reason, 'conflict', `a reason outside the enum (${JSON.stringify(r)}) never reaches the client`);
    }
    assert.notStrictEqual(OE.orderExistsBody('closed', 'x').error, 'order_conflict');
  }
  ok('body = EXACTLY {error:"order_exists", reason, detail:<plan string>, order_id}; reason ∈ the closed enum, anything else (an order status, a restaurant id) → "conflict"');

  FINISHED = true;
  console.log(`\norder-exists: OK (${n})`);
} catch (e) { console.error('order-exists FAILED:', e && e.stack || e); process.exit(1); }
