'use strict';
// RTDB get() guard (PLAN-rtdb-get-once-race-r3 §2.4 fixed point, §2.4 RG-FAMILY-DU). firebase-js-sdk #10653: a pending get() orphans an
// overlapping listener's connection listen. Every RTDB get() left in production code is one the r3 audit RETAINED — keyed by file |
// enclosing function | path template (tools/rtdb-ref-scan.js), never by line — and the deleted_uids family has none at all. A NEW get()
// (or a retained one moved into another function / path) is red until it is audited against the overlap rule and added here.
//   node tools/rtdb-get.guard.test.js
const assert = require('assert');
const S = require('./rtdb-ref-scan');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

// the 32 RETAIN reads of the r3 audit (+ the 4 the scan added: identity-manifest ×3 tools-only, owner-index no listener), count per key
const RETAIN = Object.freeze({
  "catalog/context-source.js|loadPersisted|catalog_snapshot_ctx/{}": 1,
  "catalog/context-writer.js|precheck|{}/{}/head": 1,
  "catalog/identity-integrity-monitor.js|checkRestaurant|{}/{}/audited_through": 1,
  "catalog/identity-integrity-monitor.js|checkRestaurant|{}/{}/boundary": 1,
  "catalog/identity-integrity-monitor.js|get|{}/{}/{}": 1,
  "catalog/identity-manifest.js|divergenceReport|menus/{}": 1,
  "catalog/identity-manifest.js|publishIdentityManifests|{}/{}": 2,
  "catalog/identity-record-verifier.js|loadVersionNode|{}/{}/{}": 1,
  "catalog/identity-record-verifier.js|mirrorValue|catalog_snapshot/{}": 1,
  "catalog/identity-record-writer.js|mirrorVersionId|catalog_snapshot/{}/version": 1,
  "catalog/owner-index.js|readOwnerRestaurants|owner_restaurants/{}": 1,
  "catalog/portal-reads.js|displayName|restaurants/{}/identity/name": 1,
  "catalog/snapshot-fallback.js|makeRtdbMirrorReader|catalog_snapshot/{}": 1,
  "checkout-otp.js|requestCheckoutCode|otp/{}/sends": 1,
  "claim-order.js|claimOrderCore|order_tracking/{}": 1,
  "claim-order.js|claimOrderCore|user_profiles/{}/phone_hash": 1,
  "client-floor.js|read|{}": 1,
  "delivery/delivery-wire.js|loadPricing|platform_config/delivery_pricing": 1,
  "index.js|exports.deleteAccount|user_profiles/{}/phone_hash": 1,
  "index.js|exports.earnRewardsOnCompletion|orders/{}": 1,
  "index.js|exports.mirrorStatusToHistory|orders/{}/customer_uid": 1,
  "index.js|exports.mirrorStatusToHistory|user_orders/{}/{}": 1,
  "index.js|exports.verifyOtp|otp/{}/rid": 1,
  "portal/location-name.js|displayName|restaurants/{}/identity/name": 1,
  "ratings/rate-order.js|purchasedDishIds|user_orders/{}/{}": 1,
  "ratings/rate-order.js|rateOrderCore|orders/{}": 1,
  "rewards-earn.js|reverseEarnForOrder|user_rewards/{}/{}/ledger/earn_{}": 1,
  "rewards-redeem-config.js|redemptionEnabled|config/redemption_allowlist/{}": 1,
  "rewards-redeem-config.js|redemptionEnabled|config/redemption_enabled": 1,
  "rewards-redeem-intake.js|quoteRedemptionCore|user_rewards/{}/{}": 1,
  "token-gate.js|tokenEnforceEnabled|config/token_enforce": 1,
});

const gets = S.scan().filter((r) => r.op === 'get');
const keyOf = (r) => `${r.file}|${r.fn}|${r.path}`;

cell('RG-SCAN: every RTDB receiver resolves (an UNRESOLVED get / write is ruled by hand in rtdb-ref-scan.js, never guessed)', (L) => {
  const un = S.scan().filter((r) => /UNRESOLVED/.test(r.how)).filter((r) => r.op === 'get');
  assert.deepStrictEqual(un.map((r) => `${r.file}:${r.line} ${r.how}`), [], L);
});
cell('RG-FAMILY-DU: no get() reads the deleted_uids family (every tombstone read is a once)', (L) => {
  const du = gets.filter((r) => r.path && (r.path === 'deleted_uids' || r.path.startsWith('deleted_uids/')));
  assert.deepStrictEqual(du.map((r) => `${r.file}:${r.line}`), [], `🔴 ${L}`);
});
cell('RG-RETAIN: every get() left is an audited RETAIN read — nothing else, and each as many times as audited', (L) => {
  const seen = {}; for (const r of gets) seen[keyOf(r)] = (seen[keyOf(r)] || 0) + 1;
  const extra = Object.keys(seen).filter((k) => !(k in RETAIN) || seen[k] > RETAIN[k]).map((k) => `${k} ×${seen[k]} — ${gets.filter((r) => keyOf(r) === k).map((r) => `${r.file}:${r.line}`).join(', ')}`);
  assert.deepStrictEqual(extra, [], `🔴 ${L}: get() reads outside the audited RETAIN set`);
});
cell('RG-RETAIN-LIVE: every RETAIN entry still names a live read (a stale entry would silently re-admit a get there)', (L) => {
  const seen = new Set(gets.map(keyOf));
  assert.deepStrictEqual(Object.keys(RETAIN).filter((k) => !seen.has(k)), [], L);
});
if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
console.log(`rtdb-get.guard: OK (${n})`);
