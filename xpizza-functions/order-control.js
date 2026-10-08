'use strict';
/**
 * D4-c4 — "Pausar pedidos": READING the per-restaurant pause switch (PLAN-D4c4 rev 13 §2) + the HTTP refusal.
 *
 * `orderControlFor(db, rid)` → the request's control decision: null (admit) | 'paused' | 'unavailable'.
 *   - ONE RTDB read of `order_control/{rid}/current`, bounded at 1 s (the bound belongs to the read, so a hung read frees
 *     the slot and the next request starts a new one).
 *   - A per-instance cache of 10 s measured from read INITIATION; single-flight; a late result older than the cached one
 *     is discarded; NO stale fallback past expiry (expired + failed / timed-out read = UNKNOWN). A failure is never cached.
 *   - The cache holds the RAW node; the effective state — incl. `until` — is evaluated on EVERY request against this
 *     function's clock (order-control-state.js), so the auto-resume needs no cache refresh and no writer.
 * The only writer is the owner CLI (tools/order-control.js); clients cannot write the node (database.rules.json).
 * Captured-payment code never reads it.
 */
const S = require('./order-control-state');

const CACHE_TTL_MS = 10000;
const READ_TIMEOUT_MS = 1000;
const READ_FAILED = Symbol('read_failed');

function createReader({ ttlMs = CACHE_TTL_MS, timeoutMs = READ_TIMEOUT_MS, clock = Date.now, log = (l) => console.log(l) } = {}) {
  const cache = new Map();      // rid → { initiatedAt, raw }
  const inflight = new Map();   // rid → { initiatedAt, promise → raw | READ_FAILED }

  function readRaw(db, rid) {
    const t = clock();
    const c = cache.get(rid);
    if (c && t - c.initiatedAt < ttlMs) return { cache: 'hit', promise: Promise.resolve(c.raw) };
    const joined = inflight.get(rid);
    if (joined) return { cache: 'join', promise: joined.promise };
    const initiatedAt = t;
    const flight = { initiatedAt, promise: null };
    const clear = () => { if (inflight.get(rid) === flight) inflight.delete(rid); };
    flight.promise = new Promise((resolve) => {
      const timer = setTimeout(() => { clear(); resolve(READ_FAILED); }, timeoutMs);
      let read;   // issued synchronously: the read is INITIATED now, at `initiatedAt`
      try { read = db.ref(`order_control/${rid}/current`).once('value'); } catch (e) { read = Promise.reject(e); }
      Promise.resolve(read)
        .then((snap) => {
          const raw = snap.val();
          const cur = cache.get(rid);
          if (!cur || cur.initiatedAt < initiatedAt) cache.set(rid, { initiatedAt, raw });   // older-than-cached → discarded
          clearTimeout(timer); clear(); resolve(raw);
        }, () => { clearTimeout(timer); clear(); resolve(READ_FAILED); });
    });
    inflight.set(rid, flight);
    return { cache: c ? 'refresh' : 'miss', promise: flight.promise };
  }

  async function orderControlFor(db, rid) {
    const key = String(rid);
    const t0 = clock();
    const r = readRaw(db, key);
    const raw = await r.promise;
    const eff = raw === READ_FAILED ? { state: S.UNKNOWN, until: null } : S.effectiveState(raw, clock());
    const decision = S.decisionOf(eff.state);
    // §6: the latency measurement classifies the cache state per request from this line
    log(`order_control_read ${JSON.stringify({ rid: key, cache: r.cache, ms: clock() - t0, state: eff.state, ...(raw === READ_FAILED ? { read: 'failed' } : {}) })}`);
    return decision;
  }

  return { orderControlFor, _cache: cache, _inflight: inflight };
}

let shared = createReader();
const orderControlFor = (db, rid) => shared.orderControlFor(db, rid);
function _resetForTests(opts) { shared = createReader(opts); return shared; }

// the refusal for a decision ('paused' → 423 ordering_paused; 'unavailable' → the retryable 503)
function respond(res, decision) {
  const r = S.REFUSALS[decision];
  if (r.retryAfter) res.set('Retry-After', r.retryAfter);
  return res.status(r.status).json({ ...r.body });
}

module.exports = { CACHE_TTL_MS, READ_TIMEOUT_MS, createReader, orderControlFor, _resetForTests, respond };
