'use strict';
/**
 * attribution-refire.test.js — proves the attribution-only write (adding orders/<id>/delivered_by_uid/name to an
 * already-terminal order) is SAFE against every order-node watcher it re-fires. Run: node attribution-refire.test.js
 *
 * A write to orders/<id>/delivered_by_* is a CHILD write, so ONLY the six WHOLE-NODE (/orders/{orderId}) watchers
 * re-fire — the /status-LEAF watchers (sendOrderStatusNotifications, earnRewardsOnCompletion, clearTrackerMirrorOnDone,
 * deleteTasksOnOrderTerminal) do NOT fire on it at all. The six whole-node watchers:
 *   materializeOnConfirm, allocateFacturaOnSale, allocateDisplayNumberOnSale, voidFacturaOnCancel,
 *   notifyStaffOnNewOrder, autoAssignOnOrderCreate — each gated on a Sale/new/cancel transition.
 * An attribution write leaves `status` UNCHANGED on a terminal order, so each gate rejects. Four gates are pure
 * predicates and are proven executably here (fed the real attribution before/after); the other two are inline and
 * asserted structurally. Codex's specific worry — display-number HEALING — is covered: no new number is minted.
 */
const fs = require('fs');
const assert = require('assert');
const { displayNumberEligible } = require('./order-display-number');
const { facturaSaleEligible, facturaVoidEligible } = require('./factura/eligibility');

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const CUTOFF = 0;   // FACTURA_LAUNCH_CUTOFF_MS stand-in; created_at >= 0 always
const HERMEZ = 'xaHcwaRND1V63w8tpXi5VZ7n9P72';

// An attribution-only write to a terminal order: before → after differ ONLY by delivered_by_*.
const terminalBefore = (status) => ({ status, payment_status: 'confirmed', payment_method: 'online', materialized_at: 1, display_number: 47, factura_status: 'issued', created_at: 2e12 });
const attributionAfter = (before) => ({ ...before, delivered_by_uid: HERMEZ, delivered_by_name: 'Hermez' });

(async () => {
  for (const status of ['delivered', 'completed']) {
    const before = terminalBefore(status);
    const after = attributionAfter(before);

    // allocateDisplayNumberOnSale: mint requires displayNumberEligible (status:'new'). A terminal order → false →
    // NO new number is ever minted on an attribution write. When display_number is present the trigger short-circuits
    // (index.js:2746); when it is MISSING, the re-fire takes the HEAL branch — a benign heal that may RE-STAMP an
    // existing reservation (healing a missing label), but still NEVER mints (isTransition is false either way).
    assert.strictEqual(displayNumberEligible(after), false, `${status}: displayNumberEligible false → NO number minted on an attribution write`);
    assert.strictEqual(displayNumberEligible({ status, payment_status: 'confirmed' }), false, `${status} MISSING display_number: still not a transition → heal may re-stamp an existing reservation, never mints`);

    // notifyStaffOnNewOrder fires on becameLive = eligible(after) && !eligible(before). Status unchanged → false.
    const becameLive = displayNumberEligible(after) && !displayNumberEligible(before);
    assert.strictEqual(becameLive, false, `${status}: notifyStaffOnNewOrder becameLive=false (no staff re-notify on an attribution write)`);

    // allocateFacturaOnSale: eligible ⇒ issue. Use factura_status:'not_due' so the predicate PASSES its first check
    // and actually EXERCISES the status!=='new' guard (a delivered order's 'issued' would short-circuit earlier).
    const notDueAfter = { ...after, factura_status: 'not_due' };
    assert.strictEqual(facturaSaleEligible(notDueAfter, CUTOFF), false, `${status}: facturaSaleEligible false via the STATUS guard (not_due + terminal → no factura on an attribution write)`);
    assert.strictEqual(facturaSaleEligible(after, CUTOFF), false, `${status}: also false for the realistic already-issued order`);

    // voidFacturaOnCancel: eligible ⇒ void. before.status === after.status (unchanged, not 'cancelled') → no void.
    assert.strictEqual(facturaVoidEligible(before, after), false, `${status}: facturaVoidEligible false → no factura void on an attribution write`);
  }
  ok('re-fire: display-number (no mint/heal-only), notifyStaff (no re-notify), factura sale/void (no-op) — proven via the REAL predicates for delivered AND completed');

  // Sensitivity — the predicates are not vacuously false; they DO fire on the genuine transitions.
  assert.strictEqual(displayNumberEligible({ status: 'new', payment_method: 'cash' }), true, 'sensitivity: a real Sale IS display-number eligible');
  assert.strictEqual(facturaSaleEligible({ status: 'new', factura_status: 'not_due', payment_method: 'cash', created_at: 2e12 }, CUTOFF), true, 'sensitivity: a real Sale IS factura eligible');
  assert.strictEqual(facturaVoidEligible({ status: 'delivered' }, { status: 'cancelled' }), true, 'sensitivity: a real cancel IS void eligible');
  const realSaleBefore = { status: 'pending_payment' }, realSaleAfter = { status: 'new', payment_method: 'cash' };
  assert.strictEqual(displayNumberEligible(realSaleAfter) && !displayNumberEligible(realSaleBefore), true, 'sensitivity: a real Sale transition IS becameLive (notifyStaff fires)');
  ok('sensitivity: all four predicates fire on the genuine Sale/cancel transitions (the no-ops above are real, not vacuous)');

  // ── Structural: the two inline-guarded whole-node watchers + the leaf-watcher exclusion ──
  const SRC = fs.readFileSync(require.resolve('./index.js'), 'utf8');
  // materializeOnConfirm: explicit terminal skip (added for close_fulfilled) → a delivered/completed order never re-materializes.
  assert.ok(/if \(after\.status === 'completed' \|\| after\.status === 'delivered'\) return;/.test(SRC), 'materializeOnConfirm skips terminal completed/delivered (no re-materialize on an attribution write)');
  // autoAssignOnOrderCreate: gated on AUTO_ASSIGNABLE_STATUSES — a terminal order is not auto-assignable.
  assert.ok(/AUTO_ASSIGNABLE_STATUSES\.has\(orderNow\.status\)/.test(SRC), 'autoAssignOnOrderCreate gates on AUTO_ASSIGNABLE_STATUSES (a terminal order is skipped)');
  // The attribution write targets /delivered_by_*, NOT /status → the /status-leaf watchers never fire on it.
  const DA = fs.readFileSync(require.resolve('./driver-attribution.js'), 'utf8');
  assert.ok(/orders\/\$\{orderId\}\/delivered_by_uid/.test(DA) && !/orders\/\$\{orderId\}\/status/.test(DA), 'attribution writes /delivered_by_* only, never /status (the /status-leaf watchers do not re-fire)');
  ok('structural: materialize terminal-skip + autoAssign status-gate + /status never written (leaf watchers inert)');

  console.log(`\nAll ${pass} attribution re-fire safety checks passed.`);
})().catch((e) => { console.error('\n✗ FAIL:', e && e.message); process.exit(1); });
