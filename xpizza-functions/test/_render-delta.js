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

// ── CACHE-FILL traffic, set aside on BOTH sides of a companion pair (not render) ─────────────────────────────────────
// The per-instance catalog caches (the catalog context, the gate pointer, the verifier: TTLs 45 / 45 / 60 s) re-read
// restaurants/<rid>/meta/active_version | versions/<v>/… in whichever request crosses their TTL — on either side of a
// pair; a cold context load adds its runTransaction to the request's LEADING Firestore block. Render adds none of it in
// createOrder / chargeOnlineOrder: the charge's render-gated gate read (prepFailureRefusal) is served from the snapshot
// the request already took (redeemEligibleFor), as quoteRedemption shows; the refresh delta itself is proved in the quote
// suite on a controlled clock. SENSITIVITY: a cache refills at most once per TTL, so the requests carrying fill traffic
// are bounded by wall time — per restaurant, 3 caches × (⌊elapsed / 30 s⌋ + 1); a read issued on every request exceeds it.
const { performance } = require('perf_hooks');
function makeCacheFill(rids) {
  const t0 = performance.now();
  const carriers = new Map(rids.map((r) => [r, new Set()]));
  const fillPath = (rid) => new RegExp(`^restaurants/${rid}/(meta/active_version|versions/[^/]+(/.*)?)$`);
  const isFillRead = (rid) => { const re = fillPath(rid); return (o) => o.db === 'fs' && (o.op === 'get' || o.op === 'getAll') && (() => {
    const ps = [o.path, ...(o.paths || [])].filter((x) => typeof x === 'string'); return ps.length > 0 && ps.every((x) => re.test(x)); })(); };
  // → the trace without its fill traffic; `id` names the recorded request (counted once however often it is compared)
  function strip(trace, rid, id, label) {
    const fill = isFillRead(rid);
    let i = 0; while (i < trace.length && trace[i].db === 'fs') i += 1;
    const lead = trace.slice(0, i);
    assert.ok(lead.every((o) => fill(o) || o.op === 'runTransaction'), `🔴 ${label}: a leading Firestore block that is not the catalog cache fill (${JSON.stringify(lead)})`);
    const rest = trace.slice(i); const kept = rest.filter((o) => !fill(o));
    if (i > 0 || kept.length !== rest.length) carriers.get(rid).add(id);
    return kept;
  }
  function assertBounded(label) {
    const budget = 3 * (Math.floor((performance.now() - t0) / 30000) + 1);
    const seen = Object.fromEntries([...carriers].map(([r, s]) => [r, s.size]));
    for (const [r, n] of Object.entries(seen)) assert.ok(n <= budget, `🔴 ${label}: ${n} ${r} requests carried catalog fill traffic — more than its caches can refill in this run (${budget}): a per-request read, not a TTL`);
    return { seen, budget };
  }
  return { strip, assertBounded };
}

// the duplicate-order guard's content key hashes the phone; companion cells use their own phones
const contentHash = (s) => String(s).replace(/(recent_order_content\/[^/]+\/)[0-9a-f]{32}/g, '$1<content>');
const normOps = (ops) => ops.map((e) => (typeof e.path === 'string' ? { ...e, path: contentHash(e.path) } : e));

module.exports = { PROBE_ABSENT, PROBE_FULL, afterUidCheck, assertInserted, assertShortCircuit, makeCacheFill, contentHash, normOps };
