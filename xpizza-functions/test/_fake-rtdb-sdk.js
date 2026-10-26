'use strict';
// ORCHESTRATION O1a — test-only in-memory RTDB that is FAITHFUL to the Admin SDK where writers can get it wrong:
//   • transaction(fn): the speculative FIRST pass runs fn(null) (an uncached node) and an `undefined` there ABORTS without
//     consulting the server; a non-null server value re-runs fn on it; null / undefined leaves and empty objects are pruned;
//   • ref(path).update(patch) is a multi-path update relative to path; orderByChild(c).equalTo(x).once() filters children.
// Seams: hooks[path] = async fn run before a transaction on that path (one-shot, interleavings); failAfter[path] = true | k
// throws AFTER the next / k-th successful write on that path (crashes). `writes` logs every committed write as [kind, path, value].
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function fakeRtdb(init = {}, { strict = false } = {}) {
  const root = clone(init);
  const writes = [];
  const segs = (p) => (p ? String(p).split('/').filter(Boolean) : []);
  const get = (p) => segs(p).reduce((o, k) => (o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null), root);
  const prune = () => { (function walk(o) { for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === 'object') { walk(v); if (!Object.keys(v).length) delete o[k]; } else if (v === null || v === undefined) delete o[k]; } })(root); };
  const set = (p, v) => {
    const ks = segs(p); if (!ks.length) { for (const k of Object.keys(root)) delete root[k]; Object.assign(root, clone(v) || {}); return; }
    let o = root; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
    if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v);
    prune();
  };
  prune();   // as stored: RTDB never holds a null leaf or an empty object
  const hooks = {};
  const failAfter = {};
  const crash = (p) => { if (!(p in failAfter)) return false; const v = failAfter[p]; if (v === true || v <= 1) { delete failAfter[p]; return true; } failAfter[p] = v - 1; return false; };
  const snap = (v) => ({ val: () => clone(v), exists: () => v != null });
  // OPT-IN strict mode (O1b): refuse an `undefined` leaf on set / update / transaction, as the real RTDB does ("Data returned
  // contains undefined in property …") — default off, so no existing suite shifts.
  const noUndefined = (v, where) => {
    if (!strict) return;
    if (v === undefined) throw new Error(`transaction failed: Data returned contains undefined in property '${where.replace(/\//g, '.')}'`);
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) noUndefined(x, `${where}/${k}`);
  };
  const ref = (p = '') => ({
    async once() { return snap(get(p)); },
    async set(v) { noUndefined(v, p); set(p, v); writes.push(['set', p, clone(v)]); if (crash(p)) throw new Error(`crash after ${p}`); },
    async remove() { set(p, null); writes.push(['set', p, null]); },
    async update(patch) {
      for (const [k, v] of Object.entries(patch)) noUndefined(v, p ? `${p}/${k}` : k);
      for (const [k, v] of Object.entries(patch)) set(p ? `${p}/${k}` : k, v);
      writes.push(['update', p, clone(patch)]);
      const hit = Object.keys(patch).map((k) => (p ? `${p}/${k}` : k)).find((k) => crash(k)); if (hit) throw new Error(`crash after ${hit}`);
    },
    orderByChild(child) { return { equalTo(x) { return { async once() { const all = get(p) || {}; const out = {}; for (const [k, v] of Object.entries(all)) if (v && v[child] === x) out[k] = v; return snap(Object.keys(out).length ? out : null); } }; } }; },
    async transaction(fn) {
      if (hooks[p]) { const h = hooks[p]; delete hooks[p]; await h(); }
      const real = clone(get(p));
      let next = fn(null);
      if (next === undefined) return { committed: false, snapshot: snap(null) };
      if (real !== null) next = fn(clone(real));
      if (next === undefined) return { committed: false, snapshot: snap(real) };
      noUndefined(next, p);
      set(p, next); writes.push(['txn', p, clone(next)]);
      if (crash(p)) throw new Error(`crash after ${p}`);
      return { committed: true, snapshot: snap(get(p)) };
    },
  });
  return { ref, root, get, hooks, failAfter, writes };
}

module.exports = { fakeRtdb };
