'use strict';
const { withPath } = require('./test/_ref-path');
// TEST-ONLY in-memory RTDB model that is NEVER LAXER than production (rule 29; codex extra-pay r2):
//   · keys are validated RECURSIVELY on every write (no empty key, no . # $ [ ] /), and an undefined value anywhere is
//     refused, as RTDB rejects both;
//   · null children are PRUNED (an object written with null fields stores none of them; an emptied object disappears);
//   · snapshots are IMMUTABLE (deep-cloned when taken; later writes never show through);
//   · transactions follow the Admin SDK: the first call sees the cached value (null when uncached) and returning undefined
//     there ABORTS; a value is sent and, if the server value differs from what the function saw, the function is RE-RUN with
//     the server value — and a concurrent write landing while the function ran is a CONFLICT that re-runs it too (up to 25×).
//   · a write is PREPARED (validated + every server-value sentinel resolved) before anything is COMMITTED, so a refused write —
//     including every entry of an update — changes nothing; update() refuses a non-object patch and overlapping paths;
//     {'.sv':'timestamp'} resolves to now(), {'.sv':{increment:n}} to the previous numeric value + n (n when absent / not a number).
// Optional hooks let a test interleave work deterministically: beforeRead(path, api), beforeTx(path, api),
// beforeWrite(path, value, api); now() is the clock a {'.sv':'timestamp'} write resolves to.
// NOT MODELLED (production does not write these — grep-checked 11-16, Codex #112 accepted residual): an overlap with the root ''
// path, a//b path normalization, .priority / .value keys (the model is STRICTER there: refused), function values, more than 32
// levels of nesting. Do not assume full SDK fidelity for them.
const RESERVED = /[.#$[\]/\u0000-\u001f\u007f]/;   // as the Admin SDK: . # $ [ ] / and ASCII control characters

function validateKeys(v, where, seed = false) {
  if (v === undefined) { if (seed) return; throw new Error(`undefined value at ${where} (RTDB refuses undefined)`); }
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`non-finite number at ${where} (RTDB refuses NaN / Infinity)`);
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
// prevAt(relativePath) → the value stored at that place BEFORE this write (an increment resolves against it)
function resolveServerValues(v, now, prevAt = () => null, rel = '') {
  if (v === null || typeof v !== 'object') return v;
  if (isServerValue(v)) {
    const sv = v['.sv'];
    if (sv === 'timestamp') return now;
    if (sv && typeof sv === 'object' && Object.keys(sv).length === 1 && typeof sv.increment === 'number' && Number.isFinite(sv.increment)) {
      const prev = prevAt(rel);
      return (typeof prev === 'number' ? prev : 0) + sv.increment;
    }
    throw new Error(`server value ${JSON.stringify(v)} not modelled`);
  }
  const out = Array.isArray(v) ? [] : {};
  for (const [k, x] of Object.entries(v)) out[k] = resolveServerValues(x, now, prevAt, rel ? `${rel}/${k}` : k);
  return out;
}
function prune(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) { const a = v.map(prune); return a.some((x) => x !== null) ? a : null; }   // RTDB: an array with no children is absent
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
  // PREPARE (may throw; touches nothing): the path, the value, and every sentinel resolved against the CURRENT state
  const prepare = (p, val) => {
    const a = segs(p);
    for (const k of a) if (!k || RESERVED.test(k)) throw new Error(`invalid RTDB key "${k}" in path ${p}`);
    validateKeys(val, p || '/');
    const now = hooks.now ? hooks.now() : Date.now();
    return prune(resolveServerValues(clone(val), now, (rel) => getAt(rel ? (p ? `${p}/${rel}` : rel) : p)));
  };
  const setAt = (p, val) => commit(p, prepare(p, val));
  // COMMIT (never throws on a prepared value)
  const commit = (p, v) => {
    const a = segs(p);
    if (!a.length) { root = v || {}; return; }
    let n = root; const chain = [];
    for (let i = 0; i < a.length - 1; i++) { if (n[a[i]] == null || typeof n[a[i]] !== 'object') n[a[i]] = {}; chain.push([n, a[i]]); n = n[a[i]]; }
    const l = a[a.length - 1];
    if (v === null) delete n[l]; else n[l] = v;
    for (let i = chain.length - 1; i >= 0; i--) { const [parent, key] = chain[i]; if (parent[key] && typeof parent[key] === 'object' && !Object.keys(parent[key]).length) delete parent[key]; }
  };
  let pk = 0;
  // RTDB key order: 32-bit integer keys first (numerically), then the rest by string
  const INT = /^-?(0|[1-9]\d*)$/;
  const isInt = (k) => INT.test(k) && Number(k) >= -2147483648 && Number(k) <= 2147483647;
  const keyCmp = (a, b) => (isInt(a) !== isInt(b) ? (isInt(a) ? -1 : 1) : isInt(a) ? Number(a) - Number(b) : (a < b ? -1 : a > b ? 1 : 0));
  const snap = (v) => { const frozen = clone(v); return { val: () => clone(frozen), exists: () => frozen != null }; };
  // RTDB value order (orderByValue / orderByChild): null < false < true < numbers < strings < objects
  const rank = (v) => (v === null || v === undefined ? 0 : v === false ? 1 : v === true ? 2 : typeof v === 'number' ? 3 : typeof v === 'string' ? 4 : 5);
  const cmpV = (a, b) => (rank(a) !== rank(b) ? rank(a) - rank(b) : rank(a) === 3 ? a - b : rank(a) === 4 ? (a < b ? -1 : a > b ? 1 : 0) : 0);
  const queries = [];
  const api = {};
  const ref = (p = '') => {
    if (/[.#$[\]\u0000-\u001f\u007f]/.test(p)) throw new Error(`invalid RTDB path "${p}"`);   // as the Admin SDK: a path with . # $ [ ] or a control character throws at ref(), read or write
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
        // As the Admin SDK (Codex #111 P3): the WHOLE patch is validated BEFORE anything is written — every path segment, every value
        // (undefined / non-finite / a reserved key refused), and no path may be an ancestor of (or equal to) another — so a refused
        // update writes nothing.
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error(`update: the patch must be an object (got ${patch === null ? 'null' : Array.isArray(patch) ? 'an array' : typeof patch})`);
        const entries = Object.entries(patch).map(([k, v]) => [p ? `${p}/${k}` : k, v]);
        for (const [full, v] of entries) {
          for (const k of segs(full)) if (!k || RESERVED.test(k)) throw new Error(`invalid RTDB key "${k}" in path ${full}`);
          validateKeys(v, full || '/');
        }
        const paths = entries.map(([full]) => segs(full).join('/')).sort();
        for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
          if (paths[j] === paths[i] || paths[j].startsWith(`${paths[i]}/`)) throw new Error(`update: path ${paths[i]} is an ancestor of (or equal to) ${paths[j]}`);
        }
        const prepared = entries.map(([full, v]) => [full, prepare(full, v)]);   // every sentinel resolved BEFORE the first commit
        for (const [full, v] of prepared) commit(full, v);
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
          const keys = Object.keys(v).sort(keyCmp);
          const out = {}; for (const k of keys.slice(0, n)) out[k] = v[k];
          return snap(keys.length ? out : null);
        } });
        // LEDGER S5: a key range (inclusive both ends, RTDB key order) — the refund rows of one attempt (`${aid}-${ts}`)
        const lim = (n) => { if (!Number.isInteger(n) || n < 1) throw new Error(`limitToFirst: invalid limit ${n}`); return n; };
        const range = (a, b, n) => ({ async once() {
          if (hooks.beforeRead) await hooks.beforeRead(p, api);
          const v = getAt(p);
          if (v == null || typeof v !== 'object') return snap(null);
          const keys = Object.keys(v).filter((k) => keyCmp(k, a) >= 0 && (b === undefined || keyCmp(k, b) <= 0)).sort(keyCmp).slice(0, n);
          const out = {}; for (const k of keys) out[k] = v[k];
          return snap(keys.length ? out : null);
        }, limitToFirst(m) { return range(a, b, lim(m)); } });
        const str = (x, w) => { if (typeof x !== 'string') throw new Error(`orderByKey().${w}: a key bound must be a string`); return x; };
        return { limitToFirst(n) { if (!Number.isInteger(n) || n < 1) throw new Error(`limitToFirst: invalid limit ${n}`); return page(n); },
          startAt(a) { str(a, 'startAt'); return { ...range(a), endAt(b) { return range(a, str(b, 'endAt')); } }; } };
      },
      // LEDGER S5: a child-value query in RTDB VALUE order (absent < false < true < numbers < strings < objects, ties by key):
      // startAt(x) keeps every child whose value ranks ≥ x — so a numeric startAt ALSO returns string / object values, as production
      // does; equalTo(x) is exact (a primitive). Each query is logged in db.queries ({ path, child }) for the index cross-check.
      orderByChild(c) {
        if (typeof c !== 'string' || !c || RESERVED.test(c)) throw new Error(`orderByChild: invalid child "${c}"`);
        queries.push({ path: p, child: c });
        const cv = (x) => (x && typeof x === 'object' && x[c] !== undefined ? x[c] : null);
        // the bounds the Admin SDK accepts (Codex #116 #4, differential cell HRM-BOUNDS): null, a boolean, a FINITE number or a string;
        // startAt(undefined) is startAt(null), equalTo(undefined) throws; NaN / ±Infinity / objects / arrays throw
        const prim = (x, w) => {
          if (x === undefined && w === 'startAt') return null;
          if (x === null || typeof x === 'boolean' || typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x))) return x;
          throw new Error(`orderByChild().${w}: ${String(x)} is not a valid bound (null, boolean, finite number or string)`);
        };
        const sel = (keep, n) => ({ async once() {
          if (hooks.beforeRead) await hooks.beforeRead(p, api);
          const v = getAt(p);
          if (v == null || typeof v !== 'object') return snap(null);
          const keys = Object.keys(v).filter((k) => keep(cv(v[k]))).sort((a, b) => cmpV(cv(v[a]), cv(v[b])) || keyCmp(a, b)).slice(0, n);
          const out = {}; for (const k of keys) out[k] = v[k];
          return snap(keys.length ? out : null);
        }, limitToFirst(m) { if (!Number.isInteger(m) || m < 1) throw new Error(`limitToFirst: invalid limit ${m}`); return sel(keep, m); } });
        return { startAt(x) { const b = prim(x, 'startAt'); return sel((y) => cmpV(y, b) >= 0); }, equalTo(x) { const b = prim(x, 'equalTo'); return sel((y) => rank(y) === rank(b) && (b === null || y === b)); } };
      },
      // a value-ordered page, as RTDB orders values: null < false < true < numbers < strings < objects, ties by key;
      // endAt is inclusive; a non-positive limit throws instead of returning everything
      orderByValue() {
        const page = (end, n) => ({ async once() {
          if (hooks.beforeRead) await hooks.beforeRead(p, api);
          const v = getAt(p);
          if (v == null || typeof v !== 'object') return snap(null);
          const keys = Object.keys(v).filter((k) => end === undefined || cmpV(v[k], end) <= 0)
            .sort((a, b) => cmpV(v[a], v[b]) || keyCmp(a, b));
          const out = {}; for (const k of keys.slice(0, n)) out[k] = v[k];
          return snap(keys.length ? out : null);
        } });
        const lim = (end) => ({ limitToFirst(n) { if (!Number.isInteger(n) || n < 1) throw new Error(`limitToFirst: invalid limit ${n}`); return page(end, n); } });
        return { ...lim(undefined), endAt(e) { return lim(e); } };
      },
    };
    return withPath(r, p);   // + the SDK's path API (toString / root / key), test/_ref-path.js
  };
  Object.assign(api, { ref, getAt, setAt, queries });
  // a LIVE getter: Object.assign would copy a getter's value once, at creation, and every later db.root would be stale
  Object.defineProperty(api, 'root', { get: () => clone(root) || {}, enumerable: true });
  return api;
}

module.exports = { makeHonestDb, validateKeys, prune };
