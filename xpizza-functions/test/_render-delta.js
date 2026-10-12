'use strict';
/* THE RENDER-ON DELTA, asserted against the render-OFF trace of the SAME run (1D add-product B, PB-2 advisor ruling (A)).
 *
 * A render-ON companion cell records the same request with the platform render capability ON (test/_render-pin.js) and
 * asserts: ON trace == OFF trace with EXACTLY the listed insertions at the listed positions, and nothing else. The OFF
 * side is the real handler's trace in this run (itself equal to the frozen golden), never a hand-written expectation;
 * only the inserted calls are listed, and each list names the code that issues it.
 *
 * The render-gated reads (index.js, PB-1):
 *   • chargeOnlineOrder, a reward request (body.redeem + a verified customer) — catalog/bound-reuse.js probeBoundReuse,
 *     BEFORE prepareRedemption, right after the customer's deleted_uids check:
 *       PROBE_ABSENT: the order read — no order / another customer's / no bound charge-input fingerprint / a different one
 *                     → null, the current path continues unchanged;
 *       PROBE_FULL:   the order read, classifyHostedAttempt (its order read + attempt read), the attempt read, the hold
 *                     read — the full probe; it returns null (the hold is not this order's) or answers the bound reuse.
 *   • quoteOrder — GI.groupIssues → gateReader().intakeGatesFor: the gate pointer (asserted in its suite).
 */
const assert = require('assert');

const once = (path) => ({ db: 'rtdb', op: 'once', path });
const PROBE_ABSENT = () => [once('orders/<oid>')];
const PROBE_FULL = (rid) => [
  once('orders/<oid>'),                                     // bound-reuse.js: the order
  once('orders/<oid>'), once('payment_attempts/<active_attempt_id>'),   // classifyHostedAttempt (pixelpay-hosted-charge.js)
  once('payment_attempts/<active_attempt_id>'),             // bound-reuse.js: the live attempt
  once(`user_rewards/<uid>/${rid}/reservations/<oid>`),     // bound-reuse.js: the hold
];

// the probe's position: right after the verified customer's deleted_uids read (it needs customer_uid, index.js)
const isUidCheck = (e) => e.db === 'rtdb' && e.op === 'get' && e.path === 'deleted_uids/<uid>';
function afterUidCheck(off, label) {
  const i = off.findIndex(isUidCheck);
  assert.ok(i > -1, `${label}: premise — the render-OFF trace carries the customer's deleted_uids read`);
  return i + 1;
}

// ON == OFF with `ops` inserted before off[at] — nothing else (the delta must be non-empty: a sensitivity of the pin)
function assertInserted(off, on, at, ops, label) {
  assert.ok(ops.length > 0, `${label}: the declared delta is non-empty`);
  const want = [...off.slice(0, at), ...ops, ...off.slice(at)];
  assert.deepStrictEqual(on, want, `🔴 ${label}: the render-ON trace is not the render-OFF trace + exactly ${JSON.stringify(ops)} at ${at}`);
}
// ON == OFF's first `at` calls, then exactly `ops`, and the request ends there (the bound reuse answers)
function assertShortCircuit(off, on, at, ops, label) {
  const want = [...off.slice(0, at), ...ops];
  assert.ok(off.length > want.length, `${label}: premise — the render-OFF path continues past the probe`);
  assert.deepStrictEqual(on, want, `🔴 ${label}: the render-ON trace is not the render-OFF prefix + exactly the probe ${JSON.stringify(ops)}, ending there`);
}

// ── CATALOG CACHE TRAFFIC under the R1c CATALOG CLOCK (test/_catalog-clock.js) — the COLD load, once, and nothing else ──
// The suites install the catalog clock BEFORE index.js loads: the TTL-only caches (pricing pointer, gate pointer, registry)
// run on a frozen virtual clock and the deadline-bearing ones (context record, verifier observation) have their TTL held.
// So inside a run NO catalog cache can refill unless the test advances the clock, and the only catalog Firestore traffic a
// request may carry beyond its own logic is the process's FIRST load per restaurant:
//   COLD  — pricing docs readVersionDocs, the context, the certification transaction, the menu read readVersionMenu: its
//           exact 31-operation sequence with its ONE runTransaction, LEADING the request. Set aside once per restaurant.
//   FLOOR — the client floor reader (client-floor.js, rtdb, 30 s): exactly { rtdb get platform_config/client_floor/orders },
//           ≤ 1 per request. It stays on the REAL clock (its suites wait for its expiry in real time), so it keeps the
//           wall-time bound ⌊elapsed / 30 s⌋ + 1.
// A GATE or CTX refill (refillShapes) is NOT set aside any more: under the clock it cannot be due, so one that appears stays
// IN the comparison and shows as a diff. This REPLACES makeCacheFill (R1b), which recognised GATE / CTX by shape under a
// wall-time budget and could not prove a refill was due (codex PB-2 r2 P2-1, the documented residual R1c closes).
const { performance } = require('perf_hooks');
const FLOOR_PATH = 'platform_config/client_floor/orders';
const isFloorOp = (o) => o && o.db === 'rtdb' && typeof o.path === 'string' && o.path.startsWith('platform_config/client_floor');
function refillShapes(rid) {
  const R = `restaurants/${rid}`;
  const P = `${R}/meta/active_version`, V = `${R}/versions/<v>`;
  const DOC = (p) => [{ op: 'get', path: p }, { op: 'getAll', paths: [p] }];
  const COL = (p) => [{ op: 'get', path: p }, { op: 'get', path: p }];
  const TX = [{ op: 'runTransaction' }];
  return {
    GATE: DOC(P),
    CTX: [...DOC(P), ...DOC(V)],
    COLD: [...DOC(P), ...DOC(P), ...DOC(V), ...COL(`${V}/menu_items`), ...COL(`${V}/extras`), ...DOC(V), ...TX,
      ...DOC(P), ...DOC(V), ...DOC(V), ...COL(`${V}/menu_items`), ...DOC(`${V}/meta/menu_structure`), ...COL(`${V}/extras`),
      ...DOC(V), ...COL(`${V}/menu_items`), ...COL(`${V}/extras`)],
  };
}
// an operation, as the shapes describe it: Firestore only, the version id normalised (either suite's spelling)
const vnorm = (p) => (typeof p === 'string' ? p.replace(/(restaurants\/[^/]+\/versions\/)[^/]+/, '$1<v>') : p);
// (the recorders write a pathless call — a transaction — as path "" or no path at all: both are pathless)
const shapeOf = (o) => (o.paths !== undefined ? { op: o.op, paths: o.paths.map(vnorm) } : (o.path !== undefined && o.path !== '' ? { op: o.op, path: vnorm(o.path) } : { op: o.op }));
const sameOp = (o, want) => o.db === 'fs' && JSON.stringify(shapeOf(o)) === JSON.stringify(want);
const matchAt = (ops, i, shape) => i + shape.length <= ops.length && shape.every((w, k) => sameOp(ops[i + k], w));
// `clock` = the installed catalog clock (test/_catalog-clock.js install()). assertBounded proves the live singletons were
// built through it — without that, "no GATE / CTX can be due" is an assumption, not a fact.
const CLOCKED = ['createCatalogReader', 'createGateReader', 'createContextSource', 'createCatalogVerifier'];
function makeColdOnly(rids, clock) {
  if (!clock || typeof clock.assertBuilt !== 'function') throw new Error('makeColdOnly: pass the installed catalog clock (test/_catalog-clock.js) — without it a GATE / CTX refill can still be due');
  const t0 = performance.now();
  const seen = new Map(rids.map((r) => [r, { COLD: new Set(), FLOOR: new Set() }]));
  // → the trace without the COLD load (if it leads) and the floor read. `id` names the recorded request (counted once
  //   however often it is compared). `ignore`: test-issued calls recorded BEFORE the handler's first (e.g. the suite's
  //   rate-limit reset) — passed through untouched, they do not start the request.
  function strip(trace, rid, id, label, { ignore = () => false } = {}) {
    let pre = 0; while (pre < trace.length && ignore(trace[pre])) pre += 1;
    return [...trace.slice(0, pre), ...stripRequest(trace.slice(pre), rid, id, label)];
  }
  function stripRequest(trace, rid, id, label) {
    const floors = trace.filter(isFloorOp);
    assert.ok(floors.length <= 1 && floors.every((o) => o.op === 'get' && o.path === FLOOR_PATH), `🔴 ${label}: the client-floor calls are not exactly ≤ 1 { rtdb get ${FLOOR_PATH} } (${JSON.stringify(floors)})`);
    if (floors.length) seen.get(rid).FLOOR.add(id);
    const ops = trace.filter((o) => !isFloorOp(o));
    const cold = refillShapes(rid).COLD;
    if (!matchAt(ops, 0, cold)) return ops;   // everything stays IN, including any GATE / CTX refill (it cannot be due)
    const s = seen.get(rid).COLD;
    assert.ok(s.size === 0 || s.has(id), `🔴 ${label}: a SECOND COLD catalog load for ${rid} — under the catalog clock it happens once per process`);
    s.add(id);
    return ops.slice(cold.length);
  }
  function assertBounded(label) {
    clock.assertBuilt(CLOCKED, label);
    const per = Math.floor((performance.now() - t0) / 30000) + 1;
    const counts = {};
    for (const [r, m] of seen) {
      counts[r] = { COLD: m.COLD.size, FLOOR: m.FLOOR.size };
      assert.ok(m.FLOOR.size <= per, `🔴 ${label}: ${m.FLOOR.size} ${r} requests carried a FLOOR refill — more than that cache can refill in this run (${per}): a per-request read, not a TTL`);
    }
    return { seen: counts, budget: per };
  }
  return { strip, assertBounded };
}

// the duplicate-order guard's content key hashes the phone; companion cells use their own phones
const contentHash = (s) => String(s).replace(/(recent_order_content\/[^/]+\/)[0-9a-f]{32}/g, '$1<content>');
const normOps = (ops) => ops.map((e) => (typeof e.path === 'string' ? { ...e, path: contentHash(e.path) } : e));

module.exports = { PROBE_ABSENT, PROBE_FULL, afterUidCheck, assertInserted, assertShortCircuit, makeColdOnly, refillShapes, contentHash, normOps, CLOCKED };
