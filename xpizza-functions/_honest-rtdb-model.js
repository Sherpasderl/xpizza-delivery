'use strict';
// TEST-ONLY in-memory RTDB model that is NEVER LAXER than production (rule 29; codex extra-pay r2):
//   · keys are validated RECURSIVELY on every write (no empty key, no . # $ [ ] /), and an undefined value anywhere is
//     refused, as RTDB rejects both;
//   · null children are PRUNED (an object written with null fields stores none of them; an emptied object disappears);
//   · snapshots are IMMUTABLE (deep-cloned when taken; later writes never show through);
//   · transactions follow the Admin SDK: the first call sees the cached value (null when uncached) and returning undefined
//     there ABORTS; a value is sent and, if the server value differs from what the function saw, the function is RE-RUN with
//     the server value — and a concurrent write landing while the function ran is a CONFLICT that re-runs it too (up to 25×).
// Optional hooks let a test interleave work deterministically: beforeRead(path, api), beforeTx(path, api),
// beforeWrite(path, value, api); now() is the clock a {'.sv':'timestamp'} write resolves to.
const RESERVED = /[.#$[\]/]/;

function validateKeys(v, where, seed = false) {
  if (v === undefined) { if (seed) return; throw new Error(`undefined value at ${where} (RTDB refuses undefined)`); }
  if (v === null || typeof v !== 'object') return;
  if (isServerValue(v)) return;
  for (const k of Object.keys(v)) {
    if (!k || RESERVED.test(k)) throw new Error(`invalid RTDB key "${k}" under ${where}`);
    validateKeys(v[k], `${where}/${k}`, seed);
  }
}
// A server-value sentinel ({'.sv': 'timestamp'}) is the one dotted key RTDB accepts; the model resolves it to its clock
// and refuses any other sentinel loudly rather than store something production never would.
function isServerValue(v) { return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && Object.prototype.hasOwnProperty.call(v, '.sv'); }
function resolveServerValues(v, now) {
  if (v === null || typeof v !== 'object') return v;
  if (isServerValue(v)) { if (v['.sv'] === 'timestamp') return now; throw new Error(`server value ${JSON.stringify(v)} not modelled`); }
  const out = Array.isArray(v) ? [] : {};
  for (const [k, x] of Object.entries(v)) out[k] = resolveServerValues(x, now);
  return out;
}
function prune(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) { const p = prune(x); if (p !== null) out[k] = p; }
  return Object.keys(out).length ? out : null;
}
const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function makeHonestDb(initial = {}, hooks = {}) {
  validateKeys(initial, '/', true);                            // a seed may spell "absent" as undefined; a WRITE may not
  let root = prune(clone(initial)) || {};
  const segs = (p) => (p ? p.split('/') : []);
  const getAt = (p) => { let n = root; for (const k of segs(p)) { if (n == null || typeof n !== 'object') return null; n = n[k]; } return n === undefined ? null : clone(n); };
  const setAt = (p, val) => {
    const a = segs(p);
    for (const k of a) if (!k || RESERVED.test(k)) throw new Error(`invalid RTDB key "${k}" in path ${p}`);
    validateKeys(val, p || '/');
    const v = prune(resolveServerValues(clone(val), hooks.now ? hooks.now() : Date.now()));
    if (!a.length) { root = v || {}; return; }
    let n = root; const chain = [];
    for (let i = 0; i < a.length - 1; i++) { if (n[a[i]] == null || typeof n[a[i]] !== 'object') n[a[i]] = {}; chain.push([n, a[i]]); n = n[a[i]]; }
    const l = a[a.length - 1];
    if (v === null) delete n[l]; else n[l] = v;
    for (let i = chain.length - 1; i >= 0; i--) { const [parent, key] = chain[i]; if (parent[key] && typeof parent[key] === 'object' && !Object.keys(parent[key]).length) delete parent[key]; }
  };
  let pk = 0;
  const snap = (v) => { const frozen = clone(v); return { val: () => clone(frozen), exists: () => frozen != null }; };
  const api = {};
  const ref = (p = '') => {
    if (/[.#$[\]]/.test(p)) throw new Error(`invalid RTDB path "${p}"`);   // as the Admin SDK: a path with . # $ [ ] throws at ref(), read or write
    const r = {
      async once() { if (hooks.beforeRead) await hooks.beforeRead(p, api); return snap(getAt(p)); },
      async get() { return r.once(); },
      async transaction(fn) {
        if (hooks.beforeTx) await hooks.beforeTx(p, api);
        let seen = null; let nx = fn(null);                        // the uncached first call
        for (let i = 0; i < 25; i++) {
          if (nx === undefined) return { committed: false, snapshot: snap(getAt(p)) };
          const server = getAt(p);
          if (!same(server, seen)) { seen = server; nx = fn(clone(server)); continue; }   // mismatch → re-run with the server value
          await Promise.resolve();                                 // a write may land while the function's result is in flight
          if (!same(getAt(p), seen)) { seen = getAt(p); nx = fn(clone(seen)); continue; }   // conflict → re-run
          setAt(p, nx);
          return { committed: true, snapshot: snap(getAt(p)) };
        }
        throw new Error(`transaction on ${p} did not converge`);
      },
      async update(patch) {
        if (hooks.beforeWrite) await hooks.beforeWrite(p, patch, api);
        for (const [k, v] of Object.entries(patch || {})) setAt(p ? `${p}/${k}` : k, v);
      },
      async set(v) { if (hooks.beforeWrite) await hooks.beforeWrite(p, v, api); setAt(p, v); },
      async push(v) { const k = `k${String(++pk).padStart(6, '0')}`; setAt(p ? `${p}/${k}` : k, v); return { key: k }; },
      async remove() { setAt(p, null); },
      // a key-ordered page, as RTDB orders keys: 32-bit integer keys first (numerically), then the rest by string; an
      // unsupported order or a non-positive limit throws instead of returning everything
      orderByKey() {
        const page = (n) => ({ async once() {
          if (hooks.beforeRead) await hooks.beforeRead(p, api);
          const v = getAt(p);
          if (v == null || typeof v !== 'object') return snap(null);
          const INT = /^-?(0|[1-9]\d*)$/;
          const isInt = (k) => INT.test(k) && Number(k) >= -2147483648 && Number(k) <= 2147483647;
          const keys = Object.keys(v).sort((a, b) => (isInt(a) !== isInt(b) ? (isInt(a) ? -1 : 1) : isInt(a) ? Number(a) - Number(b) : (a < b ? -1 : a > b ? 1 : 0)));
          const out = {}; for (const k of keys.slice(0, n)) out[k] = v[k];
          return snap(keys.length ? out : null);
        } });
        return { limitToFirst(n) { if (!Number.isInteger(n) || n < 1) throw new Error(`limitToFirst: invalid limit ${n}`); return page(n); } };
      },
    };
    return r;
  };
  Object.assign(api, { ref, getAt, setAt });
  // a LIVE getter: Object.assign would copy a getter's value once, at creation, and every later db.root would be stale
  Object.defineProperty(api, 'root', { get: () => clone(root) || {}, enumerable: true });
  return api;
}

module.exports = { makeHonestDb, validateKeys, prune };
