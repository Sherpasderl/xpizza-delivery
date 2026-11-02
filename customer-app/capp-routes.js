// Customer app — the website's URL scheme (PLAN-capp-desktop-D4a-routing r2, APPROVED, Phase 1 = URL REFLECTION). Pure, UMD,
// brand-agnostic (no restaurant id or name in this file — guarded). The path WORDS are OWNER-PENDING copy.
//
//   /                          Inicio                       { name: 'home' }
//   /buscar                    Buscar                       { name: 'search' }
//   /cuenta                    Cuenta                       { name: 'account' }
//   /pedidos                   Pedidos                      { name: 'orders' }   (owner-approved D-3 r3 URL table, frame 9.3)
//   /r/{rid}                   a store                      { name: 'store', rid, step: 'store' }
//   /r/{rid}/plato/{dishId}    the dish sheet open          { name: 'store', rid, step: 'plato', dish }
//   /r/{rid}/pedido            the cart open                { name: 'store', rid, step: 'pedido' }
//   /r/{rid}/pago              the checkout (tip, sending)  { name: 'store', rid, step: 'pago' }
// ONE id domain (Codex r2 #8): an id never contains '/' — parse rejects a decoded '/', format REFUSES (throws). Every segment is
// written with encodeURIComponent and read with a guarded decode (a malformed escape ⇒ null). Trailing / repeated slashes are
// normalised; '.', '..', empty segments, control characters, an over-long dish id and an unknown first segment ⇒ null.
// Paths are case-SENSITIVE (ids are exact).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappRoutes = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WORDS = Object.freeze({ store: 'r', search: 'buscar', account: 'cuenta', orders: 'pedidos', dish: 'plato', cart: 'pedido', checkout: 'pago' });   // OWNER-PENDING
  const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;   // the platform's restaurant id rule (the functions' platform-manifest RID_RE)
  const DISH_MAX = 128;
  const BAD = /[\u0000-\u001f\u007f]/;
  const okId = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && s !== '.' && s !== '..' && !s.includes('/') && !BAD.test(s);

  function decode(seg) { try { return decodeURIComponent(seg); } catch (_) { return null; } }

  // → a route, or null for anything outside the scheme
  function parse(pathname) {
    if (typeof pathname !== 'string' || pathname[0] !== '/') return null;
    const raw = pathname.split('/').filter((x, i, a) => !(x === '' && (i === 0 || i === a.length - 1)));   // the leading '' and ONE trailing ''
    const parts = [];
    for (const r of raw) {
      if (r === '') continue;   // repeated slashes collapse
      const d = decode(r);
      if (d === null || !okId(d, Math.max(DISH_MAX, 40))) return null;
      parts.push(d);
    }
    if (!parts.length) return { name: 'home' };
    if (parts.length === 1 && parts[0] === WORDS.search) return { name: 'search' };
    if (parts.length === 1 && parts[0] === WORDS.account) return { name: 'account' };
    if (parts.length === 1 && parts[0] === WORDS.orders) return { name: 'orders' };
    if (parts[0] !== WORDS.store || parts.length < 2 || !RID_RE.test(parts[1])) return null;
    const rid = parts[1];
    if (parts.length === 2) return { name: 'store', rid, step: 'store' };
    if (parts.length === 3 && parts[2] === WORDS.cart) return { name: 'store', rid, step: 'pedido' };
    if (parts.length === 3 && parts[2] === WORDS.checkout) return { name: 'store', rid, step: 'pago' };
    if (parts.length === 4 && parts[2] === WORDS.dish && okId(parts[3], DISH_MAX)) return { name: 'store', rid, step: 'plato', dish: parts[3] };
    return null;
  }

  // → the canonical path; THROWS for anything outside the scheme (the reflector then leaves the URL as it is)
  function format(r) {
    if (!r || typeof r !== 'object') throw new TypeError('capp-routes: no route');
    if (r.name === 'home') return '/';
    if (r.name === 'search') return `/${WORDS.search}`;
    if (r.name === 'account') return `/${WORDS.account}`;
    if (r.name === 'orders') return `/${WORDS.orders}`;
    if (r.name !== 'store' || typeof r.rid !== 'string' || !RID_RE.test(r.rid)) throw new TypeError('capp-routes: bad store route');
    const base = `/${WORDS.store}/${encodeURIComponent(r.rid)}`;
    if (!r.step || r.step === 'store') return base;
    if (r.step === 'pedido') return `${base}/${WORDS.cart}`;
    if (r.step === 'pago') return `${base}/${WORDS.checkout}`;
    if (r.step === 'plato' && okId(r.dish, DISH_MAX)) return `${base}/${WORDS.dish}/${encodeURIComponent(r.dish)}`;
    throw new TypeError('capp-routes: bad step or dish id');
  }

  return { parse, format, WORDS, RID_RE, DISH_MAX };
});
