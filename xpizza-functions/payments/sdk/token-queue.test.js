'use strict';
// card-cleanup (owner UNPARKED 11-18; PLAN-card-token-cleanup «PLAN DELTA» (1)–(7)) — a card token PixelPay keeps alive (Q3: a token used
// for a payment and voided STAYS) is NEVER dropped without its provider-delete handle: every removal of payment_sdk_tokens/{oid} ENQUEUES
// each token at provider_token_deletes/{hash} in the SAME multi-path update; the drain deletes it at the provider by the probe rule, after
// an OWNERSHIP re-check (a live saved card, or another order's live node, keeps it). Real coordinator + sweeper + cards on the honest RTDB
// model; the provider is the fake adapter. Run: node payments/sdk/token-queue.test.js
const assert = require('assert');
const crypto = require('crypto');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const { makeAdapter } = require('./psp-adapter');
const { makeFakePsp } = require('./fake-adapter');

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const C = require('./coordinator');
const K = require('./cards');
const SW = require('./sweeper');
const Q = () => require('./token-queue');
const T0 = 1_800_000_000_000;
const H = (t) => crypto.createHash('sha256').update(t).digest('hex');
const DISP = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 };
const ORDER = (o = {}) => ({ payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', restaurant_id: 'tq_rest', customer_uid: 'uid_A', customer_name: 'Ana', total_cents: 100, pay_deadline_at: T0 + 900000, ...o });
const world = (script = {}, { hooks = {}, orders = { o_1: ORDER() }, namespace = 'sandbox', logs = [] } = {}) => {
  const db = makeHonestDb({ orders }, { now: () => T0, ...hooks });
  const fake = makeFakePsp(script);
  const deps = { db, psp: makeAdapter(fake.impl), clock: () => T0, voidEligible: () => false, ppNamespace: namespace, goLive: async () => {}, verifyIdToken: async () => ({ uid: 'uid_A' }), log: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) } };
  return { db, fake, deps, logs, node: (o = 'o_1') => db.getAt(`payment_sdk_tokens/${o}`), item: (t) => db.getAt(`provider_token_deletes/${H(t)}`), queue: () => db.getAt('provider_token_deletes') };
};
const card = (save, ref = 'new') => ({ card_ref: ref, display: DISP, save, vault_gen: 0 });
const place = async (w, tok, save, { oid = 'o_1', att = 'att_tq_place_00000001', ref } = {}) => {
  const p = await C.placeOriginal(w.deps, { orderId: oid, attempt_id: att, token: tok, amount_cents: 100, card: card(save, ref) });
  assert.strictEqual(p.outcome, 'placed', `premise: placed (${p.outcome})`);
};
const finish = async (w, oid = 'o_1') => { await w.db.ref(`orders/${oid}/status`).set('delivered'); await SW.visitDueOrder(w.deps, oid); };
const deletes = (w) => w.fake.calls.filter((c) => c.action === 'delete_token');
const alerts = (w) => Object.values(w.db.getAt('dispatcher_alerts') || {});

(async () => {
  // (1) the null ENQUEUES then drops, in ONE update — never a bare drop
  await cell('TQ-NULL-ENQUEUE', async (L) => {
    const w = world(); await place(w, 'T-q1', false); await finish(w);
    assert.strictEqual(w.node(), null, 'premise: the null removed the node');
    const it = w.item('T-q1');
    assert.ok(it && it.token === 'T-q1', `${L}: the dropped token is queued for the provider delete at provider_token_deletes/{hash}`);
    assert.deepStrictEqual(Object.keys(it.sources || {}), ['order_o_1'], `${L}: its source is the order`);
    assert.ok(it.sources.order_o_1.aid === 'att_tq_place_00000001' && it.sources.order_o_1.uid === 'uid_A', `${L}: the source names the attempt and the uid (for the ownership check) — nothing else`);
    assert.strictEqual(w.db.getAt(`payment_sdk_token_refs/${H('T-q1')}`), null, `${L}: the live-node reference is removed with the node`);
  });
  await cell('TQ-ATOMIC', async (L) => {
    let armed = false;
    const w = world({}, { hooks: { beforeWrite: async (p, patch) => { if (armed && p === '' && patch && Object.keys(patch).some((k) => k.startsWith('provider_token_deletes/'))) throw Object.assign(new Error('update failed'), { code: 'unavailable' }); } } });
    await place(w, 'T-q2', false); await w.db.ref('orders/o_1/status').set('delivered'); await C.settleTerminal(w.deps, { orderId: 'o_1' });
    armed = true;
    await K.nullSpentToken(w.deps, 'o_1').catch(() => null);
    assert.ok(w.node() && w.node().att_tq_place_00000001 === 'T-q2', `${L}: a failed enqueue-and-drop update leaves the node (the handle) in place`);
    assert.strictEqual(w.queue(), null, `${L}: and queues nothing (one atomic update)`);
    armed = false;
    await K.nullSpentToken(w.deps, 'o_1');
    assert.ok(w.node() == null && w.item('T-q2'), `${L}: a retry completes both`);
  });
  // a write-ahead whose claim LOST (a real cancel before the claim CAS) — the client still tokenized it → queued, never a bare drop
  await cell('TQ-ORPHAN-ENQUEUE', async (L) => {
    let n = 0; let w = null;
    // the SDK config is unconfigured here, so the sweeper's drain is INERT and the queued handle stays observable
    w = world({}, { namespace: 'unconfigured', hooks: { beforeTx: async (p) => { if (String(p) === 'payment_sdk/o_1' && ++n === 2) await C.cancelSdkOrder(w.deps, { orderId: 'o_1' }); } } });
    const p = await C.placeOriginal(w.deps, { orderId: 'o_1', attempt_id: 'att_tq_orphan_0000001', token: 'T-q3', amount_cents: 100, card: card(false) });
    assert.ok(p.outcome !== 'placed' && w.node(), `premise: an orphan write-ahead (${p.outcome})`);
    await SW.sweepSdkPayments(w.deps);
    assert.ok(w.node() == null && w.item('T-q3'), `${L}: the orphan walk enqueues-and-drops (the handle is kept in the queue)`);
  });
  // (2) Finding A — a SAVED card shares the order's token: the drain must NOT delete what a live saved card still owns
  await cell('TQ-SAVED-OWNED', async (L) => {
    const w = world(); await place(w, 'T-saved', true); await finish(w);
    assert.ok(w.item('T-saved') && Object.keys(w.db.getAt('customer_cards/uid_A/cards') || {}).length === 1, 'premise: queued, and the saved card holds the same token');
    await Q().drainProviderDeletes(w.deps);
    assert.strictEqual(deletes(w).length, 0, `${L}: NO provider delete while a live saved card owns the token`);
    assert.strictEqual(w.item('T-saved'), null, `${L}: the item is closed «owned» (the saved card keeps the handle)`);
    const id = Object.keys(w.db.getAt('customer_cards/uid_A/cards'))[0];
    assert.ok(await K.resolveSavedCard(w.deps, 'uid_A', id), `${L}: the saved card still charges`);
  });
  await cell('TQ-SHARED-LIVE', async (L) => {
    const w = world({}, { orders: { o_1: ORDER(), o_2: ORDER() } });
    await place(w, 'T-shared', false);
    await place(w, 'T-shared', false, { oid: 'o_2', att: 'att_tq_second_0000002' });   // a second, still OPEN order holding the same token
    await finish(w, 'o_1');
    assert.ok(w.item('T-shared') && w.node('o_2'), 'premise: o_1 queued it, o_2 is open with its node');
    await Q().drainProviderDeletes(w.deps);
    assert.strictEqual(deletes(w).length, 0, `${L}: NO provider delete while another order's live node holds the token`);
    assert.strictEqual(w.node('o_2').att_tq_second_0000002, 'T-shared', `${L}: the open order keeps its token`);
  });
  // (3) the drain, by the probe rule
  await cell('TQ-DRAIN-200', async (L) => {
    const w = world({ delete_token: [{ status: 200, success: true }] }); await place(w, 'T-d1', false); await finish(w);
    const r = await Q().drainProviderDeletes(w.deps);
    assert.ok(deletes(w).length === 1 && deletes(w)[0].token === 'T-d1', `${L}: the provider delete is called with the queued token`);
    assert.strictEqual(w.item('T-d1'), null, `${L}: 200 ⇒ done, the item is removed`);
    assert.ok(r && r.done === 1, `${L}: counted (${JSON.stringify(r)})`);
  });
  await cell('TQ-DRAIN-400-FIRST', async (L) => {
    const w = world({ delete_token: [{ status: 400, success: false }] }); await place(w, 'T-d2', false); await finish(w);
    await Q().drainProviderDeletes(w.deps);
    const it = w.item('T-d2');
    assert.ok(it && it.tries === 1 && !it.ok_at, `${L}: a 400 on the FIRST try is UNKNOWN — the item stays (counted)`);
    assert.ok(alerts(w).some((a) => a.type === 'payment_sdk_provider_delete_unknown'), `${L}: and alerts (fixed code)`);
  });
  await cell('TQ-DRAIN-400-AFTER-OUR-200', async (L) => {
    // the model's remove() runs no hook, so the failing removal is injected on the drain's own db handle: after OUR 200 is recorded, the
    // item's removal throws once (a crash between the two writes)
    let failRemove = true;
    const w = world({ delete_token: [{ status: 200, success: true }, { status: 400, success: false }] });
    await place(w, 'T-d3', false); await finish(w);
    const realRef = w.db.ref.bind(w.db);
    w.deps.db = Object.assign(Object.create(w.db), { ref: (p) => { const r = realRef(p); if (failRemove && String(p) === `provider_token_deletes/${H('T-d3')}`) return Object.assign(Object.create(r), { remove: async () => { failRemove = false; throw Object.assign(new Error('remove failed'), { code: 'unavailable' }); } }); return r; } });
    await Q().drainProviderDeletes(w.deps).catch(() => null);
    assert.ok(w.item('T-d3') && w.item('T-d3').ok_at, 'premise: our 200 is recorded; the removal failed');
    await Q().drainProviderDeletes(w.deps);
    assert.strictEqual(w.item('T-d3'), null, `${L}: a 400 AFTER our own recorded 200 means «absent» ⇒ removed`);
  });
  await cell('TQ-DRAIN-403-STOPS', async (L) => {
    const w = world({ delete_token: [{ status: 403, success: false }, { status: 200, success: true }] }, { orders: { o_1: ORDER(), o_2: ORDER() } });
    await place(w, 'T-a', false); await place(w, 'T-b', false, { oid: 'o_2', att: 'att_tq_b_000000000002' }); await finish(w, 'o_1'); await finish(w, 'o_2');
    await Q().drainProviderDeletes(w.deps);
    assert.strictEqual(deletes(w).length, 1, `${L}: a 401/403 STOPS the whole drain (no second call)`);
    assert.ok(w.item('T-a') && w.item('T-b'), `${L}: both items stay`);
    assert.ok(alerts(w).some((a) => a.type === 'payment_sdk_provider_delete_auth'), `${L}: one auth alert`);
  });
  await cell('TQ-DRAIN-TIMEOUT', async (L) => {
    const w = world({ delete_token: [{ throw: true }] }); await place(w, 'T-d4', false); await finish(w);
    await Q().drainProviderDeletes(w.deps);
    assert.ok(w.item('T-d4') && w.item('T-d4').tries === 1, `${L}: a transport failure is UNKNOWN — retried later, the item stays`);
  });
  await cell('TQ-DRAIN-INERT-OFF', async (L) => {
    const w = world({}, { namespace: 'unconfigured' }); await place(w, 'T-off', false); await finish(w);
    const r = await Q().drainProviderDeletes(w.deps);
    assert.strictEqual(deletes(w).length, 0, `${L}: SDK config off ⇒ NO provider call`);
    assert.ok(w.item('T-off'), `${L}: the item stays queued`);
    assert.ok(alerts(w).some((a) => a.type === 'payment_sdk_provider_delete_unconfigured'), `${L}: and items-while-unconfigured is alerted`);
    assert.ok(r && r.inert === true, `${L}: reported inert`);
  });
  await cell('TQ-DRAIN-FAIR', async (L) => {
    const w = world({ delete_token: [{ status: 400, success: false }, { status: 200, success: true }, { status: 400, success: false }, { status: 200, success: true }] }, { orders: { o_1: ORDER(), o_2: ORDER() } });
    await place(w, 'T-x', false); await place(w, 'T-y', false, { oid: 'o_2', att: 'att_tq_y_000000000002' }); await finish(w, 'o_1'); await finish(w, 'o_2');
    const [first] = [H('T-x'), H('T-y')].sort();
    for (let i = 0; i < 2; i++) await Q().drainProviderDeletes(w.deps, { batch: 1 });
    const second = first === H('T-x') ? 'T-y' : 'T-x';
    assert.strictEqual(w.item(second), null, `${L}: the entry behind a failing one is reached within a bounded number of runs (rotating cursor)`);
  });
  await cell('TQ-NO-PII-IN-LOGS', async (L) => {
    const w = world({ delete_token: [{ status: 400, success: false }] }); await place(w, 'T-pii-xyz', false); await finish(w);
    await Q().drainProviderDeletes(w.deps);
    const blob = JSON.stringify([w.logs, alerts(w)]);
    assert.ok(!blob.includes('T-pii-xyz') && !blob.includes(H('T-pii-xyz')) && !blob.includes('uid_A'), `${L}: no token, hash or uid in any log or alert`);
  });
  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\ntoken-queue: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { process.stderr.write(`token-queue: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
