'use strict';
/**
 * SPLIT 2 — the FISCAL path of "Cerrar como entregado" (close_fulfilled), executed end-to-end.
 * Run:  node recon-close-fulfilled-fiscal.test.js
 *
 * resolveManualReconciliationCore is driven against a small in-memory RTDB fake and the REAL factura issuer
 * (allocateFacturaNumber → decideReserve/buildFacturaRecord — never a hand-built record, per the "originate from
 * the real writer" rule). It proves the load-bearing fiscal invariants of the delivered-offline close:
 *
 *   A. X.Pizza (platform-factura) → issues EXACTLY ONE SAR factura from the real issuer, THEN closes terminal.
 *   B. ALWAYS-INVARIANT (failure path actually RUN): issuance FAILS (config_missing) → the order does NOT close,
 *      it reverts to manual_reconciliation (retryable), no factura exists, factura_status:'failed', dispatcher alerted.
 *   C. La Musa (non-platform) → closes with ZERO platform facturas issued (external POS owns its fiscal doc).
 *   D. Crash-between-issue-and-close convergence: an order already carrying an issued factura re-resolves via the
 *      IDEMPOTENT issuer (no second number, seq not advanced) and closes — one factura, not two.
 *
 * This is the executing complement to the source-placement guards in recon-close-fulfilled.test.js.
 */
const assert = require('assert');
const { resolveManualReconciliationCore, recoverStaleResolve } = require('./resolve-manual');
const { allocateFacturaNumber } = require('./factura/factura-helpers');   // the REAL issuer, used to ORIGINATE the convergence fixture (no hand-built factura)

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// ── Minimal in-memory RTDB fake: nested path store with the exact surface the close path + real issuer touch ──
function makeDb(initial) {
  const store = JSON.parse(JSON.stringify(initial || {}));
  const parts = (p) => String(p).split('/').filter((s) => s.length);
  const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
  const getAt = (p) => { let n = store; for (const k of parts(p)) { if (n == null || typeof n !== 'object') return null; n = n[k]; } return n === undefined ? null : n; };
  const setAt = (p, v) => {
    const ks = parts(p); let n = store;
    for (let i = 0; i < ks.length - 1; i++) { if (typeof n[ks[i]] !== 'object' || n[ks[i]] === null) n[ks[i]] = {}; n = n[ks[i]]; }
    const leaf = ks[ks.length - 1];
    if (v === null || v === undefined) delete n[leaf]; else n[leaf] = clone(v);
  };
  let seq = 0;
  const ref = (path) => ({
    once: async () => ({ val: () => clone(getAt(path)) }),
    get: async () => ({ val: () => clone(getAt(path)) }),
    set: async (v) => setAt(path, v),
    update: async (obj) => setAt(path, { ...(getAt(path) || {}), ...obj }),
    remove: async () => setAt(path, null),
    push: async (v) => { const id = `k${++seq}`; setAt(`${path}/${id}`, v); return { key: id }; },
    transaction: async (fn) => {
      const cur = clone(getAt(path));           // RTDB passes the current server value; our updaters are null-safe
      const res = fn(cur);
      if (res === undefined || res === null) return { committed: false, snapshot: { val: () => clone(getAt(path)) } };
      setAt(path, res);
      return { committed: true, snapshot: { val: () => clone(res) } };
    },
  });
  return { ref, get: getAt };
}

// A valid X.Pizza fiscal config (mirrors restaurants/<rid>/factura_config); seq shape is decideReserve's.
const goodConfig = () => ({
  restaurant_name: 'X. Pizza', legal_name: 'XPIZZA S DE RL', rtn: '08019999999999',
  address_1: 'Tegucigalpa', address_2: '', email: 'fiscal@x.pizza', phone: '2200-0000',
  cai_code: 'ABC123-DEF456-GHI789-JKL012-MNO345-01', prefix: '000-001-01',
  range_start: 1, range_end: 100, fecha_limite: '2099-12-31', is_temp: false,
  seq: { last_reserved: 0, pending: {} },
});

// A delivered-offline order parked in manual_reconciliation (priced fields present so it is a valid Sale).
const parkedOrder = (rid) => ({
  restaurant_id: rid, payment_status: 'manual_reconciliation', status: 'new',
  blocked_reason: 'manual_refund_required_paid_after_close', active_attempt_id: null,
  customer_name: 'Cliente Prueba', payment_method: 'online',
  items: [{ qty: 1, description: 'Pizza 12"', line_gross_cents: 25000 }],
  subtotal_cents: 25000, tax_cents: 3750, total_cents: 28750,
});

const deps = (db) => {
  const alertCalls = [];
  return {
    d: { db, client: {}, alert: async (kind, detail) => { alertCalls.push([kind, detail]); }, sanitizeText: (s) => s, serverTimestamp: 1700000000000 },
    alertCalls,
  };
};
const NOW = Date.UTC(2026, 8, 26, 18, 0, 0);   // fixed epoch, well before fecha_limite
const call = (d) => resolveManualReconciliationCore(d, { orderId: 'O1', action: 'close_fulfilled', actor: 'disp@x', note: 'entregado', now: NOW, claimId: 'C1' });

(async () => {
  // ── A. X.Pizza: issue exactly ONE real factura, then close ──────────────────────────────────────
  {
    const db = makeDb({ orders: { O1: parkedOrder('x_pizza') }, restaurants: { x_pizza: { factura_config: goodConfig() } } });
    const { d } = deps(db);
    const r = await call(d);
    assert.strictEqual(r.status, 200, 'X.Pizza close returns 200');
    assert.strictEqual(r.body.outcome, 'closed_fulfilled_offline', "outcome closed_fulfilled_offline");
    const order = db.get('orders/O1');
    assert.strictEqual(order.payment_status, 'confirmed', 'payment KEPT (confirmed)');
    assert.strictEqual(order.status, 'completed', 'order closed terminal (completed)');
    assert.strictEqual(order.factura_status, 'issued', 'factura_status stamped issued by the real issuer');
    const facs = db.get('facturas/x_pizza') || {};
    assert.strictEqual(Object.keys(facs).length, 1, 'EXACTLY ONE factura issued');
    const fac = facs.O1;
    assert.ok(fac && fac.state === 'issued', 'the factura record is state:issued');
    assert.match(fac.factura_number, /^000-001-01-\d{8}$/, 'factura_number has the real prefix + 8-digit seq');
    // Fields only the REAL buildFacturaRecord emits (not a hand-built stub): emisor CAI + verbatim gravado/total.
    assert.strictEqual(fac.cai_code, 'ABC123-DEF456-GHI789-JKL012-MNO345-01', 'emisor CAI copied from config (real record)');
    assert.strictEqual(fac.gravado_15_cents, 25000, 'gravado_15 = subtotal, verbatim (real record)');
    assert.strictEqual(fac.total_cents, 28750, 'total copied verbatim from the order (money not recomputed)');
    ok('X.Pizza: exactly ONE real SAR factura issued, then payment-kept terminal close (confirmed+completed)');
  }

  // ── B. ALWAYS-INVARIANT: issuance FAILS (config_missing) → do NOT close (failure path actually run) ──
  {
    const db = makeDb({ orders: { O1: parkedOrder('x_pizza') } });   // NO factura_config → real issuer returns config_missing
    const { d, alertCalls } = deps(db);
    const r = await call(d);
    assert.strictEqual(r.status, 409, 'issuance failure returns 409 (not a fake success)');
    assert.strictEqual(r.body.outcome, 'factura_failed', 'outcome factura_failed');
    const order = db.get('orders/O1');
    assert.notStrictEqual(order.status, 'completed', 'order NOT closed on issuance failure');
    assert.strictEqual(order.status, 'new', 'order status unchanged (still parked)');
    assert.strictEqual(order.payment_status, 'manual_reconciliation', 'claim RELEASED back to manual_reconciliation (retryable)');
    assert.strictEqual(order.factura_status, 'failed', 'factura_status:failed stamped by the real issuer');
    assert.strictEqual(db.get('facturas/x_pizza'), null, 'NO factura record exists (nothing issued)');
    assert.ok(alertCalls.some(([k]) => k === 'factura_config_missing'), 'dispatcher alerted (factura_config_missing)');
    ok('ALWAYS-INVARIANT: real issuance failure leaves the order UN-closed + reverted + alerted (failure path RAN)');
  }

  // ── C. La Musa (non-platform): close directly, ZERO platform facturas ───────────────────────────
  {
    const db = makeDb({ orders: { O1: parkedOrder('la_musa') }, restaurants: { x_pizza: { factura_config: goodConfig() } } });
    const { d } = deps(db);
    const r = await call(d);
    assert.strictEqual(r.status, 200, 'La Musa close returns 200');
    assert.strictEqual(r.body.outcome, 'closed_fulfilled_offline', 'outcome closed_fulfilled_offline');
    const order = db.get('orders/O1');
    assert.strictEqual(order.payment_status, 'confirmed', 'payment kept');
    assert.strictEqual(order.status, 'completed', 'closed terminal');
    assert.strictEqual(db.get('facturas/x_pizza'), null, 'ZERO platform facturas issued for La Musa (external POS owns fiscal)');
    assert.ok(order.factura_status === undefined || order.factura_status === null, 'no platform factura_status stamped on the La Musa close');
    ok('La Musa: payment-kept terminal close with ZERO platform facturas (external POS unchanged)');
  }

  // ── D. Crash-between-issue-and-close convergence — EXERCISED through the real writer + real recovery ───────────
  //    Reproduce the real mid-crash state rather than hand-building a factura: (1) a stale close_fulfilled claim,
  //    (2) the factura ISSUED by the REAL allocateFacturaNumber (a resolve that crashed AFTER issue, BEFORE the
  //    close CAS), (3) the REAL recoverStaleResolve reverts the pre-side-effect stale claim to manual_reconciliation
  //    (safe because issuance is idempotent — this is exactly why the branch does not stamp side_effect_started),
  //    (4) a fresh resolve re-issues idempotently (no second number, seq intact) and finally closes.
  {
    const order = { ...parkedOrder('x_pizza'), status: 'new',
      payment_status: 'resolving_close_fulfilled', resolving_action: 'close_fulfilled',
      resolving_claim_id: 'CRASHED', resolving_phase: 'claimed', resolving_claimed_at: NOW - 10 * 60 * 1000 };
    const db = makeDb({ orders: { O1: order }, restaurants: { x_pizza: { factura_config: goodConfig() } } });
    const { d } = deps(db);

    // (2) The factura is created by the REAL issuer (same call the branch makes) — the fixture ORIGINATES from the
    //     real writer, not a hand-built record. This is the "issued, then crashed before close" state.
    const issue = await allocateFacturaNumber(db, { restaurantId: 'x_pizza', orderId: 'O1', order: { ...order, orderId: 'O1' }, now: NOW });
    assert.ok(issue.ok && issue.reserved, 'real issuer produced a factura for the crash fixture');
    const firstNumber = db.get('facturas/x_pizza/O1').factura_number;
    const firstSeq = db.get('restaurants/x_pizza/factura_config/seq/last_reserved');
    assert.strictEqual(firstSeq, 1, 'first real issue advanced seq to 1');

    // (3) REAL stale-claim recovery: a pre-side-effect (phase:claimed) stale claim reverts to manual_reconciliation.
    const rec = await recoverStaleResolve(d, 'O1', db.get('orders/O1'), NOW, 1000);
    assert.deepStrictEqual(rec, { recovered: true, to: 'manual_reconciliation' }, 'stale close_fulfilled claim recovers to manual_reconciliation (retryable)');
    assert.strictEqual(db.get('orders/O1').payment_status, 'manual_reconciliation', 'order is back to manual_reconciliation after recovery');
    assert.strictEqual(db.get('orders/O1').factura_status, 'issued', 'the already-issued factura survives the recovery');

    // (4) Re-resolve: the real issuer returns the already-issued number idempotently, then the order closes.
    const r = await call(d);
    assert.strictEqual(r.status, 200, 're-resolve after recovery closes (200)');
    assert.strictEqual(r.body.outcome, 'closed_fulfilled_offline', 'outcome closed_fulfilled_offline');
    const facs = db.get('facturas/x_pizza') || {};
    assert.strictEqual(Object.keys(facs).length, 1, 'still EXACTLY ONE factura (idempotent — no second number)');
    assert.strictEqual(facs.O1.factura_number, firstNumber, 'the SAME factura number (not re-minted)');
    assert.strictEqual(db.get('restaurants/x_pizza/factura_config/seq/last_reserved'), firstSeq, 'seq NOT advanced on the idempotent re-issue (no number burned)');
    assert.strictEqual(db.get('orders/O1').status, 'completed', 'the order finally closes (convergence)');
    assert.strictEqual(db.get('orders/O1').payment_status, 'confirmed', 'payment kept on the converged close');
    ok('Convergence: real issue → real stale-claim recovery → idempotent real re-issue (one factura, seq intact) → close');
  }

  console.log(`\nAll ${pass} close_fulfilled FISCAL invariants passed (executed against the real issuer).`);
})().catch((e) => { console.error('\n✗ FAIL:', e && e.message); process.exit(1); });
