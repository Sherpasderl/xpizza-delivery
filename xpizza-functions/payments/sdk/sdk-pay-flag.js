'use strict';
// §9 «tarjeta temporalmente no disponible» (PLAN-sdk-d4-r5). platform_config/sdk_pay = { available, reason, since, retry_after_s,
// restaurants: { <rid>: true } } — written only by Admin (platform_config denies clients). It gates NEW attempts only; status,
// recovery and cancellation are never blocked by it. Absent / malformed ⇒ unavailable (fail-closed); no allowlist ⇒ no restaurant.
const DEFAULT_RETRY_S = 300;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const read = async (db) => { const v = (await db.ref('platform_config/sdk_pay').once('value')).val(); return isObj(v) ? v : null; };
const retryOf = (v) => (v && Number.isInteger(v.retry_after_s) && v.retry_after_s > 0 ? v.retry_after_s : DEFAULT_RETRY_S);
const { RID_RE } = require('../../platform-manifest');   // the platform's ONE restaurant-id grammar (the manifest's)
// THE rule (one place): new attempts for this restaurant — the flag on AND its allowlist entry exactly true
const allowedIn = (v, restaurantId) => !!v && v.available === true && isObj(v.restaurants) && typeof restaurantId === 'string' && v.restaurants[restaurantId] === true;
// the public GET sdkPayStatus body — exactly the client's keys. Without a restaurant (rid === undefined): the GLOBAL flag, as before.
// With one (advisor Q2 RULED 2026-11-12, ?restaurant_id=): THAT restaurant's availability ≡ the placement gate; a malformed or unknown
// rid answers unavailable (no existence oracle beyond the public directory)
async function sdkPayStatusCore(db, rid) {
  const v = await read(db);
  if (rid === undefined) return { available: !!v && v.available === true, retry_after_s: retryOf(v) };
  return { available: typeof rid === 'string' && RID_RE.test(rid) && allowedIn(v, rid), retry_after_s: retryOf(v) };
}
async function newAttemptsAllowed(db, restaurantId) {
  return allowedIn(await read(db), restaurantId);
}
module.exports = { sdkPayStatusCore, newAttemptsAllowed, DEFAULT_RETRY_S, retryOf };
