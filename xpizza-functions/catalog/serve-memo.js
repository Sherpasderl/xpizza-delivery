'use strict';
// The public menu's NON-BLOCKING decoration memo (moved from catalog/dish-stats-serve.js — 5f review / advisor 11-13, rule 7: no
// awaited network on the menu's path), shared so every decoration (dish_stats, offers) behaves the same way. Per instance, per rid:
//   - a FRESH memo (ok ≤ okTtlMs / failure ≤ failTtlMs) is served as it is (a failure ⇒ nothing);
//   - otherwise ONE background read is STARTED (in-flight deduped; raced against a cleared timeoutMs timer) and NOT awaited;
//     · a STALE success is served meanwhile (stale-while-revalidate), and a FAILED refresh keeps it — but only up to staleMaxMs past
//       its expiry; after that nothing is served until a refresh succeeds;
//     · with no usable memo (a cold instance, after a failure) this response carries nothing; the next one has it.
// The read is `deps.read(rid)` when injected, else the decoration's own default reader (given the deps). Never rejects.
function createServeMemo({ okTtlMs, failTtlMs, staleMaxMs, timeoutMs, timeoutError, absentLog, defaultRead }) {
  const MEMO = new Map();
  const INFLIGHT = new Map();
  function withTimeout(promise, ms) {
    let timer = null;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(timeoutError)), ms); });
    return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
  }
  // ONE bounded background read for rid → { ok, raw, at } (fills the memo)
  function startRead(rid, deps) {
    const inflight = deps.inflight || INFLIGHT;
    if (inflight.has(rid)) return inflight.get(rid);
    const read = deps.read || ((r) => defaultRead(r, deps));
    const p = withTimeout(Promise.resolve().then(() => read(rid)), deps.timeoutMs || timeoutMs)
      .then((raw) => ({ ok: true, raw }), () => ({ ok: false, raw: null }))
      .then((r) => {
        const memo = deps.memo || MEMO; const prev = memo.get(rid);
        // a FAILED read keeps the LAST SUCCESS beside it (served while within the staleness cap); a success replaces both
        const lastOk = r.ok ? null : (prev && prev.ok ? { raw: prev.raw, at: prev.at } : (prev && prev.lastOk) || null);
        const rec = { ...r, at: deps.now ? deps.now() : Date.now(), ...(lastOk ? { lastOk } : {}) }; memo.set(rid, rec); inflight.delete(rid);
        if (!rec.ok) console.warn(absentLog, JSON.stringify({ rid, reason: 'read_failed' }));
        return rec;
      });
    inflight.set(rid, p);
    return p;
  }
  // the newest usable SUCCESS for rid (this memo, or the one a failed refresh kept) — starting a background refresh when not fresh
  function memoFor(rid, deps) {
    const now = deps.now ? deps.now() : Date.now();
    const memo = (deps.memo || MEMO).get(rid);
    const fresh = memo && now - memo.at < (memo.ok ? okTtlMs : failTtlMs);
    if (!fresh) startRead(rid, deps);   // background: never awaited here
    const ok = memo && (memo.ok ? memo : memo.lastOk);
    return ok && now - ok.at < okTtlMs + staleMaxMs ? ok : null;
  }
  return { memoFor, startRead, state: { MEMO, INFLIGHT } };
}

module.exports = { createServeMemo };
