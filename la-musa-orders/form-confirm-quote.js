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
    // Resolved at CALL time, not construction: the store is built while the form script is still
    // loading, and binding the host's timer functions then makes them unobservable afterwards — which
    // also made the refresh untestable through the real wiring, where the defect actually lived.
    function timerFns() {
      return {
        set: opts.setInterval || (typeof setInterval === 'function' ? setInterval : null),
        clear: opts.clearInterval || (typeof clearInterval === 'function' ? clearInterval : null),
      };
    }

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
    /* Arming also RE-QUOTES IMMEDIATELY, which is the difference between "a fresh token from now on"
       and "a fresh token ten minutes from now". A customer can sit on the menu step well past the
       issuance window and then walk into checkout: entry renders from cache, issues nothing, and the
       first tick is a full interval away — so the token at the pay-tap is already expired, which is
       precisely the friction this exists to prevent. Arming happens once per entry (idempotent below),
       so the immediate tick is once per entry too, not once per render. */
    function scheduleRefresh() {
      var fns = timerFns();
      if (timer !== null || !fns.set) return false;
      timer = fns.set(function () { try { requote(); } catch (_) {} }, REFRESH_MS);
      try { requote(); } catch (_) {}
      return true;
    }
    function stopRefresh() {
      if (timer === null) return false;
      try { var c = timerFns().clear; if (c) c(timer); } catch (_) {}
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

    /* ── T8: WHAT GOES ON THE WIRE ────────────────────────────────────────────────────────────────
       Three outcomes, and the customer must never feel the difference between them:
         signed   — a token for this exact body. The server runs the full gate.
         degraded — no usable token, so the body carries the net the customer was SHOWN as an unsigned
                    ceiling. T6 accepts that even under enforcement, and it is money-safe by
                    construction: the server charges its own recompute and only ever compares against
                    the ceiling, so this number can refuse a sale but can never become the price.
         bare     — neither. Only when there is no displayed net to stand behind either.
       Deliberately NOT a blocking pre-send re-quote: T7 keeps a fresh token in hand, so this path is
       rare, and when it does happen the degraded floor is immediate. Adding a round-trip would buy
       latency on every rare case in exchange for nothing the server does not already guarantee.
       expectedNetCents is the caller's BUILD-TIME figure for the same reason the signature is — see
       the header. */
    function send(body, cartSig, expectedNetCents) {
      if (!body || typeof body !== 'object') return 'bare';
      if (attach(body, cartSig)) return 'signed';
      if (typeof expectedNetCents === 'number' && Number.isFinite(expectedNetCents)
          && Math.floor(expectedNetCents) === expectedNetCents && expectedNetCents >= 0) {
        body.expected_net_cents = expectedNetCents;
        return 'degraded';
      }
      return 'bare';
    }

    /* The server's answer, reduced to the only distinction the customer can feel. `price_increase` is
       the ONE thing worth interrupting someone for: the number changed and they have not agreed to the
       new one. `stale_quote` is a bookkeeping mismatch — a fingerprint that no longer lines up — which
       says nothing about the price and must be recovered silently. Everything else is not ours. */
    function classify(err) {
      if (!err || typeof err !== 'object') return null;
      if (err.error === 'price_increased') return 'price_increase';
      if (err.error === 'quote_required' || err.error === 'quote_invalid') return 'stale_quote';
      return null;
    }

    return {
      store: store, current: current, attach: attach, send: send, classify: classify,
      scheduleRefresh: scheduleRefresh, stopRefresh: stopRefresh,
      state: state, reset: reset,
    };
  }

  /* ── T8: THE ONE VISIBLE FRICTION ────────────────────────────────────────────────────────────────
     A re-confirm sheet, shown for exactly one reason: the price went UP and the customer has not
     agreed to the new one. Drops, expiry, quote outages and stale fingerprints are all recovered
     without a pixel changing — the absence of this sheet is the feature.

     IT LIVES IN THE SHARED MODULE, not in each form's chrome. x_pizza has a pk-modal to copy and
     la_musa has none, so mirroring by hand would have meant writing the money-critical sheet twice,
     in two files, with a byte-parity test as the only thing holding them together. One implementation
     cannot drift.

     EVERY STRING GOES IN AS textContent — not safeText, not escaped interpolation. The amounts are
     server-supplied and the copy is authored, so escaping would be adequate; textContent is stronger
     because nothing is ever parsed as HTML in the first place, and it cannot be weakened by a later
     edit that reaches for innerHTML "just for the icon". The icon is an inline monochrome SVG for the
     same reason it is not an emoji: form chrome should not be carrying a colour picture. */
  function confirmPriceSheet(opts) {
    opts = opts || {};
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.body) return Promise.resolve(false);
    var fmt = typeof opts.formatMoney === 'function' ? opts.formatMoney
      : function (cents) { return 'L ' + (cents / 100).toFixed(2); };

    var wrap = doc.createElement('div');
    wrap.className = 'cq-sheet';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'cq-sheet-title');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;'
      + 'justify-content:center;background:rgba(0,0,0,.45)';

    var card = doc.createElement('div');
    card.style.cssText = 'background:#fff;color:#111;width:100%;max-width:480px;border-radius:16px 16px 0 0;'
      + 'padding:20px 18px calc(18px + env(safe-area-inset-bottom,0px));box-shadow:0 -8px 32px rgba(0,0,0,.25)';

    var icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('width', '22'); icon.setAttribute('height', '22');
    icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '2');
    icon.setAttribute('aria-hidden', 'true');
    icon.style.cssText = 'vertical-align:-4px;margin-right:8px';
    var p1 = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    p1.setAttribute('d', 'M12 8v5M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z');
    p1.setAttribute('stroke-linecap', 'round'); p1.setAttribute('stroke-linejoin', 'round');
    icon.appendChild(p1);

    var title = doc.createElement('div');
    title.id = 'cq-sheet-title';
    title.style.cssText = 'font-weight:700;font-size:17px;margin-bottom:6px;display:flex;align-items:center';
    var titleText = doc.createElement('span');
    titleText.textContent = 'El precio cambió';
    title.appendChild(icon); title.appendChild(titleText);

    var body = doc.createElement('div');
    body.style.cssText = 'font-size:15px;line-height:1.45;margin-bottom:16px';
    body.textContent = fmt(opts.oldCents) + ' \u2192 ' + fmt(opts.newCents)
      + '. Confirmá para continuar con el precio nuevo.';

    var row = doc.createElement('div');
    row.style.cssText = 'display:flex;gap:10px';
    var cancel = doc.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancelar';
    cancel.style.cssText = 'flex:1;padding:13px;border-radius:10px;border:1px solid #ccc;background:#fff;font-size:15px';
    var confirm = doc.createElement('button');
    confirm.type = 'button'; confirm.textContent = 'Confirmar';
    confirm.style.cssText = 'flex:2;padding:13px;border-radius:10px;border:0;background:#111;color:#fff;font-size:15px;font-weight:600';
    row.appendChild(cancel); row.appendChild(confirm);

    card.appendChild(title); card.appendChild(body); card.appendChild(row);
    wrap.appendChild(card);
    doc.body.appendChild(wrap);

    return new Promise(function (resolve) {
      var done = false;
      function finish(ok) {
        if (done) return;                       // a double-tap must not resend twice
        done = true;
        try { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } catch (_) {}
        resolve(ok);
      }
      confirm.addEventListener('click', function () { finish(true); });
      cancel.addEventListener('click', function () { finish(false); });
      // Tapping the scrim cancels; tapping the card itself must not.
      wrap.addEventListener('click', function (e) { if (e.target === wrap) finish(false); });
      try { confirm.focus(); } catch (_) {}
    });
  }

  // Published to BOTH worlds: the same bytes load as a Node module under `node --test` and as a classic
  // browser script inside the form. No ESM syntax anywhere — see form-cart.js for the same discipline.
  if (typeof module !== 'undefined' && module.exports) module.exports = { createConfirmQuote: createConfirmQuote, confirmPriceSheet: confirmPriceSheet };
  if (typeof window !== 'undefined') { window.createConfirmQuote = createConfirmQuote; window.confirmPriceSheet = confirmPriceSheet; }
})();
