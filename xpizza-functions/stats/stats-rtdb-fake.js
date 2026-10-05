'use strict';
// TEST-ONLY RTDB double for the /orders read path. Models exactly the query surface the stats code uses
// — orderByChild + startAt / startAfter / endBefore / limitToFirst + once('value') — with RTDB's real
// ordering (missing/null child first, then numbers ascending, ties by key) and REAL half-open/inclusive
// semantics. Every query is LOGGED so a suite can assert read volume; EVERY write method THROWS, so a
// stats path that tried to write /orders fails here as loudly as the guard says it never does.
// The emulator suite (test/stats.emulator.test.js) runs the same reads against real RTDB.
function makeRtdb(ordersById) {
  const queries = [];
  const val = (o) => (o && typeof o.created_at === 'number' ? o.created_at : null);
  const cmp = ([ka, a], [kb, b]) => {
    const va = val(a), vb = val(b);
    if (va === null && vb !== null) return -1;
    if (vb === null && va !== null) return 1;
    if (va !== vb) return va - vb;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
  const deny = (what) => () => { throw new Error(`rtdb-fake: WRITE ATTEMPTED (${what}) — stats must never write RTDB`); };
  function query(path, q) {
    const self = {
      orderByChild: (c) => { if (c !== 'created_at') throw new Error(`rtdb-fake: unmodelled orderByChild(${c})`); return query(path, { ...q, order: c }); },
      startAt: (v, k) => query(path, { ...q, start: { v, k, incl: true } }),
      startAfter: (v, k) => query(path, { ...q, start: { v, k, incl: false } }),
      endBefore: (v) => query(path, { ...q, endBefore: v }),
      endAt: () => { throw new Error('rtdb-fake: endAt unmodelled (stats uses endBefore)'); },
      limitToFirst: (n) => query(path, { ...q, limit: n }),
      once: async (ev) => {
        if (ev !== 'value') throw new Error('rtdb-fake: once(value) only');
        if (path !== 'orders') throw new Error(`rtdb-fake: unexpected read of ${path}`);
        if (q.order !== 'created_at' || q.limit == null || !q.start || q.endBefore == null) throw new Error(`rtdb-fake: UNBOUNDED read refused ${JSON.stringify(q)}`);
        queries.push(q);
        let rows = Object.entries(ordersById).sort(cmp);
        rows = rows.filter(([k, o]) => {
          const v = val(o);
          if (v === null) return false;
          const s = q.start;
          if (v < s.v) return false;
          if (v === s.v && s.k != null) { if (s.incl ? k < s.k : k <= s.k) return false; }
          if (v === s.v && s.k == null && !s.incl) return false;
          return v < q.endBefore;
        }).slice(0, q.limit);
        return { forEach: (f) => { for (const [k, o] of rows) if (f({ key: k, val: () => JSON.parse(JSON.stringify(o)) }) === true) break; }, numChildren: () => rows.length };
      },
      set: deny('set'), update: deny('update'), push: deny('push'), remove: deny('remove'), transaction: deny('transaction'),
      child: (c) => query(`${path}/${c}`, q),
    };
    return self;
  }
  return { ref: (p) => query(String(p).replace(/^\/+/, ''), {}), _queries: queries };
}
module.exports = { makeRtdb };
