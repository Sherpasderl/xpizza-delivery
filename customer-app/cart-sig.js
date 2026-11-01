// PLAN-guest-checkout-server r4 §1.4 (D3 re-ruled (i)) — THE cart signature, ONE source. The customer app signs a cart with it
// (its cartSig) and the functions recompute it from a guest's placement body (the checkout ticket's cart_fp binding).
// CANONICAL file: platform/client/cart-sig.js. Deployed copies (byte-identical, written by `npm run sync:client`, guarded by
// cart-sig-sync.guard.test.js): xpizza-functions/cart-sig.js and every platform-context orders deployment's folder.
//   canonicalJson(v)           sorted keys, undefined keys dropped, undefined → null (lifted verbatim from capp-checkout.js)
//   cartSigInput(o)            the canonical six-field object {restaurant_id, items, order_type, pin, uid, tip_cents}
//   cartSigHex(o, digest)      lowercase hex sha256 of canonicalJson(cartSigInput(o)); `digest(bytes)` is INJECTED
//                              (WebCrypto subtle.digest in the browser, node crypto on the server) → a Promise<string>
// Pure, UMD, brand-agnostic.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CartSig = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function canonicalJson(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  }

  function cartSigInput(o) {
    return { restaurant_id: o.restaurant_id, items: o.items, order_type: o.order_type, pin: o.pin, uid: o.uid, tip_cents: o.tip_cents };
  }

  function cartSigHex(o, digest) {
    const bytes = new TextEncoder().encode(canonicalJson(cartSigInput(o)));
    return Promise.resolve(digest(bytes)).then((h) => Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join(''));
  }

  return { canonicalJson, cartSigInput, cartSigHex };
});
