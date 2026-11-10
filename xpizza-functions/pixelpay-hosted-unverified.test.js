/**
 * An UNVERIFIED hosted callback (bad hash, bad binding or wrong amount) never writes the attempt's authoritative payment
 * binding (codex extra-pay r2 #2). Its evidence is kept apart, once per claimed payment; the readers that routed on the
 * old written uuid (paid-evidence routing, abandon refusal, cancel) still see it, and a manual refund never sends a
 * provider void for a payment id that no verified callback bound.
 * Through the REAL handleHostedCallback / resolveManualReconciliationCore / pixelpay-client (fetch stubbed and
 * validated) on the honest RTDB model; differential cells compile base 8a31e2a3's handler from git.
 * Each failure message starts with its cell label. Run: node pixelpay-hosted-unverified.test.js
 */
process.env.PIXELPAY_MODE = 'sandbox';
const assert = require('assert');
const { handleHostedCallback } = require('./pixelpay-hosted-webhook');
const { resolveManualReconciliationCore } = require('./resolve-manual');
const MR = require('./manual-resolve');
const { buildMaterializeUpdates } = require('./materialize');
const { paymentHash } = require('./pixelpay');
const realClient = require('./pixelpay-client');
const { voidOrRefund } = require('./pixelpay-cancel');
const { paymentAlert } = require('./lib/payment-alert');
const { makeHonestDb: makeDb } = require('./_honest-rtdb-model');
const PP = require('./pixelpay'); const { resolvePixelPayConfig } = require('./pixelpay-config');

const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
const OID = 'TBUV1', AID = 'c0ffee00c0ffee00', HOID = `${OID}-${AID}`;

let voidCalls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.endsWith('/api/v2/transaction/void')) throw new Error(`unexpected fetch ${u}`);
  const cfg = resolvePixelPayConfig(); const h = init.headers || {}; const body = JSON.parse(init.body);
  if (init.method !== 'POST') throw new Error('provider stub: void must be POST');
  if (h['x-auth-key'] !== cfg.app_key || h['x-auth-hash'] !== cfg.auth_hash) throw new Error('provider stub: bad auth headers');
  if (h['x-auth-user'] !== PP.platformUser(cfg.merchant_email)) throw new Error('provider stub: bad x-auth-user');
  if (body.void_signature !== PP.voidSignature(cfg.merchant_email, HOID, cfg.secret)) throw new Error('provider stub: bad void signature');
  if (typeof body.payment_uuid !== 'string' || !body.payment_uuid) throw new Error('provider stub: missing payment_uuid');
  voidCalls.push(body);
  return new Response(JSON.stringify({ success: true, message: 'anulada' }), { status: 200 });
};

const order = (o = {}) => ({ order_id: OID, order_type: 'pickup', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', total: 299, total_cents: 29900, customer_name: 'T', items_text: 'x', active_attempt_id: AID, created_at: 1, ...o });
const live = (att = {}) => ({ orders: { [OID]: order() }, payment_attempts: { [AID]: { order_id: OID, hosted_state: 'created', hosted_order_id: HOID, ...att } } });
const refundedPay1 = () => ({ orders: { [OID]: order({ status: 'cancelled', payment_status: 'refunded' }) },
  payment_attempts: { [AID]: { order_id: OID, hosted_order_id: HOID, hosted_state: 'voided', status: 'refunded', payment_uuid: 'PAY-1', paid_amount_cents: 29900, payment_reference: 'TXN-PAY-1', paid_at: 1000 } } });
const GOOD = paymentHash(HOID, KEY, SECRET);
const cb = (uuid, over = {}) => ({ order: HOID, status: 'paid', amount: 299, uuid, transaction_id: `TXN-${uuid}`, payment_hash: GOOD, ...over });
const BAD = { payment_hash: 'deadbeef'.repeat(4) };
const CLOCK = { now: () => 42 };   // a fixed server clock where two databases are compared whole
const deps = (db) => ({ db, restaurant: { lat: 15.5, lng: -88, name: 'TB', phone: 'p' }, buildMaterializeUpdates, alert: (k, d) => paymentAlert(db, k, d), genToken: () => 'TOK', client: realClient, voidOrRefund });
const rdeps = (db) => ({ ...deps(db), sanitizeText: (s) => String(s), serverTimestamp: 0 });
const att = (db) => db.getAt(`payment_attempts/${AID}`) || {};
const evidence = (db) => Object.values(att(db).unverified_callbacks || {});

function baseHandler() {
  const { execFileSync } = require('child_process'); const Module = require('module'); const path = require('path');
  const filename = path.join(__dirname, 'pixelpay-hosted-webhook.js');
  const src = execFileSync('git', ['show', '8a31e2a3:xpizza-functions/pixelpay-hosted-webhook.js'], { cwd: __dirname, encoding: 'utf8' });
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(__dirname); m._compile(src, filename);
  return m.exports.handleHostedCallback;
}
const without = (root, dropPaths) => { const r = JSON.parse(JSON.stringify(root)); for (const p of dropPaths) { const a = p.split('/'); let n = r; for (let i = 0; i < a.length - 1 && n; i++) n = n[a[i]]; if (n) delete n[a[a.length - 1]]; } return r; };

let pass = 0; const fails = [];
async function cell(name, fn) { voidCalls = []; try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { fails.push(name); console.error(`  ✗ ${String((e && e.message) || e).split('\n')[0]}`); } }

(async () => {
  // Codex r2 #2 repro A: a refunded PAY-1, then a bad-hash callback naming another payment, then a verified PAY-1 re-delivery.
  await cell('UV-A-REFUNDED-PAY1-SURVIVES-BAD-HASH', async () => {
    const L = 'UV-A-REFUNDED-PAY1-SURVIVES-BAD-HASH';
    const db = makeDb(refundedPay1());
    const r1 = await handleHostedCallback(deps(db), cb('PAY-X', BAD), 2000);
    assert.strictEqual(r1.outcome, 'manual_reconciliation', `${L}: PREMISE — the bad-hash callback is flagged (got ${r1.outcome})`);
    assert.strictEqual(att(db).payment_uuid, 'PAY-1', `${L}: the bound payment is NOT replaced by an unverified one (got ${att(db).payment_uuid})`);
    assert.strictEqual(att(db).paid_amount_cents, 29900, `${L}: nor its paid amount`);
    await handleHostedCallback(deps(db), cb('PAY-1'), 3000);
    assert.strictEqual(voidCalls.length, 0, `${L}: the verified PAY-1 re-delivery sends NO provider void (it was already refunded) — got ${JSON.stringify(voidCalls)}`);
    assert.ok(att(db).extra_payments == null, `${L}: and PAY-1 is never treated as an extra payment`);
    assert.strictEqual(att(db).payment_uuid, 'PAY-1', `${L}: PAY-1 stays bound`);
  });

  // Codex r2 #2 repro B: a bad-hash callback FIRST, then the legitimate single payment → the same end state as base.
  await cell('UV-B-BAD-FIRST-THEN-LEGIT-SAME-AS-BASE', async () => {
    const L = 'UV-B-BAD-FIRST-THEN-LEGIT-SAME-AS-BASE';
    const db = makeDb(live(), CLOCK);
    await handleHostedCallback(deps(db), cb('PAY-X', BAD), 1000);
    const r = await handleHostedCallback(deps(db), cb('PAY-1'), 2000);
    const dbB = makeDb(live(), CLOCK); const base = baseHandler();
    await base(deps(dbB), cb('PAY-X', BAD), 1000);
    const rB = await base(deps(dbB), cb('PAY-1'), 2000);
    assert.strictEqual(rB.outcome, 'paid_evidence_recorded', `${L}: PREMISE — base records the legit payment as paid evidence (got ${rB.outcome})`);
    assert.strictEqual(r.outcome, rB.outcome, `${L}: the legit payment takes base's path (got ${r.outcome}, base ${rB.outcome})`);
    assert.strictEqual(att(db).payment_uuid, 'PAY-1', `${L}: the legit payment is the bound one`);
    assert.ok(att(db).hosted_callback_verified === true && db.getAt(`orders/${OID}/paid_during_resolve`) === true, `${L}: verified flags and paid_during_resolve are set`);
    assert.ok(att(db).extra_payments == null, `${L}: the legit payment is never an extra`);
    // the ONLY declared delta vs base: the unverified evidence lives apart (and base kept the bad callback's text in manual_reason, unchanged here)
    assert.deepStrictEqual(without(db.root, [`payment_attempts/${AID}/unverified_callbacks`]), dbB.root, `${L}: the whole database equals base's apart from the separated evidence`);
  });

  // No verification failure — hash, binding or amount — writes the binding fields; each leaves one evidence record.
  for (const [tag, seed, body] of [
    ['HASH', live(), cb('PAY-X', BAD)],
    ['BINDING', live({ hosted_order_id: `TBOTHER-${AID}` }), cb('PAY-X')],
    ['AMOUNT', live(), cb('PAY-X', { amount: 1 })],
  ]) {
    await cell(`UV-NO-BINDING-WRITE-${tag}`, async () => {
      const L = `UV-NO-BINDING-WRITE-${tag}`;
      const db = makeDb(seed);
      const r = await handleHostedCallback(deps(db), body, 1000);
      assert.strictEqual(r.outcome, 'manual_reconciliation', `${L}: PREMISE — flagged for manual reconciliation (got ${r.outcome})`);
      assert.strictEqual(att(db).payment_uuid, undefined, `${L}: payment_uuid is NOT written (got ${att(db).payment_uuid})`);
      assert.strictEqual(att(db).paid_amount_cents, undefined, `${L}: paid_amount_cents is NOT written`);
      assert.ok(att(db).hosted_state === 'manual_reconciliation' && db.getAt(`orders/${OID}/payment_status`) === 'manual_reconciliation', `${L}: the attempt and order are flagged as in base`);
      const ev = evidence(db);
      assert.strictEqual(ev.length, 1, `${L}: one evidence record (got ${ev.length})`);
      assert.ok(ev[0].uuid === 'PAY-X' && ev[0].at === 1000 && typeof ev[0].amount_cents === 'number', `${L}: the evidence keeps the claimed payment id, amount and time (got ${JSON.stringify(ev[0])})`);
      assert.ok(!('payment_hash' in ev[0]), `${L}: the evidence never stores the presented hash`);
    });
  }

  await cell('UV-EVIDENCE-ONCE', async () => {
    const L = 'UV-EVIDENCE-ONCE';
    const db = makeDb(live());
    await handleHostedCallback(deps(db), cb('PAY-X', BAD), 1000);
    await handleHostedCallback(deps(db), cb('PAY-X', BAD), 5000);
    await handleHostedCallback(deps(db), cb('PAY-Y', BAD), 6000);
    const ev = evidence(db).sort((a, b) => a.at - b.at);
    assert.deepStrictEqual(ev.map((e) => [e.uuid, e.at]), [['PAY-X', 1000], ['PAY-Y', 6000]], `${L}: one record per claimed payment, first sighting kept (got ${JSON.stringify(ev.map((e) => [e.uuid, e.at]))})`);
  });

  // The readers that routed on base's written uuid see the separated evidence the same way.
  await cell('UV-ROUTING-SAME-AS-BASE', async () => {
    const L = 'UV-ROUTING-SAME-AS-BASE';
    const db = makeDb(live()); await handleHostedCallback(deps(db), cb('PAY-X', BAD), 1000);
    const dbB = makeDb(live()); await baseHandler()(deps(dbB), cb('PAY-X', BAD), 1000);
    const o = db.getAt(`orders/${OID}`), oB = dbB.getAt(`orders/${OID}`);
    assert.strictEqual(MR.hasPaidEvidence(oB, att(dbB)), true, `${L}: PREMISE — base routes this as paid evidence`);
    assert.strictEqual(MR.hasPaidEvidence(o, att(db)), true, `${L}: the separated evidence still routes as paid evidence (abandon refused, cancel → manual review)`);
    assert.strictEqual(MR.hasCapturedMoneyEvidence(o, att(db)), MR.hasCapturedMoneyEvidence(oB, att(dbB)), `${L}: and is never captured-money evidence (no auto-void), as base`);
  });

  await cell('UV-ABANDON-REFUSED', async () => {
    const L = 'UV-ABANDON-REFUSED';
    const db = makeDb(live()); await handleHostedCallback(deps(db), cb('PAY-X', BAD), 1000);
    const r = await resolveManualReconciliationCore(rdeps(db), { orderId: OID, action: 'abandon', actor: 'disp@tb', note: '', now: 2000, claimId: 'CL1' });
    assert.strictEqual(r.status, 409, `${L}: abandon is refused while unverified payment evidence exists, as base (got ${r.status} ${JSON.stringify(r.body)})`);
    assert.notStrictEqual(db.getAt(`orders/${OID}/payment_status`), 'abandoned', `${L}: the order is not abandoned`);
  });

  await cell('UV-REFUND-NEVER-VOIDS-UNVERIFIED', async () => {
    const L = 'UV-REFUND-NEVER-VOIDS-UNVERIFIED';
    const db = makeDb(live()); await handleHostedCallback(deps(db), cb('PAY-X', BAD), 1000);
    const r = await resolveManualReconciliationCore(rdeps(db), { orderId: OID, action: 'refund', actor: 'disp@tb', note: '', now: 2000, claimId: 'CL1' });
    assert.strictEqual(voidCalls.length, 0, `${L}: no provider void for a payment id no verified callback bound (got ${JSON.stringify(voidCalls)})`);
    assert.strictEqual(r.body && r.body.outcome, 'manual_review', `${L}: the refund converges to manual review for a human (got ${JSON.stringify(r.body)})`);
  });

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\npixelpay-hosted-unverified: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.message); process.exit(1); });
