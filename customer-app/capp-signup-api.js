// Customer app G6 — the sign-in / sign-up TRANSPORT, `context:'platform'` (CONTRACT-capp-signup-platform-wire.md, PROPOSED 2026-10-27:
// the order forms' own endpoints, scoped to the platform — never a restaurant id; additive fields only). UMD, brand-agnostic. DARK.
//
//   createSignupApi({ endpoints, fetch?, timeoutMs?, timers? }) → { config, requestOtp, verifyOtp, googleStart, googleSignIn,
//   completeProfile, redeemSignupGrant }. Every call is BOUNDED (timeoutMs) and returns a plain result — never throws:
//     { ok:true, … } | { ok:false, reason } with reason ∈ the contract's codes, or 'offline' (network / timeout / unparsable).
//   endpoints: { requestOtp, verifyOtp, getSignupConfig, googleStart, googleSignIn, completeProfile, redeemSignupGrant } — the app
//   runtime's (the same deployed functions the forms call; the app's web origin is already in their CORS list).
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappSignupApi = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const CONTEXT = 'platform';
  const TIMEOUT_MS = 12000;

  function createSignupApi(opts) {
    const o = opts || {};
    const E = o.endpoints || {};
    const T = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
    const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : TIMEOUT_MS;
    // the forms' canonical wrapper (pselfupdate-wrapper-lint): the page loads sherpa-client.js first
    function sherpaFetch(u, o){ var S = root && root.SherpaClient; return (S && typeof S.fetch === 'function') ? S.fetch(u, o) : fetch(u, o); }
    const doFetch = typeof o.fetch === 'function' ? o.fetch : sherpaFetch;
    async function call(url, { method = 'POST', body = null, idToken = null } = {}) {
      if (!url) return { status: 0, json: null };
      const headers = { 'Content-Type': 'application/json', ...(idToken ? { 'x-firebase-id-token': idToken } : {}) };
      const req = Promise.resolve().then(() => doFetch(url, method === 'GET' ? { method } : { method, headers, body: JSON.stringify(body) }))
        .then(async (r) => { let j = null; try { j = await r.json(); } catch (_) { j = null; } return { status: r.status, json: j && typeof j === 'object' ? j : null }; }, () => ({ status: 0, json: null }));
      return new Promise((res) => { const t = T.setTimeout(() => res({ status: 0, json: null }), timeoutMs); req.then((v) => { T.clearTimeout(t); res(v); }); });
    }
    const off = { ok: false, reason: 'offline' };
    const reasonOf = (r) => (r.json && typeof r.json.reason === 'string' ? r.json.reason : r.status === 429 ? 'rate_limited' : r.status === 401 ? 'unauthenticated' : r.status === 0 || !r.json ? 'offline' : 'failed');
    const COMPLETION = new Set(['complete', 'needed', 'off']);
    const signedIn = (j) => ({ ok: true, token: j.token, isNew: j.is_new === true, name: typeof j.name === 'string' ? j.name : null,
      completion: COMPLETION.has(j.completion) ? j.completion : 'needed',   // an old server without the field ⇒ ask (never skip consent)
      profile: j.profile && typeof j.profile === 'object' ? { name: typeof j.profile.name === 'string' ? j.profile.name : null, email: typeof j.profile.email === 'string' ? j.profile.email : null } : null });

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
      async redeemSignupGrant({ grant, email, name, promos }) {
        const r = await call(E.redeemSignupGrant, { body: { grant, context: CONTEXT, email, name, accept_terms: true, promos: promos === true } });
        const j = r.json;
        if (r.status === 200 && j && j.ok === true && typeof j.token === 'string') return signedIn({ ...j, completion: 'complete' });
        return { ok: false, reason: reasonOf(r) };
      },
    };
  }

  return { createSignupApi, CONTEXT, TIMEOUT_MS };
});
