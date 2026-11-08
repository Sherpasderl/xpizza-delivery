'use strict';
// Production dependencies for the SDK coordinator. The real PixelPay adapter waits on PixelPay/BAC's written §7.V answers, so
// production uses an UNCONFIGURED adapter: every call fails, which the adapter contract normalises to `unknown` / `inconclusive`
// — it can only LOCK, never decline, approve, capture or void. No SDK order can be created until the endpoint slice ships.
const { makeAdapter } = require('./psp-adapter');
const { voidEligible } = require('./void-eligibility');

const UNCONFIGURED = Object.freeze({
  pspAuthorize: async () => { throw new Error('sdk psp adapter not configured'); },
  pspCapture: async () => { throw new Error('sdk psp adapter not configured'); },
  pspVoid: async () => { throw new Error('sdk psp adapter not configured'); },
  pspStatus: async () => { throw new Error('sdk psp adapter not configured'); },
});

function productionDeps(db) {
  return { db, psp: makeAdapter(UNCONFIGURED), clock: () => Date.now(), voidEligible, releaseResources: (dp, id, o) => require('./release').releaseSdkOrder(dp, id, o) };
}
module.exports = { productionDeps, UNCONFIGURED };
