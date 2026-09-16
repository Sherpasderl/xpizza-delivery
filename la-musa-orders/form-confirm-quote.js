// Portal 1C Task 7 — THE CONFIRMED-QUOTE TOKEN, CLIENT SIDE.
//
// WHAT THIS IS AND IS NOT. The server is authoritative: it reprices every order and gates every charge
// (1C T4/T5), so nothing here can move money. A missing or stale token only changes which SERVER path
// runs — signed gate, unsigned floor, or grace. That is the whole reason this module can be simple and
// the reason its one hard rule is about SEAMLESSNESS rather than safety:
//
//   🔴 NEVER ATTACH A TOKEN THAT WAS NOT ISSUED FOR THE CART BEING SENT.
//
// A stale-for-cart token is strictly worse than no token. With no token the server falls to the
// unsigned floor or to grace and the order goes through. With the WRONG token the server's cart
// fingerprint refuses it — a 409 on an order that was never in doubt, and in T8 a re-confirm sheet in
// front of a customer who changed nothing. So every attach is conditional on the signature matching,
// and the failure direction is always "attach nothing".
//
// EXPIRY IS DELIBERATELY INVISIBLE. The token carries its own expiry, and this module never looks at
// it: decoding the payload would couple the client to the token's internal format, so a server-side
// format change would silently break refresh timing. Instead a fixed cadence well under the issuance
// window keeps a fresh token in hand, and the client never needs to know what "fresh" means.
(function () {
  'use strict';

  function createConfirmQuote(opts) {
    opts = opts || {};
    var requote = typeof opts.requote === 'function' ? opts.requote : function () {};
    var now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    // Well under the 15-minute issuance window. Not derived from the token: see the header.
    var REFRESH_MS = typeof opts.refreshMs === 'number' && opts.refreshMs > 0 ? opts.refreshMs : 10 * 60 * 1000;
    var setTimer = opts.setInterval || (typeof setInterval === 'function' ? setInterval : null);
    var clearTimer = opts.clearInterval || (typeof clearInterval === 'function' ? clearInterval : null);

    var stored = null;        // { token, cart_sig, net, at }
    var needsRefresh = false;
    var timer = null;

    /* A quote landed. `cartSig` is the signature captured when the request was SENT, not read now —
       the caller owns that discipline (the same one 1B's __serverQuote.inflight token enforces), because
       by the time a response arrives the cart on screen may be a different cart entirely.
       A response with no quote_token is ORDINARY, not a failure: the server issues token-less whenever
       QUOTE_TOKEN_SECRET is unset, and every client ran that way before this shipped. It clears rather
       than keeps, because "the current cart has no signed quote" is the truth in that case, and holding
       an older token would only produce a mismatch later. */
    function store(resp, cartSig) {
      if (!resp || typeof resp !== 'object' || !resp.quote_token || typeof resp.quote_token !== 'string') {
        stored = null;
        needsRefresh = false;      // nothing to refresh TOWARD — the server is not issuing
        return false;
      }
      stored = {
        token: resp.quote_token,
        cart_sig: cartSig == null ? null : String(cartSig),
        net: typeof resp.net_total_cents === 'number' ? resp.net_total_cents : null,
        at: now(),
      };
      needsRefresh = false;
      return true;
    }

    function matches(cartSig) {
      return !!(stored && stored.cart_sig !== null && cartSig != null && stored.cart_sig === String(cartSig));
    }

    // The token for THIS cart, or null. Never "the most recent token".
    function current(cartSig) {
      return matches(cartSig) ? stored : null;
    }

    /* 🔴 THE ATTACH. Additive and conditional: on a match the body gains quote_token and is otherwise
       untouched; on a mismatch the body is not touched AT ALL, which is what makes a token-less send
       byte-identical to the one that shipped before 1C. Returns whether it attached, so a caller (T8)
       can tell "gated" from "grace" without re-deriving it. */
    function attach(body, cartSig) {
      if (!body || typeof body !== 'object') return false;
      if (!matches(cartSig)) { needsRefresh = true; return false; }
      body.quote_token = stored.token;
      return true;
    }

    /* Keep a fresh token in hand at pay-tap. The existing triggers (every cart change, and every
       pay-step render) already re-quote on the events that CHANGE the cart; this covers the one case
       they cannot — a customer who reaches checkout and simply waits. Idempotent: calling it twice does
       not stack timers, which matters because the pay step re-renders on every edit. */
    function scheduleRefresh() {
      if (timer !== null || !setTimer) return false;
      timer = setTimer(function () { try { requote(); } catch (_) {} }, REFRESH_MS);
      return true;
    }
    function stopRefresh() {
      if (timer === null) return false;
      try { if (clearTimer) clearTimer(timer); } catch (_) {}
      timer = null;
      return true;
    }

    // Enough for T8's pay-tap machine to decide between sending, re-quoting, or showing a sheet.
    function state(cartSig) {
      return {
        hasToken: !!stored,
        freshForCart: matches(cartSig),
        needsRefresh: needsRefresh,
        net: stored ? stored.net : null,
        refreshing: timer !== null,
      };
    }

    function reset() { stored = null; needsRefresh = false; stopRefresh(); }

    return {
      store: store, current: current, attach: attach,
      scheduleRefresh: scheduleRefresh, stopRefresh: stopRefresh,
      state: state, reset: reset,
    };
  }

  // Published to BOTH worlds: the same bytes load as a Node module under `node --test` and as a classic
  // browser script inside the form. No ESM syntax anywhere — see form-cart.js for the same discipline.
  if (typeof module !== 'undefined' && module.exports) module.exports = { createConfirmQuote: createConfirmQuote };
  if (typeof window !== 'undefined') window.createConfirmQuote = createConfirmQuote;
})();
