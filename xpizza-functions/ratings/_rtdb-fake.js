'use strict';
// The in-memory RTDB the ratings producer's tests run on (moved verbatim from aggregate-producer.test.js so the Anuncio's day-recorder
// cells run the SAME double): ordered key queries (orderByKey + startAt / endAt / startAfter / limitToFirst), equality child queries,
// a read log (every get / once / query), and production's transaction semantics (the SDK's uncached first run sees null; an
// `undefined` there aborts; any value re-runs on the real node when the server is not null).
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function fakeDb() {
  const tree = {}; const reads = [];
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v); };
  const prune = (v) => { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(prune); const o = {}; for (const [k, x] of Object.entries(v)) { const p = prune(x); if (p !== null && p !== undefined && !(typeof p === 'object' && !Object.keys(p).length)) o[k] = p; } return o; };
  const snap = (v, rows) => ({ exists: () => v != null, val: () => (v == null ? null : clone(v)),
    forEach: (cb) => { for (const [k, x] of (rows || Object.entries(v || {}))) if (cb({ key: k, val: () => clone(x) }) === true) return true; return false; } });
  const ref = (p = '') => ({
    get: async () => { reads.push({ kind: 'get', path: p }); return snap(get(p)); }, once: async () => { reads.push({ kind: 'get', path: p }); return snap(get(p)); },
    set: async (v) => set(p, prune(v)), update: async (m) => { for (const [k, v] of Object.entries(m)) set(p ? `${p}/${k}` : k, v === null ? null : prune(v)); },
    orderByKey: () => { const q = {}; const api = {
      startAt: (k) => { q.ge = k; return api; }, endAt: (k) => { q.le = k; return api; }, startAfter: (k) => { q.gt = k; return api; }, limitToFirst: (m) => { q.first = m; return api; },
      once: async () => {
        reads.push({ kind: 'query', path: p, ...q });
        let rows = Object.entries(get(p) || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        rows = rows.filter(([k]) => (q.ge === undefined || k >= q.ge) && (q.le === undefined || k <= q.le) && (q.gt === undefined || k > q.gt));
        if (q.first !== undefined) rows = rows.slice(0, q.first);
        return snap(rows.length ? Object.fromEntries(rows) : null, rows);
      } }; return api; },
    orderByChild: (c) => ({ equalTo: (v) => ({ once: async () => { const rows = Object.entries(get(p) || {}).filter(([, r]) => r && r[c] === v); return snap(rows.length ? Object.fromEntries(rows) : null); } }) }),
    transaction: async (fn) => {
      const actual = clone(get(p)) ?? null;
      let next = fn(null);
      if (next === undefined) return { committed: false, snapshot: snap(get(p)) };
      if (actual !== null) { next = fn(actual); if (next === undefined) return { committed: false, snapshot: snap(get(p)) }; }
      set(p, prune(next)); return { committed: true, snapshot: snap(get(p)) };
    },
  });
  return { tree, reads, get, set, ref };
}

module.exports = { fakeDb };
