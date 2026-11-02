/**
 * FINDING-hosted-charge-recover-race — a DETERMINISTIC race cell (no timing luck).
 *
 * The create-CAS winner sets orders/{id}.active_attempt_id, and only AFTER that writes payment_attempts/{aaid}. A
 * concurrent request whose pre-read lands in that window sees «pointer set, record missing» and decides `recover`.
 * This harness FORCES the window: the FIRST write to payment_attempts/* (whatever its form — update, set or
 * transaction) is held until every racer has passed its orders/{id} CAS; then it is released.
 *
 * Asserted through the REAL acquireHostedAttempt AND the REAL resolveAndIssueHostedCheckout (with a createCheckout
 * spy), exactly as the charge handler composes them: EXACTLY ONE request is claimed and EXACTLY ONE checkout is
 * created; every other request answers in_progress (202). Each failure message starts with its cell label.
 * Run: node pixelpay-hosted-recover-race.test.js
 */
const assert = require('assert');
const { acquireHostedAttempt } = require('./pixelpay-hosted-charge');
const { resolveAndIssueHostedCheckout } = require('./hosted-charge-flow');

// The same in-memory RTDB model as pixelpay-hosted-charge.test.js (Admin-SDK null-first transaction), plus set().
function makeDb(initial = {}) {
  const root = JSON.parse(JSON.stringify(initial));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const getAt = (p) => { if (!p) return root; let n = root; for (const k of p.split('/')) { if (n == null) return null; n = n[k]; } return n === undefined ? null : n; };
  const setAt = (p, val) => { const a = p.split('/'); let n = root; for (let i = 0; i < a.length - 1; i++) { if (n[a[i]] == null || typeof n[a[i]] !== 'object') n[a[i]] = {}; n = n[a[i]]; } const l = a[a.length - 1]; if (val === null) delete n[l]; else n[l] = val; };
  const ref = (p = '') => ({
    async once() { return { val: () => clone(getAt(p)) }; },
    // Admin-SDK null-first semantics, honestly: the uncached call sees null; returning undefined there ABORTS (no retry);
    // a value is sent, and only a mismatch with the server re-runs fn with the real value (a stub never laxer than RTDB).
    async transaction(fn) {
      const cur = clone(getAt(p));
      let nx = fn(null);
      if (nx === undefined) return { committed: false, snapshot: { val: () => cur } };
      if (cur !== null) { nx = fn(clone(cur)); if (nx === undefined) return { committed: false, snapshot: { val: () => cur } }; }
      setAt(p, clone(nx));
      return { committed: true, snapshot: { val: () => clone(getAt(p)) } };
    },
    async update(patch) { if (!p) { for (const [k, v] of Object.entries(patch)) setAt(k, clone(v)); return; } setAt(p, Object.assign({}, getAt(p) || {}, clone(patch))); },
    async set(v) { setAt(p, clone(v)); },
  });
  return { ref, getAt, root };
}

// Hold the FIRST payment_attempts/* write until `racers` order CASes (plus the creator's) have run.
function raceDb(base, racers) {
  let orderTx = 0; let release; const gate = new Promise((r) => { release = r; });
  let firstHeld = false; let creatorPastCas; const creatorPast = new Promise((r) => { creatorPastCas = r; });
  const wrap = (p) => {
    const r = base.ref(p);
    if (p.startsWith('orders/')) {
      return { ...r, transaction: async (fn) => { const out = await r.transaction(fn); orderTx += 1; if (orderTx === 1) creatorPastCas(); if (orderTx === 1 + racers) release(); return out; } };
    }
    if (p.startsWith('payment_attempts/')) {
      const hold = async () => { if (!firstHeld) { firstHeld = true; await gate; } };
      return { ...r, update: async (v) => { await hold(); return r.update(v); }, set: async (v) => { await hold(); return r.set(v); }, transaction: async (fn) => { await hold(); return r.transaction(fn); } };
    }
    return r;
  };
  return { db: { ref: wrap, getAt: base.getAt }, creatorPast };
}

const NOW = 1_000_000_000;
const FP = 'fp-race';
const PENDING = { order_id: 'O1', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', total: 299, total_cents: 29900 };

// The handler's composition: acquire → resolve → (on a fresh claim) createCheckout.
async function charge(db, id, createCheckout) {
  const acq = await acquireHostedAttempt(db, 'O1', PENDING, FP, NOW, [], () => `AT_${id}`, () => `TOK_${id}`);
  const flow = await resolveAndIssueHostedCheckout({
    acq, orderId: 'O1', totalCents: 29900,
    releaseHold: async () => {}, retireAttempt: async () => {}, runGate: async () => ({ provenance: null }),
    attemptId: acq.attempt_id, toLempiras: (c) => (c / 100).toFixed(2), now: NOW, log: { log() {}, error() {} },
    chargeRequest: { pixelpayOrderId: `O1-${acq.attempt_id}` },
    createCheckout, persistCreated: async () => {},
  });
  return { acq, flow };
}

let pass = 0; const fails = [];
async function cell(name, fn) { try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { fails.push(name); console.error(`  ✗ ${String((e && e.message) || e).split('\n')[0]}`); } }

(async () => {
  for (const RACERS of [1, 4]) {
    await cell(`HRR-ONE-CHECKOUT-${RACERS}`, async () => {
      const L = `HRR-ONE-CHECKOUT-${RACERS}`;
      const { db, creatorPast } = raceDb(makeDb({}), RACERS);
      const calls = [];
      const createCheckout = async (req) => { calls.push(req.pixelpayOrderId); return { ok: true, url: `https://pay.example/${calls.length}` }; };
      const creator = charge(db, 'C', createCheckout);
      await creatorPast;                                               // the creator's order CAS is in; its attempt write is HELD
      const racers = Array.from({ length: RACERS }, (_, i) => charge(db, `R${i}`, createCheckout));
      const all = await Promise.all([creator, ...racers]);
      const claimed = all.filter((x) => x.acq.outcome === 'claimed').length;
      const inProgress = all.filter((x) => x.acq.outcome === 'in_progress').length;
      assert.strictEqual(claimed, 1, `${L}: exactly ONE request may claim the attempt (got ${claimed}: ${all.map((x) => x.acq.outcome).join(',')})`);
      assert.strictEqual(calls.length, 1, `${L}: exactly ONE PixelPay checkout may be created (got ${calls.length})`);
      assert.strictEqual(inProgress, RACERS, `${L}: every other request answers in_progress (got ${inProgress})`);
      for (const x of all) if (x.acq.outcome === 'in_progress') assert.strictEqual(x.flow.respond && x.flow.respond.status, 202, `${L}: an in_progress request answers 202`);
      const att = db.getAt('payment_attempts/AT_C');
      assert.ok(att && att.hosted_state === 'creating', `${L}: the one attempt record is creating (got ${JSON.stringify(att && att.hosted_state)})`);
      assert.strictEqual(db.getAt('orders/O1').active_attempt_id, 'AT_C', `${L}: the order still points at the creator's attempt`);
    });
  }

  // Preserved behaviour: a CRASHED creator (pointer set, record never written) is still RECOVERED by the next request —
  // exactly once — and a later request then sees creating → in_progress.
  await cell('HRR-STALE-RECOVER-PRESERVED', async () => {
    const L = 'HRR-STALE-RECOVER-PRESERVED';
    const db = makeDb({ orders: { O1: { ...PENDING, active_attempt_id: 'AT_DEAD', payment_fingerprint: FP } } });
    const calls = [];
    const createCheckout = async (req) => { calls.push(req.pixelpayOrderId); return { ok: true, url: 'https://pay.example/x' }; };
    const a = await charge(db, 'A', createCheckout);
    assert.strictEqual(a.acq.outcome, 'claimed', `${L}: the first request recovers the crashed attempt (got ${a.acq.outcome})`);
    assert.strictEqual(a.acq.attempt_id, 'AT_DEAD', `${L}: recovery reuses the pointer's attempt id`);
    const b = await charge(db, 'B', createCheckout);
    assert.strictEqual(b.acq.outcome, 'in_progress', `${L}: a later request sees creating → in_progress (got ${b.acq.outcome})`);
    assert.strictEqual(calls.length, 1, `${L}: one checkout`);
  });

  // Preserved: a fresh order with no contention is claimed once, as today.
  await cell('HRR-FRESH-PRESERVED', async () => {
    const L = 'HRR-FRESH-PRESERVED';
    const db = makeDb({});
    const calls = [];
    const r = await charge(db, 'F', async (req) => { calls.push(req.pixelpayOrderId); return { ok: true, url: 'https://pay.example/f' }; });
    assert.strictEqual(r.acq.outcome, 'claimed', `${L}: claimed`);
    assert.strictEqual(r.acq.hosted_order_id, 'O1-AT_F', `${L}: deterministic hosted_order_id`);
    assert.strictEqual(db.getAt('payment_attempts/AT_F').poll_token, 'TOK_F', `${L}: the poll token is persisted`);
    assert.strictEqual(calls.length, 1, `${L}: one checkout`);
  });

  if (fails.length) { console.error(`\nFAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`\nAll ${pass} hosted recover-race cells passed.`);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
