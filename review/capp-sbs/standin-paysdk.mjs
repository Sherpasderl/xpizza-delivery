// SBS-STANDIN-PAYSDK — the side-by-side harness's STAND-IN for the PixelPay binding (advisor 11-09, SBS method (A)). HARNESS ONLY:
// no production file references it and no packaged bundle contains it (customer-app/capp-guards.test.mjs proves both). The real
// binding (the vendored @pixelpay/capacitor-plugin + its native secure fields) belongs to the native-shell slice, which OWES a
// real-plugin SBS of frame 3 and 4c; until then frame 3's field pixels are classified «STAND-IN (native field host)».
//
// What it is: a pre-boot script (Page.addScriptToEvaluateOnNewDocument) that traps the assignment of self.CappShellUI and wraps its
// mount so CappUI.mount receives `uiOpts.paySdk` = the bundle's OWN strict wrapper (CappPaySdk.createPaySdk, which validates every
// return exactly as production will) around a raw binding, plus a field host. The host draws the approved mockup's own <input>
// markup (frame 3: mid-entry; 3·dark: all valid) and pushes the field states formVm reads — the states the native host will push.
// The raw binding returns ONLY the keys the wrapper accepts (as strict as test/fake-sdk-checkout.mjs: an extra key fails the token).
const FIELDS = {
  // MOCKUP-capp-S2-sdk-checkout.html frame 3 «mid-entry» (the expiry invalid and touched, the CVV focused and empty)
  mid: {
    html: {
      number: '<input id="c-num" inputmode="numeric" autocomplete="cc-number" value="4242 4242 4242 4242">',
      expiry: '<input id="c-exp" inputmode="numeric" autocomplete="cc-exp" value="13 / 27" placeholder="MM / AA">',
      cvv: '<input id="c-cvv" inputmode="numeric" autocomplete="cc-csc" value="" class="focus" placeholder="3 dígitos">',
      name: '<input id="c-name" autocomplete="cc-name" value="Ana Mejía" placeholder="Como aparece en la tarjeta">',
    },
    states: { number: { state: 'valid', brand: 'visa', touched: true }, expiry: { state: 'invalid', touched: true }, cvv: { state: 'empty', touched: false }, name: { state: 'valid', touched: true } },
  },
  // frame 3 · dark «all fields valid»
  valid: {
    html: {
      number: '<input id="c-num" inputmode="numeric" autocomplete="cc-number" value="4242 4242 4242 4242">',
      expiry: '<input id="c-exp" inputmode="numeric" autocomplete="cc-exp" value="12 / 28" placeholder="MM / AA">',
      cvv: '<input id="c-cvv" inputmode="numeric" autocomplete="cc-csc" value="•••" placeholder="3 dígitos">',
      name: '<input id="c-name" autocomplete="cc-name" value="Ana Mejía" placeholder="Como aparece en la tarjeta">',
    },
    states: { number: { state: 'valid', brand: 'visa', touched: true }, expiry: { state: 'valid', touched: true }, cvv: { state: 'valid', touched: true }, name: { state: 'valid', touched: true } },
  },
};
export const STANDIN_MARKER = 'SBS-STANDIN-PAYSDK';
export function standinPaySdk(fields = 'mid') {
  const f = FIELDS[fields]; if (!f) throw new Error(`standin-paysdk: no field set ${fields}`);
  return `/* ${STANDIN_MARKER} */ (() => {
  const F = ${JSON.stringify(f)};
  const raw = {
    available: () => true,
    tokenize: async () => ({ sdk_token: 'sbs-standin-token', authentication_identifier: null, display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028 } }),
    continue3ds: async () => ({ sdk_result: { sbs: true } }),
  };
  const fieldHost = { input: (k) => F.html[k] || '', onChange: (cb) => { const t = setTimeout(() => cb(JSON.parse(JSON.stringify(F.states))), 0); return () => clearTimeout(t); } };
  let real;
  Object.defineProperty(self, 'CappShellUI', { configurable: true, enumerable: true, get: () => real, set: (v) => {
    if (!v || typeof v.mount !== 'function' || !self.CappPaySdk) { real = v; return; }
    const paySdk = { ...self.CappPaySdk.createPaySdk(raw), fieldHost };
    real = { ...v, mount: (doc, o) => v.mount(doc, { ...(o || {}), uiOpts: { ...((o && o.uiOpts) || {}), paySdk } }) };
  } });
})();`;
}
