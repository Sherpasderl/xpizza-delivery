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
function makeDb(initial, hooks = {}) {
  const root = JSON.parse(JSON.stringify(initial)); const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const getAt = (p) => { if (!p) return root; let n = root; for (const k of p.split('/')) { if (n == null) return null; n = n[k]; } return n === undefined ? null : n; };
  const setAt = (p, val) => { const a = p.split('/'); for (const k of a) if (/[.#$[\]]/.test(k)) throw new Error(`invalid RTDB key: ${k}`); let n = root; for (let i = 0; i < a.length - 1; i++) { if (n[a[i]] == null || typeof n[a[i]] !== 'object') n[a[i]] = {}; n = n[a[i]]; } const l = a[a.length - 1]; if (val === null) delete n[l]; else n[l] = val; };
  let pk = 0;
  const snap = (v) => ({ val: () => clone(v), exists: () => v != null });
  const ref = (p = '') => {
    const r = {
      async once() { if (hooks.beforeRead) await hooks.beforeRead(p, api); return snap(getAt(p)); }, async get() { return r.once(); },
      async transaction(fn) {   // Admin-SDK null-first, honestly: undefined on the null call aborts; a value re-runs only on a server mismatch
        if (hooks.beforeTx) await hooks.beforeTx(p, api);
        const cur = clone(getAt(p)); let nx = fn(null);
        if (nx === undefined) return { committed: false, snapshot: snap(cur) };
        if (cur !== null) { nx = fn(clone(cur)); if (nx === undefined) return { committed: false, snapshot: snap(cur) }; }
        setAt(p, clone(nx)); return { committed: true, snapshot: snap(getAt(p)) };
      },
      async update(patch) { if (hooks.beforeWrite) await hooks.beforeWrite(p, patch, api); if (!p) { for (const [k, v] of Object.entries(patch)) setAt(k, clone(v)); return; } setAt(p, Object.assign({}, getAt(p) || {}, clone(patch))); },
      async set(v) { if (hooks.beforeWrite) await hooks.beforeWrite(p, v, api); setAt(p, clone(v)); },
      async push(v) { const k = `k${++pk}`; setAt(p ? `${p}/${k}` : k, clone(v)); return { key: k }; }, async remove() { setAt(p, null); },
    };
    return r;
  };
  const api = { ref, getAt, setAt, root };
  return api;
}

// The PixelPay provider, stubbed at fetch with REAL Response objects; every void request body is recorded.
let voidScript = []; let voidCalls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.endsWith('/api/v2/transaction/void')) throw new Error(`unexpected fetch ${u}`);
  voidCalls.push(JSON.parse(init.body));
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

let pass = 0; const fails = [];
async function cell(name, fn) { resetProvider(); try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { fails.push(name); console.error(`  ✗ ${String((e && e.message) || e).split('\n')[0]}`); } }

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

  // ── a LIVE order: record + durable alert + flag; NO provider call ──
  await cell('XP-LIVE-RECORDED-NO-VOID', async () => {
    const L = 'XP-LIVE-RECORDED-NO-VOID';
    const db = makeDb(livePaid());
    await handleHostedCallback(depsFor(db), cb('PAY-1'), 1000);
    const r = await handleHostedCallback(depsFor(db), cb('PAY-2'), 2000);
    const att = db.getAt(`payment_attempts/${AID}`);
    assert.strictEqual(att.payment_uuid, 'PAY-1', `${L}: the first payment stays bound`);
    assert.strictEqual(att.paid_at, 1000, `${L}: first paid_at preserved`);
    const ex = extra(db, 'PAY-2');
    assert.ok(ex && ex.uuid === 'PAY-2' && ex.phase === 'held_for_review' && ex.amount_cents === 29900, `${L}: the extra is held for review under sha256(uuid) with the exact uuid (got ${JSON.stringify(ex)})`);
    assert.ok(extraAlert(db, 'PAY-2'), `${L}: a DURABLE alert exists at its own key`);
    assert.strictEqual(db.getAt(`orders/${OID}/extra_payment_review`), true, `${L}: the order is flagged`);
    assert.strictEqual(voidCalls.length, 0, `${L}: NO provider void on a live order`);
    assert.strictEqual(r.code, 200, `${L}: 2xx`);
  });

  // ── a CANCELLED order: the extra's OWN reversal, scoped to its payment id; the attempt-level reversal untouched ──
  await cell('XP-CANCELLED-FIRST-REFUNDED-VOIDS-PAY2', async () => {
    const L = 'XP-CANCELLED-FIRST-REFUNDED-VOIDS-PAY2';
    const db = makeDb(cancelled());
    await handleHostedCallback(depsFor(db), cb('PAY-2'), 2000);
    assert.strictEqual(voidCalls.length, 1, `${L}: exactly one provider void (got ${voidCalls.length})`);
    assert.strictEqual(voidCalls[0].payment_uuid, 'PAY-2', `${L}: the void targets PAY-2 (got ${voidCalls[0] && voidCalls[0].payment_uuid})`);
    const att = db.getAt(`payment_attempts/${AID}`);
    assert.strictEqual(att.status, 'refunded', `${L}: the attempt-level reversal state is untouched`);
    assert.strictEqual(att.payment_uuid, 'PAY-1', `${L}: the first payment stays bound`);
    const ex = extra(db, 'PAY-2');
    assert.ok(ex && ex.phase === 'voided' && ex.outcome === 'auto_voided', `${L}: the extra's own outcome is auto_voided (got ${JSON.stringify(ex)})`);
  });

  await cell('XP-CANCELLED-PAY2-UNCONFIRMED-MANUAL', async () => {
    const L = 'XP-CANCELLED-PAY2-UNCONFIRMED-MANUAL';
    const db = makeDb(cancelled());
    resetProvider([{ status: 200, body: { success: false, message: 'card 4111 tb_SECRET_provider_text' } }]);
    await handleHostedCallback(depsFor(db), cb('PAY-2'), 2000);
    const att = db.getAt(`payment_attempts/${AID}`);
    assert.strictEqual(att.status, 'refunded', `${L}: the attempt-level reversal state is untouched (got ${att.status})`);
    assert.strictEqual(isReconcilerRetryable(att, 3000, 120000), false, `${L}: the refund reconciler does NOT pick the attempt up (it would retry PAY-1)`);
    const ex = extra(db, 'PAY-2');
    assert.ok(ex && ex.phase === 'manual' && ex.outcome === 'void_unconfirmed_manual', `${L}: an unconfirmed extra reversal is manual-only (got ${JSON.stringify(ex)})`);
    assert.ok(!JSON.stringify(db.getAt('dispatcher_alerts') || {}).includes('tb_SECRET_provider_text'), `${L}: no provider message reaches an alert`);
    assert.ok(!JSON.stringify(ex).includes('tb_SECRET_provider_text'), `${L}: nor the record`);
  });

  await cell('XP-CANCELLED-PAY1-OUTSTANDING-UNTOUCHED', async () => {
    const L = 'XP-CANCELLED-PAY1-OUTSTANDING-UNTOUCHED';
    const db = makeDb(cancelled({ hosted_state: 'refund_pending', status: 'refund_pending' }));
    await handleHostedCallback(depsFor(db), cb('PAY-2'), 2000);
    const att = db.getAt(`payment_attempts/${AID}`);
    assert.strictEqual(att.status, 'refund_pending', `${L}: PAY-1's outstanding reversal is NOT marked done by PAY-2's (got ${att.status})`);
    assert.strictEqual(isReconcilerRetryable(att, 3000, 120000), true, `${L}: the reconciler still retries PAY-1`);
    assert.ok(extra(db, 'PAY-2') && extra(db, 'PAY-2').outcome === 'auto_voided', `${L}: PAY-2 voided on its own record`);
  });

  await cell('XP-BASE-PROVIDER-CALL', async () => {
    const L = 'XP-BASE-PROVIDER-CALL';
    const db = makeDb(cancelled({ hosted_state: 'created', status: undefined, payment_uuid: 'PAY-1' }));
    await handleHostedCallback(depsFor(db), cb('PAY-2'), 2000);
    const mine = voidCalls.slice();
    // base 8a31e2a3's own handler on the same input, through the real voidOrRefund + real client
    const { execFileSync } = require('child_process'); const Module = require('module'); const path = require('path');
    const filename = path.join(__dirname, 'pixelpay-hosted-webhook.js');
    const src = execFileSync('git', ['show', '8a31e2a3:xpizza-functions/pixelpay-hosted-webhook.js'], { cwd: __dirname, encoding: 'utf8' });
    const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(__dirname); m._compile(src, filename);
    resetProvider();
    const dbB = makeDb(cancelled({ hosted_state: 'created', status: undefined, payment_uuid: 'PAY-1' }));
    await m.exports.handleHostedCallback(depsFor(dbB), cb('PAY-2'), 2000);
    assert.strictEqual(voidCalls.length, 1, `${L}: PREMISE — base voids the payment on a cancelled order`);
    assert.deepStrictEqual(mine, voidCalls, `${L}: the provider void request is IDENTICAL to base 8a31e2a3's (got ${JSON.stringify(mine)} vs ${JSON.stringify(voidCalls)})`);
  });

  // ── crash safety: the alert/flag are durable and awaited; phases resume or go manual ──
  await cell('XP-ALERT-WRITE-FAILS-SURFACED', async () => {
    const L = 'XP-ALERT-WRITE-FAILS-SURFACED';
    let fail = 1;
    const db = makeDb(livePaid(), { beforeWrite: async (p) => { if (p.startsWith('dispatcher_alerts/extra_payment_') && fail > 0) { fail -= 1; throw new Error('injected alert write failure'); } } });
    await handleHostedCallback(depsFor(db), cb('PAY-1'), 1000);
    const r = await handleHostedCallback(depsFor(db), cb('PAY-2'), 2000);
    assert.ok(r.code >= 500, `${L}: an alert write failure is SURFACED as a 5xx so PixelPay re-delivers (got ${r.code} ${r.outcome})`);
    assert.ok(extra(db, 'PAY-2'), `${L}: PREMISE — the record exists`);
    const r2 = await handleHostedCallback(depsFor(db), cb('PAY-2'), 3000);
    assert.ok(extraAlert(db, 'PAY-2') && r2.code === 200, `${L}: the re-delivery writes the alert and completes (got ${r2.code})`);
    assert.ok(extra(db, 'PAY-2') && extra(db, 'PAY-2').phase === 'held_for_review', `${L}: and resumes to held_for_review`);
  });

  await cell('XP-CRASH-AFTER-CLAIM-RESUMES', async () => {
    const L = 'XP-CRASH-AFTER-CLAIM-RESUMES';
    const db = makeDb(cancelled());
    db.setAt(`payment_attempts/${AID}/extra_payments/${xkey('PAY-2')}`, { uuid: 'PAY-2', amount_cents: 29900, at: 1500, phase: 'reversal_claimed', claimed_at: 1500 });
    await handleHostedCallback(depsFor(db), cb('PAY-2'), 2000);
    assert.strictEqual(voidCalls.length, 1, `${L}: a claimed-but-not-started reversal resumes once (got ${voidCalls.length})`);
    assert.ok(extra(db, 'PAY-2') && extra(db, 'PAY-2').outcome === 'auto_voided', `${L}: completed`);
  });

  await cell('XP-CRASH-AFTER-SIDE-EFFECT-MANUAL', async () => {
    const L = 'XP-CRASH-AFTER-SIDE-EFFECT-MANUAL';
    const db = makeDb(cancelled());
    db.setAt(`payment_attempts/${AID}/extra_payments/${xkey('PAY-2')}`, { uuid: 'PAY-2', amount_cents: 29900, at: 1500, phase: 'side_effect_started', claimed_at: 1500 });
    await handleHostedCallback(depsFor(db), cb('PAY-2'), 2000);
    assert.strictEqual(voidCalls.length, 0, `${L}: an uncertain started void is NEVER re-sent (got ${voidCalls.length})`);
    const ex = extra(db, 'PAY-2') || {};
    assert.ok(ex.phase === 'manual' && ex.outcome === 'void_uncertain_manual', `${L}: held for manual review (got ${JSON.stringify(ex)})`);
  });

  await cell('XP-REDELIVERY-EXACTLY-ONCE', async () => {
    const L = 'XP-REDELIVERY-EXACTLY-ONCE';
    const db = makeDb(cancelled());
    await handleHostedCallback(depsFor(db), cb('PAY-2'), 2000);
    await handleHostedCallback(depsFor(db), cb('PAY-2'), 3000);
    assert.strictEqual(voidCalls.length, 1, `${L}: one void across re-deliveries (got ${voidCalls.length})`);
    const alerts = Object.keys(db.getAt('dispatcher_alerts') || {}).filter((k) => k.startsWith('extra_payment_'));
    assert.strictEqual(alerts.length, 1, `${L}: one durable alert (got ${alerts.length})`);
  });

  // ── a cancel racing the callback; a cancel after the extra was held ──
  await cell('XP-CANCEL-RACE-VOIDS', async () => {
    const L = 'XP-CANCEL-RACE-VOIDS';
    let reads = 0;
    const db = makeDb(livePaid(), { beforeRead: async (p, api) => { if (p === `orders/${OID}`) { reads += 1; if (reads === 3) api.setAt(`orders/${OID}/status`, 'cancelled'); } } });
    await handleHostedCallback(depsFor(db), cb('PAY-1'), 1000);   // reads 1 (+ confirm's own reads)
    reads = 1;                                                      // the next delivery's first order read is #2; the decision re-read is #3
    await handleHostedCallback(depsFor(db), cb('PAY-2'), 2000);
    const ex = extra(db, 'PAY-2');
    assert.ok(ex && ex.outcome === 'auto_voided' && voidCalls.length === 1, `${L}: a cancel landing before the decision re-read is honoured → voided (got ${JSON.stringify(ex)}, ${voidCalls.length} voids)`);
  });

  await cell('XP-HELD-THEN-CANCELLED-REDELIVERY-VOIDS', async () => {
    const L = 'XP-HELD-THEN-CANCELLED-REDELIVERY-VOIDS';
    const db = makeDb(livePaid());
    await handleHostedCallback(depsFor(db), cb('PAY-1'), 1000);
    await handleHostedCallback(depsFor(db), cb('PAY-2'), 2000);
    assert.ok(extra(db, 'PAY-2') && extra(db, 'PAY-2').phase === 'held_for_review', `${L}: PREMISE — held (got ${JSON.stringify(extra(db, 'PAY-2'))})`);
    db.setAt(`orders/${OID}/status`, 'cancelled');
    await handleHostedCallback(depsFor(db), cb('PAY-2'), 3000);
    assert.strictEqual(extra(db, 'PAY-2').outcome, 'auto_voided', `${L}: an existing held extra goes through its reversal after the cancel (got ${JSON.stringify(extra(db, 'PAY-2'))})`);
    assert.strictEqual(voidCalls.length, 1, `${L}: one void`);
  });

  // ── keys and alerts ──
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

  if (fails.length) { console.error(`\nFAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`\nAll ${pass} extra-payment cells passed.`);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
