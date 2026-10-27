// Customer app S7a-2 (PLAN-capp-S7a r1 §1.2 failure contract + r3.3-F1 perf, APPROVED) — the CLIENT side of the restaurant
// directory: what Inicio / Buscar list, and which rows may be entered. Pure, UMD, brand-agnostic (no restaurant id or name in
// this file — guarded). DARK: only the undeployed shell page loads it.
//
//   stored       the last verified COMPLETE body { v:1, body, etag, fetched_at } — written only from a 200 complete:true or a 304
//                matching its etag (fetched_at = that receipt; a read never refreshes it)
//   boot         a stored body younger than 24 h (and not > 5 min in the future) is painted at once as PRESENTATION: listed,
//                never enterable (eligibility is separate); otherwise the cold path (phase 'cold': the «Cargando restaurantes…» line)
//   revalidate   a conditional GET (If-None-Match = the stored etag), one at a time:
//                · 200 complete / 304 matching ⇒ every listed store is VERIFIED (CappEligibility); a stored store it omits is
//                  TOMBSTONED — still drawn, disabled in place, until the next visit() (never from under a finger)
//                · 200 partial ⇒ the stores it lists are verified; one it omits is NOT tombstoned (presentation, held); the
//                  stored body is not overwritten; the partial note (frame 9) shows
//                · 304 without a matching stored body ⇒ re-fetched without a validator
//                · 503 / offline / anything else ⇒ nothing changes; with nothing to show ⇒ phase 'error' (frame 7)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappDirectory = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY = 'capp:directory', PRESENT_MS = 24 * 60 * 60 * 1000, SKEW_MS = 5 * 60 * 1000;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const validBody = (b) => isObj(b) && Array.isArray(b.restaurants) && b.restaurants.every((r) => isObj(r) && typeof r.restaurant_id === 'string' && r.restaurant_id);
  const ridsOf = (b) => b.restaurants.map((r) => r.restaurant_id);

  // fetchDirectory(etag|null) → Promise<{ status, body?, etag? }> (status 0 = network failure); storage: localStorage-like;
  // eligibility: a CappEligibility instance (the shell's one)
  function createDirectory(opts) {
    const o = opts || {};
    const now = typeof o.now === 'function' ? o.now : () => Date.now();
    const storage = o.storage || null, elig = o.eligibility, key = o.key || KEY;
    let stored = null;         // the stored record (validated)
    let rows = [];             // [{ rid, entry, gone }] in display order
    let phase = 'cold';        // cold | ready | error
    let partial = false, verified = false, platform = null, inflight = null, failedAt = null;
    const listeners = new Set();
    const notify = () => { for (const fn of [...listeners]) { try { fn(view()); } catch (_) {} } };

    function readStored() {
      let rec = null;
      try { const s = storage && storage.getItem(key); rec = s ? JSON.parse(s) : null; } catch (_) { rec = null; }
      if (!isObj(rec) || rec.v !== 1 || !validBody(rec.body) || rec.body.complete !== true || !Number.isFinite(rec.fetched_at)) return null;
      const t = now();
      if (rec.fetched_at > t + SKEW_MS || t - rec.fetched_at >= PRESENT_MS) return null;   // a clock anomaly, or older than 24 h
      return rec;
    }
    // verified write: read back byte-equal, else the stored record is left as it was in memory only
    function writeStored(rec) {
      stored = rec;
      try { const s = JSON.stringify(rec); storage.setItem(key, s); return storage.getItem(key) === s; } catch (_) { return false; }
    }
    function dropStored() { stored = null; try { storage && storage.removeItem(key); } catch (_) {} }

    function boot() {
      const rec = readStored();
      if (!rec) { try { storage && storage.getItem(key) !== null && storage.removeItem(key); } catch (_) {} }
      if (rec) { stored = rec; rows = rec.body.restaurants.map((entry) => ({ rid: entry.restaurant_id, entry, gone: false })); platform = rec.body.platform || null; phase = 'ready'; }
      return view();
    }

    // a COMPLETE verification: the listed stores in its order; stores shown before and now absent stay, disabled, in place
    function applyComplete(body) {
      const ids = new Set(ridsOf(body));
      const kept = rows.filter((r) => !ids.has(r.rid));
      const next = body.restaurants.map((entry) => ({ rid: entry.restaurant_id, entry, gone: false }));
      for (const g of kept) {   // a tombstoned row keeps its slot (after the row it followed) until the next visit
        const i = rows.indexOf(g), prev = rows.slice(0, i).reverse().find((r) => ids.has(r.rid));
        const at = prev ? next.findIndex((r) => r.rid === prev.rid) + 1 : 0;
        next.splice(at, 0, { ...g, gone: true });
      }
      rows = next; platform = body.platform || null; partial = false;
      elig.verified({ listed: [...ids], complete: true, at: now() });
    }
    function applyPartial(body) {
      const ids = new Set(ridsOf(body));
      const byRid = new Map(body.restaurants.map((e) => [e.restaurant_id, e]));
      const next = rows.map((r) => (byRid.has(r.rid) ? { rid: r.rid, entry: byRid.get(r.rid), gone: false } : r));
      for (const e of body.restaurants) if (!next.some((r) => r.rid === e.restaurant_id)) next.push({ rid: e.restaurant_id, entry: e, gone: false });
      rows = next; if (body.platform !== undefined && body.platform !== null) platform = body.platform; partial = true;
      elig.verified({ listed: [...ids], complete: false, at: now() });
    }

    async function request(etag) {
      let r; try { r = await o.fetchDirectory(etag); } catch (_) { r = null; }
      return r && Number.isFinite(r.status) ? r : { status: 0 };
    }
    async function run() {
      const etag = stored && stored.etag ? stored.etag : null;
      let r = await request(etag);
      // a 304 is accepted ONLY for the validator WE sent, over the body we hold (a 304 naming another etag ⇒ re-fetched without one)
      let matched = r.status === 304 && !!etag && !!stored && (r.etag == null || r.etag === etag);
      if (r.status === 304 && !matched) { r = await request(null); matched = false; }
      if (r.status === 304 && matched) {
        writeStored({ ...stored, fetched_at: now() });
        applyComplete(stored.body); verified = true; phase = 'ready'; failedAt = null;
      } else if (r.status === 200 && validBody(r.body) && r.body.complete === true) {
        if (typeof r.etag === 'string' && r.etag) writeStored({ v: 1, body: r.body, etag: r.etag, fetched_at: now() });
        else dropStored();   // a complete body with no validator is shown, never stored (it could not be revalidated)
        applyComplete(r.body); verified = true; phase = 'ready'; failedAt = null;
      } else if (r.status === 200 && validBody(r.body) && r.body.complete === false) {
        applyPartial(r.body); verified = true; phase = 'ready'; failedAt = null;
      } else {
        failedAt = now();
        if (!rows.length && phase !== 'ready') phase = 'error';
      }
    }
    // subscribers hear the outcome only once the request is no longer in flight (Codex s7a2 r1 #5: a held tap reads `pending`)
    function revalidate() {
      if (inflight) return inflight;
      inflight = run().then(() => { inflight = null; notify(); return view(); }, () => { inflight = null; failedAt = now(); notify(); return view(); });
      return inflight;
    }
    // Inicio / Buscar entered again: tombstoned rows leave the list now (never while visible)
    function visit() { const n = rows.length; rows = rows.filter((r) => !r.gone); if (rows.length !== n) notify(); }
    function view() {
      return { phase, rows: rows.slice(), partial, verified, platform, failed: failedAt !== null, pending: !!inflight,
        presentation: !verified && rows.length > 0 };
    }
    return { boot, revalidate, visit, view, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      state: (rid) => { const r = rows.find((x) => x.rid === rid); return !r ? 'unknown' : r.gone ? 'gone' : elig.state(rid); } };
  }

  return { createDirectory, KEY, PRESENT_MS, SKEW_MS };
});
