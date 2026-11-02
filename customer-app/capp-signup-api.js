// Customer app G6 — the sign-in / sign-up TRANSPORT, `context:'platform'` (CONTRACT-capp-signup-platform-wire.md, PROPOSED 2026-10-27:
// the order forms' own endpoints, scoped to the platform — never a restaurant id; additive fields only). UMD, brand-agnostic. DARK.
//
//   createSignupApi({ endpoints, fetch?, timeoutMs?, timers? }) → { config, requestOtp, verifyOtp, googleStart, googleSignIn,
//   completeProfile, redeemSignupGrant, setPromos }. Every call is BOUNDED (timeoutMs) and returns a plain result — never throws:
//     { ok:true, … } | { ok:false, reason } with reason ∈ the contract's codes, or 'offline' (network / timeout / unparsable).
//   endpoints: one URL per key of ENDPOINTS (below) — the app runtime's (the same deployed functions the forms call; the app's web
//   origin is already in their CORS list). ENDPOINTS is the ONE source of the set: the host that builds runtime.signup builds its
//   endpoints from it, and a guard holds every call here to a key in it.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappSignupApi = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const CONTEXT = 'platform';
  const TIMEOUT_MS = 12000;
  // the runtime.signup endpoint set — every call below uses one of these keys (capp-signup.test.mjs guard)
  const ENDPOINTS = Object.freeze(['requestOtp', 'verifyOtp', 'getSignupConfig', 'googleStart', 'googleSignIn', 'completeProfile', 'redeemSignupGrant', 'setPromos', 'getMyOrders', 'getMyRating', 'rateOrder']);

  function createSignupApi(opts) {
    const o = opts || {};
    const E = o.endpoints || {};
    const T = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
    const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : TIMEOUT_MS;
    // the forms' canonical wrapper (pselfupdate-wrapper-lint): the page loads sherpa-client.js first
    function sherpaFetch(u, o){ var S = root && root.SherpaClient; return (S && typeof S.fetch === 'function') ? S.fetch(u, o) : fetch(u, o); }
    const doFetch = typeof o.fetch === 'function' ? o.fetch : sherpaFetch;
    async function call(base, { method = 'POST', body = null, idToken = null, query = null } = {}) {
      if (!base) return { status: 0, json: null };
      const url = query ? `${base}?${query}` : base;   // a GET's query is built by the caller from fixed keys (getMyOrders)
      const headers = { 'Content-Type': 'application/json', ...(idToken ? { 'x-firebase-id-token': idToken } : {}) };
      // a GET carries no body; the member's token still rides its header (getMyOrders — never in the URL, NOTE-getMyOrders §1)
      const req = Promise.resolve().then(() => doFetch(url, method === 'GET' ? (idToken ? { method, headers: { 'x-firebase-id-token': idToken } } : { method }) : { method, headers, body: JSON.stringify(body) }))
        .then(async (r) => { let j = null; try { j = await r.json(); } catch (_) { j = null; } return { status: r.status, json: j && typeof j === 'object' ? j : null }; }, () => ({ status: 0, json: null }));
      return new Promise((res) => { const t = T.setTimeout(() => res({ status: 0, json: null }), timeoutMs); req.then((v) => { T.clearTimeout(t); res(v); }); });
    }
    const off = { ok: false, reason: 'offline' };
    const reasonOf = (r) => (r.json && typeof r.json.reason === 'string' ? r.json.reason : r.status === 429 ? 'rate_limited' : r.status === 401 ? 'unauthenticated' : r.status === 0 || !r.json ? 'offline' : 'failed');
    const COMPLETION = new Set(['complete', 'needed', 'off']);
    const signedIn = (j) => ({ ok: true, token: j.token, isNew: j.is_new === true, name: typeof j.name === 'string' ? j.name : null,
      completion: COMPLETION.has(j.completion) ? j.completion : 'needed',   // an old server without the field ⇒ ask (never skip consent)
      profile: j.profile && typeof j.profile === 'object' ? { name: typeof j.profile.name === 'string' ? j.profile.name : null, email: typeof j.profile.email === 'string' ? j.profile.email : null,
        ...(typeof j.profile.promos === 'boolean' ? { promos: j.profile.promos } : {}) } : null });   // Codex G7 r1 #3: the stored consent (omitted when none is stored)

    return {
      CONTEXT,
      async config() {
        if (!E.getSignupConfig) return off;
        const r = await call(`${E.getSignupConfig}${E.getSignupConfig.includes('?') ? '&' : '?'}context=${CONTEXT}`, { method: 'GET' });
        const j = r.json;
        if (r.status !== 200 || !j || j.ok !== true) return { ok: false, reason: reasonOf(r) };
        return { ok: true, termsUrl: j.terms_url || null, privacyUrl: j.privacy_url || null, legalReady: j.legal_ready === true,
          googleEnabled: j.google_enabled === true && typeof j.google_client_id === 'string' && !!j.google_client_id, googleClientId: j.google_client_id || null };
      },
      // always 200 {ok:true, cooldown:30} by design (no enumeration) — only the transport can fail
      async requestOtp({ phone, linkTicket, sessionId }) {
        const r = await call(E.requestOtp, { body: { phone, context: CONTEXT, ...(linkTicket ? { link_ticket: linkTicket, session_id: sessionId } : {}) } });
        return r.status === 200 && r.json && r.json.ok === true ? { ok: true, cooldown: Number.isFinite(r.json.cooldown) ? r.json.cooldown : 30 } : off;
      },
      async verifyOtp({ phone, code, linkTicket, sessionId }) {
        const r = await call(E.verifyOtp, { body: { phone, code, context: CONTEXT, ...(linkTicket ? { link_ticket: linkTicket, session_id: sessionId } : {}) } });
        const j = r.json;
        if (r.status === 200 && j && j.ok === true && typeof j.token === 'string' && j.token) return { ...signedIn(j), link: typeof j.link === 'string' ? j.link : null };
        if (r.status === 200 && j && j.ok === false) return { ok: false, reason: typeof j.reason === 'string' ? j.reason : 'code_invalid', retryInS: Number.isFinite(j.retry_in_s) ? j.retry_in_s : null };
        return { ok: false, reason: reasonOf(r) };
      },
      async googleStart({ sessionId }) {
        const r = await call(E.googleStart, { body: { context: CONTEXT, session_id: sessionId } });
        return r.status === 200 && r.json && r.json.ok === true && typeof r.json.nonce === 'string' ? { ok: true, nonce: r.json.nonce } : { ok: false, reason: reasonOf(r) };
      },
      async googleSignIn({ sessionId, idToken }) {
        const r = await call(E.googleSignIn, { body: { context: CONTEXT, session_id: sessionId, id_token: idToken } });
        const j = r.json;
        if (r.status === 200 && j && j.ok === true && j.linked === true && typeof j.token === 'string') return { ...signedIn(j), linked: true };
        if (r.status === 200 && j && j.ok === true && j.linked === false && typeof j.ticket === 'string') return { ok: true, linked: false, ticket: j.ticket, email: j.email || '', name: j.name || '' };
        return { ok: false, reason: reasonOf(r) };
      },
      async completeProfile({ idToken, email, name, promos }) {
        const r = await call(E.completeProfile, { idToken, body: { context: CONTEXT, email, accept_terms: true, promos: promos === true, name } });
        return r.status === 200 && r.json && r.json.ok === true ? { ok: true } : { ok: false, reason: reasonOf(r) };
      },
      // G7 (CONTRACT-capp-signup-platform-wire §6): the member's promotions choice — {context:'platform', value}, the member's ID token
      async setPromos({ idToken, value }) {
        const r = await call(E.setPromos, { idToken, body: { context: CONTEXT, value: value === true } });
        // the platform answer reads the committed value back ({ok:true, value}, contract §6) — adopted when present
        return r.status === 200 && r.json && r.json.ok === true ? { ok: true, ...(typeof r.json.value === 'boolean' ? { value: r.json.value } : {}) } : { ok: false, reason: reasonOf(r) };
      },
      // «Pedidos» (NOTE-getMyOrders, 3a, APPROVED): the member's own orders, newest first, paged by an opaque cursor. ONLY the contract's
      // Row whitelist is kept (a field the server never promised is dropped; a malformed row is dropped, never guessed)
      async getMyOrders({ idToken, limit, cursor } = {}) {
        if (!idToken) return { ok: false, reason: 'unauthenticated' };
        // an argument that is SUPPLIED must be valid — refused locally, never silently dropped into a first-page request (Codex r1)
        if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 50)) return { ok: false, reason: 'bad_request' };
        if (cursor !== undefined && cursor !== null && !(typeof cursor === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(cursor))) return { ok: false, reason: 'bad_request' };
        const q = ['context=platform'];
        if (limit !== undefined) q.push(`limit=${limit}`);
        if (typeof cursor === 'string') q.push(`cursor=${cursor}`);
        const r = await call(E.getMyOrders, { method: 'GET', idToken, query: q.join('&') });
        const j = r.json;
        if (r.status !== 200 || !j || j.ok !== true || !Array.isArray(j.active) || !Array.isArray(j.past)) return { ok: false, reason: r.status === 403 ? 'deleted' : reasonOf(r) };
        return { ok: true, active: j.active.map(rowOf).filter(Boolean), past: j.past.map(rowOf).filter(Boolean), next_cursor: typeof j.next_cursor === 'string' && j.next_cursor ? j.next_cursor : null };
      },
      // the RECEIPT detail mode (NOTE-getMyOrders-receipt, 3a 75eed212, APPROVED): ONE order of the member's own, ?order_id alone with the
      // same header auth; a uniform 404 for anything not hers ⇒ 'not_found'. Only the contract's receipt whitelist survives (receiptOf)
      async getReceipt({ idToken, orderId } = {}) {
        if (!idToken) return { ok: false, reason: 'unauthenticated' };
        if (!(typeof orderId === 'string' && ORDER_ID_RE.test(orderId))) return { ok: false, reason: 'bad_request' };
        const r = await call(E.getMyOrders, { method: 'GET', idToken, query: `context=platform&order_id=${orderId}` });
        const j = r.json, rc = r.status === 200 && j && j.ok === true ? receiptOf(j.receipt) : null;
        if (rc && rc.order_id === orderId) return { ok: true, receipt: rc };
        return { ok: false, reason: r.status === 404 ? 'not_found' : r.status === 403 ? 'deleted' : r.status === 200 ? 'failed' : reasonOf(r) };
      },
      // C-2 (PLAN §C-2; 3a's getMyRating 1958b8ed): the member's OWN rating of one order — GET ?order_id alone (the endpoint refuses any
      // other key), the token in its header. Only the contract's fields survive (myRatingOf); 403 is the ONE generic refusal
      async getMyRating({ idToken, orderId } = {}) {
        if (!idToken) return { ok: false, reason: 'unauthenticated' };
        if (!(typeof orderId === 'string' && ORDER_ID_RE.test(orderId))) return { ok: false, reason: 'bad_request' };
        const r = await call(E.getMyRating, { method: 'GET', idToken, query: `order_id=${orderId}` });
        const v = r.status === 200 && r.json && r.json.ok === true ? myRatingOf(r.json) : null;
        if (v) return { ok: true, ...v };
        return { ok: false, reason: r.status === 403 ? 'not_allowed' : r.status === 200 ? 'failed' : reasonOf(r) };
      },
      // C-2 (the S-A1 writer rateOrder, v2): ONLY the fields the customer set — a body the server would refuse is refused HERE (never sent)
      async rateOrder({ idToken, orderId, fields } = {}) {
        if (!idToken) return { ok: false, reason: 'unauthenticated' };
        if (!(typeof orderId === 'string' && ORDER_ID_RE.test(orderId)) || !rateFieldsOk(fields)) return { ok: false, reason: 'bad_request' };
        const r = await call(E.rateOrder, { body: { order_id: orderId, ...fields }, idToken });
        const j = r.json || {};
        if (r.status === 200 && j.ok === true) return { ok: true, dishesUnavailable: j.dishes === 'unavailable' };
        if (r.status === 409 && RATE_409.has(j.error)) return { ok: false, reason: j.error };
        if (r.status === 400 && j.error === 'dish_not_purchased') return { ok: false, reason: 'dish_not_purchased' };
        return { ok: false, reason: r.status === 403 ? 'not_allowed' : reasonOf(r) };
      },
      async redeemSignupGrant({ grant, email, name, promos }) {
        const r = await call(E.redeemSignupGrant, { body: { grant, context: CONTEXT, email, name, accept_terms: true, promos: promos === true } });
        const j = r.json;
        if (r.status === 200 && j && j.ok === true && typeof j.token === 'string') return signedIn({ ...j, completion: 'complete' });
        return { ok: false, reason: reasonOf(r) };
      },
    };
  }

  // the contract's Row (NOTE-getMyOrders §3), field by field — nothing else survives
  const ORDER_ID_RE = /^[A-Za-z0-9_-]{4,64}$/, RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
  function rowOf(x) {
    if (!x || typeof x !== 'object' || typeof x.order_id !== 'string' || !ORDER_ID_RE.test(x.order_id) || !Number.isFinite(x.ts) || typeof x.restaurant !== 'string' || !RID_RE.test(x.restaurant)) return null;
    return { order_id: x.order_id, ts: x.ts, total: Number.isFinite(x.total) ? x.total : null, order_type: x.order_type === 'pickup' ? 'pickup' : x.order_type === 'delivery' ? 'delivery' : null,
      restaurant: x.restaurant, status: typeof x.status === 'string' ? x.status : null, items_text: typeof x.items_text === 'string' ? x.items_text : null, items: Array.isArray(x.items) ? x.items : [],
      ...(typeof x.recipe_format === 'string' ? { recipe_format: x.recipe_format } : {}),
      ...(Number.isInteger(x.display_number) && x.display_number > 0 ? { display_number: x.display_number } : {}) };   // advisor 11-01: 3a adds it to the whitelist
  }
  // the contract's receipt (NOTE-getMyOrders-receipt §3), field by field: lines only when EVERY line is well-formed (else null ⇒ the
  // items_text lines), totals = the present integer keys only (never 0-filled), the tender as cash / card with no digits, the address
  // for a delivery only — anything else the server might add never survives
  const isInt = (v) => Number.isSafeInteger(v), str = (v) => (typeof v === 'string' ? v : null);
  const TOTAL_KEYS = ['subtotal_cents', 'tax_cents', 'delivery_cents', 'promo_discount_cents', 'tip_cents', 'total_cents'];
  function receiptOf(x) {
    if (!x || typeof x !== 'object' || typeof x.order_id !== 'string' || !ORDER_ID_RE.test(x.order_id) || typeof x.restaurant !== 'string' || !RID_RE.test(x.restaurant)) return null;
    const type = x.order_type === 'pickup' ? 'pickup' : x.order_type === 'delivery' ? 'delivery' : null;
    const lines = Array.isArray(x.lines) && x.lines.length && x.lines.every((l) => l && typeof l === 'object' && isInt(l.qty) && l.qty >= 1 && typeof l.description === 'string' && isInt(l.line_cents))
      ? x.lines.map((l) => ({ qty: l.qty, description: l.description, line_cents: l.line_cents })) : null;
    const totals = {}; const t = x.totals && typeof x.totals === 'object' ? x.totals : {}; for (const k of TOTAL_KEYS) if (isInt(t[k])) totals[k] = t[k];
    const tn = x.tender && typeof x.tender === 'object' ? x.tender : {}, method = tn.method === 'cash' || tn.method === 'card' ? tn.method : null;
    const a = type === 'delivery' && x.address && typeof x.address === 'object' ? x.address : null;
    return { order_id: x.order_id, ...(Number.isInteger(x.display_number) && x.display_number > 0 ? { display_number: x.display_number } : {}),
      ts: Number.isFinite(x.ts) ? x.ts : null, restaurant: x.restaurant, order_type: type, status: str(x.status), lines, items_text: str(x.items_text), totals,
      tender: { method, ...(method === 'cash' && isInt(tn.cash_tendered_cents) ? { cash_tendered_cents: tn.cash_tendered_cents } : {}) },
      ...(a ? { address: { detected: str(a.detected), details: str(a.details), area: str(a.area) } } : {}) };
  }
  // C-2: getMyRating's 200 body, field by field (the S-A(d) contract) — a malformed body is a failure, never a guess
  const ts = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const thumbOk = (v) => v === 1 || v === -1;
  const DISH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/, COMMENT_MAX = 500, DISHES_MAX = 30;
  const RATE_409 = new Set(['window_closed', 'not_fulfilled', 'not_rated']);
  function myRatingOf(j) {
    if (typeof j.can_rate !== 'boolean') return null;
    const until = j.editable_until === null ? null : ts(j.editable_until);
    if (j.editable_until !== null && until === null) return null;
    let rating = null;
    if (j.rating !== null) {
      const x = j.rating; if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
      const store = x.store === null ? null : Number.isInteger(x.store) && x.store >= 1 && x.store <= 5 ? x.store : undefined;
      const d = x.dishes; if (!d || typeof d !== 'object' || Array.isArray(d) || Object.entries(d).some(([k, v]) => !DISH_ID_RE.test(k) || !thumbOk(v))) return null;
      if (store === undefined || !(x.delivery === null || thumbOk(x.delivery)) || !(x.legacy_thumb === null || thumbOk(x.legacy_thumb))) return null;
      if (!(x.comment === null || (typeof x.comment === 'string' && x.comment.length <= COMMENT_MAX))) return null;
      rating = { store, dishes: { ...d }, delivery: x.delivery, comment: x.comment, legacyThumb: x.legacy_thumb, ratedAt: ts(x.rated_at), editedAt: ts(x.edited_at) };
    }
    return { rating, canRate: j.can_rate, editableUntil: until };
  }
  // the writer's parseRequest, mirrored: at least one of store / dishes / delivery / comment, each in its shape
  function rateFieldsOk(f) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
    const keys = Object.keys(f); if (!keys.length || keys.some((k) => !['store', 'dishes', 'delivery', 'comment'].includes(k))) return false;
    if ('store' in f && !(f.store === null || (Number.isInteger(f.store) && f.store >= 1 && f.store <= 5))) return false;
    if ('delivery' in f && !(f.delivery === null || thumbOk(f.delivery))) return false;
    if ('comment' in f && !(f.comment === null || (typeof f.comment === 'string' && f.comment.length <= COMMENT_MAX))) return false;
    if ('dishes' in f) { const d = f.dishes; if (!d || typeof d !== 'object' || Array.isArray(d)) return false; const ids = Object.keys(d); if (ids.length > DISHES_MAX || ids.some((k) => !DISH_ID_RE.test(k) || !thumbOk(d[k]))) return false; }
    return true;
  }
  return { createSignupApi, CONTEXT, TIMEOUT_MS, ENDPOINTS, rowOf, receiptOf, myRatingOf };
});
