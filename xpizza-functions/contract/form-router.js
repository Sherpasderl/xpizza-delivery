'use strict';
/* R3 §5a — FORM FETCH ROUTING: the order forms' network calls go to the REAL HTTP handlers (index.js exports), in
 * process, with the page's own method / headers / body forwarded unchanged. The confirmation and return screens are
 * therefore produced by the real submit / return flow — `currentOrder` is never injected, no price is faked.
 *
 *   https://…cloudfunctions.net/<fn>[/<path>]          → app[<fn>] (express), path forwarded (getPublicMenu/menu/<rid>)
 *   https://…firebaseio.com/<path>.json (RTDB REST GET) → the emulator value at <path> (Admin read), as REST returns it
 *   anything else                                       → REFUSED (recorded in `refused`, the promise rejects)
 *
 * Responses are fetch-shaped ({ ok, status, headers.get, json(), text() }). Every routed call is logged with its
 * function, status and (parsed) request body so a cell can assert WHICH endpoint answered and what it was sent.
 */
const http = require('http');
const express = require('express');

function makeFormRouter({ app, rtdb }) {
  const log = []; const refused = [];
  function runHandler(handler, { method, path, headers, body }) {
    return new Promise((resolve, reject) => {
      const w = express(); w.use(express.json({ limit: '2mb' })); w.use(handler);
      const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${s.address().port}${path || '/'}`, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body });
          const text = await r.text(); const hs = {}; r.headers.forEach((v, k) => { hs[k] = v; });
          s.close(() => resolve({ status: r.status, text, headers: hs }));
        } catch (e) { s.close(() => reject(e)); }
      });
    });
  }
  const shaped = (status, text, headers = {}) => ({
    ok: status >= 200 && status < 300, status, statusText: String(status),
    headers: { get: (h) => headers[String(h).toLowerCase()] ?? null },
    json: async () => JSON.parse(text), text: async () => text, clone() { return shaped(status, text, headers); },
  });
  async function respond(url, init = {}) {
    const u = new URL(String(url));
    const method = (init.method || 'GET').toUpperCase();
    const headers = {};
    const h = init.headers || {};
    // header NAMES are case-insensitive: normalize, so the page's own Content-Type replaces the default instead of being
    // MERGED with it ("application/json, application/json" is not JSON to a body parser — the request would arrive empty)
    if (typeof h.forEach === 'function') h.forEach((v, k) => { headers[String(k).toLowerCase()] = v; });
    else for (const [k, v] of Object.entries(h)) headers[String(k).toLowerCase()] = v;
    const body = init.body === undefined || init.body === null ? undefined : String(init.body);
    const fnm = /cloudfunctions\.net$/.test(u.hostname) ? /^\/([A-Za-z0-9_]+)(\/.*)?$/.exec(u.pathname) : null;
    if (fnm) {
      const name = fnm[1];
      if (!app[name] || typeof app[name] !== 'function') { refused.push(url); throw new Error(`form-router: no handler ${name}`); }
      const r = await runHandler(app[name], { method, path: (fnm[2] || '/') + u.search, headers: { 'content-type': 'application/json', ...headers }, body });
      let reqBody = null; try { reqBody = body ? JSON.parse(body) : null; } catch (_) { reqBody = body; }
      let resBody = null; try { resBody = JSON.parse(r.text); } catch (_) { resBody = r.text; }
      log.push({ fn: name, method, path: fnm[2] || '/', status: r.status, req: reqBody, res: resBody, headers });
      return shaped(r.status, r.text, r.headers);
    }
    if (/firebaseio\.com$/.test(u.hostname) && u.pathname.endsWith('.json') && method === 'GET') {
      const p = decodeURIComponent(u.pathname.replace(/\.json$/, '')).replace(/^\/+/, '');
      const v = (await rtdb.ref(p).get()).val();
      log.push({ fn: 'rtdb-rest', method, path: p, status: 200 });
      return shaped(200, JSON.stringify(v));
    }
    refused.push(url);
    throw new Error(`form-router: ${url} is not routed (refused)`);
  }
  return { respond, log, refused };
}

module.exports = { makeFormRouter };
