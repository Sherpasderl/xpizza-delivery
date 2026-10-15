'use strict';
// PLATFORM F1 — test-only in-memory RTDB handle for the brand store and CLI core. Supports ref(path).once('value') / set / transaction,
// counts writes (`sets`, `txns`) and reads (`reads`), and `beforeTxn` injects a concurrent write just before a transaction commits.
// Empty objects are dropped on write, as RTDB does.
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const prune = (v) => {
  if (v === null || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) { const p = prune(x); if (p !== null && p !== undefined && !(typeof p === 'object' && !Object.keys(p).length)) out[k] = p; }
  return Object.keys(out).length ? out : null;
};

function fakeRtdb(init = {}) {
  const db = { data: clone(init), reads: [], sets: 0, txns: 0, beforeTxn: null };
  const get = (p) => p.split('/').reduce((o, k) => (o == null ? undefined : o[k]), db.data);
  const put = (p, v) => {
    const ks = p.split('/'); let o = db.data;
    for (const k of ks.slice(0, -1)) o = o[k] = o[k] || {};
    const pv = prune(clone(v));
    if (pv === null) delete o[ks.at(-1)]; else o[ks.at(-1)] = pv;
  };
  db.ref = (p) => ({
    once: async () => { db.reads.push(p); const v = get(p); return { val: () => (v === undefined ? null : clone(v)) }; },
    set: async (v) => { db.sets += 1; put(p, v); },
    transaction: async (fn) => {
      db.txns += 1;
      if (db.beforeTxn) { const f = db.beforeTxn; db.beforeTxn = null; f(); }
      const cur = get(p) === undefined ? null : clone(get(p));
      const next = fn(cur);
      if (next === undefined) return { committed: false };
      put(p, next);
      return { committed: true };
    },
  });
  return db;
}

module.exports = { fakeRtdb };
