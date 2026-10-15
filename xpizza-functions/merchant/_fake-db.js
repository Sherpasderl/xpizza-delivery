'use strict';
// H1a test helper — a tiny in-memory RTDB stand-in (ref().once/set/update/remove/transaction) for the merchant unit tests.
// It mirrors the Admin SDK surface the merchant modules use, nothing more. `failReads` makes the next reads under a prefix
// throw (an injected outage); `onTxn` lets a test interleave a write between a transaction's read and its commit.
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const parts = (p) => String(p).split('/').filter(Boolean);

function createFakeDb(initial = {}) {
  let root = clone(initial) || {};
  const failReads = new Set();
  const hooks = { onTxn: null };

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

  function ref(path) {
    return {
      async once() { guard(path); const v = get(path); return { val: () => v, exists: () => v !== null }; },
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
