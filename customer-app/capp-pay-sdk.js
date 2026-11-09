// Customer app — S2-checkout: the ONE boundary to the PixelPay SDK / `@pixelpay/capacitor-plugin` (PLAN §2 steps 1–3; CONTRACT-sdk-
// checkout r3 §2.1 `card.new`, §8 the 3DS continuation, VENDOR-provisional). The binding itself (the vendored plugin + the merchant's
// public-key runtime key) belongs to the native-shell slice (advisor Q8); this file is the interface and its strict wrapper:
//   available()          → boolean — false for no binding, a throw, or anything but true (frame 7; never a hosted fallback, §2.8)
//   tokenize(fields)     → { ok: true, sdk_token, authentication_identifier, display: { brand, last4, exp_month, exp_year } } | { ok: false }
//                          `fields` is the abstract field implementation (DOM or native secure fields — advisor Q9, PCI unsettled):
//                          the card data goes device → PixelPay inside the binding, never through this file or our servers
//   continue3ds(challenge) → { ok: true, sdk_result } | { ok: false }
// Whatever the binding returns is validated: an extra key (a PAN, a CVV), a bad display or a throw is a FAILURE, never a token. Nothing
// is ever logged (SDK request objects carry card data — §2 step 1).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappPaySdk = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const obj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
  const str = (s) => typeof s === 'string' && s !== '';
  const keys = (o, k) => obj(o) && Object.keys(o).sort().join() === [...k].sort().join();
  const BRANDS = ['visa', 'mastercard', 'amex', 'other'];
  const displayOk = (d) => keys(d, ['brand', 'last4', 'exp_month', 'exp_year']) && BRANDS.includes(d.brand) && typeof d.last4 === 'string' && /^\d{4}$/.test(d.last4)
    && Number.isInteger(d.exp_month) && d.exp_month >= 1 && d.exp_month <= 12 && Number.isInteger(d.exp_year) && d.exp_year >= 1000 && d.exp_year <= 9999;
  const tokenOk = (t) => keys(t, ['sdk_token', 'authentication_identifier', 'display']) && str(t.sdk_token) && (t.authentication_identifier === null || str(t.authentication_identifier)) && displayOk(t.display);
  const FAIL = Object.freeze({ ok: false });
  const quiet = async (f) => { try { return await f(); } catch (_) { return undefined; } };   // never rethrown, never logged

  function createPaySdk(impl) {
    const b = obj(impl) ? impl : {};
    return {
      async available() { return typeof b.available === 'function' && (await quiet(() => b.available())) === true; },
      async tokenize(fields) {
        if (typeof b.tokenize !== 'function') return { ...FAIL };
        const t = await quiet(() => b.tokenize(fields));
        return tokenOk(t) ? { ok: true, sdk_token: t.sdk_token, authentication_identifier: t.authentication_identifier, display: { ...t.display } } : { ...FAIL };
      },
      async continue3ds(challenge) {
        if (typeof b.continue3ds !== 'function') return { ...FAIL };
        const r = await quiet(() => b.continue3ds(challenge));
        return keys(r, ['sdk_result']) && r.sdk_result !== undefined && r.sdk_result !== null ? { ok: true, sdk_result: r.sdk_result } : { ...FAIL };
      },
    };
  }

  return { createPaySdk };
});
