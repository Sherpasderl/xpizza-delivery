'use strict';
// LEDGER S1 (PLAN-5f-ledger-shadow-s1-r3 §1) — the DECLARED additive writes of the frozen allocation snapshot, for the goldens and frozen
// traces that compare today's handlers with a BASE that predates S1:
//   cash create (held / ASAP)   ledger_alloc/<oid>                 = snapshotOf(stored order, modeOf(request))
//   hosted card claim           payment_attempts/<aid>/ledger      = withCommittedCreatedAt(snapshotOf(order record), order created_at)
//   SDK record create           payment_sdk/<oid>/ledger           = snapshotOf(order, modeOf({ sdk: true }))
// EXACT paths only — never a prefix or a wildcard: the declared keys are the LEAVES the REAL writer (ledger/alloc-snapshot) derives
// from the STORED order, and the WRITTEN subtree at that root must equal them exactly (an extra, missing or different leaf fails);
// every other byte of a golden stays compared. Each caller also asserts non-vacuity (the path IS present where S1 writes it).
const assert = require('assert');
const LA = require('../ledger/alloc-snapshot');

const leaves = (v, pre = '', out = new Map()) => {
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) leaves(v[k], pre ? `${pre}/${k}` : k, out); } else out.set(pre, v);
  return out;
};
// RTDB keeps no null leaf and no empty object: the stored form
const stored = (v) => { if (v === null || typeof v !== 'object') return v; const o = {}; for (const [k, x] of Object.entries(v)) { const y = stored(x); if (y !== null && !(typeof y === 'object' && !Object.keys(y).length)) o[k] = y; } return Object.keys(o).length ? o : null; };

// the expected snapshot subtree for a STORED order (created_at already resolved) — the real writer's output
// headers: the request's HTTP headers — read by the REAL reader (client-floor readClientHeaders), as the handler reads them
const clientHdrOf = (headers) => require('../client-floor').readClientHeaders({ headers: Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v])) });
function expectedSnapshot(order, { body = {}, headers = null, clientHdr = null, sdk = false, hosted = false } = {}) {
  const hdr = clientHdr || clientHdrOf(headers);
  const mode = sdk ? LA.modeOf({ sdk: true }) : LA.modeOf({ body, clientHdr: hdr });
  let snap = LA.snapshotOf(order, mode);
  if (hosted) snap = LA.withCommittedCreatedAt(snap, order.created_at);
  return stored(snap);
}

// a flat Map(path → value) (a DB «leaves» tree) → the subtree at `root` as an object (null when absent)
// decode: for a leaves map that stores STRINGIFIED values (JSON.stringify per leaf), pass JSON.parse
function subtreeOf(flat, root, decode = (v) => v) {
  let out = null;
  for (const [k, v0] of flat) { const v = decode(v0);
    if (!k.startsWith(`${root}/`)) continue;
    out = out || {}; let n = out; const parts = k.slice(root.length + 1).split('/');
    for (let i = 0; i < parts.length - 1; i += 1) n = n[parts[i]] = n[parts[i]] || {};
    n[parts[parts.length - 1]] = v;
  }
  return out;
}

// The written subtree at `root` (read from the stored DB state) must EQUAL `expected` exactly; returns the declared leaf keys
// `${root}/<leaf>` (the only keys a caller may strip). `label` names the cell in the failure message (the 🔴 marker).
// createdAtSkewMs (the HOSTED snapshot only): its created_at is the order time the claim COMMITTED against (withCommittedCreatedAt), which
// may differ from the stored order's by the server-time estimate (Codex #110 r2 accepted residual) — so it is checked as a safe integer
// within that bound; EVERY other leaf stays exact
function declaredLeaves({ root, written, expected, label, createdAtSkewMs = null }) {
  assert.ok(expected && typeof expected === 'object', `🔴 ${label}: premise — the real writer derives a snapshot for ${root}`);
  const w = stored(written);
  if (createdAtSkewMs !== null) {
    assert.ok(w && Number.isSafeInteger(w.created_at) && Math.abs(w.created_at - expected.created_at) <= createdAtSkewMs, `🔴 ${label}: the hosted snapshot's created_at is the committed order time (±${createdAtSkewMs} ms)`);
    const { created_at: _a, ...wr } = w; const { created_at: _b, ...ex } = expected;
    assert.deepStrictEqual(wr, ex, `🔴 ${label}: the S1 snapshot at ${root} is EXACTLY the real writer's (alloc-snapshot of the stored order; created_at bounded above)`);
  } else {
    assert.deepStrictEqual(w, expected, `🔴 ${label}: the S1 snapshot at ${root} is EXACTLY the real writer's (alloc-snapshot of the stored order)`);
  }
  return [...leaves(expected).keys()].map((k) => `${root}/${k}`);
}

const HOSTED_SKEW_MS = 60000;
module.exports = { HOSTED_SKEW_MS, expectedSnapshot, declaredLeaves, subtreeOf, clientHdrOf, leaves, stored };
