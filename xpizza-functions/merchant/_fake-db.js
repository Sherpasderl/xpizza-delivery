'use strict';
// H1a test helper — a tiny in-memory RTDB stand-in (ref().once/set/update/remove/transaction) for the merchant unit tests.
// It mirrors the Admin SDK surface the merchant modules use, nothing more. `failReads` makes the next reads under a prefix
// throw (an injected outage); `onTxn` lets a test interleave a write between a transaction's read and its commit.
// `afterUpdater(path, proposed)` (one-shot, additive) runs AFTER the updater and BEFORE the compare-and-put, so a write it commits makes
// the compare fail and the updater RE-RUN on that value — RTDB's real retry (onTxn runs before the updater and can never prove one).
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const parts = (p) => String(p).split('/').filter(Boolean);

function createFakeDb(initial = {}) {
  let root = clone(initial) || {};
  const failReads = new Set();
  const hooks = { onTxn: null, afterUpdater: null };

  function get(path) {
    let cur = root;
    for (const k of parts(path)) { if (cur === null || typeof cur !== 'object' || !(k in cur)) return null; cur = cur[k]; }
    return clone(cur);
  }
  function put(path, val) {
    const ks = parts(path);
    if (!ks.length) { root = clone(val) || {}; return; }
    let cur = root;
    for (const k of ks.slice(0, -1)) { if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {}; cur = cur[k]; }
    const last = ks[ks.length - 1];
    if (val === null || val === undefined) delete cur[last]; else cur[last] = clone(val);
  }
  function guard(path) { for (const p of failReads) if (String(path).startsWith(p)) throw new Error(`injected read failure: ${path}`); }

  function ref(path = "") {
    return {
      async once() { guard(path); const v = get(path); return { val: () => v, exists: () => v !== null }; },
      // an equality query over direct children (orderByChild(k).equalTo(v).once()), as the Admin SDK returns it: matches or null
      orderByChild(k) { return { equalTo(v) { return { async once() {
        guard(path); const all = get(path) || {};
        const hit = Object.fromEntries(Object.entries(all).filter(([, c]) => c !== null && typeof c === 'object' && c[k] === v));
        const out = Object.keys(hit).length ? hit : null; return { val: () => out, exists: () => out !== null };
      } }; },
      // offer-audience (additive): the LAST n children ordered by child `k` (the SDK's order: absent / non-number values first, then
      // numbers ascending; ties by key) — orderByChild('ts').limitToLast(n), as my-orders reads user_orders
      limitToLast(nLast) { return { async once() {
        guard(path); const all = get(path) || {};
        const rank = (c) => (c !== null && typeof c === 'object' && typeof c[k] === 'number' ? [1, c[k]] : [0, 0]);
        const ents = Object.entries(all).sort(([ka, a], [kb, b]) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || (ka < kb ? -1 : ka > kb ? 1 : 0); }).slice(-nLast);
        const out = ents.length ? Object.fromEntries(ents) : null; return { val: () => out, exists: () => out !== null };
      } }; } }; },
      // offer-audience (additive): key-ordered range reads — orderByKey().endBefore(k).limitToFirst(n) (the bounded sweeps) and
      // orderByKey().limitToFirst(n); keys compared as the SDK compares string keys
      orderByKey() {
        const q = (endBefore, nFirst) => ({
          endBefore(kk) { return q(kk, nFirst); },
          limitToFirst(nn) { return q(endBefore, nn); },
          async once() {
            guard(path); const all = get(path) || {};
            let ents = Object.entries(all).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
            if (endBefore !== undefined) ents = ents.filter(([kk]) => kk < endBefore);
            if (nFirst !== undefined) ents = ents.slice(0, nFirst);
            const out = ents.length ? Object.fromEntries(ents) : null; return { val: () => out, exists: () => out !== null };
          },
        });
        return q(undefined, undefined);
      },
      async set(v) { put(path, v); },
      async remove() { put(path, null); },
      async update(obj) { for (const [k, v] of Object.entries(obj)) put(`${path}/${k}`, v); },
      async transaction(fn) {
        guard(path);
        for (let attempt = 0; attempt < 5; attempt++) {
          const before = get(path);
          if (hooks.onTxn) { const h = hooks.onTxn; hooks.onTxn = null; await h(path); }
          const now = get(path);
          const out = fn(clone(now));
          if (out === undefined) return { committed: false, snapshot: { val: () => now } };
          if (hooks.afterUpdater) { const h = hooks.afterUpdater; hooks.afterUpdater = null; await h(path, clone(out)); }
          if (JSON.stringify(now) !== JSON.stringify(get(path))) continue; // concurrent change → retry, like RTDB
          put(path, out);
          void before;
          return { committed: true, snapshot: { val: () => get(path) } };
        }
        throw new Error('transaction retries exhausted');
      },
    };
  }
  return { ref, get, put, failReads, hooks };
}

module.exports = { createFakeDb };
