// Customer app S7a-2 (PLAN-capp-S7a r1 §2.1 + r2 §2.1, APPROVED as a plan) — ONE shared menu-envelope cache for Inicio, Buscar and
// store entry. Pure, UMD, brand-agnostic. DARK: no page loads it yet.
//
//   • ONE global concurrency limit (3) across every consumer; in-flight DEDUPE per restaurant
//   • per-rid entries { body, etag, fetched_at, state: fresh|stale|failed, gen } — the per-rid gen increments only on a NEW network
//     request; consumers subscribe / unsubscribe independently (leaving Inicio cancels nothing Buscar is sharing)
//   • a 200 must carry envelope.rid === rid (else a failed fetch); a 304 is accepted ONLY with a retained body whose etag equals the
//     request's If-None-Match (else re-fetched without a validator)
//   • failed (re)validation: the stale body is kept for STALE_MS after it was fetched, then the entry is `failed`
//   • one retry on a network error / 5xx
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappMenuCache = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONCURRENCY = 3, FRESH_MS = 60 * 1000, STALE_MS = 10 * 60 * 1000;

  // fetchEnvelope(rid, etag|null) → Promise<{ status, body?, etag? }> (status 0 = network failure)
  function createMenuCache(opts) {
    const o = opts || {};
    const fetchEnvelope = o.fetchEnvelope;
    const now = o.now || (() => Date.now());
    const limit = o.concurrency || CONCURRENCY;
    const entries = new Map(), inflight = new Map(), listeners = new Map();
    const queue = []; let active = 0;
    const notify = (rid) => { for (const fn of [...(listeners.get(rid) || [])]) { try { fn(entries.get(rid) || null); } catch (_) {} } };
    function slot(task) {
      return new Promise((resolve) => {
        const run = () => { active++; Promise.resolve().then(task).then(resolve, () => resolve(null)).finally(() => { active--; const next = queue.shift(); if (next) next(); }); };
        if (active < limit) run(); else queue.push(run);
      });
    }
    async function attempt(rid, etag) {
      let r; try { r = await fetchEnvelope(rid, etag); } catch (_) { r = { status: 0 }; }
      return r || { status: 0 };
    }
    async function load(rid) {
      const cur = entries.get(rid) || null;
      const gen = (cur ? cur.gen : 0) + 1;
      const etag = cur && cur.body && cur.etag ? cur.etag : null;
      let r = await attempt(rid, etag);
      if (r.status === 0 || r.status >= 500) r = await attempt(rid, etag);   // ONE retry
      let next;
      if (r.status === 304) {
        if (etag && cur && cur.body && cur.etag === etag) next = { ...cur, state: 'fresh', fetched_at: now(), gen };   // the retained body IS that etag
        else { const f = await attempt(rid, null); next = okBody(rid, f, gen) || failOf(cur, gen); }   // no matching body ⇒ re-fetch without a validator
      } else {
        next = okBody(rid, r, gen) || failOf(cur, gen);
      }
      entries.set(rid, next); notify(rid);
      return next;
    }
    function okBody(rid, r, gen) {
      if (r && r.status === 200 && r.body && r.body.rid === rid) return { body: r.body, etag: r.etag || null, fetched_at: now(), state: 'fresh', gen };
      return null;
    }
    function failOf(cur, gen) {
      if (cur && cur.body && now() - cur.fetched_at < STALE_MS) return { ...cur, state: 'stale', gen };
      return { body: null, etag: null, fetched_at: cur ? cur.fetched_at : 0, state: 'failed', gen };
    }
    function get(rid) {
      const cur = entries.get(rid);
      if (cur && cur.state === 'fresh' && now() - cur.fetched_at < FRESH_MS) return Promise.resolve(cur);
      if (inflight.has(rid)) return inflight.get(rid);
      const p = slot(() => load(rid)).finally(() => inflight.delete(rid));
      inflight.set(rid, p);
      return p;
    }
    // the render-side read: what is there NOW (fresh / stale / failed), without fetching; stale entries past STALE_MS read as failed
    function peek(rid) {
      const e = entries.get(rid); if (!e) return null;
      if (e.state === 'stale' && now() - e.fetched_at >= STALE_MS) return { ...e, state: 'failed', body: null };
      return e;
    }
    function subscribe(rid, fn) {
      if (!listeners.has(rid)) listeners.set(rid, new Set());
      listeners.get(rid).add(fn);
      return () => { const s = listeners.get(rid); if (s) s.delete(fn); };
    }
    // search completeness: every listed rid has a FRESH body (stale / failed / missing ⇒ partial)
    const complete = (rids) => rids.every((rid) => { const e = peek(rid); return !!e && e.state === 'fresh'; });
    return { get, peek, subscribe, complete, _active: () => active, _queued: () => queue.length };
  }

  return { createMenuCache, CONCURRENCY, FRESH_MS, STALE_MS };
});
