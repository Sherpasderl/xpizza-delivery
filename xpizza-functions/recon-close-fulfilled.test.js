'use strict';
/**
 * Money-path guards for "Cerrar como entregado" (resolve-manual close_fulfilled). Run:
 *   node recon-close-fulfilled.test.js
 * The KEEP-PAYMENT terminal close: keep the capture, close terminal, NO void/refund and NO materialize/task/
 * tracking, NO customer message. SPLIT 2: a platform-factura brand (X.Pizza) ISSUES the SAR factura via the real
 * issuer (allocateFacturaNumber) BEFORE the close, and an issuance failure does NOT close (always-invariant); a
 * non-platform brand (La Musa) closes directly. Behavior is exercised end-to-end in recon-close-fulfilled-fiscal.
 * test.js (real issuer + fake db); this locks the load-bearing SOURCE preconditions red-when-reverted (the pure
 * claim/outcome discipline is golden-tested in manual-resolve.test.js).
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

// 2. SPLIT 2 fiscal path — a platform-factura brand (X.Pizza) ISSUES the SAR factura (real issuer,
//    allocateFacturaNumber) BEFORE the terminal close; the ALWAYS-INVARIANT is that issuance failure does NOT close.
//    FAIL CLOSED on brand: normalize a missing/empty restaurant_id to 'x_pizza' (legacy default) so an unbranded
//    order takes the FISCAL path, never slips through as non-fiscal and closes a SAR sale with no factura.
//    (The always-invariant is EXECUTED end-to-end in recon-close-fulfilled-fiscal.test.js; this locks placement.)
assert.match(branch, /const restaurantId = order\.restaurant_id \|\| 'x_pizza';/, 'brand NORMALIZED to x_pizza (fail closed on fiscal — an unbranded order takes the fiscal path)');
assert.match(branch, /if \(usesPlatformFactura\(restaurantId\)\)/, 'only a platform-factura brand issues (La Musa / external POS closes directly)');
assert.ok(!/fiscal_close_not_enabled/.test(branch), 'SPLIT 1 refusal REMOVED — a platform brand now issues the factura, it is not refused');
// Field-presence mirrors allocateFacturaOnSale: a Sale missing priced fields is a factura FAILURE, not a close.
assert.match(branch, /!Array\.isArray\(order\.items\)[\s\S]*?order\.total_cents == null[\s\S]*?order\.subtotal_cents == null[\s\S]*?order\.tax_cents == null/, 'field-presence check mirrors the trigger (missing priced fields → factura failure, not a close)');
// Issuance uses the REAL issuer, and it happens BEFORE the terminal keep-payment write (no close without a factura).
assert.match(branch, /allocateFacturaNumber\(db, \{/, 'issues via the REAL factura issuer (allocateFacturaNumber — same path materialize uses), not a hand-built record');
const iIssue = branch.indexOf('allocateFacturaNumber(db');
const iClose = branch.indexOf("payment_status: 'confirmed'");
assert.ok(iIssue !== -1 && iClose !== -1 && iIssue < iClose, 'factura is ISSUED before the terminal keep-payment close (a failed issuance can never reach the close)');
// ALWAYS-INVARIANT: issuance failure (or a throw) → releaseClaim + 409 factura_failed, and NO terminal write.
assert.match(branch, /if \(!fr \|\| !fr\.ok\)/, 'the issuance result is checked (ok gate)');
assert.match(branch, /if \(!fr \|\| !fr\.ok\)[\s\S]*?await releaseClaim\(\);[\s\S]*?outcome: 'factura_failed'/, 'issuance failure → releaseClaim + 409 factura_failed (do NOT close — order left parked for retry)');
const iFail = branch.search(/if \(!fr \|\| !fr\.ok\)/);
assert.ok(iFail !== -1 && iFail < iClose, 'the failure return sits BEFORE the terminal write (issuance-failure short-circuits the close)');
assert.match(branch, /catch \(e\)[\s\S]*?fr = \{ ok: false, reason: 'threw' \}/, 'a THROW from the issuer is caught and treated as a failure (still no close)');
ok('close_fulfilled: SPLIT 2 X.Pizza issues the factura (real issuer) BEFORE closing; issuance-failure/throw → no close (always-invariant, placement)');

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
