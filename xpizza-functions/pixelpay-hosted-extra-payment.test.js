/**
 * A SECOND distinct verified payment on a hosted attempt (FINDING-hosted-charge-recover-race Q3; codex extra-pay r1).
 * Through the REAL handleHostedCallback with the REAL pixelpay-client (fetch stubbed: real Response objects, the provider
 * void request is observed), the REAL voidOrRefund and the REAL paymentAlert, on an RTDB model that is never laxer than
 * production (reserved key characters refused; the null-first transaction abort honoured). Each failure message starts with
 * its cell label. Run: node pixelpay-hosted-extra-payment.test.js
 */
process.env.PIXELPAY_MODE = 'sandbox';
const assert = require('assert');
const crypto = require('crypto');
const { handleHostedCallback } = require('./pixelpay-hosted-webhook');
const { buildMaterializeUpdates } = require('./materialize');
const { paymentHash } = require('./pixelpay');
const realClient = require('./pixelpay-client');
const { voidOrRefund } = require('./pixelpay-cancel');
const { paymentAlert } = require('./lib/payment-alert');
const { isReconcilerRetryable } = require('./cancel-order-core');
const { alertsToPrune } = require('./alert-prune');

const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
const { makeHonestDb: makeDb } = require('./_honest-rtdb-model');   // never laxer than production (nested keys, null pruning, immutable snapshots, null-first + conflicts)

// The PixelPay provider, stubbed at fetch with REAL Response objects; every void request body is recorded.
let voidScript = []; let voidCalls = [];
const PP = require('./pixelpay'); const { resolvePixelPayConfig } = require('./pixelpay-config');
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.endsWith('/api/v2/transaction/void')) throw new Error(`unexpected fetch ${u}`);
  // validate the request as the provider would: method, authentication and the void signature for THIS hosted order
  const cfg = resolvePixelPayConfig(); const h = init.headers || {}; const body = JSON.parse(init.body);
  if (init.method !== 'POST') throw new Error('provider stub: void must be POST');
  if (h['x-auth-key'] !== cfg.app_key || h['x-auth-hash'] !== cfg.auth_hash) throw new Error('provider stub: bad auth headers');
  if (h['x-auth-user'] !== PP.platformUser(cfg.merchant_email)) throw new Error('provider stub: bad x-auth-user');
  if (body.void_signature !== PP.voidSignature(cfg.merchant_email, HOID, cfg.secret)) throw new Error('provider stub: bad void signature');
  if (typeof body.payment_uuid !== 'string' || !body.payment_uuid) throw new Error('provider stub: missing payment_uuid');
  voidCalls.push(body);
  const step = voidScript[Math.min(voidCalls.length - 1, voidScript.length - 1)] || { status: 200, body: { success: true, message: 'anulada' } };
  return new Response(JSON.stringify(step.body), { status: step.status });
};
const resetProvider = (steps = []) => { voidScript = steps; voidCalls = []; };

const OID = 'TBXP1', AID = 'a1b2c3d4e5f6a7b8', HOID = `${OID}-${AID}`;
const xkey = (uuid) => crypto.createHash('sha256').update(String(uuid)).digest('hex');
const order = (o = {}) => ({ order_id: OID, order_type: 'pickup', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', total: 299, total_cents: 29900, customer_name: 'T', items_text: 'x', active_attempt_id: AID, created_at: 1, ...o });
const freshAttempt = () => ({ order_id: OID, hosted_state: 'created', hosted_order_id: HOID });
const cb = (uuid, txn) => ({ order: HOID, status: 'paid', amount: 299, uuid, transaction_id: txn || `TXN-${uuid}`, payment_hash: paymentHash(HOID, KEY, SECRET) });
const depsFor = (db) => ({ db, restaurant: { lat: 15.5, lng: -88, name: 'TB', phone: 'p' }, buildMaterializeUpdates, alert: (k, d) => paymentAlert(db, k, d), genToken: () => 'TOK', client: realClient, voidOrRefund });
const extra = (db, uuid) => db.getAt(`payment_attempts/${AID}/extra_payments/${xkey(uuid)}`);
const extraAlert = (db, uuid) => db.getAt(`dispatcher_alerts/extra_payment_${xkey(uuid)}`);
const cancelled = (attemptOver = {}) => ({ orders: { [OID]: order({ status: 'cancelled', payment_status: 'refunded' }) },
  payment_attempts: { [AID]: { order_id: OID, hosted_order_id: HOID, hosted_state: 'voided', status: 'refunded', payment_uuid: 'PAY-1', payment_reference: 'TXN-PAY-1', paid_at: 1000, ...attemptOver } } });
const livePaid = () => ({ orders: { [OID]: order() }, payment_attempts: { [AID]: freshAttempt() } });

let pass = 0; const fails = []; let FINISHED = false; let CURRENT = null;
// a promise that never settles drains the event loop and node exits 0 — a hang must FAIL, never pass silently
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error(`TEST FAILED: exited without finishing (stuck in ${CURRENT})`); process.exitCode = 1; } });
async function cell(name, fn) { CURRENT = name; resetProvider(); try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { fails.push(name); console.error(`  ✗ ${String((e && e.message) || e).split('\n')[0]}`); } }

(async () => {
  // ── the FIRST payment: bound atomically; a same-payment re-delivery never rewrites the immutable fields ──
  await cell('XP-SAME-UUID-IMMUTABLE', async () => {
    const L = 'XP-SAME-UUID-IMMUTABLE';
    const db = makeDb(livePaid());
    assert.strictEqual((await handleHostedCallback(depsFor(db), cb('PAY-1'), 1000)).outcome, 'confirmed', `${L}: PREMISE — confirmed`);
    const r2 = await handleHostedCallback(depsFor(db), cb('PAY-1', 'TXN-OTHER'), 2000);
    const att = db.getAt(`payment_attempts/${AID}`);
    assert.strictEqual(r2.outcome, 'already_confirmed', `${L}: idempotent (got ${r2.outcome})`);
    assert.strictEqual(att.paid_at, 1000, `${L}: paid_at is immutable (got ${att.paid_at})`);
    assert.strictEqual(att.payment_reference, 'TXN-PAY-1', `${L}: payment_reference is immutable (got ${att.payment_reference})`);
    assert.strictEqual(att.extra_payments, undefined, `${L}: no extra payment`);
  });

  await cell('XP-SAME-UUID-MATERIALIZE-RECOVERY', async () => {
    const L = 'XP-SAME-UUID-MATERIALIZE-RECOVERY';
    // a first delivery that bound the payment and crashed before materializing
    const db = makeDb({ orders: { [OID]: order() }, payment_attempts: { [AID]: { ...freshAttempt(), hosted_state: 'paid', payment_uuid: 'PAY-1', payment_reference: 'TXN-PAY-1', paid_at: 1000 } } });
    const r = await handleHostedCallback(depsFor(db), cb('PAY-1'), 2000);
    assert.strictEqual(r.outcome, 'confirmed', `${L}: the re-delivery still materializes (got ${r.outcome})`);
    assert.strictEqual(db.getAt(`orders/${OID}/payment_status`), 'confirmed', `${L}: confirmed`);
    assert.strictEqual(db.getAt(`payment_attempts/${AID}/paid_at`), 1000, `${L}: paid_at untouched`);
  });

  await cell('XP-CONCURRENT-FIRST-BINDING', async () => {
    const L = 'XP-CONCURRENT-FIRST-BINDING';
    // both callbacks pass their reads before either binds: the binding must still admit exactly one
    let arrived = 0; let release; const gate = new Promise((r) => { release = r; });
    const db = makeDb(livePaid(), { beforeTx: async (p) => { if (p === `payment_attempts/${AID}/payment_uuid`) { arrived += 1; if (arrived === 2) release(); await gate; } },
      beforeWrite: async (p, v) => { if (p === `payment_attempts/${AID}` && v && v.payment_uuid) { arrived += 1; if (arrived === 2) release(); await gate; } } });
    const [a, b] = await Promise.all([handleHostedCallback(depsFor(db), cb('PAY-A'), 1000), handleHostedCallback(depsFor(db), cb('PAY-B'), 1001)]);
    const att = db.getAt(`payment_attempts/${AID}`);
    const bound = att.payment_uuid; const other = bound === 'PAY-A' ? 'PAY-B' : 'PAY-A';
    assert.ok(['PAY-A', 'PAY-B'].includes(bound), `${L}: exactly one payment is bound (got ${bound})`);
    assert.ok(extra(db, other) && extra(db, other).uuid === other, `${L}: the other is recorded as an extra payment (outcomes ${a.outcome}/${b.outcome})`);
    assert.ok(extraAlert(db, other), `${L}: and alerted`);
  });

  // ── OWNER 2026-11-02: a second distinct verified payment is NEVER voided automatically — live or cancelled; a person
  //    refunds it in PixelPay. It is recorded once, alerted durably and flags the order; the first payment is untouched. ──
  const pay1Untouched = (L, db, before) => {
    const a = db.getAt(`payment_attempts/${AID}`);
    for (const k of ['payment_uuid', 'payment_reference', 'paid_at', 'status', 'hosted_state', 'paid_amount_cents']) assert.deepStrictEqual(a[k], before[k], `${L}: the first payment's ${k} is untouched (got ${JSON.stringify(a[k])}, was ${JSON.stringify(before[k])})`);
  };
  const recorded = (L, db, uuid, at) => {
    const r = extra(db, uuid);
    assert.deepStrictEqual(r, { uuid, amount_cents: 29900, at }, `${L}: one record {uuid, amount_cents, at} — no phase, no reversal state (got ${JSON.stringify(r)})`);
    const al = extraAlert(db, uuid);
    assert.ok(al && al.type === 'payment_extra_payment_received' && al.detail && al.detail.orderId === OID && al.detail.attemptId === AID, `${L}: the durable alert (got ${JSON.stringify(al)})`);
    assert.strictEqual(db.getAt(`orders/${OID}/extra_payment_review`), true, `${L}: the order's manual-review flag`);
  };
  for (const [label, seed] of [['LIVE', 'live'], ['CANCELLED-PAY1-REFUNDED', 'refunded'], ['CANCELLED-PAY1-OUTSTANDING', 'outstanding']]) {
    await cell(`XP-${label}-RECORDED-NO-VOID`, async () => {
      const L = `XP-${label}-RECORDED-NO-VOID`;
      const db = seed === 'live' ? makeDb(livePaid()) : makeDb(cancelled(seed === 'outstanding' ? { status: 'refund_pending', hosted_state: 'refund_pending' } : {}));
      if (seed === 'live') await handleHostedCallback(depsFor(db), cb('PAY-1'), 1000);
      const before = db.getAt(`payment_attempts/${AID}`); resetProvider();
      const r = await handleHostedCallback(depsFor(db), cb('PAY-2'), 2000);
      assert.ok(r.code === 200 && r.outcome === 'extra_payment_recorded', `${L}: (got ${r.code} ${r.outcome})`);
      assert.strictEqual(voidCalls.length, 0, `${L}: NO provider void (got ${JSON.stringify(voidCalls)})`);
      recorded(L, db, 'PAY-2', 2000);
      pay1Untouched(L, db, before);
    });
  }

  await cell('XP-REDELIVERY-RECORDED-ONCE', async () => {
    const L = 'XP-REDELIVERY-RECORDED-ONCE';
    const db = makeDb(cancelled());
    for (const t of [2000, 3000, 4000]) await handleHostedCallback(depsFor(db), cb('PAY-2'), t);
    assert.strictEqual(voidCalls.length, 0, `${L}: no void on any delivery`);
    recorded(L, db, 'PAY-2', 2000);
    assert.strictEqual(Object.keys(db.getAt('dispatcher_alerts') || {}).filter((k) => k.startsWith('extra_payment_')).length, 1, `${L}: one alert`);
  });

  await cell('XP-ATOMIC-WRITE-FAILURE-SURFACED', async () => {
    const L = 'XP-ATOMIC-WRITE-FAILURE-SURFACED';
    let fail = 1;
    const db = makeDb(cancelled(), { beforeWrite: async (p, v) => { if (p === '' && v && Object.keys(v).some((k) => k.startsWith('dispatcher_alerts/extra_payment_')) && fail > 0) { fail -= 1; throw new Error('injected write failure'); } } });
    const r = await handleHostedCallback(depsFor(db), cb('PAY-2'), 2000);
    assert.ok(r.code >= 500, `${L}: a failed write answers 5xx so PixelPay re-delivers (got ${r.code} ${r.outcome})`);
    assert.ok(!extraAlert(db, 'PAY-2') && db.getAt(`orders/${OID}/extra_payment_review`) == null && !(extra(db, 'PAY-2') || {}).uuid,
      `${L}: ALL OR NOTHING — no record without its alert and flag (record ${JSON.stringify(extra(db, 'PAY-2'))}, alert ${JSON.stringify(extraAlert(db, 'PAY-2'))})`);
    const r2 = await handleHostedCallback(depsFor(db), cb('PAY-2'), 3000);
    assert.strictEqual(r2.code, 200, `${L}: the re-delivery completes`);
    recorded(L, db, 'PAY-2', 3000);
    assert.strictEqual(voidCalls.length, 0, `${L}: and nothing is voided`);
  });

  // ── Codex r2 P1 #1 / #3 / P2 #4 — interleavings that produced a second (or post-withdrawal) void: impossible by construction ──
  await cell('XP-CODEX-R2-INTERLEAVINGS-NO-VOID', async () => {
    const L = 'XP-CODEX-R2-INTERLEAVINGS-NO-VOID';
    // #1: two concurrent deliveries of PAY-2 with a cancellation landing between them
    let release; const gate = new Promise((res) => { release = res; }); let n = 0; let armed = false;
    const db = makeDb(livePaid(), { beforeWrite: async (p) => { if (armed && p === '' && (n += 1) === 1) await gate; } });
    await handleHostedCallback(depsFor(db), cb('PAY-1'), 1000);
    resetProvider(); armed = true;
    const a = handleHostedCallback(depsFor(db), cb('PAY-2'), 2000);
    await new Promise((res) => setTimeout(res, 0));
    db.setAt(`orders/${OID}/status`, 'cancelled');
    const b = handleHostedCallback(depsFor(db), cb('PAY-2'), 2001);
    release(); await Promise.all([a, b]);
    // #3: the cancellation withdrawn (order back to new), then another delivery; #4: cancellation after the last delivery
    db.setAt(`orders/${OID}/status`, 'new');
    await handleHostedCallback(depsFor(db), cb('PAY-2'), 3000);
    db.setAt(`orders/${OID}/status`, 'cancelled');
    await handleHostedCallback(depsFor(db), cb('PAY-2'), 4000);
    assert.strictEqual(voidCalls.length, 0, `${L}: the extra is never voided, whatever the interleaving (got ${JSON.stringify(voidCalls)})`);
    assert.ok(extra(db, 'PAY-2') && extraAlert(db, 'PAY-2'), `${L}: and it stays recorded and alerted for a person`);
  });

  await cell('XP-EXTRA-PATH-HAS-NO-PROVIDER-CALL', async () => {
    const L = 'XP-EXTRA-PATH-HAS-NO-PROVIDER-CALL';
    const src = require('fs').readFileSync(require('path').join(__dirname, 'pixelpay-hosted-webhook.js'), 'utf8');
    const a = src.indexOf('async function handleExtraPayment'); const b = src.indexOf('\n}\n', a);
    const body = src.slice(a, b);
    assert.ok(a > 0 && !/voidTransaction|voidOrRefund|client\.|phase/.test(body), `${L}: the extra-payment path contains no provider call and no reversal phase`);
  });

  // ── the base auto-void for a FIRST payment on a cancelled order is unchanged (whole database, provider request) ──
  await cell('XP-FIRST-PAYMENT-ON-CANCELLED-SAME-AS-BASE', async () => {
    const L = 'XP-FIRST-PAYMENT-ON-CANCELLED-SAME-AS-BASE';
    const seed = () => ({ orders: { [OID]: order({ status: 'cancelled' }) }, payment_attempts: { [AID]: freshAttempt() } });
    const CLOCK = { now: () => 42 };
    const db = makeDb(seed(), CLOCK);
    const r = await handleHostedCallback(depsFor(db), cb('PAY-1'), 2000);
    const mine = voidCalls.slice();
    const { execFileSync } = require('child_process'); const Module = require('module'); const path = require('path');
    const filename = path.join(__dirname, 'pixelpay-hosted-webhook.js');
    const src = execFileSync('git', ['show', '8a31e2a3:xpizza-functions/pixelpay-hosted-webhook.js'], { cwd: __dirname, encoding: 'utf8' });
    const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(__dirname); m._compile(src, filename);
    resetProvider();
    const dbB = makeDb(seed(), CLOCK);
    const rB = await m.exports.handleHostedCallback(depsFor(dbB), cb('PAY-1'), 2000);
    assert.ok(rB.outcome === 'cancelled_voided' && voidCalls.length === 1, `${L}: PREMISE — base voids the first payment (got ${rB.outcome}, ${voidCalls.length})`);
    assert.strictEqual(r.outcome, rB.outcome, `${L}: same outcome as base`);
    assert.deepStrictEqual(mine, voidCalls, `${L}: the same provider void request`);
    assert.deepStrictEqual(db.root, dbB.root, `${L}: the whole database equals base's`);
  });

  await cell('XP-KEY-COLLISION-RESISTANT', async () => {
    const L = 'XP-KEY-COLLISION-RESISTANT';
    const db = makeDb(livePaid());
    await handleHostedCallback(depsFor(db), cb('PAY-1'), 1000);
    await handleHostedCallback(depsFor(db), cb('PAY/2'), 2000);
    await handleHostedCallback(depsFor(db), cb('PAY_2'), 3000);
    assert.ok(extra(db, 'PAY/2') && extra(db, 'PAY/2').uuid === 'PAY/2', `${L}: PAY/2 has its own record with its exact uuid`);
    assert.ok(extra(db, 'PAY_2') && extra(db, 'PAY_2').uuid === 'PAY_2', `${L}: PAY_2 has its own record (no collision)`);
  });

  await cell('XP-ALERT-NOT-PRUNED', async () => {
    const L = 'XP-ALERT-NOT-PRUNED';
    const db = makeDb(cancelled());
    await handleHostedCallback(depsFor(db), cb('PAY-2'), 2000);
    const alerts = db.getAt('dispatcher_alerts') || {};
    const key = `extra_payment_${xkey('PAY-2')}`;
    assert.ok(alerts[key], `${L}: PREMISE — the extra-payment alert exists`);
    assert.ok(!alertsToPrune(alerts, db.getAt('orders')).includes(key), `${L}: the resolved-order pruning never removes the extra-payment alert`);
  });

  FINISHED = true;
  if (fails.length) { console.error(`\nFAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  FINISHED = true;
  console.log(`\nAll ${pass} extra-payment cells passed.`);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
