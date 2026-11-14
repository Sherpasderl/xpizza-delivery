// THE RTDB HANDLE the ref-loaded server code runs on (advisor 11-14: the Pedidos list = 3a's REAL makeMyOrders handler; the rider name =
// 3a's REAL writeDeliveryAttribution). A plain nested object; ONLY the calls those two make, each as firebase-admin answers it — anything
// else THROWS (a fake never laxer than production):
//   ref(p).once('value')                                   → { val(), exists(), forEach } (a deep copy: the caller never aliases the store)
//   ref(p).orderByChild(c)[.endBefore(v, key)].limitToLast(n).once('value') → the children ordered by (child value, key), as RTDB orders
//       them (null / absent first, then numbers ascending; a tie by key), forEach in that order
//   ref(p).set(v)                                          → writes (null deletes)
//   ref(p).transaction(fn)                                 → fn(current) — undefined aborts; → { committed, snapshot }
const copy = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const parts = (p) => String(p).split('/').filter(Boolean);

export function fakeRtdb(data) {
  const get = (p) => parts(p).reduce((x, k) => (x == null || typeof x !== 'object' ? undefined : x[k]), data);
  const put = (p, v) => {
    const ks = parts(p), last = ks.pop(); let x = data;
    for (const k of ks) { if (x[k] == null || typeof x[k] !== 'object') x[k] = {}; x = x[k]; }
    if (v === null || v === undefined) delete x[last]; else x[last] = copy(v);
  };
  const snap = (v, key, kids) => ({ key, val: () => copy(v), exists: () => v !== undefined && v !== null,
    forEach: (cb) => { for (const [k, c] of kids || Object.entries(v && typeof v === 'object' ? v : {})) if (cb(snap(c, k)) === true) break; } });
  // RTDB's orderByChild order for the values this suite stores: absent / null first, then numbers ascending; equal ⇒ by key
  const rank = (v) => (v === undefined || v === null ? [0, 0] : typeof v === 'number' ? [1, v] : (() => { throw new Error(`fakeRtdb: unsupported orderByChild value ${typeof v}`); })());
  const cmp = (a, b) => { const [ra, va] = rank(a.v), [rb, vb] = rank(b.v); return ra - rb || va - vb || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0); };
  function query(p, child, before = null, last = null) {
    return {
      endBefore(v, k) { if (before || last !== null) throw new Error('fakeRtdb: endBefore after a limit'); return query(p, child, { v, k }, last); },
      limitToLast(n) { if (!Number.isInteger(n) || n < 1) throw new Error('fakeRtdb: limitToLast'); return query(p, child, before, n); },
      once(ev) {
        if (ev !== 'value') throw new Error('fakeRtdb: once ' + ev);
        const node = get(p) || {};
        let rows = Object.entries(node).map(([k, c]) => ({ k, c, v: c && typeof c === 'object' ? c[child] : undefined })).sort(cmp);
        if (before) rows = rows.filter((r) => cmp(r, { k: before.k, v: before.v }) < 0);
        if (last !== null) rows = rows.slice(-last);
        return Promise.resolve(snap(node, parts(p).pop(), rows.map((r) => [r.k, r.c])));
      },
    };
  }
  return {
    ref(p) {
      return {
        once(ev) { if (ev !== 'value') throw new Error('fakeRtdb: once ' + ev); return Promise.resolve(snap(get(p), parts(p).pop())); },
        orderByChild(c) { return query(p, c); },
        set(v) { put(p, v); return Promise.resolve(); },
        transaction(fn) { const cur = copy(get(p)); const nx = fn(cur); if (nx === undefined) return Promise.resolve({ committed: false, snapshot: snap(cur, parts(p).pop()) }); put(p, nx); return Promise.resolve({ committed: true, snapshot: snap(get(p), parts(p).pop()) }); },
      };
    },
  };
}
