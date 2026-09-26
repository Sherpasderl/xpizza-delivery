'use strict';
/**
 * SPLIT 1 money-path guards for "Cerrar como entregado" (resolve-manual close_fulfilled). Run:
 *   node recon-close-fulfilled.test.js
 * The KEEP-PAYMENT terminal close: keep the capture, close terminal, NO void/refund and NO materialize/task/
 * tracking, NO customer message; refuse platform-factura brands (X.Pizza) in SPLIT 1. Behavior is exercised in
 * the emulator; this locks the load-bearing preconditions in source, red-when-reverted (the pure claim/outcome
 * discipline is golden-tested in manual-resolve.test.js).
 */
const fs = require('fs');
const assert = require('assert');
const RM = fs.readFileSync(require.resolve('./resolve-manual.js'), 'utf8');
const IDX = fs.readFileSync(require.resolve('./index.js'), 'utf8');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const between = (h, a, b) => { const ia = h.indexOf(a); assert.ok(ia !== -1, `marker not found: ${a}`); const ib = b ? h.indexOf(b, ia + 1) : h.length; return h.slice(ia, ib === -1 ? h.length : ib); };

// ── The close_fulfilled branch: isolate it (from its label to the next action branch) ──
const branch = between(RM, "if (action === 'close_fulfilled')", "if (action === 'materialize')");

// 1. KEEP PAYMENT — the branch moves NO money and dispatches NOTHING.
assert.ok(!/voidOrRefund|client\.void|voidTransaction/.test(branch), 'close_fulfilled makes ZERO void/refund/provider calls (keep payment)');
assert.ok(!/confirmAndMaterialize|materializeFromManualClaim|genToken|trackingToken|order_tracking|_delivery`|tasks\//.test(branch), 'close_fulfilled does NOT materialize / build a task / mint a tracking token');
ok('close_fulfilled: zero void/refund AND zero materialize/task/tracking (keep-payment, no dispatch)');

// 2. SPLIT 1 fiscal gate — a platform-factura brand (X.Pizza) is refused here (SPLIT 2 issues the factura first).
//    FAIL CLOSED: normalize a missing/empty restaurant_id to 'x_pizza' (legacy default) BEFORE the gate, so an
//    unbranded order can't slip through as non-fiscal and close a SAR sale with no factura.
assert.match(branch, /usesPlatformFactura\(order\.restaurant_id \|\| 'x_pizza'\)/, 'fiscal gate NORMALIZES missing restaurant_id → x_pizza (fail closed on fiscal)');
assert.match(branch, /await releaseClaim\(\);[\s\S]*?outcome: 'fiscal_close_not_enabled'/, 'platform-factura brand → releaseClaim + 409 fiscal_close_not_enabled (no close without a factura)');
ok('close_fulfilled: SPLIT 1 refuses platform-factura brands, fail-closed on a missing brand (releases claim, no terminal write)');

// 3. Keep-payment TERMINAL write (CAS on our claim): confirmed + completed + cleared block + audit stamps.
assert.match(branch, /cur\.resolving_claim_id !== claimId \|\| cur\.payment_status !== MR\.resolvingStatus\('close_fulfilled'\)/, 'terminal write is a CAS on OUR claim (no clobber)');
assert.match(branch, /payment_status: 'confirmed'/, 'keeps payment (payment_status confirmed — captured revenue)');
assert.match(branch, /status: 'completed'/, 'closes terminal as completed (delivered terminal)');
assert.match(branch, /blocked_reason: null/, 'clears blocked_reason');
assert.match(branch, /closed_from_blocked_reason:/, 'carries the original blocked_reason into an audit field');
assert.match(branch, /fulfilled_offline_at: now/, 'stamps fulfilled_offline_at');
assert.match(branch, /resolved_by: actor/, 'stamps resolved_by (dispatcher)');
assert.match(branch, /resolution: 'offline_fulfilled'/, "stamps resolution:'offline_fulfilled'");
assert.match(branch, /reverseRedemptionForOrder\(db, \{ orderId, order, disposition: 'sale'/, 'delivered → sale → consume any redemption (same as materialize-to-sale)');
assert.match(branch, /audit\('closed_fulfilled_offline'/, "audits the closed_fulfilled_offline outcome");
ok('close_fulfilled: CAS keep-payment terminal (confirmed+completed, cleared block, stamped audit, redemption consumed)');

// 4. materializeOnConfirm must SKIP a terminal 'completed'/'delivered' — else confirmed+completed re-materializes
//    (the phantom live order + late notify this action exists to avoid).
const moc = between(IDX, 'exports.materializeOnConfirm', 'exports.');
assert.match(moc, /if \(after\.status === 'completed' \|\| after\.status === 'delivered'\) return;/, "materializeOnConfirm skips terminal completed/delivered (no re-materialize of a closed order)");
ok('materializeOnConfirm: a confirmed + completed/delivered order never re-materializes');

// 5. NO customer message on this path: status:'completed' is not a messaged transition, and the close sets
//    'completed' (never 'delivered'/'cancelled', which DO message). Both directions locked.
const notifyGate = between(IDX, "if (!['out_for_delivery', 'delivered', 'cancelled'].includes(after)) return;", 'isEnabledForRestaurant');
assert.ok(notifyGate.length > 0, 'sendOrderStatusNotifications gates the customer WhatsApp to out_for_delivery/delivered/cancelled only');
assert.ok(!/includes\(after\)/.test(branch) && !/'delivered'|'cancelled'/.test((branch.match(/status: '[^']*'/g) || []).join(' ')), 'close_fulfilled sets status:completed — never delivered/cancelled (no lifecycle message)');
ok('close_fulfilled: fires NO customer lifecycle message (completed is not a messaged transition)');

// 6. Endpoint whitelist admits the new action.
assert.match(IDX, /\['materialize', 'refund', 'keep', 'abandon', 'close_fulfilled'\]\.includes\(action\)/, 'resolve endpoint whitelists close_fulfilled');
ok('resolve endpoint accepts action=close_fulfilled');

console.log(`\nAll ${pass} close_fulfilled money-path placement guards passed.`);
