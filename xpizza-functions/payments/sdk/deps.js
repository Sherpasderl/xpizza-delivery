'use strict';
// Production dependencies for the SDK coordinator. The real PixelPay adapter waits on PixelPay/BAC's written §7.V answers, so
// production uses an UNCONFIGURED adapter: every call fails, which the adapter contract normalises to `unknown` / `inconclusive`
// — it can only LOCK, never decline, approve, capture or void. No SDK order can be created until the endpoint slice ships.
const { makeAdapter } = require('./psp-adapter');
const { voidEligible } = require('./void-eligibility');

const UNCONFIGURED = Object.freeze({
  authorize: async () => { throw new Error('sdk psp adapter not configured'); },
  capture: async () => { throw new Error('sdk psp adapter not configured'); },
  void: async () => { throw new Error('sdk psp adapter not configured'); },
  status: async () => { throw new Error('sdk psp adapter not configured'); },
});

function productionDeps(db) {
  return { db, psp: makeAdapter(UNCONFIGURED), now: () => Date.now(), voidEligible, release: (dp, id, o) => require('./release').releaseSdkOrder(dp, id, o) };
}
module.exports = { productionDeps, UNCONFIGURED };
