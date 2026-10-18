'use strict';
// PLATFORM F2 Q1 — test-only in-memory RTDB handle for the access tools: ref(p).once('value'); ref(p).orderByKey().startAfter(k)
// .limitToFirst(n).once('value') (records each page's row count in `queries`); ref().update(multi-path) (records `updates`).
function pagedFake(init) {
  const db = { data: JSON.parse(JSON.stringify(init)), queries: [], updates: [] };
  const at = (p) => (p ? p.split('/').reduce((o, k) => (o == null ? undefined : o[k]), db.data) : db.data);
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  db.ref = (p = '') => {
    const q = { after: null, n: Infinity };
    const api = {
      orderByKey: () => api, startAfter: (k) => { q.after = k; return api; }, limitToFirst: (n) => { q.n = n; return api; },
      once: async () => {
        const v = at(p);
        if (q.n === Infinity) return { val: () => clone(v), forEach: () => {} };
        const keys = Object.keys(v || {}).sort().filter((k) => q.after === null || k > q.after).slice(0, q.n);
        db.queries.push({ path: p, rows: keys.length });
        return { val: () => null, forEach: (fn) => keys.forEach((key) => fn({ key, val: () => clone(v[key]) })) };
      },
      update: async (u) => {
        db.updates.push(u);
        for (const [k, v] of Object.entries(u)) {
          const ks = k.split('/'); let o = db.data;
          for (const s of ks.slice(0, -1)) o = o[s] = o[s] || {};
          if (v === null) delete o[ks.at(-1)]; else o[ks.at(-1)] = v;
        }
      },
    };
    return api;
  };
  return db;
}
module.exports = { pagedFake };
