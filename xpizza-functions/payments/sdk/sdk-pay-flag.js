'use strict';
// §9 «tarjeta temporalmente no disponible» (PLAN-sdk-d4-r5). platform_config/sdk_pay = { available, reason, since, retry_after_s,
// restaurants: { <rid>: true } } — written only by Admin (platform_config denies clients). It gates NEW attempts only; status,
// recovery and cancellation are never blocked by it. Absent / malformed ⇒ unavailable (fail-closed); no allowlist ⇒ no restaurant.
const DEFAULT_RETRY_S = 300;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const read = async (db) => { const v = (await db.ref('platform_config/sdk_pay').once('value')).val(); return isObj(v) ? v : null; };
const retryOf = (v) => (v && Number.isInteger(v.retry_after_s) && v.retry_after_s > 0 ? v.retry_after_s : DEFAULT_RETRY_S);
// the public GET sdkPayStatus body — exactly the client's keys
async function sdkPayStatusCore(db) {
  const v = await read(db);
  return { available: !!v && v.available === true, retry_after_s: retryOf(v) };
}
async function newAttemptsAllowed(db, restaurantId) {
  const v = await read(db);
  return !!v && v.available === true && isObj(v.restaurants) && typeof restaurantId === 'string' && v.restaurants[restaurantId] === true;
}
module.exports = { sdkPayStatusCore, newAttemptsAllowed, DEFAULT_RETRY_S, retryOf };
