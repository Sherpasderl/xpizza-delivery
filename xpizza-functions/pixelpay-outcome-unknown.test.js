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
  assert.ok(['reserved', 'held_paid'].includes(holdState(db)), `${label}: the reward hold must NOT be released (got ${holdState(db)})`);
}

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const fails = [];
// each cell runs independently: one failing cell never hides another
async function cell(name, fn) { const before = pass; try { await fn(); if (pass === before) { console.log(`  ✓ ${name}`); pass++; } } catch (e) { fails.push(name); console.error(`  ✗ ${String((e && e.message) || e).split('\n')[0]}`); } }

(async () => {
  // POU-CAPTURE-BODY-LOST: capture 200, the body drops → the existing "capture may have landed" path.
  for (const [label, step, reason] of [['POU-CAPTURE-BODY-LOST', { kind: 'bodyLost' }, 'body_read_failed'], ['POU-CAPTURE-EMPTY-200', { kind: 'empty' }, 'body_empty'], ['POU-CAPTURE-GARBAGE-200', { kind: 'garbage' }, 'body_unparseable'], ['POU-CAPTURE-ARRAY-200', json(200, [1]), 'body_unparseable'], ['POU-CAPTURE-BARE-VALUE-200', json(200, 'ok'), 'body_unparseable']]) {
    await cell(label, async () => {
      const db = makeDb(redeemedOrder());
      const calls = installFetch({ status: [STATUS_OK('authorized')], capture: [step] });
      const { r, e } = await settle(confirmOnlinePayment(deps(db), { orderId: 'TB-1', paymentUuid: 'S-tb', now: 1000 }));
      assert.ok(!e, `${label}: confirm must resolve (capture throw is caught), got ${e && e.message}`);
      assert.strictEqual(r.outcome, 'capture_error_retryable', `${label}: outcome must be capture_error_retryable, got ${r.outcome}`);
      assert.ok(/PIXELPAY_OUTCOME_UNKNOWN/.test(String(r.error)), `${label}: the error names the unknown outcome, got ${r.error}`);
      assert.ok(String(r.error).includes(reason), `${label}: the unknown outcome is classified ${reason}, got ${r.error}`);
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

  // ── codex P5a r1 #1: a complete-looking 2xx that does not carry the action's evidence is UNKNOWN ──
  // POU-CAPTURE-NO-SUCCESS-200: an approved capture body WITHOUT `success` must not decline + release.
  for (const [label, body] of [['POU-CAPTURE-NO-SUCCESS-200', { data: { response_approved: true, transaction_approved_amount: 385, payment_hash: HASH } }], ['POU-CAPTURE-EMPTY-OBJECT-200', {}]]) {
    await cell(label, async () => {
      const db = makeDb(redeemedOrder());
      installFetch({ status: [STATUS_OK('authorized')], capture: [json(200, body)] });
      const r = await confirmOnlinePayment(deps(db), { orderId: 'TB-1', paymentUuid: 'S-tb', now: 1000 });
      assert.strictEqual(r.outcome, 'capture_error_retryable', `${label}: outcome must be capture_error_retryable, got ${r.outcome}`);
      assert.ok(String(r.error).includes('envelope_incomplete'), `${label}: classified envelope_incomplete, got ${r.error}`);
      assertNotDeclined(db, label);
    });
  }

  // POU-412-STATUS-EMPTY: capture 412, the disambiguating status says nothing ({}) → never a decline / release.
  await cell('POU-412-STATUS-EMPTY', async () => {
    const label = 'POU-412-STATUS-EMPTY';
    const db = makeDb(redeemedOrder());
    installFetch({ status: [STATUS_OK('authorized'), json(200, {})], capture: [json(412, { success: false, message: 'Error al encontrar el cobro' })] });
    const { r, e } = await settle(confirmOnlinePayment(deps(db), { orderId: 'TB-1', paymentUuid: 'S-tb', now: 1000 }));
    if (e) assert.strictEqual(e.code, 'PIXELPAY_OUTCOME_UNKNOWN', `${label}: a rejection must carry the unknown-outcome code, got ${e.code} ${e.message}`);
    else assert.notStrictEqual(r.outcome, 'capture_failed', `${label}: must not resolve as capture_failed`);
    assertNotDeclined(db, label);
  });

  // POU-412-STATUS-NON2XX: capture 412, the status lookup itself fails (HTTP 500, no status) → insufficient
  // evidence to call it "not paid" → manual reconciliation, never a decline / release.
  await cell('POU-412-STATUS-NON2XX', async () => {
    const label = 'POU-412-STATUS-NON2XX';
    const db = makeDb(redeemedOrder());
    installFetch({ status: [STATUS_OK('authorized'), json(500, { success: false, message: 'err' })], capture: [json(412, { success: false, message: 'Error al encontrar el cobro' })] });
    const r = await confirmOnlinePayment(deps(db), { orderId: 'TB-1', paymentUuid: 'S-tb', now: 1000 });
    assert.strictEqual(r.outcome, 'manual_reconciliation', `${label}: an unknown status after a 412 → manual_reconciliation, got ${r.outcome}`);
    assertNotDeclined(db, label);
  });

  // POU-STALE-RETRY-NO-RECAPTURE: lost capture body, then a stale re-drive whose status pre-check says nothing ({})
  // must NOT send a second capture.
  await cell('POU-STALE-RETRY-NO-RECAPTURE', async () => {
    const label = 'POU-STALE-RETRY-NO-RECAPTURE';
    const db = makeDb(redeemedOrder());
    const calls = installFetch({ status: [STATUS_OK('authorized'), json(200, {})], capture: [{ kind: 'bodyLost' }, CAPTURE_OK] });
    await confirmOnlinePayment(deps(db), { orderId: 'TB-1', paymentUuid: 'S-tb', now: 1000 });
    await settle(confirmOnlinePayment(deps(db), { orderId: 'TB-1', paymentUuid: 'S-tb', now: 1000 + 90001 }));
    assert.strictEqual(calls.capture, 1, `${label}: an empty status on the re-drive must not lead to a second capture (got ${calls.capture})`);
    assertNotDeclined(db, label);
  });

  // POU-STATUS-COMPAT-NO-SUCCESS (compatibility control): a status body WITHOUT `success` but WITH data.status is a
  // real answer — "paid" must still be honoured (→ manual reconciliation for an unverified capture), never unknown.
  await cell('POU-STATUS-COMPAT-NO-SUCCESS', async () => {
    const label = 'POU-STATUS-COMPAT-NO-SUCCESS';
    installFetch({ status: [json(200, { data: { status: 'paid', attemps: 1 } })] });
    const { r, e } = await settle(realClient.getStatus({ payment_uuid: 'S-tb' }));
    assert.ok(!e, `${label}: a status body with data.status must not throw, got ${e && e.message}`);
    assert.strictEqual(realClient.interpretStatus(r).paid, true, `${label}: data.status "paid" is honoured`);
  });

  // POU-VOID-NO-SUCCESS-200: a void 200 without `success` is not an "anulada" → refund_pending, never voided. (asm2 ruling: the
  // sanitized result carries OUR reason code — P5a's envelope_incomplete — with the one FIXED message; never the raw error text.)
  // POU-VOID-UNKNOWN-REASON-<reason>: each of the client's four PIXELPAY_OUTCOME_UNKNOWN reasons passes through as the code.
  for (const [label, step, reason] of [['POU-VOID-NO-SUCCESS-200', json(200, {}), 'envelope_incomplete'], ['POU-VOID-UNKNOWN-REASON-BODY-LOST', { kind: 'bodyLost' }, 'body_read_failed'],
    ['POU-VOID-UNKNOWN-REASON-EMPTY', { kind: 'empty' }, 'body_empty'], ['POU-VOID-UNKNOWN-REASON-GARBAGE', { kind: 'garbage' }, 'body_unparseable']]) {
    await cell(label, async () => {
      const db = makeDb({ payment_attempts: { A: { order_id: 'TB-1', status: 'captured', payment_uuid: 'S-tb' } } });
      const sent = [];
      installFetch({ void: [step] });
      const r = await voidOrRefund({ db, client: realClient, alert: (k, d) => sent.push([k, d]) }, { orderId: 'TB-1', attemptId: 'A', pixelpayOrderId: 'TB-1-A', paymentUuid: 'S-tb', reason: 'cancel', now: 1000 });
      assert.strictEqual(r.outcome, 'refund_pending', `${label}: refund_pending, got ${r.outcome}`);
      assert.strictEqual(r.code, reason, `${label}: the result's code is the reason ${reason}, got ${r.code}`);
      assert.strictEqual(r.message, 'void request did not complete', `${label}: the ONE fixed message, got ${r.message}`);
      const att = db.getAt('payment_attempts/A');
      const rec = Object.values(db.getAt('refund_attempts') || {})[0];
      const al = sent.find(([k]) => k === 'refund_pending');
      assert.ok(att.refund_code === reason && rec && rec.code === reason && al && al[1].code === reason, `${label}: attempt, audit record and alert carry the code (got ${JSON.stringify({ a: att.refund_code, r: rec && rec.code, al: al && al[1].code })})`);
      const all = JSON.stringify([r, att, rec, sent]);
      assert.ok(!/PIXELPAY_OUTCOME_UNKNOWN|HTTP \d/.test(all), `${label}: never the raw error text`);
    });
  }
  // POU-VOID-UNKNOWN-REASON-ALLOWLIST: an outcome-unknown error whose reason is NOT one of the four is provider_unreachable.
  await cell('POU-VOID-UNKNOWN-REASON-ALLOWLIST', async () => {
    const label = 'POU-VOID-UNKNOWN-REASON-ALLOWLIST';
    const db = makeDb({ payment_attempts: { A: { order_id: 'TB-1', status: 'captured', payment_uuid: 'S-tb' } } });
    const client = { voidTransaction: async () => { throw Object.assign(new Error('PIXELPAY_OUTCOME_UNKNOWN: x'), { code: 'PIXELPAY_OUTCOME_UNKNOWN', reason: 'Transacción no encontrada' }); } };
    const r = await voidOrRefund({ db, client, alert: () => {} }, { orderId: 'TB-1', attemptId: 'A', pixelpayOrderId: 'TB-1-A', paymentUuid: 'S-tb', reason: 'cancel', now: 1000 });
    assert.ok(r.code === 'provider_unreachable' && r.message === 'void request did not complete', `${label}: an unlisted reason never becomes the code (got ${JSON.stringify(r)})`);
    assert.ok(!JSON.stringify(db.root).includes('no encontrada'), `${label}: and its text is stored nowhere`);
  });

  // POU-MISMATCH-VOID-UNKNOWN (codex P5a r1 #4): a captured-but-mismatched payment whose void outcome is unknown →
  // reported as not voided, refund_pending, and the reward hold is SECURED (held_paid), never left to expire.
  await cell('POU-MISMATCH-VOID-UNKNOWN', async () => {
    const label = 'POU-MISMATCH-VOID-UNKNOWN';
    const db = makeDb(redeemedOrder());
    const bad = json(200, { success: true, data: { response_approved: true, transaction_approved_amount: 385, payment_hash: 'deadbeef', transaction_reference: 'R' } });
    installFetch({ status: [STATUS_OK('authorized')], capture: [bad], void: [{ kind: 'bodyLost' }] });
    const r = await confirmOnlinePayment(deps(db), { orderId: 'TB-1', paymentUuid: 'S-tb', now: 1000 });
    assert.strictEqual(r.outcome, 'mismatch_voided', `${label}: outcome mismatch_voided, got ${r.outcome}`);
    assert.strictEqual(r.voided, false, `${label}: voided:false on an unknown void`);
    assert.strictEqual(db.getAt('orders/TB-1').payment_status, 'refund_pending', `${label}: order refund_pending`);
    assert.strictEqual(holdState(db), 'held_paid', `${label}: the reward hold is secured held_paid (got ${holdState(db)})`);
  });

  // POU-ESCALATE-RESUMES (codex P5a r2 #3): the escalation's order update fails AFTER the attempt CAS committed → the next
  // call completes it (order → manual_reconciliation, hold secured), idempotently; a third call changes nothing.
  await cell('POU-ESCALATE-RESUMES', async () => {
    const label = 'POU-ESCALATE-RESUMES';
    const init = redeemedOrder();
    init.payment_attempts.A = { ...init.payment_attempts.A, status: 'capturing', capturing_started_at: 0, payment_uuid: 'S-tb' };
    init.orders['TB-1'].payment_status = 'pending';
    const db = makeDb(init);
    let failOrderUpdate = 1;
    const flaky = { ...db, ref: (path) => { const r = db.ref(path); if (path === 'orders/TB-1') return { ...r, update: async (v) => { if (failOrderUpdate > 0) { failOrderUpdate--; throw new Error('injected order-update failure'); } return r.update(v); }, transaction: async (fn) => { if (failOrderUpdate > 0) { failOrderUpdate--; throw new Error('injected order-write failure'); } return r.transaction(fn); } }; return r; } };   // the order write (update or transaction) fails once
    const { escalateStaleCapture } = require('./pixelpay-confirm');
    const d = { db: flaky, alert: () => {} };
    const first = await settle(escalateStaleCapture(d, { orderId: 'TB-1', attemptId: 'A', now: 10 * 60 * 60000 }));
    assert.ok(first.e, `${label}: PREMISE — the injected failure interrupts the first escalation`);
    assert.strictEqual(db.getAt('payment_attempts/A').status, 'capture_unverified', `${label}: PREMISE — the attempt CAS committed`);
    assert.strictEqual(db.getAt('orders/TB-1').payment_status, 'pending', `${label}: PREMISE — the order was not updated`);
    const second = await escalateStaleCapture(d, { orderId: 'TB-1', attemptId: 'A', now: 10 * 60 * 60000 + 1 });
    assert.strictEqual(second, true, `${label}: the next call RESUMES the incomplete escalation (got ${second})`);
    assert.strictEqual(db.getAt('orders/TB-1').payment_status, 'manual_reconciliation', `${label}: the order completes to manual_reconciliation`);
    assert.ok(['held_paid'].includes(holdState(db)), `${label}: the hold is secured (got ${holdState(db)})`);
    const third = await escalateStaleCapture(d, { orderId: 'TB-1', attemptId: 'A', now: 10 * 60 * 60000 + 2 });
    assert.strictEqual(third, false, `${label}: a completed escalation is not redone (got ${third})`);
  });

  // POU-ESCALATE-NEVER-REOPENS (codex P5a r3 #1): a capture_unverified attempt whose order a resolver already settled
  // (refunded / resolving) is NEVER reopened to manual_reconciliation by a resumed escalation.
  for (const [label, ps] of [['POU-ESCALATE-NEVER-REOPENS-REFUNDED', 'refunded'], ['POU-ESCALATE-NEVER-REOPENS-RESOLVING', 'resolving_refund']]) {
    await cell(label, async () => {
      const init = redeemedOrder();
      init.payment_attempts.A = { ...init.payment_attempts.A, status: 'capture_unverified', manual_reason: 'stale_capturing_unrecovered', payment_uuid: 'S-tb' };
      init.orders['TB-1'] = { ...init.orders['TB-1'], payment_status: ps, status: ps === 'refunded' ? 'cancelled' : 'pending_payment' };
      const db = makeDb(init);
      const { escalateStaleCapture } = require('./pixelpay-confirm');
      const r = await escalateStaleCapture({ db, alert: () => {} }, { orderId: 'TB-1', attemptId: 'A', now: 10 * 60 * 60000 });
      assert.strictEqual(r, false, `${label}: a settled order is not escalated (got ${r})`);
      assert.strictEqual(db.getAt('orders/TB-1').payment_status, ps, `${label}: payment_status stays ${ps} (got ${db.getAt('orders/TB-1').payment_status})`);
    });
  }

  // POU-ESCALATE-RACE-RESOLVED (codex P5a r3 #1): the order is pending when read, but a resolver claims it before the
  // escalation's order write → the write must REFUSE (an atomic pre-state guard), never overwrite the resolver.
  await cell('POU-ESCALATE-RACE-RESOLVED', async () => {
    const label = 'POU-ESCALATE-RACE-RESOLVED';
    const init = redeemedOrder();
    init.payment_attempts.A = { ...init.payment_attempts.A, status: 'capture_unverified', manual_reason: 'stale_capturing_unrecovered', payment_uuid: 'S-tb' };
    init.orders['TB-1'].payment_status = 'pending';
    const db = makeDb(init);
    let raced = false;
    const racing = { ...db, ref: (path) => {
      const r = db.ref(path);
      if (path !== 'orders/TB-1') return r;
      const claim = () => { if (!raced) { raced = true; const o = db.getAt('orders/TB-1'); db.root.orders['TB-1'] = { ...o, payment_status: 'resolving_refund' }; } };
      return { ...r, update: async (v) => { claim(); return r.update(v); }, transaction: async (fn) => { claim(); return r.transaction(fn); } };
    } };
    const { escalateStaleCapture } = require('./pixelpay-confirm');
    await settle(escalateStaleCapture({ db: racing, alert: () => {} }, { orderId: 'TB-1', attemptId: 'A', now: 10 * 60 * 60000 }));
    assert.strictEqual(db.getAt('orders/TB-1').payment_status, 'resolving_refund', `${label}: the resolver's claim survives (got ${db.getAt('orders/TB-1').payment_status})`);
  });

  // POU-REPAIR-LEGACY-HOLDS (codex P5a r3 #3 + ruling 2): a repair record WITHOUT redemption_mode (written before this
  // slice) on an ONLINE order keeps the hold; if the order shows a refund it ESCALATES (alert), never releases.
  for (const [label, ps, wantAlert] of [['POU-REPAIR-LEGACY-HOLDS-PENDING', 'refund_pending', false], ['POU-REPAIR-LEGACY-HOLDS-REFUNDED', 'refunded', true]]) {
    await cell(label, async () => {
      const init = redeemedOrder();
      init.orders['TB-1'] = { ...init.orders['TB-1'], status: 'cancelled', payment_status: ps };
      init.user_rewards.uTb.tb_rest.reservations['TB-1'].state = 'held_paid';
      init.reward_ledger_repair = { 'TB-1': { order_id: 'TB-1', disposition: 'refund', uid: 'uTb', rid: 'tb_rest', has_redemption: true, earn_failed: false, redemption_failed: true, reason: 'cancel', attempts: 0 } };
      const db = makeDb(init);
      const alerts = [];
      const { retryRewardLedgerRepair } = require('./cancel-order-core');
      await retryRewardLedgerRepair({ db, alert: async (k, d) => { alerts.push(k); } }, { now: 5000 });
      assert.strictEqual(holdState(db), 'held_paid', `${label}: a legacy record never releases an online order's hold (got ${holdState(db)})`);
      const node = db.getAt('dispatcher_alerts/refund_points_order_TB-1');
      assert.strictEqual(!!(node && node.type === 'payment_refund_confirmed_release_points'), wantAlert, `${label}: durable escalation node ${wantAlert ? 'written' : 'absent'} (got ${JSON.stringify(node)})`);
    });
  }
  // control: a legacy record on a CASH order (no money moved) still reverses, as before
  await cell('POU-REPAIR-LEGACY-CASH-REVERSES', async () => {
    const label = 'POU-REPAIR-LEGACY-CASH-REVERSES';
    const init = redeemedOrder();
    init.orders['TB-1'] = { ...init.orders['TB-1'], payment_method: 'cash', status: 'cancelled', payment_status: 'pending' };
    init.reward_ledger_repair = { 'TB-1': { order_id: 'TB-1', disposition: 'refund', uid: 'uTb', rid: 'tb_rest', has_redemption: true, earn_failed: false, redemption_failed: true, reason: 'cancel', attempts: 0 } };
    const db = makeDb(init);
    const { retryRewardLedgerRepair } = require('./cancel-order-core');
    await retryRewardLedgerRepair({ db, alert: async () => {} }, { now: 5000 });
    assert.strictEqual(holdState(db), 'released', `${label}: a cash order's reserved hold is released as before (got ${holdState(db)})`);
  });

  // POU-REPAIR-ALERT-DURABLE (codex P5a r4 #2): the legacy escalation alert write FAILS once → the repair record is KEPT
  // (never deleted after a swallowed alert), and the next retry writes the alert, then clears the record.
  await cell('POU-REPAIR-ALERT-DURABLE', async () => {
    const label = 'POU-REPAIR-ALERT-DURABLE';
    const init = redeemedOrder();
    init.orders['TB-1'] = { ...init.orders['TB-1'], status: 'cancelled', payment_status: 'refunded' };
    init.user_rewards.uTb.tb_rest.reservations['TB-1'].state = 'held_paid';
    init.reward_ledger_repair = { 'TB-1': { order_id: 'TB-1', disposition: 'refund', uid: 'uTb', rid: 'tb_rest', has_redemption: true, earn_failed: false, redemption_failed: true, reason: 'cancel', attempts: 0 } };
    const db = makeDb(init);
    let failAlert = 1;
    const flaky = { ...db, ref: (path) => { const r = db.ref(path); if (path.startsWith('dispatcher_alerts')) return { ...r, set: async (v) => { if (failAlert > 0) { failAlert--; throw new Error('injected alert-write failure'); } return r.set(v); }, push: async (v) => { if (failAlert > 0) { failAlert--; throw new Error('injected alert-write failure'); } return r.push(v); } }; return r; } };
    const { retryRewardLedgerRepair } = require('./cancel-order-core');
    const { paymentAlert } = require('./lib/payment-alert');
    await retryRewardLedgerRepair({ db: flaky, alert: (k, d) => paymentAlert(flaky, k, d) }, { now: 5000 });
    assert.ok(db.getAt('reward_ledger_repair/TB-1'), `${label}: a failed escalation write KEEPS the repair record`);
    await retryRewardLedgerRepair({ db: flaky, alert: (k, d) => paymentAlert(flaky, k, d) }, { now: 6000 });
    const node = db.getAt('dispatcher_alerts/refund_points_order_TB-1');
    assert.ok(node && node.type === 'payment_refund_confirmed_release_points', `${label}: the retry writes the durable alert (got ${JSON.stringify(node)})`);
    assert.strictEqual(db.getAt('reward_ledger_repair/TB-1'), null, `${label}: the record clears only after the alert landed`);
    assert.strictEqual(holdState(db), 'held_paid', `${label}: still never released`);
  });

  // POU-ALERT-NOT-PRUNED (codex P5a r4 #1): the release-points escalation survives the resolved-order alert pruning.
  await cell('POU-ALERT-NOT-PRUNED', async () => {
    const label = 'POU-ALERT-NOT-PRUNED';
    const { alertsToPrune } = require('./alert-prune');
    const alerts = { refund_points_A: { type: 'payment_refund_confirmed_release_points', detail: { orderId: 'O1', attemptId: 'A' } },
                     refund_points_order_O1: { type: 'payment_refund_confirmed_release_points', detail: { orderId: 'O1' } },
                     other: { type: 'payment_manual_reconciliation', detail: { orderId: 'O1' } } };
    const pruned = alertsToPrune(alerts, { O1: { status: 'cancelled', payment_status: 'refunded' } });
    assert.deepStrictEqual(pruned, ['other'], `${label}: only the ordinary alert is pruned for a resolved order (got ${JSON.stringify(pruned)})`);
  });

  if (fails.length) { console.error(`\nFAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`\nAll ${pass} outcome-unknown tests passed.`);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
