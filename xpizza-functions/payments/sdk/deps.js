'use strict';
// Production dependencies for the SDK coordinator. The real PixelPay adapter waits on PixelPay/BAC's written §7.V answers, so
// production uses an UNCONFIGURED adapter: every call fails, which the adapter contract normalises to `unknown` / `inconclusive`
// — it can only LOCK, never decline, approve, capture or void. No SDK order can be created until the endpoint slice ships.
const { makeAdapter } = require('./psp-adapter');
const { voidEligible, cancelVoidEligible } = require('./void-eligibility');

const UNCONFIGURED = Object.freeze({
  pspAuthorize: async () => { throw new Error('sdk psp adapter not configured'); },
  pspCapture: async () => { throw new Error('sdk psp adapter not configured'); },
  pspVoid: async () => { throw new Error('sdk psp adapter not configured'); },
  pspStatus: async () => { throw new Error('sdk psp adapter not configured'); },
});

// The go-live materializer (ruling #9 A) is the shared confirm-and-materialize, registered ONCE by the composition root with
// confirm dependencies that carry NO refund capability (a closed kitchen parks the order for a person; its money exits only
// through this coordinator). Unregistered ⇒ every go-live fails closed: the order stays placed and the sweeper alerts.
let goLiveImpl = null;
function setSdkGoLive(fn) {
  if (typeof fn !== 'function') throw new Error('sdk go-live: a function is required');
  if (goLiveImpl) throw new Error('sdk go-live: already registered');
  goLiveImpl = fn;
}
async function goLive(dp, orderId) {
  if (!goLiveImpl) throw new Error('sdk go-live: not registered');
  return goLiveImpl(dp.db, orderId);
}

function productionDeps(db) {
  return { db, psp: makeAdapter(UNCONFIGURED), clock: () => Date.now(), voidEligible, cancelVoidEligible, releaseResources: (dp, id, o) => require('./release').releaseSdkOrder(dp, id, o), goLive };
}
module.exports = { productionDeps, UNCONFIGURED, setSdkGoLive };
