'use strict';
// Portal 1D · D4-b — a minimal in-memory RTDB for driving the REAL reward/payment writers in unit tests
// (reserveRedemption, prepareRedemption, the charge acquirers). It implements only what those writers
// call: ref(path).get / once('value') / set / update / transaction / child / push. Values are stored as
// JSON (so an RTDB-style normalisation of undefined applies) and every read hands back a fresh copy.
// It also RECORDS every operation as `<op> <path>`, so a test can assert a writer's read/transaction
// SEQUENCE (the plan's call-sequence golden) without a running emulator. The emulator suite exercises
// the same writers against the real RTDB.

function createFakeRtdb(initial = {}) {
  let root = JSON.parse(JSON.stringify(initial));
  const calls = [];
  const split = (p) => String(p || '').split('/').filter(Boolean);
  const getAt = (path) => { let cur = root; for (const s of split(path)) { if (cur == null || typeof cur !== 'object') return null; cur = cur[s]; } return cur === undefined ? null : cur; };
  // RTDB normalisation: a null field is not stored, and a container left empty is not stored either.
  const normalize = (v) => {
    if (v === null || typeof v !== 'object') return v;
    const out = Array.isArray(v) ? [] : {};
    for (const k of Object.keys(v)) { const c = normalize(v[k]); if (c !== null && c !== undefined) out[k] = c; }
    return Object.keys(out).length ? out : null;
  };
  const clean = (v) => (v === undefined ? null : normalize(JSON.parse(JSON.stringify(v))));
  const setAt = (path, value) => {
    const parts = split(path);
    if (!parts.length) { root = clean(value) || {}; return; }
    let cur = root;
    for (let i = 0; i < parts.length - 1; i += 1) { if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}; cur = cur[parts[i]]; }
    const v = clean(value);
    if (v === null) delete cur[parts[parts.length - 1]]; else cur[parts[parts.length - 1]] = v;
  };
  const snap = (path) => { const v = getAt(path); const c = v == null ? null : JSON.parse(JSON.stringify(v)); return { val: () => c, exists: () => c !== null, key: split(path).pop() || null }; };
  let pushSeq = 0;
  function ref(path = '') {
    return {
      path,
      child: (c) => ref(`${path}/${c}`),
      get: async () => { calls.push(`get ${path}`); return snap(path); },
      once: async () => { calls.push(`once ${path}`); return snap(path); },
      set: async (v) => { calls.push(`set ${path}`); setAt(path, v); },
      update: async (obj) => { calls.push(`update ${path}`); for (const [k, v] of Object.entries(obj || {})) setAt(`${path}/${k}`, v); },
      push: async (v) => { calls.push(`push ${path}`); const k = `p${String(pushSeq += 1).padStart(6, '0')}`; setAt(`${path}/${k}`, v); return ref(`${path}/${k}`); },
      transaction: async (fn) => {
        calls.push(`transaction ${path}`);
        const cur = getAt(path);
        const next = fn(cur == null ? null : JSON.parse(JSON.stringify(cur)));
        if (next === undefined) return { committed: false, snapshot: snap(path) };
        setAt(path, next);
        return { committed: true, snapshot: snap(path) };
      },
    };
  }
  return { ref, calls, dump: () => JSON.parse(JSON.stringify(root)), _getAt: getAt };
}

module.exports = { createFakeRtdb };
