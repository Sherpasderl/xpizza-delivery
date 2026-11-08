'use strict';
// SDK payment coordinator cells (BRIEF-sdk-payment-coordinator r5). Real coordinator + honest RTDB model + the fake PSP
// behind the real adapter contract. Every money cell asserts the provider calls BY ARGUMENT, the derived figures, the live
// holds and the open obligations. Failure messages start with the cell label. Run: node payments/sdk/coordinator.test.js
const assert = require('assert');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const { makeAdapter } = require('./psp-adapter');
const { makeFakePsp } = require('./fake-adapter');
const R = require('./record');
const C = () => require('./coordinator');

const OID = 'tb_sdk_1';
const TOKEN = 'T-tb-token';
const order = (o = {}) => ({ restaurant_id: 'tb_rest', payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', order_type: 'delivery', hub_lat: 14.1, hub_lng: -87.2, items: [{ name: 'tb_item', qty: 1, unit: 100 }], items_text: '1x tb_item', lat: 14.08, lng: -87.19, address_detected: 'tb calle 1', address_details: 'tb casa azul', customer_name: 'tb Cliente', customer_phone: '+50499990000', restaurant_name: 'tb R', restaurant_phone: '+50400000000', total: 100, total_cents: 10000, created_at: 1000, ...o });
// the order revision an adjustment commits with its payment decision (canonical items + totals)
const REV = (cents) => ({ items: [{ name: 'tb_item', qty: 1, unit: cents / 100 }], total_cents: cents, delivery_cents: 0 });
// the REAL go-live: confirmAndMaterialize through its explicit SDK admission (no refund wiring → a closed kitchen parks)
const realGoLive = (db, clock, extra = {}) => (dp, id) => require('../../pixelpay-confirm').confirmAndMaterialize({ db, buildMaterializeUpdates: require('../../materialize').buildMaterializeUpdates, restaurant: { lat: 14.1, lng: -87.2, name: 'tb R', phone: '+50400000000' }, ...extra }, { orderId: id, attemptId: null, now: clock(), trackingToken: 'TT-tb', sdkGoLive: true });
function world({ seed = {}, script = {}, hooks = {}, eligible = () => false, t0 = 100000, goLiveDeps = {} } = {}) {
  let t = t0;
  const db = makeHonestDb({ orders: { [OID]: order() }, ...seed }, { now: () => t, ...hooks });
  const fake = makeFakePsp(script);
  const deps = { db, psp: makeAdapter(fake.impl), clock: () => t, voidEligible: eligible, releaseResources: async () => { deps.released = (deps.released || 0) + 1; }, goLive: realGoLive(db, () => t, goLiveDeps) };
  return { db, fake, deps, rec: () => db.getAt(`payment_sdk/${OID}`), ord: () => db.getAt(`orders/${OID}`), tick: (ms) => { t += ms; }, at: () => t };
}
const legs = (rec) => Object.values((rec && rec.legs) || {});
const alerts = (db) => Object.values(db.getAt('dispatcher_alerts') || {});

let pass = 0; const fails = []; const w0 = {};
async function cell(name, fn) { try { await fn(name); console.log(`  ✓ ${name}`); pass++; } catch (e) { fails.push(name); console.log(`  ✗ ${name}: ${String((e && e.message) || e).split('\n')[0]}`); } }

(async () => {
  // ── placement ──
  await cell('SDK-PLACE-APPROVED', async (L) => {
    const w = world();
    const r = await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(r.outcome, 'placed', `${L}: placed (got ${JSON.stringify(r)})`);
    assert.deepStrictEqual(w.fake.calls.map((c) => [c.action, c.token, c.amount_cents]), [['authorize', TOKEN, 10000]], `${L}: ONE authorize with the token + the SERVER amount`);
    assert.ok(/^tb_sdk_1:L1:auth:/.test(w.fake.calls[0].op_id), `${L}: the call carries the journaled op_id`);
    const rec = w.rec();
    assert.ok(legs(rec).length === 1 && legs(rec)[0].role === 'committed' && legs(rec)[0].state === 'approved', `${L}: L1 committed + approved`);
    assert.deepStrictEqual([rec.derived.committed_auth_total, rec.derived.captured_total, rec.derived.refund_liability, rec.derived.live_holds], [10000, 0, 0, 1], `${L}: derived`);
    assert.ok(w.ord().payment_placed && w.ord().payment_placed.leg_id === 'L1', `${L}: the go-live decision is recorded on the order`);
    assert.ok(w.db.getAt(`payment_sdk_due/${OID}`) != null, `${L}: enrolled in the due index`);
    assert.strictEqual(w.ord().payment_flow, 'sdk_auth_v1', `${L}: payment_flow preserved`);
  });
  await cell('SDK-PLACE-DECLINED', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'definitive_decline', code: '05' }] } });
    const r = await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(r.outcome, 'declined', `${L}: declined (got ${JSON.stringify(r)})`);
    assert.ok(legs(w.rec())[0].state === 'declined' && !w.rec().lock && !w.ord().payment_placed, `${L}: leg declined, no lock, not placed`);
  });
  await cell('SDK-PLACE-LOST-RESPONSE-LOCKS', async (L) => {
    const w = world({ script: { authorize: [{ lost: true }] } });
    const r = await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(r.outcome, 'unknown', `${L}: unknown (got ${JSON.stringify(r)})`);
    assert.ok(w.rec().lock && legs(w.rec())[0].state === 'unknown' && !w.ord().payment_placed, `${L}: locked, leg unknown, NOT placed`);
    const again = await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(again.outcome === 'refused' && w.fake.callCount('authorize') === 1, `${L}: a second placement is refused — still ONE authorize (got ${JSON.stringify(again)})`);
  });
  await cell('SDK-RECONCILE-NO-UUID-MANUAL', async (L) => {
    const w = world({ script: { authorize: [{ lost: true }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    w.tick(3 * 60 * 1000);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.strictEqual(w.rec().lock.reason, 'manual_reconciliation', `${L}: an unknown auth with NO uuid → manual_reconciliation (got ${JSON.stringify(w.rec().lock)})`);
    assert.ok(w.fake.callCount('status') === 0 && w.fake.callCount('authorize') === 1, `${L}: no status (no uuid), no retry`);
  });
  await cell('SDK-RECONCILE-BOUND-STATUS-RESOLVES', async (L) => {
    // approved with a mismatched amount → adapter says unknown WITH a uuid; status (bound, authorized) resolves it
    const w = world({ script: { authorize: [{ outcome: 'approved', uuid: 'P-77', amount_cents: 9999, effect: (st) => { st['P-77'] = { state: 'authorized', amount_cents: 10000 }; } }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(w.rec().lock, `${L}: PREMISE — locked on the mismatched answer`);
    w.tick(3 * 60 * 1000);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    const l1 = legs(w.rec())[0];
    assert.ok(!w.rec().lock && l1.state === 'approved' && l1.pp_uuid === 'P-77', `${L}: bound evidence resolves the op (got ${JSON.stringify({ lock: w.rec().lock, l1 })})`);
    assert.ok(w.fake.callCount('authorize') === 1 && w.fake.calls.filter((c) => c.action === 'status').every((c) => c.uuid === 'P-77'), `${L}: one authorize, status by uuid`);
  });
  await cell('SDK-RECONCILE-MISMATCHED-STATUS-KEEPS-LOCK', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'approved', uuid: 'P-78', amount_cents: 9999, effect: (st) => { st['P-78'] = { state: 'authorized', amount_cents: 9999 }; } }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    w.tick(3 * 60 * 1000);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.ok(w.rec().lock && legs(w.rec())[0].state === 'unknown', `${L}: evidence with another amount is NOT bound → lock kept (got ${JSON.stringify(w.rec().lock)})`);
  });

  // ── terminal settlement ──
  const placed = async (opts = {}) => { const w = world(opts); await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 }); return w; };
  await cell('SDK-TERMINAL-CAPTURES-ONCE-FULL', async (L) => {
    const w = await placed();
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    const r = await C().settleTerminal(w.deps, { orderId: OID });
    const caps = w.fake.calls.filter((c) => c.action === 'capture');
    assert.deepStrictEqual(caps.map((c) => [c.uuid, c.amount_cents]), [[legs(w.rec())[0].pp_uuid, 10000]], `${L}: ONE capture of L1 at its FULL amount (got ${JSON.stringify(caps)}; ${JSON.stringify(r)})`);
    assert.ok(w.ord().payment_terminal && w.rec().phase === 'frozen' && w.rec().frozen.capture_set.join() === 'L1', `${L}: payment_terminal written, frozen on {L1}`);
    assert.deepStrictEqual([w.rec().derived.captured_total, w.rec().derived.live_holds, Object.keys(w.rec().obligations || {}).length], [10000, 0, 0], `${L}: captured 10000, no live hold, no obligation`);
    assert.ok(R.isFinanciallyClosed(w.rec(), w.ord()), `${L}: financially closed`);
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.strictEqual(w.fake.callCount('capture'), 1, `${L}: idempotent — a second settle captures nothing`);
  });
  await cell('SDK-TERMINAL-COMPLETED-ALSO-SETTLES', async (L) => {
    const w = await placed();
    await w.db.ref(`orders/${OID}/status`).set('completed');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.strictEqual(w.fake.callCount('capture'), 1, `${L}: 'completed' (merchant handed) is terminal too`);
  });
  await cell('SDK-TERMINAL-NOT-TERMINAL-NOOP', async (L) => {
    const w = await placed();
    await w.db.ref(`orders/${OID}/status`).set('preparing');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.fake.callCount('capture') === 0 && !w.ord().payment_terminal && w.rec().phase === 'open', `${L}: a live order is not settled`);
  });
  await cell('SDK-TERMINAL-TRIGGER-SWEEPER-RACE-ONE-CAPTURE', async (L) => {
    let release; const gate = new Promise((r) => { release = r; });
    const w = await placed({ script: { capture: [{ pause: gate }] } });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    const a = C().settleTerminal(w.deps, { orderId: OID });   // the trigger — paused INSIDE the capture call
    await new Promise((r) => setTimeout(r, 20));
    const b = C().settleTerminal(w.deps, { orderId: OID });   // the sweeper, concurrently
    await new Promise((r) => setTimeout(r, 20));
    release(); await Promise.all([a, b]);
    assert.strictEqual(w.fake.callCount('capture'), 1, `${L}: exactly ONE capture call for L1 (got ${w.fake.callCount('capture')})`);
    assert.strictEqual(legs(w.rec())[0].state, 'captured', `${L}: captured once`);
  });
  await cell('SDK-LOST-CAPTURE-INCONCLUSIVE-KEEPS-LOCK', async (L) => {
    const w = await placed({ script: { capture: [{ lost: true }], status: [{ state: 'inconclusive' }] } });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.rec().lock, `${L}: PREMISE — the lost capture locks`);
    w.tick(3 * 60 * 1000);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.rec().lock && w.fake.callCount('capture') === 1, `${L}: inconclusive status → lock kept, NO second capture (got lock ${JSON.stringify(w.rec().lock)}, captures ${w.fake.callCount('capture')})`);
    assert.ok(!R.isFinanciallyClosed(w.rec(), w.ord()), `${L}: not closed`);
  });
  await cell('SDK-LOST-CAPTURE-BOUND-STATUS-CAPTURED', async (L) => {
    const w = await placed({ script: { capture: [{ lost: true }] } });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    w.tick(3 * 60 * 1000);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.ok(!w.rec().lock && legs(w.rec())[0].state === 'captured' && w.fake.callCount('capture') === 1, `${L}: the PSP did capture → status (bound, captured) resolves it; never a second capture`);
  });

  // ── adjustments (§2.10 via §4: proposal → order commit → projection) ──
  const committedIds = (rec) => Object.entries((rec && rec.legs) || {}).filter(([, l]) => l.role === 'committed').map(([id]) => id).sort();
  const deliver = async (w) => { await w.db.ref(`orders/${OID}/status`).set('delivered'); return C().settleTerminal(w.deps, { orderId: OID }); };
  const live = async (w) => { await w.db.ref(`orders/${OID}/status`).set('preparing'); };
  await cell('SDK-RULE4-UNDER-PRODUCTION-STUB', async (L) => {
    const w = await placed(); await live(w);
    const r = await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000, revision: REV(8000) });
    assert.strictEqual(r.outcome, 'rule4', `${L}: the production stub makes every leg ineligible → rule 4 (got ${JSON.stringify(r)})`);
    assert.ok(w.fake.callCount('authorize') === 1 && w.fake.callCount('void') === 0, `${L}: no auth B, no void`);
    const rec = w.rec();
    assert.deepStrictEqual([rec.fulfillment_total_cents, rec.derived.committed_auth_total, rec.derived.refund_liability], [8000, 10000, 2000], `${L}: fulfillment 8000, committed 10000, liability 2000 (derived)`);
    assert.ok(rec.rule4 && alerts(w.db).some((a) => a.type === 'payment_sdk_rule4'), `${L}: rule-4 flag + owner alert`);
    assert.ok(w.ord().payment_commit && w.ord().payment_commit.revision === 1 && rec.committed_revision === 1, `${L}: committed by the order transaction (revision 1) and projected`);
    assert.ok(!rec.obligations, `${L}: NO obligation before capture`);
    await deliver(w);
    assert.deepStrictEqual(w.fake.calls.filter((c) => c.action === 'capture').map((c) => c.amount_cents), [10000], `${L}: rule 4 captures the ORIGINAL amount once`);
    const obs = Object.entries(w.rec().obligations || {});
    assert.deepStrictEqual(obs.map(([id, o]) => [id, o.amount_cents, o.state]), [['refund_1', 2000, 'open']], `${L}: ONE refund obligation of 2000 opened after the capture (got ${JSON.stringify(obs)})`);
    assert.ok(!R.isFinanciallyClosed(w.rec(), w.ord()), `${L}: not closed while the obligation is open`);
    await C().openObligations(w.deps, OID);
    assert.strictEqual(Object.keys(w.rec().obligations).length, 1, `${L}: a re-run opens nothing new (deterministic id)`);
    await C().completeObligation(w.deps, { orderId: OID, obligationId: 'refund_1', state: 'verified', bank_ref: 'BANK-1' });
    assert.ok(R.isFinanciallyClosed(w.rec(), w.ord()), `${L}: verified → financially closed`);
  });
  await cell('SDK-100-80-90-NO-AUTH', async (L) => {
    const w = await placed(); await live(w);
    await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000, revision: REV(8000) });
    await C().recordConsent(w.deps, { orderId: OID, adjustment_id: 'adj1', new_total_cents: 9000 });
    const c = w.rec().consent;
    const r = await C().applyIncrease(w.deps, { orderId: OID, adjustment_id: 'adj1', order_revision: c.order_revision, new_total_cents: 9000, accept: true, revision: REV(9000) });
    assert.strictEqual(r.outcome, 'committed', `${L}: committed (got ${JSON.stringify(r)})`);
    assert.strictEqual(w.fake.callCount('authorize'), 1, `${L}: delta_needed 0 → NO delta auth`);
    assert.deepStrictEqual([w.rec().fulfillment_total_cents, w.rec().derived.refund_liability, w.rec().derived.delta_needed], [9000, 1000, 0], `${L}: the liability shrinks to 1000`);
    await deliver(w);
    assert.deepStrictEqual([w.fake.callCount('capture'), Object.values(w.rec().obligations).map((o) => o.amount_cents).join()], [1, '1000'], `${L}: one capture of 10000, one obligation of 1000`);
  });
  await cell('SDK-INCREASE-DELTA-AUTH', async (L) => {
    const w = await placed(); await live(w);
    await C().recordConsent(w.deps, { orderId: OID, adjustment_id: 'adj1', new_total_cents: 12500 });
    const c = w.rec().consent;
    assert.ok(c.expires_at - w.at() === C().CONSENT_WINDOW_MS && C().CONSENT_WINDOW_MS === 3 * 60 * 1000, `${L}: the consent window is the 3-minute constant (owner 11-07)`);
    const r = await C().applyIncrease(w.deps, { orderId: OID, adjustment_id: 'adj1', order_revision: c.order_revision, new_total_cents: 12500, accept: true, revision: REV(12500) });
    const auths = w.fake.calls.filter((c2) => c2.action === 'authorize');
    assert.deepStrictEqual(auths.map((a2) => [a2.token, a2.amount_cents]), [[TOKEN, 10000], [TOKEN, 2500]], `${L}: ONE delta auth for delta_needed 2500 with the token (got ${JSON.stringify(auths)}; ${JSON.stringify(r)})`);
    assert.deepStrictEqual(committedIds(w.rec()), ['L1', 'L2'], `${L}: the delta is committed WITH the original`);
    assert.deepStrictEqual([w.rec().fulfillment_total_cents, w.rec().derived.committed_auth_total, w.rec().derived.refund_liability], [12500, 12500, 0], `${L}: amounts`);
    await deliver(w);
    assert.deepStrictEqual(w.fake.calls.filter((x) => x.action === 'capture').map((x) => x.amount_cents).sort((x, y) => x - y), [2500, 10000], `${L}: each committed leg captured in full`);
  });
  await cell('SDK-CONSENT-WINDOW-AND-BINDING', async (L) => {
    const w = await placed(); await live(w);
    await C().recordConsent(w.deps, { orderId: OID, adjustment_id: 'adj1', new_total_cents: 12000 });
    const c = w.rec().consent;
    const bad = await C().applyIncrease(w.deps, { orderId: OID, adjustment_id: 'adj1', order_revision: c.order_revision + 1, new_total_cents: 12000, accept: true, revision: REV(12000) });
    assert.ok(bad.outcome === 'rejected' && w.fake.callCount('authorize') === 1, `${L}: a mismatched revision is rejected (got ${JSON.stringify(bad)})`);
    await C().recordConsent(w.deps, { orderId: OID, adjustment_id: 'adj2', new_total_cents: 12000 });
    w.tick(C().CONSENT_WINDOW_MS + 1);
    const late = await C().applyIncrease(w.deps, { orderId: OID, adjustment_id: 'adj2', order_revision: w.rec().consent.order_revision, new_total_cents: 12000, accept: true, revision: REV(12000) });
    assert.ok(late.outcome === 'rejected' && w.fake.callCount('authorize') === 1, `${L}: a LATE consent is rejected, no auth (got ${JSON.stringify(late)})`);
    await C().recordConsent(w.deps, { orderId: OID, adjustment_id: 'adj3', new_total_cents: 12000 });
    await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 9000, revision: REV(9000) });
    assert.strictEqual(w.rec().consent.state, 'expired', `${L}: a later edit invalidates a pending consent`);
  });
  await cell('SDK-DELTA-DECLINED-ORDER-UNCHANGED', async (L) => {
    const w = await placed({ script: { authorize: [{}, { outcome: 'definitive_decline', code: '51' }] } }); await live(w);
    await C().recordConsent(w.deps, { orderId: OID, adjustment_id: 'adj1', new_total_cents: 12000 });
    const r = await C().applyIncrease(w.deps, { orderId: OID, adjustment_id: 'adj1', order_revision: w.rec().consent.order_revision, new_total_cents: 12000, accept: true, revision: REV(12000) });
    assert.strictEqual(r.outcome, 'declined', `${L}: declined (got ${JSON.stringify(r)})`);
    assert.deepStrictEqual([committedIds(w.rec()).join(), w.rec().fulfillment_total_cents, w.rec().derived.refund_liability, (w.ord().payment_commit || {}).revision || 0], ['L1', 10000, 0, 0], `${L}: the order stays as it was, nothing to refund`);
  });
  // test-only injected eligibility: reach the replacement-B path (production stays fail-closed)
  const ELIGIBLE = () => true;
  const withDeltas = async (opts = {}) => {
    const w = await placed({ eligible: ELIGIBLE, ...opts }); await live(w);
    for (const [id, tot] of [['a1', 12000], ['a2', 13000]]) {
      await C().recordConsent(w.deps, { orderId: OID, adjustment_id: id, new_total_cents: tot });
      await C().applyIncrease(w.deps, { orderId: OID, adjustment_id: id, order_revision: w.rec().consent.order_revision, new_total_cents: tot, accept: true, revision: REV(tot) });
    }
    return w;
  };
  await cell('SDK-B-REPLACES-WHOLE-SET-NEVER-REVERTS', async (L) => {
    const w = await withDeltas({ script: { void: [{}, { outcome: 'refused' }, { lost: true }] } });
    assert.deepStrictEqual(committedIds(w.rec()), ['L1', 'L2', 'L3'], `${L}: PREMISE — original + 2 deltas committed (got ${committedIds(w.rec())})`);
    const r = await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 9000, revision: REV(9000) });
    assert.strictEqual(r.outcome, 'replaced', `${L}: replaced (got ${JSON.stringify(r)})`);
    const lastAuth = w.fake.calls.filter((c) => c.action === 'authorize').pop();
    assert.deepStrictEqual([lastAuth.token, lastAuth.amount_cents], [TOKEN, 9000], `${L}: ONE auth B for the new total`);
    assert.deepStrictEqual(committedIds(w.rec()), ['L4'], `${L}: B is the ONLY committed leg`);
    assert.deepStrictEqual(['L1', 'L2', 'L3'].map((id) => w.rec().legs[id].role), ['surplus', 'surplus', 'surplus'], `${L}: the WHOLE old set is surplus`);
    assert.strictEqual(w.fake.callCount('void'), 3, `${L}: each surplus leg voided once (one ok, one refused, one lost)`);
    w.tick(3 * 60 * 1000); await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.deepStrictEqual(committedIds(w.rec()), ['L4'], `${L}: a failed / unknown void NEVER restores S (got ${committedIds(w.rec())})`);
    await deliver(w);
    assert.deepStrictEqual(w.fake.calls.filter((c) => c.action === 'capture').map((c) => c.amount_cents), [9000], `${L}: only B is captured; surplus never`);
  });
  await cell('SDK-UNKNOWN-B-LIVE-BECOMES-SURPLUS', async (L) => {
    const w = await placed({ eligible: ELIGIBLE, script: { authorize: [{}, { lost: true, outcome: 'approved', uuid: 'P-B', amount_cents: 8000, effect: (st) => { st['P-B'] = { state: 'authorized', amount_cents: 8000 }; } }] } }); await live(w);
    const r = await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000, revision: REV(8000) });
    assert.strictEqual(r.outcome, 'unknown', `${L}: B unknown (got ${JSON.stringify(r)})`);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.ok(w.rec().lock && w.rec().lock.reason === 'manual_reconciliation', `${L}: no uuid for a lost B → manual (the lost-UUID lookup is §7.V)`);
    // the same with a uuid known (an amount-mismatched answer): status says live → B surplus, S committed
    const w2 = await placed({ eligible: ELIGIBLE, script: { authorize: [{}, { outcome: 'approved', uuid: 'P-B2', amount_cents: 1, effect: (st) => { st['P-B2'] = { state: 'authorized', amount_cents: 8000 }; } }] } }); await live(w2);
    await C().requestDecrease(w2.deps, { orderId: OID, new_total_cents: 8000, revision: REV(8000) });
    w2.tick(3 * 60 * 1000); await C().reconcileSdkOps(w2.deps, { orderId: OID });
    assert.deepStrictEqual([committedIds(w2.rec()).join(), w2.rec().legs.L2.role, w2.rec().legs.L2.state, w2.rec().fulfillment_total_cents], ['L1', 'surplus', 'approved', 10000], `${L}: B found live → SURPLUS; S stays committed; the total unchanged (got ${JSON.stringify(w2.rec().legs.L2)})`);
    await deliver(w2);
    assert.deepStrictEqual(w2.fake.calls.filter((c) => c.action === 'capture').map((c) => c.amount_cents), [10000], `${L}: only S captured`);
  });
  await cell('SDK-ADJUSTMENT-LOSES-TO-TERMINAL', async (L) => {
    let release; const gate = new Promise((r) => { release = r; });
    const w = await placed({ eligible: ELIGIBLE, script: { authorize: [{}, { pause: gate }] } }); await live(w);
    const adj = C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000, revision: REV(8000) });
    await new Promise((r) => setTimeout(r, 20));
    await w.db.ref(`orders/${OID}/status`).set('delivered');   // the driver's write never waits on payments
    release(); const r = await adj;
    assert.strictEqual(r.outcome, 'lost_to_order', `${L}: the adjustment lost the order decision (got ${JSON.stringify(r)})`);
    assert.deepStrictEqual([committedIds(w.rec()).join(), w.rec().legs.L2.role, (w.ord().payment_commit || {}).revision || 0], ['L1', 'surplus', 0], `${L}: B surplus, S committed, nothing committed on the order`);
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.deepStrictEqual([w.fake.calls.filter((c) => c.action === 'capture').map((c) => c.amount_cents).join(), Object.keys(w.rec().obligations || {}).length], ['10000', 0], `${L}: S captured; the lost decrease left no obligation`);
  });
  await cell('SDK-CRASH-AFTER-ORDER-COMMIT-RECOVERED', async (L) => {
    let armed = false; let thrown = false;
    const w = await placed({ eligible: ELIGIBLE, hooks: { beforeTx: async (p) => { if (p === `orders/${OID}` && armed === 'go') armed = 'crash'; else if (armed === 'crash' && p === `payment_sdk/${OID}` && !thrown) { thrown = true; throw new Error('crash after the order commit'); } } } }); await live(w);
    armed = 'go';
    await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000, revision: REV(8000) }).catch(() => {});
    assert.ok(thrown && w.ord().payment_commit && w.ord().payment_commit.revision === 1 && (w.rec().committed_revision || 0) === 0, `${L}: PREMISE — the order committed revision 1, the projection did not happen`);
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.deepStrictEqual([committedIds(w.rec()).join(), w.rec().committed_revision], ['L2', 1], `${L}: settle RECOVERS the committed proposal before freezing`);
    assert.deepStrictEqual(w.fake.calls.filter((c) => c.action === 'capture').map((c) => c.amount_cents), [8000], `${L}: B captured (the committed decision), not S`);
  });
  await cell('SDK-CRASH-BEFORE-ORDER-COMMIT-LOST', async (L) => {
    let thrown = false;
    const w = await placed({ eligible: ELIGIBLE, hooks: { beforeTx: async (p) => { if (p === `orders/${OID}` && w0.armed && !thrown) { thrown = true; throw new Error('crash before the order commit'); } } } }); await live(w);
    w0.armed = true;
    await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000, revision: REV(8000) }).catch(() => {});
    assert.ok(thrown && Object.keys(w.rec().proposals || {}).length === 1 && !w.ord().payment_commit, `${L}: PREMISE — proposal persisted, the order transaction never ran`);
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.deepStrictEqual([committedIds(w.rec()).join(), w.rec().legs.L2.role], ['L1', 'surplus'], `${L}: the LOST proposal's B is surplus; S captured`);
    assert.deepStrictEqual(w.fake.calls.filter((c) => c.action === 'capture').map((c) => c.amount_cents), [10000], `${L}: S captured once`);
  });
  // ── cancellation / TTL expiry (§8: win the order decision FIRST, then stop, recover, reconcile, classify, clean up) ──
  const pend = (w) => w;   // a pending_payment order (placement not decided)
  await cell('SDK-CANCEL-LIVE-ORDER', async (L) => {
    const w = await placed(); await live(w);
    const r = await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
    assert.strictEqual(r.outcome, 'cancelled', `${L}: cancelled (got ${JSON.stringify(r)})`);
    assert.ok(w.ord().status === 'cancelled' && w.ord().payment_cancel && w.ord().payment_cancel.kind === 'cancel', `${L}: the order decision (status + payment_cancel) committed`);
    assert.deepStrictEqual([w.rec().phase, w.rec().legs.L1.role, w.rec().legs.L1.state], ['cancelled', 'surplus', 'approved'], `${L}: the hold is SURPLUS, tracked (not voided under the stub)`);
    assert.deepStrictEqual([w.fake.callCount('void'), w.fake.callCount('capture'), w.deps.released], [0, 0, 1], `${L}: no void (production stub), no capture, released once`);
    assert.ok(!R.isFinanciallyClosed(w.rec(), w.ord()), `${L}: a live hold keeps it open until expiry is confirmed`);
  });
  await cell('SDK-CANCEL-LOSES-TO-TERMINAL', async (L) => {
    const w = await placed();
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    const r = await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
    assert.strictEqual(r.outcome, 'lost_to_terminal', `${L}: the terminal write won (got ${JSON.stringify(r)})`);
    assert.ok(!w.ord().payment_cancel && w.fake.callCount('capture') === 1 && !w.deps.released && w.rec().legs.L1.role === 'committed', `${L}: settled as terminal, nothing released or reclassified`);
  });
  await cell('SDK-TERMINAL-AFTER-COMMITTED-CANCEL', async (L) => {
    const w = await placed(); await live(w);
    await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
    await w.db.ref(`orders/${OID}/status`).set('delivered');   // an override AFTER the cancel decision
    const r = await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(r.outcome === 'manual' && w.fake.callCount('capture') === 0, `${L}: never captured automatically (got ${JSON.stringify(r)})`);
    assert.ok(w.rec().lock && w.rec().lock.reason === 'manual_reconciliation' && alerts(w.db).some((x) => x.type === 'payment_sdk_terminal_after_cancel'), `${L}: manual + alert`);
  });
  await cell('SDK-CANCEL-TERMINAL-AT-EACH-BOUNDARY', async (L) => {
    // a terminal write lands right AFTER the cancel's order decision (before stop / classify / cleanup)
    let fired = false;
    const w = await placed({ hooks: { beforeTx: async (p, api) => { if (p === `payment_sdk/${OID}` && api.getAt(`orders/${OID}/payment_cancel`) && !fired) { fired = true; api.setAt(`orders/${OID}/status`, 'delivered'); } } } }); await live(w);
    const r = await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
    assert.ok(fired && r.outcome === 'cancelled', `${L}: the cancel had already won (got ${JSON.stringify(r)})`);
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.fake.callCount('capture') === 0 && w.rec().legs.L1.role === 'surplus', `${L}: the later terminal write does not reopen money`);
  });
  await cell('SDK-EXPIRE-RESPECTS-TTL-AND-PLACEMENT', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'definitive_decline' }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    const early = await C().expirePending(w.deps, { orderId: OID });
    assert.ok(early.outcome === 'refused' && w.ord().status === 'pending_payment', `${L}: not before the TTL (got ${JSON.stringify(early)})`);
    w.tick(R.TTL_MS + 1);
    const r = await C().expirePending(w.deps, { orderId: OID });
    assert.ok(r.outcome === 'cancelled' && w.ord().status === 'cancelled' && w.ord().payment_cancel.kind === 'expire' && w.deps.released === 1, `${L}: expired after the TTL, released once (got ${JSON.stringify(r)})`);
    const w2 = await placed();
    w2.tick(R.TTL_MS + 1);
    const r2 = await C().expirePending(w2.deps, { orderId: OID });
    assert.ok(r2.outcome === 'refused' && !w2.ord().payment_cancel, `${L}: a PLACED order never expires (got ${JSON.stringify(r2)})`);
  });
  await cell('SDK-EXPIRE-LATE-APPROVAL-SURPLUS', async (L) => {
    let release; const gate = new Promise((r) => { release = r; });
    const w = world({ script: { authorize: [{ pause: gate }] } });
    const placing = C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    await new Promise((r) => setTimeout(r, 20));
    w.tick(R.TTL_MS + 1);
    const ex = await C().expirePending(w.deps, { orderId: OID });   // expiry while the auth is in flight
    release(); const pr = await placing;
    assert.strictEqual(pr.outcome, 'late_surplus', `${L}: the late approval cannot place the order (got ${JSON.stringify(pr)}; expiry ${JSON.stringify(ex)})`);
    await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'expire' });   // the sweeper's resume
    assert.deepStrictEqual([w.ord().status, w.rec().legs.L1.role, w.fake.callCount('capture')], ['cancelled', 'surplus', 0], `${L}: surplus, never captured`);
  });
  await cell('SDK-EXPIRE-NO-UUID-UNKNOWN-STILL-RELEASES', async (L) => {
    const w = world({ script: { authorize: [{ lost: true }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    w.tick(R.TTL_MS + 1);
    const r = await C().expirePending(w.deps, { orderId: OID });
    assert.ok(r.outcome === 'cancelled' && w.deps.released === 1, `${L}: cleanup proceeds (got ${JSON.stringify(r)})`);
    assert.ok(w.rec().lock && w.rec().lock.reason === 'manual_reconciliation' && !R.isFinanciallyClosed(w.rec(), w.ord()), `${L}: the unknown no-uuid auth stays locked for a person; not closed`);
  });
  await cell('SDK-TWO-EXPIRY-WORKERS-RELEASE-ONCE', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'definitive_decline' }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    w.tick(R.TTL_MS + 1);
    await Promise.all([C().expirePending(w.deps, { orderId: OID }), C().expirePending(w.deps, { orderId: OID })]);
    assert.strictEqual(w.deps.released, 1, `${L}: released exactly once (got ${w.deps.released})`);
  });
  await cell('SDK-CANCEL-STOPS-AN-IN-FLIGHT-ADJUSTMENT', async (L) => {
    // the decrease has read the order (live) and the record; the cancel decision lands before its auth is journaled
    let armed = false; let fired = false; let wRef = null;
    const w = await placed({ eligible: ELIGIBLE, hooks: { beforeTx: async (p, api) => {
      if (armed && !fired && p === `payment_sdk/${OID}` && api.getAt(`orders/${OID}/status`) === 'preparing' && !api.getAt(`orders/${OID}/payment_cancel`)) {
        fired = true; await C().cancelSdkOrder(wRef.deps, { orderId: OID, kind: 'cancel' });
      } } } });
    wRef = w; await live(w);
    armed = true;
    const r = await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000, revision: REV(8000) });
    assert.ok(fired, `${L}: PREMISE — the cancel landed inside the decrease`);
    assert.strictEqual(w.fake.callCount('authorize'), 1, `${L}: the cancelled order never gets the replacement auth (got ${w.fake.callCount('authorize')}; ${JSON.stringify(r)})`);
  });
  await cell('SDK-INTERRUPTED-CLEANUP-RESUMED', async (L) => {
    const w = await placed(); await live(w);
    let n = 0; w.deps.releaseResources = async () => { n += 1; if (n === 1) throw new Error('crash mid-cleanup'); };
    await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' }).catch(() => {});
    assert.ok(!(w.rec().cleanup && w.rec().cleanup.done_at), `${L}: PREMISE — cleanup not done`);
    w.tick(3 * 60 * 1000);
    await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
    assert.ok(n === 2 && w.rec().cleanup && w.rec().cleanup.done_at, `${L}: the resume finishes the cleanup (calls ${n})`);
  });
  await cell('SDK-PROD-VOID-ELIGIBILITY-FAILS-CLOSED', async (L) => {
    const { voidEligible } = require('./void-eligibility');
    const leg = { kind: 'original', amount_cents: 1, state: 'approved', created_at: Date.now(), hold_expires_at: Date.now() + R.HOLD_MS };
    for (const now of [0, leg.created_at, leg.created_at + 60 * 1000, leg.created_at + 23 * 3600 * 1000]) assert.strictEqual(voidEligible(leg, now), false, `${L}: the production rule is NOT eligible for any input until §7.V (now ${now})`);
    assert.strictEqual(require('./deps').productionDeps({}).voidEligible, voidEligible, `${L}: production deps use exactly that stub`);
  });
  await cell('SDK-NO-OBLIGATION-WHILE-CAPTURE-UNCONFIRMED', async (L) => {
    const w = await placed({ script: { capture: [{ lost: true }], status: [{ state: 'inconclusive' }] } }); await live(w);
    await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 7000, revision: REV(7000) });
    await deliver(w);
    assert.ok(w.rec().lock && w.rec().legs.L1.state === 'approved', `${L}: PREMISE — the capture is unconfirmed (locked)`);
    await C().openObligations(w.deps, OID);
    assert.ok(!w.rec().obligations, `${L}: no refund obligation opens before the LAST confirmed capture (got ${JSON.stringify(w.rec().obligations)})`);
  });
  // ── the durable sweeper + due index (§5) ──
  const SW = () => require('./sweeper');
  const due = (w, id = OID) => w.db.getAt(`payment_sdk_due/${id}`);
  await cell('SDK-SWEEP-SETTLES-MISSING-TRIGGER-THEN-REMOVES', async (L) => {
    const w = await placed();
    await w.db.ref(`orders/${OID}/status`).set('delivered');   // the trigger never ran
    w.tick(60 * 1000);
    await SW().sweepSdkPayments(w.deps);
    assert.ok(w.fake.callCount('capture') === 1 && w.rec().legs.L1.state === 'captured', `${L}: found on the due visit and settled (captures ${w.fake.callCount('capture')})`);
    assert.ok(due(w) != null, `${L}: the capture's own enrol (newer work) is not erased by the same visit`);
    w.tick(SW().REVISIT_MS + 1);
    await SW().sweepSdkPayments(w.deps);
    assert.strictEqual(due(w), null, `${L}: financially closed → removed on the next visit (got ${due(w)})`);
  });
  await cell('SDK-SWEEP-OVERLAPPING-ONE-CAPTURE', async (L) => {
    const w = await placed();
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    w.tick(60 * 1000);
    await Promise.all([SW().sweepSdkPayments(w.deps), SW().sweepSdkPayments(w.deps), C().settleTerminal(w.deps, { orderId: OID })]);
    assert.strictEqual(w.fake.callCount('capture'), 1, `${L}: exactly one capture (got ${w.fake.callCount('capture')})`);
  });
  await cell('SDK-SWEEP-NO-STARVATION-60-UNKNOWNS', async (L) => {
    const ids = Array.from({ length: 60 }, (_, i) => `tb_lock_${String(i).padStart(2, '0')}`);
    const orders = Object.fromEntries(ids.map((id) => [id, order()]));
    const w = world({ seed: { orders }, script: { authorize: ids.map(() => ({ lost: true })) } });
    for (const id of ids) await C().placeOriginal(w.deps, { orderId: id, token: TOKEN, amount_cents: 1000 });
    w.tick(3 * 60 * 1000);
    const t = w.at();
    await SW().sweepSdkPayments(w.deps);
    await SW().sweepSdkPayments(w.deps);
    const visited = ids.filter((id) => due(w, id) > t);
    assert.strictEqual(visited.length, 60, `${L}: every one of 60 persistent unknowns visited within two passes (got ${visited.length})`);
    assert.ok(ids.every((id) => w.db.getAt(`payment_sdk/${id}/lock/reason`) === 'manual_reconciliation'), `${L}: and each stays locked for a person`);
  });
  await cell('SDK-SWEEP-REMOVAL-NEVER-ERASES-NEWER-ENROL', async (L) => {
    let n = 0;
    const w = await placed({ hooks: { beforeTx: async (p, api) => { if (p === `payment_sdk_due/${OID}` && ++n === 2) api.setAt(`payment_sdk_due/${OID}`, 1); } } });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    w.tick(60 * 1000);
    await SW().sweepSdkPayments(w.deps);
    assert.strictEqual(due(w), 1, `${L}: a newer enrol landing between the visit and the removal survives (got ${due(w)})`);
  });
  await cell('SDK-SWEEP-EXPIRES-PENDING-TTL', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'definitive_decline' }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    w.tick(R.TTL_MS + 1);
    await SW().sweepSdkPayments(w.deps);
    assert.ok(w.ord().status === 'cancelled' && w.ord().payment_cancel.kind === 'expire' && w.deps.released === 1, `${L}: expired by the sweeper, released once`);
  });
  await cell('SDK-SWEEP-SURPLUS-EXPIRY-CONFIRMED', async (L) => {
    const w = await placed(); await live(w);
    await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
    const uuid = w.rec().legs.L1.pp_uuid;
    w.tick(R.HOLD_MS + 1);
    await SW().sweepSdkPayments(w.deps);
    assert.ok(w.rec().legs.L1.state === 'approved' && due(w) != null, `${L}: unconfirmed expiry → not closed, still tracked`);
    w.tick(24 * 3600 * 1000);
    await SW().sweepSdkPayments(w.deps);
    assert.ok(alerts(w.db).some((x) => x.type === 'payment_sdk_surplus_unconfirmed'), `${L}: at 16 days an unconfirmed surplus hold alerts`);
    w.fake.state[uuid].state = 'expired';
    w.tick(10 * 60 * 1000);
    await SW().sweepSdkPayments(w.deps);
    w.tick(10 * 60 * 1000);
    await SW().sweepSdkPayments(w.deps);
    assert.ok(w.rec().legs.L1.state === 'expired' && due(w) === null, `${L}: a CONFIRMED expiry closes it and removes the due entry (leg ${w.rec().legs.L1.state}, due ${due(w)})`);
  });
  await cell('SDK-CLOSURE-EMPTY-SET-UNKNOWN-STAYS', async (L) => {
    const w = world({ script: { authorize: [{ lost: true }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.deepStrictEqual(w.rec().frozen && w.rec().frozen.capture_set, undefined, `${L}: PREMISE — an empty capture set`);
    w.tick(3 * 60 * 1000);
    await SW().sweepSdkPayments(w.deps); await SW().sweepSdkPayments(w.deps);
    assert.ok(!R.isFinanciallyClosed(w.rec(), w.ord()) && due(w) != null && w.rec().lock, `${L}: an unknown no-uuid auth keeps it open, locked and discoverable`);
  });
  await cell('SDK-ENROL-FAILURE-REFUSES', async (L) => {
    const w = world({ hooks: { beforeWrite: async (p) => { if (p === `payment_sdk_due/${OID}`) throw new Error('enrol write failed'); } } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 }).catch(() => {});
    assert.ok(w.fake.callCount('authorize') === 0 && !(w.rec() && w.rec().ops), `${L}: no enrol → nothing journaled, no PSP call`);
  });
  // ── Codex r1 → r2 cells ──
  const caps = (w) => w.fake.calls.filter((c) => c.action === 'capture');
  const CLOSED = { sun: { open: false }, mon: { open: false }, tue: { open: false }, wed: { open: false }, thu: { open: false }, fri: { open: false }, sat: { open: false } };
  // #9 go-live: the approved original makes the order live through the shared materialization, admitted for SDK only
  await cell('SDK-GOLIVE-PLACED-MATERIALIZES', async (L) => {
    const w = await placed();
    const o = w.ord();
    assert.ok(o.status === 'new' && o.materialized_at && o.payment_status === 'confirmed' && o.tracking_token === 'TT-tb', `${L}: the placed order went live (got ${JSON.stringify({ status: o.status, m: o.materialized_at, ps: o.payment_status })})`);
    assert.deepStrictEqual([w.fake.callCount('capture'), w.fake.callCount('void'), w.rec().legs.L1.state], [0, 0, 'approved'], `${L}: going live moves no money`);
  });
  await cell('SDK-GOLIVE-OTHER-CALLERS-STILL-REFUSE', async (L) => {
    const CM = require('../../pixelpay-confirm').confirmAndMaterialize;
    const md = (db) => ({ db, buildMaterializeUpdates: require('../../materialize').buildMaterializeUpdates, restaurant: { lat: 1, lng: 1, name: 'R', phone: '+504' } });
    const rows = [
      ['no admission (every legacy caller)', order({ payment_placed: { leg_id: 'L1', at: 1 } }), {}],
      ['admission without payment_placed', order(), { sdkGoLive: true }],
      ['admission after a cancel decision', order({ payment_placed: { leg_id: 'L1', at: 1 }, payment_cancel: { kind: 'cancel', at: 2 } }), { sdkGoLive: true }],
      ['admission after a terminal decision', order({ payment_placed: { leg_id: 'L1', at: 1 }, payment_terminal: { revision: 0, at: 2 } }), { sdkGoLive: true }],
      ['admission with a malformed placement', order({ payment_placed: true }), { sdkGoLive: true }],
    ];
    for (const [label, o, extra] of rows) {
      const db = makeHonestDb({ orders: { [OID]: o } });
      const before = JSON.stringify(db.root);
      const r = await CM(md(db), { orderId: OID, attemptId: null, now: 5, trackingToken: 'T', ...extra });
      assert.ok(JSON.stringify(db.root) === before && r.outcome !== 'confirmed', `${L}: ${label}: refused, nothing written (got ${JSON.stringify(r)})`);
      assert.strictEqual(r.outcome, 'sdk_flow', `${L}: ${label}: refused at the pre-read (got ${JSON.stringify(r)})`);
    }
    const db = makeHonestDb({ orders: { [OID]: order({ payment_placed: { leg_id: 'L1', at: 1 } }) } });
    const ok = await CM(md(db), { orderId: OID, attemptId: null, now: 5, trackingToken: 'T', sdkGoLive: true });
    assert.strictEqual(ok.outcome, 'confirmed', `${L}: PREMISE — the admitted SDK caller does go live (got ${JSON.stringify(ok)})`);
  });
  await cell('SDK-GOLIVE-CRASH-SWEEPER-REDRIVES', async (L) => {
    const w = world();
    const real = w.deps.goLive; let n = 0; w.deps.goLive = async (dp, id) => { n += 1; if (n === 1) throw new Error('crash before going live'); return real(dp, id); };
    const r = await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(r.outcome === 'placed' && w.ord().status === 'pending_payment' && w.ord().payment_placed, `${L}: PREMISE — placed, not yet live (got ${JSON.stringify(r)})`);
    w.tick(60 * 1000);
    await SW().sweepSdkPayments(w.deps);
    assert.ok(w.ord().status === 'new' && w.ord().materialized_at, `${L}: the sweeper re-drives the go-live (status ${w.ord().status})`);
    assert.strictEqual(w.fake.callCount('authorize'), 1, `${L}: no second authorization`);
  });
  await cell('SDK-GOLIVE-CLOSED-KITCHEN-PARKS-MONEY-VIA-COORDINATOR', async (L) => {
    const w = await placed({ goLiveDeps: { getIdentity: async () => ({ hours: CLOSED, active: true }), getGraceMinutes: async () => 15 } });
    const o = w.ord();
    assert.ok(o.status === 'pending_payment' && o.payment_status === 'manual_reconciliation' && !o.materialized_at, `${L}: a closed kitchen PARKS the SDK order (got ${JSON.stringify({ s: o.status, ps: o.payment_status, b: o.blocked_reason })})`);
    w.tick(60 * 1000);
    await SW().sweepSdkPayments(w.deps);
    assert.ok(w.ord().payment_status === 'manual_reconciliation' && !w.ord().materialized_at, `${L}: the sweeper does not materialize a parked order`);
    const r = await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
    assert.ok(r.outcome === 'cancelled' && w.rec().legs.L1.role === 'surplus', `${L}: the parked order's money exits through the coordinator (got ${JSON.stringify(r)})`);
    assert.deepStrictEqual([w.fake.callCount('capture'), w.fake.callCount('void')], [0, 0], `${L}: no capture, no void (production eligibility)`);
  });
  await cell('SDK-SCHEDULED-REFUSED-AT-PLACEMENT', async (L) => {
    const w = world({ seed: { orders: { [OID]: order({ scheduled_for: 999999999 }) } } });
    const r = await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(r.outcome === 'refused' && r.reason === 'scheduled_unsupported' && w.fake.calls.length === 0, `${L}: a scheduled SDK order is refused before any PSP call (got ${JSON.stringify(r)})`);
  });
  await cell('SDK-CANCEL-WAITS-FOR-AN-IN-FLIGHT-GO-LIVE', async (L) => {
    const w = world();
    w.deps.goLive = async () => { throw new Error('crash after the confirm claim'); };
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    await w.db.ref(`orders/${OID}/payment_status`).set('confirmed');   // the shared claim committed; materialization did not run yet
    const r = await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
    assert.ok(r.outcome === 'refused' && r.reason === 'going_live' && !w.ord().payment_cancel, `${L}: a cancel never lands between the go-live claim and its materialization (got ${JSON.stringify(r)})`);
  });
  // #1 malformed (scalar-forged) decision markers are never acted on
  await cell('SDK-MALFORMED-TERMINAL-MARKER-MANUAL', async (L) => {
    const w = await placed(); await live(w);
    w.db.setAt(`orders/${OID}/payment_terminal`, true);
    const r = await C().settleTerminal(w.deps, { orderId: OID });
    await SW().sweepSdkPayments(w.deps);
    assert.ok(w.fake.callCount('capture') === 0 && w.rec().phase === 'open', `${L}: a scalar payment_terminal never freezes or captures (got ${JSON.stringify(r)}, phase ${w.rec().phase})`);
    assert.ok(w.rec().lock && w.rec().lock.reason === 'manual_reconciliation' && alerts(w.db).some((a) => a.type === 'payment_sdk_malformed_marker'), `${L}: locked for a person + alerted`);
  });
  await cell('SDK-MALFORMED-CANCEL-MARKER-NO-RELEASE', async (L) => {
    const w = await placed(); await live(w);
    w.db.setAt(`orders/${OID}/payment_cancel`, true);
    const r = await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
    await SW().sweepSdkPayments(w.deps);
    assert.ok(!w.deps.released && w.rec().phase === 'open' && w.rec().legs.L1.role === 'committed', `${L}: a scalar payment_cancel releases nothing and reclassifies nothing (got ${JSON.stringify(r)})`);
    assert.ok(alerts(w.db).some((a) => a.type === 'payment_sdk_malformed_marker'), `${L}: alerted`);
  });
  await cell('SDK-MALFORMED-COMMIT-MARKER-REFUSES', async (L) => {
    const w = await placed(); await live(w);
    w.db.setAt(`orders/${OID}/payment_commit`, { revision: '1', pid: 7 });
    const r = await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000, revision: REV(8000) });
    assert.ok(r.outcome === 'refused' && w.fake.callCount('authorize') === 1, `${L}: an adjustment on a malformed commit marker is refused (got ${JSON.stringify(r)})`);
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.fake.callCount('capture') === 0 && w.rec().lock && w.rec().lock.reason === 'manual_reconciliation', `${L}: settlement does not act on it either — a person decides`);
  });
  // #2 an authorization snapshot never licenses a second capture
  await cell('SDK-RECONCILE-CAPTURE-AUTHORIZED-STAYS-LOCKED', async (L) => {
    let release; const gate = new Promise((r) => { release = r; });
    const w = await placed({ script: { capture: [{ pause: gate }] } });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    const first = C().settleTerminal(w.deps, { orderId: OID });
    await new Promise((r) => setTimeout(r, 20));
    w.tick(3 * 60 * 1000);
    await C().reconcileSdkOps(w.deps, { orderId: OID });   // status still says authorized: the first capture is in flight
    await C().settleTerminal(w.deps, { orderId: OID });
    release(); await first;
    assert.strictEqual(caps(w).length, 1, `${L}: ONE capture of the UUID (got ${JSON.stringify(caps(w).map((c) => c.op_id))})`);
  });
  // #4 the refund obligation is born in the capture's own CAS (direct answer AND reconciled answer); closure needs it
  await cell('SDK-OBLIGATION-IN-CAPTURE-CAS', async (L) => {
    let crash = false; let thrown = false;
    const w = await placed({ hooks: { beforeTx: async (p, api) => { if (crash && !thrown && p === `payment_sdk/${OID}` && api.getAt(`payment_sdk/${OID}/legs/L1/state`) === 'captured') { thrown = true; throw new Error('crash after the capture'); } } } });
    await live(w);
    await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 7000, revision: REV(7000) });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    crash = true;
    await C().settleTerminal(w.deps, { orderId: OID }).catch(() => {});
    assert.ok(thrown, `${L}: PREMISE — crashed right after the capture CAS`);
    assert.deepStrictEqual(Object.values(w.rec().obligations || {}).map((o) => [o.amount_cents, o.state]), [[3000, 'open']], `${L}: the obligation exists already (got ${JSON.stringify(w.rec().obligations)})`);
    w.tick(60 * 1000);
    await SW().sweepSdkPayments(w.deps); await SW().sweepSdkPayments(w.deps);
    assert.deepStrictEqual([Object.keys(w.rec().obligations).length, caps(w).length], [1, 1], `${L}: still one obligation, one capture`);
  });
  await cell('SDK-OBLIGATION-IN-RECONCILED-CAPTURE-CAS', async (L) => {
    // invariant observed before EVERY later transaction (any path): a confirmed capture is never seen without its obligation
    let watch = false; let gap = null;
    const w = await placed({ script: { capture: [{ lost: true }] }, hooks: { beforeTx: async (p, api) => { if (watch && api.getAt(`payment_sdk/${OID}/legs/L1/state`) === 'captured' && !api.getAt(`payment_sdk/${OID}/obligations`)) gap = gap || p; } } });
    await live(w);
    await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 7000, revision: REV(7000) });
    await deliver(w);
    assert.ok(w.rec().lock && w.rec().legs.L1.state === 'approved', `${L}: PREMISE — the capture answer was lost`);
    w.tick(3 * 60 * 1000); watch = true;
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.ok(w.rec().legs.L1.state === 'captured', `${L}: PREMISE — bound evidence confirmed the capture`);
    assert.ok(!gap, `${L}: a transaction (${gap}) observed the confirmed capture WITHOUT its obligation`);
    assert.deepStrictEqual(Object.values(w.rec().obligations || {}).map((o) => o.amount_cents), [3000], `${L}: the reconciling CAS opened the obligation (got ${JSON.stringify(w.rec().obligations)})`);
  });
  await cell('SDK-CLOSURE-REJECTS-UNCOVERED-LIABILITY', async (L) => {
    const w = await placed(); await live(w);
    await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 7000, revision: REV(7000) });
    await deliver(w);
    await C().completeObligation(w.deps, { orderId: OID, obligationId: 'refund_1', state: 'verified', bank_ref: 'B-1' });
    assert.ok(R.isFinanciallyClosed(w.rec(), w.ord()), `${L}: PREMISE — closed with the verified obligation`);
    const rec = JSON.parse(JSON.stringify(w.rec())); delete rec.obligations;
    assert.ok(!R.isFinanciallyClosed(rec, w.ord()), `${L}: the same record WITHOUT its obligation (liability 3000 uncovered) is NOT closed`);
  });
  // #5 the sweeper recovers a committed projection on a LIVE order
  await cell('SDK-SWEEP-RECOVERS-PROJECTION-ON-LIVE-ORDER', async (L) => {
    let armed = false; let thrown = false;
    const w = await placed({ eligible: ELIGIBLE, hooks: { beforeTx: async (p) => { if (p === `orders/${OID}` && armed === 'go') armed = 'crash'; else if (armed === 'crash' && p === `payment_sdk/${OID}` && !thrown) { thrown = true; throw new Error('crash after the order commit'); } } } }); await live(w);
    armed = 'go';
    await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000, revision: REV(8000) }).catch(() => {});
    assert.ok(thrown && w.ord().payment_commit.revision === 1 && (w.rec().committed_revision || 0) === 0, `${L}: PREMISE — committed on the order, not projected`);
    w.tick(60 * 1000);
    await SW().sweepSdkPayments(w.deps);
    assert.deepStrictEqual([w.rec().committed_revision, committedIds(w.rec()).join()], [1, 'L2'], `${L}: the sweep projected the committed proposal on the live order`);
    const r = await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 7000, revision: REV(7000) });
    assert.ok(r.outcome !== 'refused', `${L}: adjustments work again (got ${JSON.stringify(r)})`);
  });
  // #6 a late approval is classified against cancellation and the frozen set
  await cell('SDK-LATE-ORIGINAL-OUTSIDE-FROZEN-SET-SURPLUS', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'approved', uuid: 'P-90', amount_cents: 9999, effect: (st) => { st['P-90'] = { state: 'authorized', amount_cents: 10000 }; } }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.rec().frozen && !(w.rec().frozen.capture_set || []).length, `${L}: PREMISE — frozen with an empty capture set`);
    w.tick(3 * 60 * 1000);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.deepStrictEqual([w.rec().legs.L1.state, w.rec().legs.L1.role], ['approved', 'surplus'], `${L}: approved outside the frozen set → SURPLUS (tracked to expiry), never committed`);
  });
  await cell('SDK-LATE-ORIGINAL-AFTER-CANCEL-SURPLUS', async (L) => {
    // the status is still inconclusive while the cancel runs, so only the LATER reconciliation classifies the approval
    const w = world({ script: { authorize: [{ outcome: 'approved', uuid: 'P-91', amount_cents: 9999, effect: (st) => { st['P-91'] = { state: 'authorized', amount_cents: 10000 }; } }], status: [{ state: 'inconclusive' }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
    w.tick(3 * 60 * 1000);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.deepStrictEqual([w.rec().legs.L1.state, w.rec().legs.L1.role], ['approved', 'surplus'], `${L}: approved after the cancellation → SURPLUS`);
  });
  // #7 the cancel enrols before its decision and before the record (fresh AND resumed)
  await cell('SDK-CANCEL-ENROLS-FIRST', async (L) => {
    const seq = [];
    const w = world({ hooks: { beforeTx: async (p) => { seq.push(`tx:${p}`); }, beforeWrite: async (p) => { seq.push(`w:${p}`); } } });
    await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
    const iDue = seq.indexOf(`w:payment_sdk_due/${OID}`); const iOrd = seq.indexOf(`tx:orders/${OID}`); const iRec = seq.indexOf(`tx:payment_sdk/${OID}`);
    assert.ok(iDue >= 0 && iDue < iOrd && iDue < iRec, `${L}: due enrol precedes the decision and the record (got ${seq.join(' ')})`);
    const w2 = world({ seed: { orders: { [OID]: order({ status: 'cancelled', payment_cancel: { kind: 'cancel', at: 1 } }) } }, hooks: { beforeWrite: async (p) => { if (p === `payment_sdk_due/${OID}`) throw new Error('enrol failed'); } } });
    await C().cancelSdkOrder(w2.deps, { orderId: OID, kind: 'cancel' }).catch(() => {});
    assert.ok(!w2.rec(), `${L}: a resumed cancel whose enrol fails creates no record (it stays discoverable by its next attempt)`);
    const w3 = world({ hooks: { beforeWrite: async (p) => { if (p === `payment_sdk_due/${OID}`) throw new Error('enrol failed'); } } });
    await C().cancelSdkOrder(w3.deps, { orderId: OID, kind: 'cancel' }).catch(() => {});
    assert.ok(!w3.ord().payment_cancel && w3.ord().status === 'pending_payment', `${L}: a fresh cancel whose enrol fails commits NO decision`);
  });
  // #10 the adjustment commits the order revision (items + canonical totals) with its payment decision
  await cell('SDK-ADJUST-COMMITS-ORDER-REVISION', async (L) => {
    const w = await placed(); await live(w);
    const rv = { items: [{ name: 'tb_item', qty: 1, unit: 70 }], total_cents: 7000, delivery_cents: 500, tip_cents: 0, promo_discount_cents: 0 };
    await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 7000, revision: rv });
    const o = w.ord();
    assert.deepStrictEqual([o.payment_commit.revision, o.total_cents, o.total, o.items, o.delivery_cents, o.tip_cents, o.promo_discount_cents], [1, 7000, 70, rv.items, 500, 0, 0], `${L}: the order carries the committed revision (got ${JSON.stringify(o)})`);
    for (const [label, bad] of [['total mismatch', { ...rv, total_cents: 6999 }], ['no items', { ...rv, items: [] }], ['fractional cents', { ...rv, delivery_cents: 1.5 }], ['missing', undefined]]) {
      const n0 = w.fake.calls.length;
      const r = await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 6000, revision: bad && { ...bad, total_cents: bad.total_cents === 6999 ? 5999 : 6000 } });
      assert.ok(r.outcome === 'refused' && w.fake.calls.length === n0 && w.ord().total_cents === 7000, `${L}: ${label}: refused before any PSP call (got ${JSON.stringify(r)})`);
    }
  });
  // #12 a server reversal after payment_terminal persists manual reconciliation; settlement stays exactly once
  await cell('SDK-SERVER-REVERSAL-AFTER-TERMINAL-PERSISTS-MANUAL', async (L) => {
    let fired = false;
    const w = await placed({ hooks: { beforeTx: async (p, api) => { if (!fired && p === `payment_sdk/${OID}` && api.getAt(`orders/${OID}/payment_terminal`) && api.getAt(`orders/${OID}/status`) === 'delivered') { fired = true; api.setAt(`orders/${OID}/status`, 'preparing'); } } } });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(fired && w.ord().status === 'preparing', `${L}: PREMISE — a server writer moved it back after the terminal decision`);
    await C().settleTerminal(w.deps, { orderId: OID });
    w.tick(60 * 1000); await SW().sweepSdkPayments(w.deps);
    assert.ok(w.rec().manual_review && w.rec().manual_review.reason === 'status_reversal_after_terminal', `${L}: the condition is PERSISTED on the record (got ${JSON.stringify(w.rec().manual_review)})`);
    assert.strictEqual(caps(w).length, 1, `${L}: the frozen set settles exactly once`);
    assert.ok(!R.isFinanciallyClosed(w.rec(), w.ord()), `${L}: not closed while a person owes the review`);
  });
  // ── Codex r1 #11: ordering + races between a pre-read and its transaction ──
  await cell('SDK-OP-JOURNALED-BEFORE-CALL', async (L) => {
    let seen; let wRef = null;
    const w = world({ script: { authorize: [(args) => { seen = wRef.db.getAt(`payment_sdk/${OID}/ops/${args.op_id}`); return {}; }] } }); wRef = w;
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(seen && seen.action === 'auth' && seen.result === undefined && seen.amount_cents === 10000, `${L}: the op is journaled (unanswered) BEFORE the PSP call (got ${JSON.stringify(seen)})`);
  });
  await cell('SDK-CANCEL-TXN-REFUSES-TERMINAL-RACE', async (L) => {
    let armed = false;
    const w = await placed({ hooks: { beforeTx: async (p, api) => { if (armed && p === `orders/${OID}`) { armed = false; api.setAt(`orders/${OID}/status`, 'delivered'); } } } });
    await live(w); armed = true;
    const r = await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
    assert.ok(!w.ord().payment_cancel && r.outcome === 'lost_to_terminal', `${L}: a delivery landing after the pre-read wins inside the cancel transaction (got ${JSON.stringify(r)})`);
    assert.strictEqual(caps(w).length, 1, `${L}: the order settles (one capture)`);
  });
  await cell('SDK-PLACE-TXN-REFUSES-CANCEL-RACE', async (L) => {
    let armed = true;
    const w = world({ hooks: { beforeTx: async (p, api) => { if (armed && p === `orders/${OID}`) { armed = false; api.setAt(`orders/${OID}/status`, 'cancelled'); api.setAt(`orders/${OID}/payment_cancel`, { kind: 'cancel', at: 1 }); } } } });
    const r = await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(r.outcome === 'late_surplus' && !w.ord().payment_placed && w.rec().legs.L1.role === 'surplus', `${L}: a cancel landing during the authorization wins the placement transaction (got ${JSON.stringify(r)})`);
  });
  await cell('SDK-GOLIVE-TXN-REFUSES-CANCEL-RACE', async (L) => {
    let armed = true;
    const db = makeHonestDb({ orders: { [OID]: order({ payment_placed: { leg_id: 'L1', at: 1 } }) } }, { beforeTx: async (p, api) => { if (armed && p === `orders/${OID}`) { armed = false; api.setAt(`orders/${OID}/payment_placed`, true); } } });
    const r = await require('../../pixelpay-confirm').confirmAndMaterialize({ db, buildMaterializeUpdates: require('../../materialize').buildMaterializeUpdates, restaurant: { lat: 1, lng: 1, name: 'R', phone: '+504' } }, { orderId: OID, attemptId: null, now: 5, trackingToken: 'T', sdkGoLive: true });
    const o = db.getAt(`orders/${OID}`);
    assert.ok(o.payment_status === 'pending' && !o.materialized_at && r.outcome !== 'confirmed', `${L}: a marker change landing after the admission pre-read is refused inside the claim (got ${JSON.stringify(r)}, ps ${o.payment_status})`);
  });
  await cell('SDK-CANCEL-TXN-REFUSES-GO-LIVE-RACE', async (L) => {
    let armed = false;
    const w = world({ hooks: { beforeTx: async (p, api) => { if (armed && p === `orders/${OID}`) { armed = false; api.setAt(`orders/${OID}/payment_status`, 'confirmed'); } } } });
    w.deps.goLive = async () => { throw new Error('go-live not yet run'); };
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    armed = true;
    const r = await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
    assert.ok(!w.ord().payment_cancel && r.outcome === 'refused', `${L}: a go-live claim landing after the cancel pre-read wins inside the cancel transaction (got ${JSON.stringify(r)})`);
  });
  await cell('SDK-CLASSIFY-LOST-PROPOSAL-DIRECT', async (L) => {
    // P1 persisted, its order transaction never ran (crash); P2 then commits on the order but is not projected (crash) —
    // classification is the ONLY step between them that reclassifies P1's leg
    let stage = 0; let thrown1 = false; let thrown2 = false;
    const w = await placed({ eligible: ELIGIBLE, hooks: { beforeTx: async (p) => {
      if (stage === 1 && p === `orders/${OID}` && !thrown1) { thrown1 = true; throw new Error('crash before the order commit'); }
      if (stage === 2 && p === `orders/${OID}`) stage = 3;
      else if (stage === 3 && p === `payment_sdk/${OID}` && !thrown2) { thrown2 = true; throw new Error('crash after the order commit'); }
    } } });
    await live(w);
    stage = 1; await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000, revision: REV(8000) }).catch(() => {});
    stage = 2; await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 7000, revision: REV(7000) }).catch(() => {});
    assert.ok(thrown1 && thrown2 && w.ord().payment_commit.pid === 'p2' && w.rec().legs.L2.role === 'pending' && w.rec().proposals.p1.state === 'proposed', `${L}: PREMISE — P1 proposed (L2 pending), P2 committed on the order, not projected (got ${JSON.stringify({ pc: w.ord().payment_commit, l2: w.rec().legs.L2, p1: w.rec().proposals && w.rec().proposals.p1 && w.rec().proposals.p1.state })})`);
    await C().classifyLostProposals(w.deps, OID, w.ord());
    assert.deepStrictEqual([w.rec().proposals.p1.state, w.rec().legs.L2.role], ['lost', 'surplus'], `${L}: the superseded proposal is LOST and its new leg SURPLUS`);
  });
  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nsdk coordinator: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
