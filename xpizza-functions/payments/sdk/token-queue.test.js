'use strict';
// card-cleanup (owner UNPARKED 11-18; PLAN-card-token-cleanup «PLAN DELTA» (1)–(7)) — a card token PixelPay keeps alive (Q3: a token used
// for a payment and voided STAYS) is NEVER dropped without its provider-delete handle: every removal of payment_sdk_tokens/{oid} ENQUEUES
// each ONE-OFF token at provider_token_deletes/{hash} in the SAME multi-path update (PLAN DELTA r2, rule 6c: a saved-card token is never
// shared out of the order path — it leaves via card removal / the account fence); the drain deletes by the probe rule, ONLY in production. Real coordinator + sweeper + cards on the honest RTDB
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
const T = require('./record-token');
const SW = require('./sweeper');
const Q = () => require('./token-queue');
const T0 = 1_800_000_000_000;
const H = (t) => crypto.createHash('sha256').update(t).digest('hex');
const DISP = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 };
const ORDER = (o = {}) => ({ payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', restaurant_id: 'tq_rest', customer_uid: 'uid_A', customer_name: 'Ana', total_cents: 100, pay_deadline_at: T0 + 900000, ...o });
const world = (script = {}, { hooks = {}, orders = { o_1: ORDER() }, mode = 'production', namespace = 'prod', logs = [] } = {}) => {
  const db = makeHonestDb({ orders }, { now: () => T0, ...hooks });
  const fake = makeFakePsp(script);
  const deps = { db, psp: makeAdapter(fake.impl), clock: () => T0, voidEligible: () => false, ppMode: mode, ppNamespace: namespace, goLive: async () => {}, verifyIdToken: async () => ({ uid: 'uid_A' }), log: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) } };
  return { db, fake, deps, logs, node: (o = 'o_1') => db.getAt(`payment_sdk_tokens/${o}`), item: (t) => db.getAt(`provider_token_deletes/${H(t)}`), queue: () => db.getAt('provider_token_deletes') };
};
const TK = (n) => `T-${n}-00000000`;   // a VALID provider token (≥ 8 chars, [A-Za-z0-9-]) — the fake refuses anything else, as production does
const card = (save, ref = 'new') => ({ card_ref: ref, display: DISP, save, vault_gen: 0 });
const place = async (w, tok, save, { oid = 'o_1', att = 'att_tq_place_00000001', ref } = {}) => {
  const p = await C.placeOriginal(w.deps, { orderId: oid, attempt_id: att, token: tok, amount_cents: 100, card: card(save, ref) });
  assert.strictEqual(p.outcome, 'placed', `premise: placed (${p.outcome})`);
};
const finish = async (w, oid = 'o_1') => { await w.db.ref(`orders/${oid}/status`).set('delivered'); await SW.visitDueOrder(w.deps, oid); };
const deletes = (w) => w.fake.calls.filter((c) => c.action === 'delete_token');
const alerts = (w) => Object.values(w.db.getAt('dispatcher_alerts') || {});
const savedCardOf = async (w, tok) => {   // a saved card made by the REAL vault writer
  assert.strictEqual((await K.completeVault(w.deps, { uid: 'uid_A', token: tok, token_hash: H(tok), display: DISP, vault_gen: 0 })).outcome, 'created', 'premise: the real vault saved the card');
  return Object.keys(w.db.getAt('customer_cards/uid_A/cards'))[0];
};

(async () => {
  // (1) the null ENQUEUES a ONE-OFF token then drops, in ONE update — never a bare drop
  await cell('TQ-NULL-ENQUEUE', async (L) => {
    const w = world(); const t = TK('q1'); await place(w, t, false); await finish(w);
    assert.strictEqual(w.node(), null, 'premise: the null removed the node');
    const it = w.item(t);
    assert.ok(it && it.token === t, `${L}: the dropped one-off token is queued at provider_token_deletes/{hash}`);
    assert.deepStrictEqual(Object.keys(it.sources || {}), ['order_o_1'], `${L}: its source is the order`);
    assert.ok(it.sources.order_o_1.aid === 'att_tq_place_00000001' && it.sources.order_o_1.uid === 'uid_A', `${L}: the source names the attempt and the uid — nothing else`);
  });
  await cell('TQ-ATOMIC', async (L) => {
    let armed = false; const t = TK('q2');
    const w = world({}, { hooks: { beforeWrite: async (p, patch) => { if (armed && p === '' && patch && Object.keys(patch).some((k) => k.startsWith('provider_token_deletes/'))) throw Object.assign(new Error('update failed'), { code: 'unavailable' }); } } });
    await place(w, t, false); await w.db.ref('orders/o_1/status').set('delivered'); await C.settleTerminal(w.deps, { orderId: 'o_1' });
    armed = true;
    await K.nullSpentToken(w.deps, 'o_1').catch(() => null);
    assert.ok(w.node() && w.node().att_tq_place_00000001 && w.node().att_tq_place_00000001.t === t, `${L}: a failed enqueue-and-drop update leaves the node (the handle) in place`);
    assert.strictEqual(w.queue(), null, `${L}: and queues nothing (one atomic update)`);
    armed = false;
    await K.nullSpentToken(w.deps, 'o_1');
    assert.ok(w.node() == null && w.item(t), `${L}: a retry completes both`);
  });
  // a write-ahead whose claim LOST (a real cancel before the claim CAS) — the client still tokenized it → queued, never a bare drop
  await cell('TQ-ORPHAN-ENQUEUE', async (L) => {
    let n = 0; let w = null; const t = TK('q3');
    // the drain is gated OFF here (unconfigured: deps' real { ppMode 'off', ppNamespace 'unconfigured' }), so the queued handle stays observable after the sweeper
    w = world({}, { mode: 'off', namespace: 'unconfigured', hooks: { beforeTx: async (p) => { if (String(p) === 'payment_sdk/o_1' && ++n === 2) await C.cancelSdkOrder(w.deps, { orderId: 'o_1' }); } } });
    const p = await C.placeOriginal(w.deps, { orderId: 'o_1', attempt_id: 'att_tq_orphan_0000001', token: t, amount_cents: 100, card: card(false) });
    assert.ok(p.outcome !== 'placed' && w.node(), `premise: an orphan write-ahead (${p.outcome})`);
    await SW.sweepSdkPayments(w.deps);
    assert.ok(w.node() == null && w.item(t), `${L}: the orphan walk enqueues-and-drops a one-off write-ahead`);
  });
  // a SAVED-CARD token never leaves through the order path — its handle lives in customer_cards (card removal / the fence enqueue it)
  await cell('TQ-ORPHAN-SAVED', async (L) => {
    let n = 0; let w = null; const t = TK('qs');
    w = world({}, { mode: 'off', namespace: 'unconfigured', hooks: { beforeTx: async (p) => { if (String(p) === 'payment_sdk/o_1' && ++n === 2) await C.cancelSdkOrder(w.deps, { orderId: 'o_1' }); } } });
    const id = await savedCardOf(w, t); n = 0;
    const p = await C.placeOriginal(w.deps, { orderId: 'o_1', attempt_id: 'att_tq_orphansv_00001', token: t, amount_cents: 100, card: card(false, `saved:${id}`) });
    assert.ok(p.outcome !== 'placed' && w.node() && w.node().att_tq_orphansv_00001.uid === 'uid_A', `premise: an orphan saved-card write-ahead, the uid recorded WITH the token (${p.outcome})`);
    await SW.sweepSdkPayments(w.deps);
    assert.ok(w.node() == null && w.queue() == null, `${L}: the walk drops the order copy of a saved-card token WITHOUT queueing it`);
    assert.ok(await K.resolveSavedCard(w.deps, 'uid_A', id), `${L}: the saved card still charges`);
  });
  // with NO order record (purged), the uid stored WITH the token keeps the saved-card check (r3)
  await cell('TQ-NO-UID-SAVED', async (L) => {
    let n = 0; let w = null; const t = TK('qn');
    w = world({}, { mode: 'off', namespace: 'unconfigured', hooks: { beforeTx: async (p) => { if (String(p) === 'payment_sdk/o_1' && ++n === 2) await C.cancelSdkOrder(w.deps, { orderId: 'o_1' }); } } });
    const id = await savedCardOf(w, t); n = 0;
    const p = await C.placeOriginal(w.deps, { orderId: 'o_1', attempt_id: 'att_tq_nouid_00000001', token: t, amount_cents: 100, card: card(false, `saved:${id}`) });
    assert.ok(p.outcome !== 'placed' && w.node(), `premise: an orphan saved-card write-ahead (${p.outcome})`);
    await w.db.ref('orders/o_1').remove();
    await K.nullSpentToken(w.deps, 'o_1');
    assert.ok(w.node() == null && w.queue() == null, `${L}: the order gone, a saved card's write-ahead is dropped WITHOUT queueing (the node's uid finds the saved card)`);
    assert.ok(await K.resolveSavedCard(w.deps, 'uid_A', id), `${L}: the saved card still charges`);
  });
  await cell('TQ-NO-UID-VAULTED', async (L) => {
    let armed = false; const t = TK('qw');
    const w = world({}, { hooks: { beforeWrite: async (p, patch) => { if (armed && p === '' && patch && Object.keys(patch).some((k) => k.startsWith('payment_sdk_tokens/'))) throw Object.assign(new Error('update failed'), { code: 'unavailable' }); } } });
    await place(w, t, true); await w.db.ref('orders/o_1/status').set('delivered'); await C.settleTerminal(w.deps, { orderId: 'o_1' });
    await K.completeVaultForOrder(w.deps, 'o_1');
    assert.strictEqual(w.db.getAt('payment_sdk/o_1/vault/state'), 'done', 'premise: the vault saved the card');
    armed = true; await K.nullSpentToken(w.deps, 'o_1').catch(() => null); armed = false;   // the pointer drop commits; the node update fails
    assert.ok(w.node() && !w.db.getAt('payment_sdk/o_1/token_attempt'), 'premise: pointer dropped, node left (a crash between the two)');
    await w.db.ref('orders/o_1').remove();
    await K.nullSpentToken(w.deps, 'o_1');
    assert.ok(w.node() == null && w.queue() == null, `${L}: the order gone, the token the vault saved is dropped WITHOUT queueing (the node's uid finds the saved card)`);
    const id = Object.keys(w.db.getAt('customer_cards/uid_A/cards'))[0];
    assert.ok(await K.resolveSavedCard(w.deps, 'uid_A', id), `${L}: the saved card still charges`);
  });
  // Codex #169 (1): the purged-order retry — a SAVED token re-submitted as «new»; the uid travels WITH the token, so by_hash still decides
  await cell('TQ-NO-UID-RESUBMITTED-SAVED', async (L) => {
    let armed = false; const t = TK('qx');
    const w = world({}, { hooks: { beforeWrite: async (p, patch) => { if (armed && p === '' && patch && Object.keys(patch).some((k) => k.startsWith('payment_sdk_tokens/'))) throw Object.assign(new Error('update failed'), { code: 'unavailable' }); } } });
    const id = await savedCardOf(w, t);
    await place(w, t, false); await w.db.ref('orders/o_1/status').set('delivered'); await C.settleTerminal(w.deps, { orderId: 'o_1' });
    armed = true; await K.nullSpentToken(w.deps, 'o_1').catch(() => null); armed = false;
    assert.ok(w.node() && !w.db.getAt('payment_sdk/o_1/token_attempt'), 'premise: pointer dropped, node left (a crash between the two)');
    await w.db.ref('orders/o_1').remove();
    await K.nullSpentToken(w.deps, 'o_1');
    assert.ok(w.node() == null && w.queue() == null, `${L}: the order gone, a «new» token that IS a live saved card of the order's uid is not queued`);
    assert.ok(await K.resolveSavedCard(w.deps, 'uid_A', id), `${L}: the saved card still charges`);
  });
  // Codex #169 (2): two tokens on ONE attempt id — X won and was vaulted; a delayed Y stashes at the emptied node. Only X is excluded.
  await cell('TQ-SAME-AID-TWO-TOKENS', async (L) => {
    const w = world(); const x = TK('qa'); const y = TK('qb'); const A = 'att_tq_place_00000001';
    await place(w, x, true, { att: A }); await finish(w);
    assert.ok(w.db.getAt('payment_sdk/o_1/vault/state') === 'done' && w.node() == null && w.queue() == null, 'premise: X vaulted, its node dropped, nothing queued');
    assert.strictEqual(await T.stashToken(w.db, 'o_1', A, y, 'uid_A'), 'ok', 'premise: the delayed Y lands at the emptied attempt node (the real writer)');
    await K.nullSpentToken(w.deps, 'o_1');
    assert.ok(w.node() == null && w.item(y) && w.item(y).token === y, `${L}: the one-off Y at the vaulted attempt id is QUEUED (only the vaulted token itself is excluded)`);
    assert.strictEqual(w.item(x), null, `${L}: and the vaulted X is not`);
  });
  await cell('TQ-SAVED-VAULTED', async (L) => {
    const w = world(); const t = TK('qv'); await place(w, t, true); await finish(w);
    assert.ok(w.db.getAt('payment_sdk/o_1/vault/state') === 'done' && Object.keys(w.db.getAt('customer_cards/uid_A/cards') || {}).length === 1, 'premise: the vault saved the card');
    assert.ok(w.node() == null && w.queue() == null, `${L}: a token the vault saved is NOT queued (the saved card keeps it)`);
    const id = Object.keys(w.db.getAt('customer_cards/uid_A/cards'))[0];
    assert.ok(await K.resolveSavedCard(w.deps, 'uid_A', id), `${L}: the saved card still charges`);
  });
  await cell('TQ-SAVED-CARD-ORDER', async (L) => {
    const w = world(); const t = TK('qc'); const id = await savedCardOf(w, t);
    await place(w, t, false, { ref: `saved:${id}` }); await finish(w);
    assert.ok(w.node() == null && w.queue() == null, `${L}: an order paid WITH a saved card never queues the saved token`);
  });
  await cell('TQ-RESUBMITTED-SAVED-TOKEN', async (L) => {
    const w = world(); const t = TK('qr'); await savedCardOf(w, t);
    await place(w, t, false); await finish(w);   // a client re-submits, as «new», a token it once saved
    assert.ok(w.node() == null && w.queue() == null, `${L}: a «new» token that IS a live saved card of the uid is not queued (deleting it would kill the saved card)`);
  });
  // (3) the drain, by the probe rule
  await cell('TQ-DRAIN-200', async (L) => {
    const w = world({ delete_token: [{ status: 200, success: true }] }); await place(w, TK('d1'), false); await finish(w);
    const r = await Q().drainProviderDeletes(w.deps);
    assert.ok(deletes(w).length === 1 && deletes(w)[0].token === TK('d1'), `${L}: the provider delete is called with the queued token`);
    assert.strictEqual(w.item(TK('d1')), null, `${L}: 200 ⇒ done, the item is removed`);
    assert.ok(r && r.done === 1, `${L}: counted (${JSON.stringify(r)})`);
  });
  await cell('TQ-DRAIN-400-FIRST', async (L) => {
    const w = world({ delete_token: [{ status: 400, success: false }] }); await place(w, TK('d2'), false); await finish(w);
    await Q().drainProviderDeletes(w.deps);
    const it = w.item(TK('d2'));
    assert.ok(it && it.tries === 1 && !it.ok_at, `${L}: a 400 on the FIRST try is UNKNOWN — the item stays (counted)`);
    assert.ok(alerts(w).some((a) => a.type === 'payment_sdk_provider_delete_unknown'), `${L}: and alerts (fixed code)`);
  });
  await cell('TQ-DRAIN-400-AFTER-OUR-200', async (L) => {
    // the model's remove() runs no hook, so the failing removal is injected on the drain's own db handle: after OUR 200 is recorded, the
    // item's removal throws once (a crash between the two writes)
    let failRemove = true;
    const w = world({ delete_token: [{ status: 200, success: true }, { status: 400, success: false }] });
    await place(w, TK('d3'), false); await finish(w);
    const realRef = w.db.ref.bind(w.db);
    w.deps.db = Object.assign(Object.create(w.db), { ref: (p) => { const r = realRef(p); if (failRemove && String(p) === `provider_token_deletes/${H(TK('d3'))}`) return Object.assign(Object.create(r), { remove: async () => { failRemove = false; throw Object.assign(new Error('remove failed'), { code: 'unavailable' }); } }); return r; } });
    await Q().drainProviderDeletes(w.deps).catch(() => null);
    assert.ok(w.item(TK('d3')) && w.item(TK('d3')).ok_at, 'premise: our 200 is recorded; the removal failed');
    await Q().drainProviderDeletes(w.deps);
    assert.strictEqual(w.item(TK('d3')), null, `${L}: a 400 AFTER our own recorded 200 means «absent» ⇒ removed`);
  });
  await cell('TQ-DRAIN-403-STOPS', async (L) => {
    const w = world({ delete_token: [{ status: 403, success: false }, { status: 200, success: true }] }, { orders: { o_1: ORDER(), o_2: ORDER() } });
    await place(w, TK('a'), false); await place(w, TK('b'), false, { oid: 'o_2', att: 'att_tq_b_000000000002' }); await finish(w, 'o_1'); await finish(w, 'o_2');
    await Q().drainProviderDeletes(w.deps);
    assert.strictEqual(deletes(w).length, 1, `${L}: a 401/403 STOPS the whole drain (no second call)`);
    assert.ok(w.item(TK('a')) && w.item(TK('b')), `${L}: both items stay`);
    assert.ok(alerts(w).some((a) => a.type === 'payment_sdk_provider_delete_auth'), `${L}: one auth alert`);
  });
  await cell('TQ-DRAIN-TIMEOUT', async (L) => {
    const w = world({ delete_token: [{ throw: true }] }); await place(w, TK('d4'), false); await finish(w);
    await Q().drainProviderDeletes(w.deps);
    assert.ok(w.item(TK('d4')) && w.item(TK('d4')).tries === 1, `${L}: a transport failure is UNKNOWN — retried later, the item stays`);
  });
  // (C) the drain deletes ONLY under the parsed production config (mode 'production' AND namespace 'prod'); anything else is INERT
  await cell('TQ-DRAIN-GATE', async (L) => {
    for (const [mode, namespace] of [['sandbox', 'prod'], ['production', 'staging'], ['production', 'sandbox']]) {
      const w = world({}, { mode, namespace }); await place(w, TK('gate'), false); await finish(w);
      const r = await Q().drainProviderDeletes(w.deps);
      assert.ok(deletes(w).length === 0 && w.item(TK('gate')) && r.inert === true, `${L}: mode ${mode} / namespace ${namespace} ⇒ NO provider call, the item stays`);
      assert.ok(alerts(w).some((x) => x.type === 'payment_sdk_provider_delete_unconfigured'), `${L}: items while not live are alerted (mode ${mode} / ${namespace})`);
    }
  });
  await cell('TQ-DRAIN-INERT-OFF', async (L) => {
    const w = world({}, { mode: 'off', namespace: 'unconfigured' }); await place(w, TK('off'), false); await finish(w);
    const r = await Q().drainProviderDeletes(w.deps);
    assert.strictEqual(deletes(w).length, 0, `${L}: SDK config off ⇒ NO provider call`);
    assert.ok(w.item(TK('off')), `${L}: the item stays queued`);
    assert.ok(alerts(w).some((a) => a.type === 'payment_sdk_provider_delete_unconfigured'), `${L}: and items-while-unconfigured is alerted`);
    assert.ok(r && r.inert === true, `${L}: reported inert`);
  });
  await cell('TQ-DRAIN-FAIR', async (L) => {
    const w = world({ delete_token: [{ status: 400, success: false }, { status: 200, success: true }, { status: 400, success: false }, { status: 200, success: true }] }, { orders: { o_1: ORDER(), o_2: ORDER() } });
    await place(w, TK('x'), false); await place(w, TK('y'), false, { oid: 'o_2', att: 'att_tq_y_000000000002' }); await finish(w, 'o_1'); await finish(w, 'o_2');
    const [first] = [H(TK('x')), H(TK('y'))].sort();
    for (let i = 0; i < 2; i++) await Q().drainProviderDeletes(w.deps, { batch: 1 });
    const second = first === H(TK('x')) ? TK('y') : TK('x');
    assert.strictEqual(w.item(second), null, `${L}: the entry behind a failing one is reached within a bounded number of runs (rotating cursor)`);
  });
  // (D) the fake refuses exactly what production refuses (one shared token check)
  await cell('TQ-FAKE-PARITY', async (L) => {
    const w = world();
    await assert.rejects(() => w.fake.impl.pspDeleteToken({ token: 'short' }), `${L}: the fake refuses a token production's check refuses`);
    assert.deepStrictEqual(await w.deps.psp.pspDeleteToken({ token: 'bad/../x' }), { status: 0, success: false }, `${L}: through the adapter that is UNKNOWN (status 0), as in production`);
  });
  await cell('TQ-NO-PII-IN-LOGS', async (L) => {
    const w = world({ delete_token: [{ status: 400, success: false }] }); await place(w, TK('pii-xyz'), false); await finish(w);
    await Q().drainProviderDeletes(w.deps);
    const blob = JSON.stringify([w.logs, alerts(w)]);
    assert.ok(!blob.includes(TK('pii-xyz')) && !blob.includes(H(TK('pii-xyz'))) && !blob.includes('uid_A'), `${L}: no token, hash or uid in any log or alert`);
  });
  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\ntoken-queue: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { process.stderr.write(`token-queue: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
