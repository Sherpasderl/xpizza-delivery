'use strict';
// BRIEF-sdk-payment-coordinator r5 §4b — the REVIEWED inventory of every server writer of an order's `status`, ratcheted against
// the census (contract/census.json, itself guarded equal to the code by census.guard). A new status writer fails here until
// it is classified for SDK card orders (refused / predicate in its own orders transaction / unreachable / creation only).
// Run: node payments/sdk/status-writers.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const REVIEWED = Object.freeze({
  'index.js#createOrderApp.all#status#update': 'creation only (no prior status)',
  'index.js#chargeOnlineApp.all#status#transaction-updater/via:acquireHostedAttempt': '§2 refusal for SDK (pre-read + inside the acquisition txn)',
  'index.js#refundReconciler#status#update': '§2 refusal (both loops skip SDK orders)',
  'materialize-guard.js#holdIfClosedAtMaterialize#status#update': 'legacy materialize only — reached via confirmAndMaterialize, which refuses SDK',
  'merchant/merchant-orders.js#runOrderActionDetailed#status#transaction-updater': 'predicate in its txn: refuses payment_terminal / payment_cancel; handed → completed writes payment_terminal (§4a)',
  'pixelpay-confirm.js#confirmAndMaterialize#status#update': '§2 refusal (a second guard; covers materializeOnConfirm)',
  'pixelpay-confirm.js#confirmOnlinePayment#status#update': '§2 refusal (right after the order load)',
  'pixelpay-hosted-webhook.js#voidPaid#status#update': '§2 refusal (the hosted callback ignores SDK orders)',
  'resolve-manual.js#confirmAndMaterializeFromManualClaim#status#update': '§2 refusal (resolveManualReconciliationCore refuses SDK before any claim)',
  'resolve-manual.js#recoverStaleResolve#status#transaction-updater': '§2 refusal (no SDK order is ever claimed by a manual resolve)',
  'resolve-manual.js#resolveManualReconciliationCore#status#transaction-updater': '§2 refusal before any claim (409, audited)',
  'resolve-manual.js#resolveManualReconciliationCore#status#update': '§2 refusal before any claim (409, audited)',
  'cancel-order-core.js#finalize#status#transaction-updater': 'SDK cancels route to the coordinator before finalize is reachable',
  'scheduled-release-core.js#claimForRelease#status#transaction-updater': 'predicate in its txn: refuses SDK / payment_terminal / payment_cancel',
  'scheduled-release-core.js#finalizeRelease#status#update': '§2 refusal at ENTRY (an SDK order returns before any write); its callers refuse SDK too — the fresh claim in its txn, the stale-releasing recovery in its re-claim txn (Codex r1 #3); legacy writes kept byte-identical',
  'scheduled-release-core.js#rollbackClaim#status#update': 'reached only from finalizeRelease, after its SDK entry refusal (Codex r1 #3)',
  'payments/sdk/coordinator.js#cancelSdkOrder#status#transaction-updater': 'the SDK cancel / expiry DECISION: an orders txn requiring a non-terminal status, no payment_terminal, no payment_cancel (§8)',
});
const census = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'contract', 'census.json'), 'utf8'));
const keys = [...new Set(JSON.stringify(census).match(/"key":"[^"]*#status#[^"]*"/g) || [])].map((k) => k.slice(7, -1).replace(/^xpizza-functions\//, '')).sort();
assert.ok(keys.length > 0, 'non-vacuity: the census records status writers');
assert.deepStrictEqual(keys, Object.keys(REVIEWED).sort(), `🔴 the order-status writers changed — classify every new one for SDK card orders (BRIEF r5 §4b) before it ships:\n${keys.filter((k) => !REVIEWED[k]).join('\n') || '(a reviewed writer disappeared)'}`);
for (const [k, why] of Object.entries(REVIEWED)) assert.ok(typeof why === 'string' && why.length > 10, `${k}: a disposition is required`);
console.log(`  ✓ 1 the census's ${keys.length} order-status writers equal the reviewed §4b inventory`);
console.log('\nsdk status-writers.guard: OK (1)');
