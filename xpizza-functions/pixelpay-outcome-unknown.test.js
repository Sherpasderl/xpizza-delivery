/**
 * P5a — a 2xx PixelPay response whose BODY is lost is an UNKNOWN outcome, never a decline.
 *
 * The REAL pixelpay-client (sandbox config, offline) runs under a stubbed globalThis.fetch that hands back
 * real Response objects (a body stream that errors / is empty / is not JSON / never ends), wired into the
 * REAL confirmOnlinePayment state machine and the REAL voidOrRefund over a nested-tree RTDB mock.
 * Every assertion message starts with its cell label (POU-…) so a mutant kill is attributable.
 * Run: `node pixelpay-outcome-unknown.test.js`.
 */
process.env.PIXELPAY_MODE = 'sandbox';
const assert = require('assert');
const { confirmOnlinePayment } = require('./pixelpay-confirm');
const { buildMaterializeUpdates } = require('./materialize');
const { voidOrRefund } = require('./pixelpay-cancel');
const realClient = require('./pixelpay-client');
const { paymentHash } = require('./pixelpay');

const SBOX_KEY = '1234567890', SBOX_SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
const RESTAURANT = { lat: 15.5, lng: -88.0, name: 'TB Kitchen', phone: '+50400000000' };
const HASH = paymentHash('TB-1-A', SBOX_KEY, SBOX_SECRET);

// ---- nested-tree RTDB mock (same model as pixelpay-confirm.test.js) ----
function makeDb(initial = {}) {
  const root = JSON.parse(JSON.stringify(initial));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const getAt = (path) => {
    if (!path) return root;
    let node = root;
    for (const p of path.split('/')) { if (node == null) return null; node = node[p]; }
    return node === undefined ? null : node;
  };
  const setAt = (path, val) => {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (node[p] == null || typeof node[p] !== 'object') node[p] = {};
      node = node[p];
    }
    const last = parts[parts.length - 1];
    if (val === null) delete node[last]; else node[last] = val;
  };
  let pk = 0;
  const ref = (path = '') => ({
    async once() { const v = getAt(path); return { val: () => clone(v) }; },
    async transaction(fn) {
      const real = clone(getAt(path));
      let next = fn(null);
      if (next === undefined) return { committed: false, snapshot: { val: () => real } };
      if (real !== null) {
        next = fn(clone(real));
        if (next === undefined) return { committed: false, snapshot: { val: () => real } };
      }
      setAt(path, clone(next));
      return { committed: true, snapshot: { val: () => clone(getAt(path)) } };
    },
    async update(patch) {
      if (!path) { for (const [k, v] of Object.entries(patch)) setAt(k, clone(v)); return; }
      setAt(path, Object.assign({}, getAt(path) || {}, clone(patch)));
    },
    async set(val) { setAt(path, clone(val)); },
    async push(val) { const k = `k${++pk}`; setAt(path ? `${path}/${k}` : k, clone(val)); return { key: k }; },
    async remove() { setAt(path, null); }
  });
  return { root, ref, getAt };
}

// A redeemed online order with a RESERVED reward hold — so a wrong release is observable.
function redeemedOrder() {
  return {
    orders: { 'TB-1': {
      order_id: 'TB-1', customer_name: 'Tb', customer_phone: '50400000001', items_text: 'Tb x1',
      total: 385, total_cents: 38500, subtotal_cents: 33478, tax_cents: 5022, notes: '', payment_method: 'online',
      payment_status: 'pending', order_type: 'pickup', pickup_time: 'standard', status: 'pending_payment',
      active_attempt_id: 'A', payment_fingerprint: 'fp', created_at: 1,
      customer_uid: 'uTb', restaurant_id: 'tb_rest', redemption: { model: 'add_free', free_item_key: 'Tb' }
    } },
    payment_attempts: { A: { order_id: 'TB-1', status: 'active', total_cents: 38500, pixelpay_order_id: 'TB-1-A', created_at: 1 } },
    user_rewards: { uTb: { tb_rest: { balance: 100, reserved: 8, reservations: { 'TB-1': { state: 'reserved', cost: 8, seq: 1, created_at: 0 } } } } }
  };
}

// ---- the fetch stub: real Response objects, scripted per PixelPay action, never the network ----
const enc = new TextEncoder();
const json = (status, body) => ({ kind: 'json', status, body });
const STATUS_OK = (s) => json(200, { success: true, data: { status: s } });
const CAPTURE_OK = json(200, { success: true, data: { response_approved: true, transaction_approved_amount: 385, payment_hash: HASH, transaction_reference: 'REF-TB' } });
function respond(step, signal) {
  if (step.kind === 'json') return new Response(JSON.stringify(step.body), { status: step.status });
  if (step.kind === 'empty') return new Response('', { status: step.status || 200 });
  if (step.kind === 'garbage') return new Response('<html>gateway</html>', { status: step.status || 200 });
  if (step.kind === 'bodyLost') {   // headers arrive (200), then the connection drops mid-body
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('{"success":tr')); c.error(new TypeError('terminated')); } }), { status: step.status || 200 });
  }
  if (step.kind === 'stall') {      // headers arrive, the body never ends — only the abort signal can end it
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(enc.encode('{"succ'));
      signal.addEventListener('abort', () => c.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
    } }), { status: 200 });
  }
  throw new Error(`unknown step ${step.kind}`);
}
function installFetch(script) {
  const calls = { status: 0, capture: 0, void: 0 };
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith('https://pixelpay.dev/api/v2/transaction/'), `POU-HARNESS: unexpected url ${url}`);
    const action = String(url).split('/').pop();
    const q = script[action] || [];
    const step = q[Math.min(calls[action], q.length - 1)];
    calls[action]++;
    assert.ok(step, `POU-HARNESS: no scripted response for ${action}`);
    return respond(step, init.signal);
  };
  return calls;
}
const deps = (db) => ({ db, client: realClient, restaurant: RESTAURANT, buildMaterializeUpdates, voidOrRefund, staleMs: 90000, alert: () => {} });
const holdState = (db) => db.getAt('user_rewards/uTb/tb_rest/reservations/TB-1/state');

// Run fn; a confirm that REJECTS with the unknown-outcome code is as acceptable as a non-decline result.
async function settle(p) { try { return { r: await p }; } catch (e) { return { e }; } }
// A hard ceiling so a regression to an unbounded body read FAILS (with its label) instead of hanging the suite.
function within(ms, p, label) {
  let t; const guard = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label}: still pending after ${ms} ms (body read is unbounded)`)), ms); });
  return Promise.race([p, guard]).finally(() => clearTimeout(t));
}

function assertNotDeclined(db, label) {
  const a = db.getAt('payment_attempts/A');
  assert.notStrictEqual(a.status, 'declined', `${label}: attempt must NOT be declined`);
  assert.notStrictEqual(db.getAt('orders/TB-1').payment_status, 'failed', `${label}: order must NOT be marked payment failed`);
  assert.strictEqual(holdState(db), 'reserved', `${label}: the reward hold must NOT be released`);
}

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const fails = [];
// each cell runs independently: one failing cell never hides another
async function cell(name, fn) { try { await fn(); } catch (e) { fails.push(name); console.error(`  ✗ ${String((e && e.message) || e).split('\n')[0]}`); } }

(async () => {
  // POU-CAPTURE-BODY-LOST: capture 200, the body drops → the existing "capture may have landed" path.
  for (const [label, step] of [['POU-CAPTURE-BODY-LOST', { kind: 'bodyLost' }], ['POU-CAPTURE-EMPTY-200', { kind: 'empty' }], ['POU-CAPTURE-GARBAGE-200', { kind: 'garbage' }]]) {
    await cell(label, async () => {
      const db = makeDb(redeemedOrder());
      const calls = installFetch({ status: [STATUS_OK('authorized')], capture: [step] });
      const { r, e } = await settle(confirmOnlinePayment(deps(db), { orderId: 'TB-1', paymentUuid: 'S-tb', now: 1000 }));
      assert.ok(!e, `${label}: confirm must resolve (capture throw is caught), got ${e && e.message}`);
      assert.strictEqual(r.outcome, 'capture_error_retryable', `${label}: outcome must be capture_error_retryable, got ${r.outcome}`);
      assert.ok(/PIXELPAY_OUTCOME_UNKNOWN/.test(String(r.error)), `${label}: the error names the unknown outcome, got ${r.error}`);
      assert.strictEqual(db.getAt('payment_attempts/A').status, 'capturing', `${label}: the capturing claim stays for the stale sweep`);
      assertNotDeclined(db, label);
      assert.strictEqual(calls.void, 0, `${label}: nothing is voided`);
      ok(`${label} → capture_error_retryable; claim kept; no decline, no release`);
    });
  }

  // POU-LATE-RECOVERY: after a lost capture body, the re-drive past the stale window sees PixelPay "paid"
  // → manual reconciliation; exactly ONE capture ever sent, never materialized twice, hold never released.
  await cell('POU-LATE-RECOVERY', async () => {
    const label = 'POU-LATE-RECOVERY';
    const db = makeDb(redeemedOrder());
    const calls = installFetch({ status: [STATUS_OK('authorized'), STATUS_OK('paid')], capture: [{ kind: 'bodyLost' }, CAPTURE_OK] });
    const first = await confirmOnlinePayment(deps(db), { orderId: 'TB-1', paymentUuid: 'S-tb', now: 1000 });
    assert.strictEqual(first.outcome, 'capture_error_retryable', `${label}: first pass is the unknown outcome, got ${first.outcome}`);
    const retry = await confirmOnlinePayment(deps(db), { orderId: 'TB-1', paymentUuid: 'S-tb', now: 1000 + 90001 });
    assert.strictEqual(retry.outcome, 'manual_reconciliation', `${label}: re-drive with PixelPay paid → manual_reconciliation, got ${retry.outcome}`);
    assert.strictEqual(calls.capture, 1, `${label}: exactly one capture is ever sent (got ${calls.capture})`);
    assert.strictEqual(db.getAt('orders/TB-1').payment_status, 'manual_reconciliation', `${label}: order routed to manual reconciliation`);
    assert.ok(!db.getAt('orders/TB-1').materialized_at, `${label}: never materialized without a verified capture`);
    assert.notStrictEqual(holdState(db), 'released', `${label}: the reward hold is never released`);
    // a third, late re-entry (e.g. a late callback) changes nothing
    const again = await confirmOnlinePayment(deps(db), { orderId: 'TB-1', paymentUuid: 'S-tb', now: 1000 + 200000 });
    assert.strictEqual(calls.capture, 1, `${label}: a late re-entry sends no second capture (got ${calls.capture}, outcome ${again.outcome})`);
    assert.ok(!db.getAt('orders/TB-1').materialized_at, `${label}: a late re-entry does not materialize`);
    ok(`${label} → manual_reconciliation; one capture; no materialize; hold kept`);
  });

  // POU-STATUS-BODY-LOST: capture 412 (ambiguous), the disambiguating status body drops → never a decline.
  await cell('POU-STATUS-BODY-LOST', async () => {
    const label = 'POU-STATUS-BODY-LOST';
    const db = makeDb(redeemedOrder());
    installFetch({ status: [STATUS_OK('authorized'), { kind: 'bodyLost' }], capture: [json(412, { success: false, message: 'Error al encontrar el cobro' })] });
    const { r, e } = await settle(confirmOnlinePayment(deps(db), { orderId: 'TB-1', paymentUuid: 'S-tb', now: 1000 }));
    if (e) assert.strictEqual(e.code, 'PIXELPAY_OUTCOME_UNKNOWN', `${label}: a rejection must carry the unknown-outcome code, got ${e.code} ${e.message}`);
    else assert.notStrictEqual(r.outcome, 'capture_failed', `${label}: must not resolve as capture_failed`);
    assertNotDeclined(db, label);
    ok(`${label} → no decline, no release (${e ? 'rejects unknown' : r.outcome})`);
  });

  // POU-BODY-STALL-DEADLINE: the body never ends → the request deadline covers the body read too.
  await cell('POU-BODY-STALL-DEADLINE', async () => {
    const label = 'POU-BODY-STALL-DEADLINE';
    installFetch({ status: [{ kind: 'stall' }] });
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 30000 ? 5 : ms, ...a);   // the 30 s request deadline fires at once
    let res;
    try { res = await settle(within(2000, realClient.getStatus({ payment_uuid: 'S-tb' }), label)); }
    finally { globalThis.setTimeout = realSetTimeout; }
    assert.ok(res.e, `${label}: a stalled body must reject`);
    assert.ok(!/still pending/.test(res.e.message), res.e.message);
    assert.strictEqual(res.e.code, 'PIXELPAY_OUTCOME_UNKNOWN', `${label}: the stalled body rejects with the unknown-outcome code, got ${res.e.code} ${res.e.message}`);
    ok(`${label} → rejects at the deadline as PIXELPAY_OUTCOME_UNKNOWN`);
  });

  // POU-DECLINE-PRESERVED (control): a complete 200 {success:false} is PixelPay's own answer → declined + release, as today.
  await cell('POU-DECLINE-PRESERVED', async () => {
    const label = 'POU-DECLINE-PRESERVED';
    const db = makeDb(redeemedOrder());
    installFetch({ status: [STATUS_OK('authorized')], capture: [json(200, { success: false, message: 'Monto excede la autorización' })] });
    const r = await confirmOnlinePayment(deps(db), { orderId: 'TB-1', paymentUuid: 'S-tb', now: 1000 });
    assert.strictEqual(r.outcome, 'capture_failed', `${label}: a parsed decline stays capture_failed, got ${r.outcome}`);
    assert.strictEqual(db.getAt('payment_attempts/A').status, 'declined', `${label}: attempt declined`);
    assert.strictEqual(db.getAt('orders/TB-1').payment_status, 'failed', `${label}: payment failed`);
    assert.strictEqual(holdState(db), 'released', `${label}: hold released (definitive no-capture)`);
    ok(`${label} → declined + failed + released (unchanged)`);
  });

  // POU-NON2XX-PRESERVED (control): non-2xx keeps today's envelope (incl. an unreadable body) — no throw.
  await cell('POU-NON2XX-PRESERVED', async () => {
    const label = 'POU-NON2XX-PRESERVED';
    installFetch({ status: [json(500, { success: false, message: 'err' }), { kind: 'garbage', status: 502 }, { kind: 'bodyLost', status: 503 }] });
    for (const want of [500, 502, 503]) {
      const { r, e } = await settle(realClient.getStatus({ payment_uuid: 'S-tb' }));
      assert.ok(!e, `${label}: HTTP ${want} must not throw, got ${e && e.message}`);
      assert.strictEqual(r.ok, false, `${label}: HTTP ${want} → ok:false`);
      assert.strictEqual(r.httpStatus, want, `${label}: httpStatus ${want}`);
    }
    const db = makeDb(redeemedOrder());
    installFetch({ status: [STATUS_OK('authorized'), STATUS_OK('authorized')], capture: [json(412, { success: false, message: 'Error al encontrar el cobro' })] });
    const r412 = await confirmOnlinePayment(deps(db), { orderId: 'TB-1', paymentUuid: 'S-tb', now: 1000 });
    assert.strictEqual(r412.outcome, 'capture_failed', `${label}: 412 + status not paid stays capture_failed, got ${r412.outcome}`);
    ok(`${label} → non-2xx envelopes and the 412 disambiguation unchanged`);
  });

  // POU-VOID-BODY-LOST (preservation): a cancel-path void whose 200 body drops → not voided → refund_pending.
  await cell('POU-VOID-BODY-LOST', async () => {
    const label = 'POU-VOID-BODY-LOST';
    const db = makeDb({ payment_attempts: { A: { order_id: 'TB-1', status: 'captured', payment_uuid: 'S-tb' } } });
    const calls = installFetch({ void: [{ kind: 'bodyLost' }] });
    const r = await voidOrRefund({ db, client: realClient, alert: () => {} }, { orderId: 'TB-1', attemptId: 'A', pixelpayOrderId: 'TB-1-A', paymentUuid: 'S-tb', reason: 'cancel', now: 1000 });
    assert.strictEqual(calls.void, 1, `${label}: one void sent`);
    assert.strictEqual(r.outcome, 'refund_pending', `${label}: a lost void body is refund_pending, got ${r.outcome}`);
    assert.strictEqual(r.voided, false, `${label}: never claims voided`);
    assert.strictEqual(db.getAt('payment_attempts/A').status, 'refund_pending', `${label}: attempt refund_pending (retry path)`);
    ok(`${label} → refund_pending, voided:false`);
  });

  // POU-HAPPY-PRESERVED (control): a complete capture still confirms through the real client.
  await cell('POU-HAPPY-PRESERVED', async () => {
    const label = 'POU-HAPPY-PRESERVED';
    const db = makeDb(redeemedOrder());
    installFetch({ status: [STATUS_OK('authorized')], capture: [CAPTURE_OK] });
    const r = await confirmOnlinePayment(deps(db), { orderId: 'TB-1', paymentUuid: 'S-tb', now: 1000, trackingToken: 'TOK-TB' });
    assert.strictEqual(r.outcome, 'confirmed', `${label}: confirmed, got ${r.outcome}`);
    assert.strictEqual(db.getAt('orders/TB-1').payment_status, 'confirmed', `${label}: payment confirmed`);
    ok(`${label} → confirmed`);
  });

  if (fails.length) { console.error(`\nFAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`\nAll ${pass} outcome-unknown tests passed.`);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
