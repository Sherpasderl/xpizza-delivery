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
function world({ seed = {}, script = {}, hooks = {}, eligible = () => false, cancelEligible, t0 = 100000, goLiveDeps = {}, contractOnlyStatus = false } = {}) {
  let t = t0;
  const db = makeHonestDb({ orders: { [OID]: order() }, ...seed }, { now: () => t, ...hooks });
  const fake = makeFakePsp(script, { contractOnlyStatus });
  const deps = { db, psp: makeAdapter(fake.impl), clock: () => t, voidEligible: eligible, releaseResources: async () => { deps.released = (deps.released || 0) + 1; }, goLive: realGoLive(db, () => t, goLiveDeps) };
  if (cancelEligible) deps.cancelVoidEligible = cancelEligible;
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
    const r = await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00001', orderId: OID, token: TOKEN, amount_cents: 10000 });
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
    const r = await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00002', orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(r.outcome, 'declined', `${L}: declined (got ${JSON.stringify(r)})`);
    assert.ok(legs(w.rec())[0].state === 'declined' && !w.rec().lock && !w.ord().payment_placed, `${L}: leg declined, no lock, not placed`);
  });
  await cell('SDK-PLACE-LOST-RESPONSE-LOCKS', async (L) => {
    const w = world({ script: { authorize: [{ lost: true }] } });
    const r = await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00003', orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(r.outcome, 'unknown', `${L}: unknown (got ${JSON.stringify(r)})`);
    assert.ok(w.rec().lock && legs(w.rec())[0].state === 'unknown' && !w.ord().payment_placed, `${L}: locked, leg unknown, NOT placed`);
    const again = await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00004', orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(again.outcome === 'refused' && w.fake.callCount('authorize') === 1, `${L}: a second placement is refused — still ONE authorize (got ${JSON.stringify(again)})`);
  });
  await cell('SDK-RECONCILE-NO-UUID-MANUAL', async (L) => {
    const w = world({ script: { authorize: [{ lost: true }] } });
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00005', orderId: OID, token: TOKEN, amount_cents: 10000 });
    w.tick(3 * 60 * 1000);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.strictEqual(w.rec().lock.reason, 'manual_reconciliation', `${L}: an unknown auth with NO uuid → manual_reconciliation (got ${JSON.stringify(w.rec().lock)})`);
    assert.ok(w.fake.callCount('status') === 0 && w.fake.callCount('authorize') === 1, `${L}: no status (no uuid), no retry`);
  });
  await cell('SDK-RECONCILE-BOUND-STATUS-RESOLVES', async (L) => {
    // approved with a mismatched amount → adapter says unknown WITH a uuid; status (bound, authorized) resolves it
    const w = world({ contractOnlyStatus: true /* CONTRACT-ONLY: an amount-bearing status binding an UNVERIFIED uuid — production's recorded status has no amount (manual) */, script: { authorize: [{ outcome: 'approved', uuid: 'P-77', amount_cents: 9999, effect: (st) => { st['P-77'] = { state: 'authorized', amount_cents: 10000 }; } }] } });
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00006', orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(w.rec().lock, `${L}: PREMISE — locked on the mismatched answer`);
    w.tick(3 * 60 * 1000);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    const l1 = legs(w.rec())[0];
    assert.ok(!w.rec().lock && l1.state === 'approved' && l1.pp_uuid === 'P-77', `${L}: bound evidence resolves the op (got ${JSON.stringify({ lock: w.rec().lock, l1 })})`);
    assert.ok(w.fake.callCount('authorize') === 1 && w.fake.calls.filter((c) => c.action === 'status').every((c) => c.uuid === 'P-77'), `${L}: one authorize, status by uuid`);
  });
  await cell('SDK-RECONCILE-MISMATCHED-STATUS-KEEPS-LOCK', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'approved', uuid: 'P-78', amount_cents: 9999, effect: (st) => { st['P-78'] = { state: 'authorized', amount_cents: 9999 }; } }] } });
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00007', orderId: OID, token: TOKEN, amount_cents: 10000 });
    w.tick(3 * 60 * 1000);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.ok(w.rec().lock && legs(w.rec())[0].state === 'unknown', `${L}: evidence with another amount is NOT bound → lock kept (got ${JSON.stringify(w.rec().lock)})`);
  });

  // ── terminal settlement ──
  const placed = async (opts = {}) => { const w = world(opts); await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00008', orderId: OID, token: TOKEN, amount_cents: 10000 }); return w; };
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
  // owner 2026-11-10: a card order's total never goes up after ordering (more food = a new order) — an increase is never offered
  // nor applied, and no hold is touched (NOTE-sdk-card-no-increase r0)
  const snap = (w) => JSON.stringify([w.rec(), w.ord(), w.fake.calls.length]);
  await cell('SDK-CARD-INCREASE-NEVER-OFFERED', async (L) => {
    const w = await placed(); await live(w);
    const before = snap(w);
    const r = await C().recordConsent(w.deps, { orderId: OID, adjustment_id: 'adj1', new_total_cents: 12500 });
    assert.deepStrictEqual(r, { outcome: 'refused', reason: 'increase_not_offered' }, `${L}: the increase is refused with its typed reason (got ${JSON.stringify(r)})`);
    assert.ok(!w.rec().consent && snap(w) === before, `${L}: no consent, the record and the order unchanged, no provider call`);
  });
  await cell('SDK-CARD-INCREASE-NEVER-APPLIED', async (L) => {
    const w = await placed(); await live(w);
    const before = snap(w);
    const r = await C().applyIncrease(w.deps, { orderId: OID, adjustment_id: 'adj1', order_revision: 0, new_total_cents: 12500, accept: true, revision: REV(12500) });
    assert.deepStrictEqual(r, { outcome: 'refused', reason: 'increase_not_offered' }, `${L}: the increase is refused with its typed reason (got ${JSON.stringify(r)})`);
    assert.ok(snap(w) === before && w.fake.callCount('authorize') === 1, `${L}: the record and the order unchanged, no new authorization, the hold untouched`);
  });
  // test-only injected eligibility: reach the replacement-B path (production stays fail-closed)
  const ELIGIBLE = () => true;
  await cell('SDK-B-REPLACES-WHOLE-SET-NEVER-REVERTS', async (L) => {
    const w = await placed({ eligible: ELIGIBLE, script: { void: [{ lost: true }] }, contractOnlyStatus: true }); await live(w);   // CONTRACT-ONLY: a 'voided' status production cannot produce (it answers 412)
    const r = await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 9000, revision: REV(9000) });
    assert.strictEqual(r.outcome, 'replaced', `${L}: replaced (got ${JSON.stringify(r)})`);
    const lastAuth = w.fake.calls.filter((c) => c.action === 'authorize').pop();
    assert.deepStrictEqual([lastAuth.token, lastAuth.amount_cents], [TOKEN, 9000], `${L}: ONE auth B for the new total`);
    assert.deepStrictEqual(committedIds(w.rec()), ['L2'], `${L}: B is the ONLY committed leg`);
    assert.strictEqual(w.rec().legs.L1.role, 'surplus', `${L}: the old set is surplus`);
    assert.strictEqual(w.fake.callCount('void'), 1, `${L}: the surplus leg voided once (lost)`);
    w.tick(3 * 60 * 1000); await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.deepStrictEqual(committedIds(w.rec()), ['L2'], `${L}: an unknown void NEVER restores S (got ${committedIds(w.rec())})`);
    await deliver(w);
    assert.deepStrictEqual(w.fake.calls.filter((c) => c.action === 'capture').map((c) => c.amount_cents), [9000], `${L}: only B is captured; surplus never`);
  });
  await cell('SDK-UNKNOWN-B-LIVE-BECOMES-SURPLUS', async (L) => {
    const w = await placed({ contractOnlyStatus: true /* CONTRACT-ONLY: an amount-bearing status binding an UNVERIFIED uuid — production's recorded status has no amount (manual) */, eligible: ELIGIBLE, script: { authorize: [{}, { lost: true, outcome: 'approved', uuid: 'P-B', amount_cents: 8000, effect: (st) => { st['P-B'] = { state: 'authorized', amount_cents: 8000 }; } }] } }); await live(w);
    const r = await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000, revision: REV(8000) });
    assert.strictEqual(r.outcome, 'unknown', `${L}: B unknown (got ${JSON.stringify(r)})`);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.ok(w.rec().lock && w.rec().lock.reason === 'manual_reconciliation', `${L}: no uuid for a lost B → manual (the lost-UUID lookup is §7.V)`);
    // the same with a uuid known (an amount-mismatched answer): status says live → B surplus, S committed
    const w2 = await placed({ contractOnlyStatus: true /* CONTRACT-ONLY: the unverified B2 uuid binds only an amount-bearing status */, eligible: ELIGIBLE, script: { authorize: [{}, { outcome: 'approved', uuid: 'P-B2', amount_cents: 1, effect: (st) => { st['P-B2'] = { state: 'authorized', amount_cents: 8000 }; } }] } }); await live(w2);
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
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00009', orderId: OID, token: TOKEN, amount_cents: 10000 });
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
    const placing = C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00010', orderId: OID, token: TOKEN, amount_cents: 10000 });
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
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00011', orderId: OID, token: TOKEN, amount_cents: 10000 });
    w.tick(R.TTL_MS + 1);
    const r = await C().expirePending(w.deps, { orderId: OID });
    assert.ok(r.outcome === 'cancelled' && w.deps.released === 1, `${L}: cleanup proceeds (got ${JSON.stringify(r)})`);
    assert.ok(w.rec().lock && w.rec().lock.reason === 'manual_reconciliation' && !R.isFinanciallyClosed(w.rec(), w.ord()), `${L}: the unknown no-uuid auth stays locked for a person; not closed`);
  });
  await cell('SDK-TWO-EXPIRY-WORKERS-RELEASE-ONCE', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'definitive_decline' }] } });
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00012', orderId: OID, token: TOKEN, amount_cents: 10000 });
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
  // owner 2026-11-10 «release it right away when possible» (NOTE-sdk-cancel-void r0): on CANCEL a hold is voided while it is still
  // voidable — the same Honduras day as its authorization, before 21:50 — else it expires, never captured; adjustments stay fail-closed
  const CVE = require('./void-eligibility').cancelVoidEligible;
  const HN = (h, m = 0, day = 0) => Date.UTC(2026, 10, 10, h + 6, m) + day * 86400000;   // Honduras local → epoch (UTC−6)
  const placedAt = async (opts = {}) => { const w = await placed({ t0: HN(12), cancelEligible: CVE, ...opts }); await live(w); return w; };
  const cancel = (w) => C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
  await cell('SDK-CANCEL-VOID-ELIGIBILITY-RULE', async (L) => {
    const leg = (at) => ({ kind: 'original', amount_cents: 1, state: 'approved', created_at: at, hold_expires_at: at + R.HOLD_MS });
    const rows = [
      ['morning hold, 21:49', HN(9), HN(21, 49), true],
      ['morning hold, 21:50', HN(9), HN(21, 50), false],
      ['morning hold, 23:00', HN(9), HN(23), false],
      ['morning hold, next day 09:00', HN(9), HN(9, 0, 1), false],
      ['hold at 22:30, 22:40', HN(22, 30), HN(22, 40), false],
      ['hold at 23:59, next day 00:10', HN(23, 59), HN(0, 10, 1), false],
      ['hold at 00:00 HN (06:00 UTC), 21:49', HN(0), HN(21, 49), true],
      ['hold at 05:59 UTC (23:59 HN the day before), 06:01 UTC', Date.UTC(2026, 10, 10, 5, 59), Date.UTC(2026, 10, 10, 6, 1), false],
      ['now before the hold', HN(12), HN(11), false],
    ];
    for (const [label, at, now, want] of rows) assert.strictEqual(typeof CVE === 'function' && CVE(leg(at), now), want, `${L}: ${label}`);
    for (const bad of [null, {}, { created_at: 'x' }]) assert.strictEqual(CVE(bad, HN(12)), false, `${L}: a malformed leg is never eligible (${JSON.stringify(bad)})`);
    const pd = require('./deps').productionDeps({});
    assert.strictEqual(pd.cancelVoidEligible, CVE, `${L}: production deps use exactly that rule for cancel`);
    assert.strictEqual(pd.voidEligible, require('./void-eligibility').voidEligible, `${L}: adjustments keep the fail-closed rule`);
  });
  await cell('SDK-CANCEL-VOIDS-SAME-DAY', async (L) => {
    const w = await placedAt();
    w.tick(3600 * 1000);   // 13:00 HN
    const r = await cancel(w);
    assert.strictEqual(r.outcome, 'cancelled', `${L}: cancelled (got ${JSON.stringify(r)})`);
    assert.deepStrictEqual(w.fake.calls.filter((c) => c.action === 'void').map((c) => c.uuid), [w.rec().legs.L1.pp_uuid], `${L}: ONE void, by the hold's uuid`);
    assert.deepStrictEqual([w.rec().legs.L1.role, w.rec().legs.L1.state, !!w.rec().lock, w.fake.callCount('capture')], ['surplus', 'voided', false, 0], `${L}: the hold is released at once — voided, no lock, no capture`);
    await cancel(w);
    assert.strictEqual(w.fake.callCount('void'), 1, `${L}: a resumed cancel never voids twice`);
  });
  await cell('SDK-CANCEL-AFTER-CUTOFF-EXPIRES', async (L) => {
    for (const [label, ms] of [['21:50 the same day', HN(21, 50) - HN(12)], ['the next day 09:00', HN(9, 0, 1) - HN(12)]]) {
      const w = await placedAt({ script: { status: [{ state: 'expired' }] } });
      w.tick(ms);
      await cancel(w);
      assert.strictEqual(w.fake.callCount('void'), 0, `${L}: ${label}: no void after the cutoff`);
      assert.deepStrictEqual([w.rec().legs.L1.role, w.rec().legs.L1.state], ['surplus', 'approved'], `${L}: ${label}: the hold is surplus, tracked`);
      // the 15-day tracking, by explicit elapsed-day boundaries (Codex r1 #3c)
      const at = w.rec().legs.L1.created_at, DAY = 86400000;
      assert.strictEqual(w.rec().legs.L1.hold_expires_at, at + 15 * DAY, `${L}: ${label}: the hold is tracked for 15 days`);
      w.tick(at + 15 * DAY - 1 - w.at());
      await C().trackExpiry(w.deps, OID);
      assert.deepStrictEqual([w.rec().legs.L1.state, w.fake.callCount('status')], ['approved', 0], `${L}: ${label}: 15 days minus 1 ms — still tracked, no status asked`);
      w.tick(1);
      await C().trackExpiry(w.deps, OID);
      assert.deepStrictEqual([w.rec().legs.L1.state, w.fake.callCount('capture')], ['expired', 0], `${L}: ${label}: it expires, never captured`);
    }
  });
  await cell('SDK-CANCEL-VOID-UNKNOWN-LOCKS-THEN-STATUS', async (L) => {
    const w = await placedAt({ script: { void: [{ lost: true }] }, contractOnlyStatus: true });   // CONTRACT-ONLY: a 'voided' status production cannot produce (it answers 412)
    w.tick(3600 * 1000);
    await cancel(w);
    assert.ok(w.rec().lock && w.rec().lock.reason === 'unknown_op' && w.rec().legs.L1.state === 'approved', `${L}: an unknown void answer LOCKS, the leg not guessed (got ${JSON.stringify(w.rec().lock)})`);
    w.tick(3 * 60 * 1000); await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.deepStrictEqual([w.rec().legs.L1.state, w.fake.callCount('void')], ['voided', 1], `${L}: the bound status 'voided' resolves it; one void only`);
    const w2 = await placedAt({ script: { void: [{ lost: true, outcome: 'refused' }] } });
    w2.tick(3600 * 1000);
    await cancel(w2);
    w2.tick(3 * 60 * 1000); await C().reconcileSdkOps(w2.deps, { orderId: OID });
    await cancel(w2);
    assert.deepStrictEqual([w2.rec().legs.L1.role, w2.rec().legs.L1.state, w2.fake.callCount('void'), w2.fake.callCount('capture')], ['surplus', 'approved', 1, 0], `${L}: status 'authorized' → refused: surplus, tracked to expiry, never voided again`);
  });
  // Codex r1 #1/#2: the prior-void check and the cancel rule are re-checked INSIDE the journal transaction, right before the call
  const atJournal = (getW, fn) => { let fired = false; return { beforeTx: async (p, api) => {
    const legsNow = api.getAt(`payment_sdk/${OID}/legs`) || {}; const opsNow = Object.values(api.getAt(`payment_sdk/${OID}/ops`) || {});
    if (!fired && p === `payment_sdk/${OID}` && legsNow.L1 && legsNow.L1.role === 'surplus' && !opsNow.some((o) => o.action === 'void')) { fired = true; await fn(getW()); }
  } }; };
  await cell('SDK-CANCEL-CONCURRENT-NEVER-VOIDS-TWICE', async (L) => {
    let wRef = null;
    const w = await placedAt({ script: { void: [{ outcome: 'refused' }, { outcome: 'refused' }] }, hooks: atJournal(() => wRef, (x) => cancel(x)) });
    wRef = w; w.tick(3600 * 1000);
    await cancel(w);   // a second cancel runs to its end between this one's read and its journal
    assert.strictEqual(w.fake.callCount('void'), 1, `${L}: two overlapping cancels send ONE void (got ${w.fake.callCount('void')})`);
    assert.deepStrictEqual([w.rec().legs.L1.role, w.rec().legs.L1.state, w.fake.callCount('capture')], ['surplus', 'approved', 0], `${L}: refused → surplus, tracked, never captured`);
  });
  await cell('SDK-CANCEL-CUTOFF-CROSSED-BEFORE-THE-CALL', async (L) => {
    let wRef = null;
    const w = await placedAt({ hooks: atJournal(() => wRef, async (x) => { x.tick(1000); }) });   // 21:49:59 → 21:50:00 at the journal
    wRef = w; w.tick(HN(21, 49) + 59 * 1000 - w.at());
    await cancel(w);
    assert.strictEqual(w.fake.callCount('void'), 0, `${L}: the cutoff passed before the call → no void sent`);
    assert.deepStrictEqual([w.rec().legs.L1.role, w.rec().legs.L1.state, !!w.rec().lock], ['surplus', 'approved', false], `${L}: the hold stays tracked, no lock`);
  });
  // Codex r1 #3a/#3b: the two rules never stand in for each other
  await cell('SDK-CANCEL-WITHOUT-ITS-RULE-NEVER-VOIDS', async (L) => {
    const w = await placed({ t0: HN(12), eligible: ELIGIBLE }); await live(w);
    w.tick(3600 * 1000);
    await cancel(w);
    assert.strictEqual(w.fake.callCount('void'), 0, `${L}: no cancel rule → never voided, even when the adjustment rule would allow it`);
  });
  await cell('SDK-SURPLUS-CLEANUP-KEEPS-THE-ADJUSTMENT-RULE', async (L) => {
    const w = await placedAt({ eligible: ELIGIBLE, cancelEligible: () => false });
    const r = await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 9000, revision: REV(9000) });
    assert.strictEqual(r.outcome, 'replaced', `${L}: PREMISE — the replacement path (got ${JSON.stringify(r)})`);
    assert.deepStrictEqual([w.fake.callCount('void'), w.rec().legs.L1.state], [1, 'voided'], `${L}: the adjustment's surplus is voided by the adjustment rule, never the cancel rule`);
  });
  await cell('SDK-DECREASE-UNCHANGED-WITH-PRODUCTION-DEPS', async (L) => {
    const pd = require('./deps').productionDeps({});
    const w = await placedAt({ eligible: pd.voidEligible, cancelEligible: pd.cancelVoidEligible });
    w.tick(3600 * 1000);
    const r = await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000, revision: REV(8000) });
    assert.strictEqual(r.outcome, 'rule4', `${L}: a same-day decrease still takes rule 4 (got ${JSON.stringify(r)})`);
    assert.deepStrictEqual([w.fake.callCount('authorize'), w.fake.callCount('void')], [1, 0], `${L}: no second authorize, no void`);
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
    const orders = Object.fromEntries(ids.map((id) => [id, order({ total_cents: 1000 })]));   // row 20: the stored total is what is placed
    const w = world({ seed: { orders }, script: { authorize: ids.map(() => ({ lost: true })) } });
    for (const id of ids) await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00013', orderId: id, token: TOKEN, amount_cents: 1000 });
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
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00014', orderId: OID, token: TOKEN, amount_cents: 10000 });
    w.tick(R.TTL_MS + 1);
    await SW().sweepSdkPayments(w.deps);
    assert.ok(w.ord().status === 'cancelled' && w.ord().payment_cancel.kind === 'expire' && w.deps.released === 1, `${L}: expired by the sweeper, released once`);
  });
  await cell('SDK-SWEEP-SURPLUS-EXPIRY-CONFIRMED', async (L) => {
    const w = await placed({ contractOnlyStatus: true }); await live(w);   // CONTRACT-ONLY: an 'expired' status production cannot produce from the recorded evidence
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
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00015', orderId: OID, token: TOKEN, amount_cents: 10000 });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.deepStrictEqual(w.rec().frozen && w.rec().frozen.capture_set, undefined, `${L}: PREMISE — an empty capture set`);
    w.tick(3 * 60 * 1000);
    await SW().sweepSdkPayments(w.deps); await SW().sweepSdkPayments(w.deps);
    assert.ok(!R.isFinanciallyClosed(w.rec(), w.ord()) && due(w) != null && w.rec().lock, `${L}: an unknown no-uuid auth keeps it open, locked and discoverable`);
  });
  await cell('SDK-ENROL-FAILURE-REFUSES', async (L) => {
    const w = world({ hooks: { beforeWrite: async (p) => { if (p === `payment_sdk_due/${OID}`) throw new Error('enrol write failed'); } } });
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00016', orderId: OID, token: TOKEN, amount_cents: 10000 }).catch(() => {});
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
      ['admission on a delivered order without a terminal marker', order({ payment_placed: { leg_id: 'L1', at: 1 }, status: 'delivered' }), { sdkGoLive: true }],
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
    const r = await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00017', orderId: OID, token: TOKEN, amount_cents: 10000 });
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
    const r = await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00018', orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(r.outcome === 'refused' && r.reason === 'scheduled_unsupported' && w.fake.calls.length === 0, `${L}: a scheduled SDK order is refused before any PSP call (got ${JSON.stringify(r)})`);
  });
  await cell('SDK-CANCEL-WAITS-FOR-AN-IN-FLIGHT-GO-LIVE', async (L) => {
    const w = world();
    w.deps.goLive = async () => { throw new Error('crash after the confirm claim'); };
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00019', orderId: OID, token: TOKEN, amount_cents: 10000 });
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
    const w = world({ contractOnlyStatus: true /* CONTRACT-ONLY: an amount-bearing status binding an UNVERIFIED uuid — production's recorded status has no amount (manual) */, script: { authorize: [{ outcome: 'approved', uuid: 'P-90', amount_cents: 9999, effect: (st) => { st['P-90'] = { state: 'authorized', amount_cents: 10000 }; } }] } });
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00020', orderId: OID, token: TOKEN, amount_cents: 10000 });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.rec().frozen && !(w.rec().frozen.capture_set || []).length, `${L}: PREMISE — frozen with an empty capture set`);
    w.tick(3 * 60 * 1000);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.deepStrictEqual([w.rec().legs.L1.state, w.rec().legs.L1.role], ['approved', 'surplus'], `${L}: approved outside the frozen set → SURPLUS (tracked to expiry), never committed`);
  });
  await cell('SDK-LATE-ORIGINAL-AFTER-CANCEL-SURPLUS', async (L) => {
    // the status is still inconclusive while the cancel runs, so only the LATER reconciliation classifies the approval
    const w = world({ contractOnlyStatus: true /* CONTRACT-ONLY: an amount-bearing status binding an UNVERIFIED uuid — production's recorded status has no amount (manual) */, script: { authorize: [{ outcome: 'approved', uuid: 'P-91', amount_cents: 9999, effect: (st) => { st['P-91'] = { state: 'authorized', amount_cents: 10000 }; } }], status: [{ state: 'inconclusive' }] } });
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00021', orderId: OID, token: TOKEN, amount_cents: 10000 });
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
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00022', orderId: OID, token: TOKEN, amount_cents: 10000 });
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
    const r = await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00023', orderId: OID, token: TOKEN, amount_cents: 10000 });
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
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00024', orderId: OID, token: TOKEN, amount_cents: 10000 });
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
  // ruling (A) on the redemption gap: a live, placed SDK order whose redemption is still `reserved` (the go-live's consume
  // failed after materialization) is re-entered through the shared go-live, whose already-confirmed branch consumes it
  await cell('SDK-SWEEP-CONSUMES-A-RESERVED-REDEMPTION', async (L) => {
    let failOnce = true;
    const RW = `user_rewards/tb_uid/tb_rest`;
    const w = world({
      seed: { orders: { [OID]: order({ customer_uid: 'tb_uid', redemption: { cost: 5, item: 'tb_item' } }) }, user_rewards: { tb_uid: { tb_rest: { balance: 10, reserved: 5, reservations: { [OID]: { state: 'reserved', cost: 5, created_at: 1 } } } } } },
      hooks: { beforeTx: async (p) => { if (failOnce && p.startsWith(RW)) { failOnce = false; throw new Error('consume transaction failed'); } } },
    });
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00025', orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(w.ord().materialized_at && !failOnce && w.db.getAt(`${RW}/reservations/${OID}/state`) === 'reserved', `${L}: PREMISE — live, but the consume failed (state ${w.db.getAt(`${RW}/reservations/${OID}/state`)})`);
    w.tick(60 * 1000);
    await SW().sweepSdkPayments(w.deps);
    assert.strictEqual(w.db.getAt(`${RW}/reservations/${OID}/state`), 'consumed', `${L}: the sweep's go-live re-entry consumed the redemption`);
    assert.deepStrictEqual([w.fake.callCount('authorize'), w.fake.callCount('capture'), w.ord().status], [1, 0, 'new'], `${L}: no money moved, the order stays live`);
    w.tick(SW().REVISIT_MS + 1); await SW().sweepSdkPayments(w.deps);
    assert.strictEqual(w.db.getAt(`${RW}/balance`), 5, `${L}: consumed ONCE (balance 10 − 5)`);
  });
  // ruling (r2.2): a FULFILLED (delivered / completed) SDK order's redemption still reserved is consumed — never left reserved
  const RWP = `user_rewards/tb_uid/tb_rest`;
  const rewardSeed = (state, o = {}) => ({ orders: { [OID]: order({ customer_uid: 'tb_uid', redemption: { cost: 5, item: 'tb_item' }, ...o }) }, user_rewards: { tb_uid: { tb_rest: { balance: 10, reserved: 5, reservations: { [OID]: { state, cost: 5, created_at: 1 } } } } } });
  const failRewardTx = (n) => { let left = n; return { beforeTx: async (p) => { if (left > 0 && p.startsWith(RWP)) { left -= 1; throw new Error('consume transaction failed'); } } }; };
  await cell('SDK-TERMINAL-SETTLE-CONSUMES-RESERVED-REDEMPTION', async (L) => {
    const w = world({ seed: rewardSeed('reserved'), hooks: failRewardTx(1) });
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00026', orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(w.db.getAt(`${RWP}/reservations/${OID}/state`), 'reserved', `${L}: PREMISE — the go-live consume failed`);
    await deliver(w);
    assert.strictEqual(w.db.getAt(`${RWP}/reservations/${OID}/state`), 'consumed', `${L}: settlement of the fulfilled order consumed the redemption`);
    w.tick(60 * 1000); await SW().sweepSdkPayments(w.deps); w.tick(SW().REVISIT_MS + 1); await SW().sweepSdkPayments(w.deps);
    assert.strictEqual(w.db.getAt(`${RWP}/balance`), 5, `${L}: consumed ONCE across settle + two sweeps (balance 10 − 5)`);
  });
  await cell('SDK-TERMINAL-SWEEP-CONSUMES-RESERVED-REDEMPTION', async (L) => {
    // the go-live consume AND settlement's consume fail; the sweeper's own terminal step consumes in the SAME visit
    const w = world({ seed: rewardSeed('reserved'), hooks: failRewardTx(2) });
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00027', orderId: OID, token: TOKEN, amount_cents: 10000 });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    w.tick(60 * 1000); await SW().sweepSdkPayments(w.deps);
    assert.strictEqual(w.db.getAt(`${RWP}/reservations/${OID}/state`), 'consumed', `${L}: the sweeper's terminal visit consumed it (one visit)`);
    w.tick(SW().REVISIT_MS + 1); await SW().sweepSdkPayments(w.deps);
    assert.strictEqual(w.db.getAt(`${RWP}/balance`), 5, `${L}: consumed ONCE`);
  });
  await cell('SDK-TERMINAL-REDEMPTION-NOT-RESERVED-NOOP', async (L) => {
    const w = await (async () => { const x = world({ seed: rewardSeed('reserved') }); await C().placeOriginal(x.deps, { attempt_id: 'att_fixed_c00028', orderId: OID, token: TOKEN, amount_cents: 10000 }); return x; })();
    assert.strictEqual(w.db.getAt(`${RWP}/reservations/${OID}/state`), 'consumed', `${L}: PREMISE — consumed at go-live`);
    const ledger0 = JSON.stringify(w.db.getAt(`${RWP}/ledger`));
    await deliver(w); w.tick(60 * 1000); await SW().sweepSdkPayments(w.deps); w.tick(SW().REVISIT_MS + 1); await SW().sweepSdkPayments(w.deps);
    assert.ok(w.db.getAt(`${RWP}/balance`) === 5 && JSON.stringify(w.db.getAt(`${RWP}/ledger`)) === ledger0, `${L}: an already-consumed redemption is untouched (no second debit, no new ledger entry)`);
    // a RELEASED one on a fulfilled order is never consumed by the backstop (no consume-after-release attempt / alert)
    const w2 = world({ seed: rewardSeed('released', { status: 'delivered', payment_placed: { leg_id: 'L1', at: 1 }, payment_status: 'confirmed', materialized_at: 5 }) });
    await SW().sweepSdkPayments(w2.deps);
    await C().consumeFulfilledRedemption(w2.deps, OID, w2.ord());
    assert.ok(w2.db.getAt(`${RWP}/reservations/${OID}/state`) === 'released' && !alerts(w2.db).some((a) => a.kind === 'reward_consume_after_release'), `${L}: a released redemption is left released (no consume attempt)`);
  });
  await cell('SDK-CANCEL-RELEASES-RESERVED-REDEMPTION', async (L) => {
    const w = world({ seed: rewardSeed('reserved') });
    w.deps.releaseResources = (dp, id, o) => require('./release').releaseSdkOrder(dp, id, o);
    const r = await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
    assert.ok(r.outcome === 'cancelled' && w.db.getAt(`${RWP}/reservations/${OID}/state`) === 'released', `${L}: the SDK cancel RELEASES the reserved redemption through the existing release path (got ${JSON.stringify(r)}, state ${w.db.getAt(`${RWP}/reservations/${OID}/state`)})`);
    w.tick(60 * 1000); await SW().sweepSdkPayments(w.deps);
    assert.ok(w.db.getAt(`${RWP}/reservations/${OID}/state`) === 'released' && w.db.getAt(`${RWP}/balance`) === 10, `${L}: never consumed afterwards (balance 10)`);
  });
  // ── Codex r2 P1-A: a go-live can never reopen a settled order (stale / overlapping workers, through the FINAL write) ──
  const OPEN_ALL = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, { open: true, start: '00:00', end: '23:59' }]));
  const CMd = (db, extra = {}) => ({ db, buildMaterializeUpdates: require('../../materialize').buildMaterializeUpdates, restaurant: { lat: 1, lng: 1, name: 'R', phone: '+504' }, ...extra });
  const CMcall = (deps, now) => require('../../pixelpay-confirm').confirmAndMaterialize(deps, { orderId: OID, attemptId: null, now, trackingToken: `TT-${now}`, sdkGoLive: true });
  await cell('SDK-GOLIVE-FAILED-ADMISSION-TERMINATES', async (L) => {
    // Codex repro 1: the order is already confirmed (an earlier claim); delivered + payment_terminal land between the pre-read and the claim
    let armed = true;
    const db = makeHonestDb({ orders: { [OID]: order({ payment_placed: { leg_id: 'L1', at: 1 }, payment_status: 'confirmed' }) } }, { beforeTx: async (p, api) => { if (armed && p === `orders/${OID}`) { armed = false; api.setAt(`orders/${OID}/status`, 'delivered'); api.setAt(`orders/${OID}/payment_terminal`, { revision: 0, at: 2 }); } } });
    const r = await CMcall(CMd(db), 5);
    const o = db.getAt(`orders/${OID}`);
    assert.ok(o.status === 'delivered' && !o.materialized_at && !db.getAt('tasks') && !db.getAt('order_tracking') && r.outcome === 'sdk_flow', `${L}: a failed admission TERMINATES — nothing materialized (got ${JSON.stringify(r)}, status ${o.status})`);
  });
  await cell('SDK-GOLIVE-OVERLAP-NEVER-REOPENS', async (L) => {
    // Codex repro 2: two overlapping go-lives; the slower one resumes after the order was delivered and completed
    let release; const gate = new Promise((r) => { release = r; });
    const w = world(); w.deps.goLive = async () => { throw new Error('not yet'); };
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00029', orderId: OID, token: TOKEN, amount_cents: 10000 });
    const slow = CMcall(CMd(w.db, { getIdentity: async () => { await gate; return { active: true, hours: OPEN_ALL }; }, getGraceMinutes: async () => 15 }), 7);
    await new Promise((r) => setTimeout(r, 20));
    const fast = await CMcall(CMd(w.db), 8);
    assert.ok(fast.outcome === 'confirmed' && w.ord().status === 'new', `${L}: PREMISE — the fast go-live materialized (got ${JSON.stringify(fast)})`);
    await w.db.ref(`orders/${OID}/status`).set('completed');
    await w.db.ref(`tasks/${OID}_delivery/status`).set('delivered');
    release(); const r = await slow;
    assert.ok(w.ord().status === 'completed' && w.db.getAt(`tasks/${OID}_delivery/status`) === 'delivered' && w.ord().tracking_token === 'TT-8', `${L}: the slower go-live writes NOTHING (got ${JSON.stringify(r)}, status ${w.ord().status}, task ${w.db.getAt(`tasks/${OID}_delivery/status`)})`);
  });
  await cell('SDK-GOLIVE-CRASH-AFTER-ORDER-TXN-REPLAYED', async (L) => {
    let n = 0; let crashed = false;
    const w = world({ hooks: { beforeTx: async (p) => { if (p.startsWith('tasks/') && ++n === 2) { crashed = true; throw new Error('crash after the first task'); } } } });
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00030', orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(crashed && w.ord().materialized_at && w.db.getAt(`tasks/${OID}_pickup`) && !w.db.getAt(`tasks/${OID}_delivery`) && w.ord().sdk_live_pending, `${L}: PREMISE — live, the pickup task written, the delivery task not, the pending list recorded`);
    await w.db.ref(`tasks/${OID}_pickup/status`).set('assigned');   // a driver took the pickup meanwhile
    const c = await C().cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel' });
    assert.ok(c.outcome === 'refused' && c.reason === 'going_live', `${L}: a cancel waits while the go-live's paths are pending (got ${JSON.stringify(c)})`);
    w.tick(60 * 1000); await SW().sweepSdkPayments(w.deps);
    assert.ok(w.db.getAt(`tasks/${OID}_delivery`) && w.db.getAt(`order_tracking/${w.ord().tracking_token}`) && !w.ord().sdk_live_pending, `${L}: the sweeper replays the pending paths and clears the list`);
    assert.strictEqual(w.db.getAt(`tasks/${OID}_pickup/status`), 'assigned', `${L}: the replay is CREATE-ONLY — the driver's pickup is never reset`);
  });
  // ── Codex r3: the pending go-live list is never trusted; tracking fills per leaf; a failed reward consume keeps the order due ──
  await cell('SDK-LIVE-PENDING-FORGED-NEVER-REPLAYED', async (L) => {
    const w = await placed(); await live(w);
    // a forged list (any shape a client could have planted) naming a payment marker and a foreign order
    w.db.setAt(`orders/${OID}/sdk_live_pending`, [{ path: `orders/${OID}/payment_terminal`, value: { revision: 0, at: 1 } }, { path: 'orders/tb_other/status', value: 'delivered' }]);
    w.tick(60 * 1000); await SW().sweepSdkPayments(w.deps); await SW().sweepSdkPayments(w.deps);
    assert.ok(!w.ord().payment_terminal && !w.db.getAt('orders/tb_other') && caps(w).length === 0, `${L}: nothing of the forged list is written (payment_terminal ${JSON.stringify(w.ord().payment_terminal)}, captures ${caps(w).length})`);
    assert.ok(alerts(w.db).some((a) => a.type === 'payment_sdk_malformed_live_pending') && !w.ord().sdk_live_pending, `${L}: alerted and dropped`);
  });
  await cell('SDK-LIVE-REPLAY-FILLS-TRACKING-PER-LEAF', async (L) => {
    let crash = true;
    const w = world({ hooks: { beforeTx: async (p) => { if (crash && p.startsWith('order_tracking/')) { crash = false; throw new Error('crash before the tracking record'); } } } });
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00031', orderId: OID, token: TOKEN, amount_cents: 10000 });
    const tok = w.ord().tracking_token;
    assert.ok(!crash && tok && !w.db.getAt(`order_tracking/${tok}`) && w.ord().sdk_live_pending, `${L}: PREMISE — live, tracking not written, list pending`);
    // the triggers write their leaves first
    await w.db.ref(`order_tracking/${tok}/display_number`).set(42);
    await w.db.ref(`order_tracking/${tok}/status`).set('preparing');
    w.tick(60 * 1000); await SW().sweepSdkPayments(w.deps);
    const t = w.db.getAt(`order_tracking/${tok}`);
    assert.ok(t.display_number === 42 && t.status === 'preparing', `${L}: trigger-written leaves are never overwritten (got ${JSON.stringify({ d: t.display_number, s: t.status })})`);
    assert.ok(t.order_type === 'delivery' && t.order_id === OID && t.items_text === '1x tb_item', `${L}: the missing leaves are initialized (got keys ${Object.keys(t).join(',')})`);
  });
  await cell('SDK-REWARD-CONSUME-FAILURE-KEEPS-DUE', async (L) => {
    let left = 6;   // go-live 1, settle 2, then two sweeper visits × (settle + sweeper) = 6 failed consumes
    const w = world({ seed: rewardSeed('reserved'), hooks: { beforeTx: async (p) => { if (left > 0 && p === RWP) { left -= 1; throw new Error('consume transaction failed'); } } } });
    await C().placeOriginal(w.deps, { attempt_id: 'att_fixed_c00032', orderId: OID, token: TOKEN, amount_cents: 10000 });
    await deliver(w);
    for (let i = 1; i <= 2; i++) {
      w.tick(SW().REVISIT_MS + 1); await SW().sweepSdkPayments(w.deps);
      assert.ok(due(w) != null, `${L}: visit ${i}: a failed reward consume keeps the order due (reservation ${w.db.getAt(`${RWP}/reservations/${OID}/state`)})`);
    }
    assert.ok(left === 0 && w.db.getAt(`${RWP}/reservations/${OID}/state`) === 'reserved', `${L}: PREMISE — every consume so far failed (left ${left})`);
    assert.ok(!R.isFinanciallyClosed(w.rec(), w.ord(), { rewardState: 'reserved' }), `${L}: an unsettled redemption is NOT financially closed`);
    w.tick(SW().REVISIT_MS + 1); await SW().sweepSdkPayments(w.deps);
    assert.strictEqual(w.db.getAt(`${RWP}/reservations/${OID}/state`), 'consumed', `${L}: a later visit consumes it`);
    w.tick(SW().REVISIT_MS + 1); await SW().sweepSdkPayments(w.deps);
    assert.strictEqual(due(w), null, `${L}: settled → closed → removed`);
  });
  await cell('SDK-LIVE-PENDING-FALSY-MALFORMED-DROPPED', async (L) => {
    for (const bad of ['', false, 0]) {
      const w = await placed(); await live(w);
      w.db.setAt(`orders/${OID}/sdk_live_pending`, bad);
      w.tick(60 * 1000); await SW().sweepSdkPayments(w.deps);
      assert.ok(w.db.getAt(`orders/${OID}/sdk_live_pending`) == null && alerts(w.db).some((a) => a.type === 'payment_sdk_malformed_live_pending'), `${L}: ${JSON.stringify(bad)}: a falsy malformed list is alerted and dropped (got ${JSON.stringify(w.db.getAt(`orders/${OID}/sdk_live_pending`))})`);
    }
  });

  // ── D4 S1 (PLAN-sdk-d4-r4): attempts, replay, the deadline, SAME-WINNER, the per-attempt reference, Q3 ──
  const A1 = 'att_d4_first_00000001', A2 = 'att_d4_second_0000002';
  const deadlineWorld = (opts = {}) => world({ ...opts, seed: { orders: { [OID]: order({ pay_deadline_at: 100000 + 15 * 60 * 1000, customer_name: 'Ana Pérez', customer_email: 'ana@example.hn' }) } } });
  await cell('SDK-D4-ATTEMPT-CLAIM-ATOMIC', async (L) => {
    let release; const gate = new Promise((r) => { release = r; });
    const w = deadlineWorld({ script: { authorize: [{ pause: gate }] } });
    const placing = C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    await new Promise((r) => setTimeout(r, 20));
    const r = w.rec();
    const leg = r && r.legs && r.legs.L1;
    const ops = Object.values((r && r.ops) || {});
    assert.ok(r && r.attempts && r.attempts[A1] && r.attempts[A1].leg_id === 'L1', `${L}: the attempt is claimed before the provider answers`);
    assert.ok(leg && leg.attempt_id === A1 && /^sdk[a-z2-7]{26}$/.test(leg.pp_ref), `${L}: the leg carries the attempt and its provider reference`);
    assert.ok(ops.length === 1 && ops[0].leg_id === 'L1' && ops[0].action === 'auth' && ops[0].result == null,   /* RTDB drops a null leaf */ `${L}: the op is journaled in the SAME record state (one CAS)`);
    assert.ok(r.attempts[A1].token_hash && r.attempts[A1].token_hash !== TOKEN && !JSON.stringify(r.attempts).includes(TOKEN), `${L}: the attempt stores a token HASH, never the token`);
    release(); await placing;
  });
  await cell('SDK-D4-ATTEMPT-REPLAY', async (L) => {
    const w = deadlineWorld();
    const p1 = await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(p1.outcome, 'placed', `${L}: premise — placed`);
    const p2 = await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: 'T-other', amount_cents: 99999 });
    assert.deepStrictEqual([p2.outcome, p2.leg_id, w.fake.callCount('authorize')], ['replay', 'L1', 1], `${L}: the same attempt_id is a replay — zero new PSP calls, the body ignored (got ${JSON.stringify(p2)})`);
    let release; const gate = new Promise((r) => { release = r; });
    const w2 = deadlineWorld({ script: { authorize: [{ pause: gate }] } });
    const first = C().placeOriginal(w2.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    await new Promise((r) => setTimeout(r, 20));
    const mid = await C().placeOriginal(w2.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    release(); await first;
    assert.deepStrictEqual([mid.outcome, w2.fake.callCount('authorize')], ['replay', 1], `${L}: a retransmission while the first is in flight is a replay — zero new PSP calls`);
  });
  await cell('SDK-D4-REPLAY-STALE-READ', async (L) => {
    // a retransmission whose first record read is STALE (the first try completes, declined, between that read and the claim):
    // the claim CAS itself must recognise the known attempt — never a second authorization for one attempt
    const w = deadlineWorld({ script: { authorize: [{ outcome: 'definitive_decline', code: 'X' }] } });
    const first = await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(first.outcome, 'declined', `${L}: premise — the first try declined`);
    let staleOnce = true;
    const staleDb = { ref: (p) => { const r = w.db.ref(p); if (p !== `payment_sdk/${OID}`) return r; return { ...r, transaction: (...a) => r.transaction(...a), once: async (...a) => { if (staleOnce) { staleOnce = false; return { val: () => null }; } return r.once(...a); } }; } };
    const again = await C().placeOriginal({ ...w.deps, db: staleDb }, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.deepStrictEqual([again.outcome, w.fake.callCount('authorize')], ['replay', 1], `${L}: the claim CAS recognises the known attempt — still ONE authorize (got ${JSON.stringify(again)})`);
    // Codex r1 P2: the SUCCESS case — the first try PLACED the order; a stale retransmission must still be a replay, never order_state
    const w2 = deadlineWorld();
    const ok = await C().placeOriginal(w2.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(ok.outcome, 'placed', `${L}: premise — the first try placed the order`);
    let stale2 = true;
    const staleDb2 = { ref: (p) => { const r = w2.db.ref(p); if (p !== `payment_sdk/${OID}`) return r; return { ...r, transaction: (...a) => r.transaction(...a), once: async (...a) => { if (stale2) { stale2 = false; return { val: () => null }; } return r.once(...a); } }; } };
    const again2 = await C().placeOriginal({ ...w2.deps, db: staleDb2 }, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.deepStrictEqual([again2.outcome, again2.leg_id, w2.fake.callCount('authorize')], ['replay', 'L1', 1], `${L}: a stale retransmission of the PLACED attempt is a replay, never order_state (got ${JSON.stringify(again2)})`);
  });
  await cell('SDK-D4-VOID-CARRIES-REF', async (L) => {
    // Codex r1 P1-1: the cancel void must carry the leg's provider reference (a production void is signed over it)
    const w = deadlineWorld({ cancelEligible: () => true });
    await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    await C().cancelSdkOrder(w.deps, { orderId: OID });
    const v = w.fake.calls.filter((c) => c.action === 'void');
    assert.ok(v.length === 1 && v[0].ref === w.rec().legs.L1.pp_ref && w.rec().legs.L1.state === 'voided', `${L}: ONE void, carrying the leg's pp_ref, and the leg voided (calls ${JSON.stringify(v)}, leg ${JSON.stringify(w.rec().legs.L1)})`);
  });
  await cell('SDK-D4-RETRY-AFTER-DECLINE', async (L) => {
    const w = deadlineWorld({ script: { authorize: [{ outcome: 'definitive_decline', code: 'X' }] } });
    const d1 = await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(d1.outcome, 'declined', `${L}: premise — the first attempt declined`);
    const d2 = await C().placeOriginal(w.deps, { attempt_id: A2, orderId: OID, token: 'T-second', amount_cents: 10000 });
    const refs = w.fake.calls.filter((c) => c.action === 'authorize').map((c) => c.ref);
    assert.ok(d2.outcome === 'placed' && refs.length === 2 && refs[0] !== refs[1], `${L}: a new attempt after a decline is admitted with a NEW leg — ref ≠ the first ref (got ${JSON.stringify(d2)}, refs ${JSON.stringify(refs)})`);
    const w2 = deadlineWorld({ script: { authorize: [{ lost: true }] } });
    await C().placeOriginal(w2.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    const u2 = await C().placeOriginal(w2.deps, { attempt_id: A2, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(u2.outcome === 'refused' && w2.fake.callCount('authorize') === 1, `${L}: a new attempt while the first is unknown is refused — still ONE authorize (got ${JSON.stringify(u2)})`);
  });
  await cell('SDK-D4-DEADLINE-AT-CLAIM', async (L) => {
    const w = deadlineWorld();
    w.tick(15 * 60 * 1000);   // exactly the deadline
    const r = await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.deepStrictEqual([r.outcome, r.reason, w.fake.callCount('authorize')], ['refused', 'past_deadline', 0], `${L}: the claim at exactly the deadline is refused — zero PSP calls (got ${JSON.stringify(r)})`);
  });
  await cell('SDK-D4-DEADLINE-AT-PLACE', async (L) => {
    const steps = [];
    const w = deadlineWorld({ script: { authorize: steps } });
    steps.push(() => { w.tick(15 * 60 * 1000); return {}; });   // the bank answers AT the deadline
    const r = await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(r.outcome === 'late_surplus' && !w.ord().payment_placed && w.rec().legs.L1.role === 'surplus', `${L}: an approval at the deadline is surplus, never placed (got ${JSON.stringify(r)})`);
  });
  await cell('SDK-D4-SAME-WINNER', async (L) => {
    const steps = [];
    const w = deadlineWorld({ script: { authorize: steps } });
    steps.push(() => { w.db.setAt(`orders/${OID}/payment_placed`, { leg_id: 'L1', at: w.at() }); return {}; });   // a racing sweep placed THIS leg
    const r = await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.deepStrictEqual([r.outcome, w.rec().legs.L1.role], ['placed', 'committed'], `${L}: the same winner resolves as placed — role kept (got ${JSON.stringify(r)})`);
    const steps2 = [];
    const w2 = deadlineWorld({ script: { authorize: steps2 } });
    steps2.push(() => { w2.db.setAt(`orders/${OID}/payment_cancel`, { kind: 'cancel', at: w2.at() }); w2.db.setAt(`orders/${OID}/status`, 'cancelled'); return {}; });
    const r2 = await C().placeOriginal(w2.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.deepStrictEqual([r2.outcome, w2.rec().legs.L1.role, !!w2.ord().payment_placed], ['late_surplus', 'surplus', false], `${L}: a loss to a cancel makes the leg surplus (got ${JSON.stringify(r2)})`);
  });
  await cell('SDK-D4-DECIDE-REFUSES-CHALLENGE', async (L) => {
    const w = deadlineWorld();
    const p = await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(p.outcome, 'placed', `${L}: premise`);
    const w2 = deadlineWorld();
    await R.createRecord(w2.db, OID, { flow: 'sdk_auth_v1', phase: 'open', committed_revision: 0, fulfillment_total_cents: 10000, created_at: w2.at(), ttl_at: w2.at() + 1e6 });
    await R.casRecord(w2.db, OID, (r) => { r.legs = { L1: { kind: 'original', amount_cents: 10000, role: 'surplus', state: 'approved', from_challenge: true, pp_uuid: 'P-1', created_at: w2.at(), hold_expires_at: w2.at() + R.HOLD_MS } }; return r; });
    const d = await C().decidePlacement(w2.deps, OID, 'L1');
    assert.ok(d.outcome === 'refused' && !w2.ord().payment_placed, `${L}: a from_challenge leg is never placed — the direct decidePlacement is refused (got ${JSON.stringify(d)})`);
  });
  await cell('SDK-D4-AUTH-ID-PASSED', async (L) => {
    const w = deadlineWorld();
    await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000, authentication_identifier: 'auth-3ds-1' });
    const c = w.fake.calls.find((x) => x.action === 'authorize');
    assert.strictEqual(c.authentication_identifier, 'auth-3ds-1', `${L}: the identifier reaches pspAuthorize`);
    assert.deepStrictEqual(c.payer, { name: 'Ana Pérez', email: 'ana@example.hn' }, `${L}: the payer comes from the ORDER`);
    assert.strictEqual(c.ref, w.rec().legs.L1.pp_ref, `${L}: the provider reference is the leg's stored pp_ref`);
  });
  await cell('SDK-D4-3DS-NO-LOCK', async (L) => {
    const w = deadlineWorld({ script: { authorize: [{ outcome: 'requires_action', uuid: 'P-ra-1' }] } });
    const r1 = await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(r1.outcome, 'requires_action', `${L}: premise — the bank challenged the saved token`);
    assert.ok(!w.rec().lock && !w.ord().payment_placed && w.rec().legs.L1.role === 'none', `${L}: no record lock, not placed`);
    const r2 = await C().placeOriginal(w.deps, { attempt_id: A2, orderId: OID, token: 'T-other-card', amount_cents: 10000 });
    assert.ok(r2.outcome === 'placed' && w.ord().payment_placed.leg_id === 'L2', `${L}: another card is admitted at once and placed (got ${JSON.stringify(r2)})`);
  });
  await cell('SDK-D4-PP-REF', async (L) => {
    const f = C().ppRef;
    const a = f('prod', 'ord_1', A1);
    assert.ok(/^sdk[a-z2-7]{26}$/.test(a) && !a.includes('-'), `${L}: 29 chars, letters + digits, no '-' (${a})`);
    assert.strictEqual(f('prod', 'ord_1', A1), a, `${L}: deterministic`);
    assert.ok(new Set([a, f('staging', 'ord_1', A1), f('prod', 'ord_2', A1), f('prod', 'ord_1', A2)]).size === 4, `${L}: namespace / order / attempt each change it`);
    assert.notStrictEqual(f('prod', 'a', 'b-abcdefghijklmnop'), f('prod', 'a-b', 'abcdefghijklmnop'), `${L}: the hyphen-ambiguous pair is distinct (NUL separators)`);
  });

  // ── D4 row 19 (5f's narrowed boundStatus, advisor 11-12): an AMOUNT-LESS status binds only a uuid journaled from an APPROVED outcome ──
  const amountless = (state) => (a) => ({ state, uuid: a.uuid, amount_cents: undefined });   // the recorded sandbox status carries NO amount (the fake's default would add one)
  await cell('SDK-D4-AMOUNTLESS-BINDS-VERIFIED', async (L) => {
    // capture: a lost capture answer, then an amount-less «captured»
    const w = deadlineWorld({ script: { capture: [{ lost: true }], status: [amountless('captured')] } });
    await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(w.rec().legs.L1.uuid_verified, true, `${L}: an APPROVED auth journals uuid_verified`);
    w.db.setAt(`orders/${OID}/status`, 'delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    w.tick(C().RECONCILE_AFTER_MS + 1);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.strictEqual(w.rec().legs.L1.state, 'captured', `${L}: capture: an amount-less status binds a VERIFIED uuid (leg ${JSON.stringify(w.rec().legs.L1)})`);
    // void: a lost void answer, then an amount-less «voided»
    const w2 = deadlineWorld({ cancelEligible: () => true, script: { void: [{ lost: true }], status: [amountless('voided')] } });
    await C().placeOriginal(w2.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    await C().cancelSdkOrder(w2.deps, { orderId: OID });
    w2.tick(C().RECONCILE_AFTER_MS + 1);
    await C().reconcileSdkOps(w2.deps, { orderId: OID });
    assert.strictEqual(w2.rec().legs.L1.state, 'voided', `${L}: void: an amount-less status binds a VERIFIED uuid`);
    // expiry: a surplus hold past its expiry, then an amount-less «expired» (trackExpiry)
    const w3 = deadlineWorld({ script: { status: [amountless('expired')] } });
    await C().placeOriginal(w3.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    await C().cancelSdkOrder(w3.deps, { orderId: OID });
    w3.tick(R.HOLD_MS + 1);
    await C().trackExpiry(w3.deps, OID);
    assert.strictEqual(w3.rec().legs.L1.state, 'expired', `${L}: expiry: an amount-less status binds a VERIFIED uuid`);
  });
  await cell('SDK-D4-AMOUNTLESS-UNBOUND-UNVERIFIED', async (L) => {
    // a uuid from a NON-approved outcome (an approval whose amount did not match ⇒ unknown + uuid) never binds amount-less evidence
    const w = deadlineWorld({ script: { authorize: [{ outcome: 'approved', uuid: 'P-mm-1', amount_cents: 9999 }], status: [amountless('authorized')] } });
    await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(w.rec().legs.L1.pp_uuid === 'P-mm-1' && w.rec().legs.L1.uuid_verified !== true, `${L}: premise — an unverified uuid journaled`);
    w.tick(C().RECONCILE_AFTER_MS + 1);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.ok(w.rec().legs.L1.state === 'unknown' && w.rec().lock && !w.ord().payment_placed, `${L}: an amount-less «authorized» on an UNVERIFIED uuid stays unbound — locked for a person (leg ${JSON.stringify(w.rec().legs.L1)})`);
    // a challenged original (requires_action) carries an unverified uuid too
    const w2 = deadlineWorld({ script: { authorize: [{ outcome: 'requires_action', uuid: 'P-ra-2' }] } });
    await C().placeOriginal(w2.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(w2.rec().legs.L1.uuid_verified !== true, `${L}: a requires_action uuid is NOT verified`);
  });
  await cell('SDK-D4-PRESENT-AMOUNT-DIFFERS-UNBOUND', async (L) => {
    const w = deadlineWorld({ script: { capture: [{ lost: true }], status: [(a) => ({ state: 'captured', uuid: a.uuid, amount_cents: 999 })] } });
    await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    w.db.setAt(`orders/${OID}/status`, 'delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    w.tick(C().RECONCILE_AFTER_MS + 1);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.ok(w.rec().legs.L1.state !== 'captured' && w.rec().lock, `${L}: a PRESENT differing amount stays unbound even for a verified uuid`);
  });
  await cell('SDK-D4-LEGACY-LEG-NEEDS-AMOUNT', async (L) => {
    // a leg journaled before row 19 has no uuid_verified: it stays on today's amount-required binding
    const w = deadlineWorld({ script: { capture: [{ lost: true }], status: [amountless('captured'), (a) => ({ state: 'captured', uuid: a.uuid, amount_cents: 10000 })] } });
    await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000 });
    w.db.setAt(`payment_sdk/${OID}/legs/L1/uuid_verified`, null);   // as journaled before this row
    w.db.setAt(`orders/${OID}/status`, 'delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    w.tick(C().RECONCILE_AFTER_MS + 1);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.ok(w.rec().legs.L1.state !== 'captured', `${L}: amount-less evidence does not bind a pre-row leg`);
    w.tick(C().RECONCILE_AFTER_MS + 1);
    await C().reconcileSdkOps(w.deps, { orderId: OID });
    assert.strictEqual(w.rec().legs.L1.state, 'captured', `${L}: amount-bearing evidence still binds it (today's rule)`);
  });

  await cell('SDK-D4-FAKE-PARITY', async (L) => {
    // Codex S0/S1 r2 P2: the fake's DEFAULT answers must be ones the REAL adapter can produce from the recorded evidence.
    // Contract cells may still INJECT other states explicitly (they are marked contract-only).
    const PRODUCIBLE = { authorize: ['approved', 'definitive_decline', 'requires_action', 'unknown'], capture: ['captured', 'declined', 'unknown'], void: ['voided', 'unknown'], status: ['authorized', 'captured', 'inconclusive'] };
    const fake = makeFakePsp({});
    const ad = makeAdapter(fake.impl);
    const a = await ad.pspAuthorize({ token: 'T', amount_cents: 100, op_id: 'o1', ref: 'sdkx' });
    const sAuth = await ad.pspStatus({ uuid: a.uuid });
    const c = await ad.pspCapture({ uuid: a.uuid, amount_cents: 100, op_id: 'o2' });
    const sCap = await ad.pspStatus({ uuid: a.uuid });
    const a2 = await ad.pspAuthorize({ token: 'T', amount_cents: 100, op_id: 'o3', ref: 'sdky' });
    const v = await ad.pspVoid({ uuid: a2.uuid, op_id: 'o4', ref: 'sdky' });
    const sVoid = await ad.pspStatus({ uuid: a2.uuid });
    const got = [['authorize', a.outcome], ['status', sAuth.state], ['capture', c.outcome], ['status', sCap.state], ['void', v.outcome], ['status', sVoid.state]];
    for (const [op, o] of got) assert.ok(PRODUCIBLE[op].includes(o), `${L}: the fake's default ${op} answer «${o}» is one the real adapter can produce (status after a void is 412 ⇒ inconclusive in production)`);
  });

  await cell('SDK-D4-DISPLAY-SCHEMA-CLAIM', async (L) => {
    // Codex S3 r4 P1: a strict SERVER-side display schema BEFORE the first persistence (the journal included)
    const bad = [{ brand: 'visa', last4: '4111111111111111', exp_month: 12, exp_year: 2030 }, { brand: { name: 'Ana', cvv: '123' }, last4: '4242', exp_month: 12, exp_year: 2030 }, { brand: 'visa', last4: '4242', exp_month: 13, exp_year: 2030 }, { brand: 'visa', last4: 4242, exp_month: 12, exp_year: 2030 }, null];
    for (const display of bad) {
      const w = deadlineWorld();
      const r = await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000, card: { card_ref: 'new', display, save: true, vault_gen: 0 } });
      assert.ok(r.outcome === 'refused' && r.reason === 'bad_display' && w.rec() == null && w.fake.callCount('authorize') === 0, `${L}: ${JSON.stringify(display)} ⇒ refused bad_display BEFORE any record / journal / PSP call (got ${JSON.stringify(r)})`);
    }
    const w = deadlineWorld();
    await C().placeOriginal(w.deps, { attempt_id: A1, orderId: OID, token: TOKEN, amount_cents: 10000, card: { card_ref: 'new', display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, email: 'x@y.hn', cvv: '999' }, save: true, vault_gen: 0 } });
    assert.deepStrictEqual(w.rec().attempts[A1].display, { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 }, `${L}: extra keys (an email, a CVV) are DROPPED — the journal stores exactly the 4 display fields`);
  });
  await cell('SDK-D4-FAKE-BINDING-PARITY', async (L) => {
    // Codex S3 r4 P2: the fake's DEFAULT status binds exactly as the REAL recorded status does — for a verified leg AND a legacy one
    const { boundStatus } = require('./psp-adapter');
    const fake = makeFakePsp({});
    const ad = makeAdapter(fake.impl);
    const a = await ad.pspAuthorize({ token: 'T', amount_cents: 100, op_id: 'o1', ref: 'sdkx' });
    const fakeEv = await ad.pspStatus({ uuid: a.uuid });
    const realEv = { state: 'authorized', uuid: a.uuid };   // the recorded shape (fixtures/pixelpay/status-authorized.json): NO amount
    const verified = { pp_uuid: a.uuid, amount_cents: 100, uuid_verified: true };
    const legacy = { pp_uuid: a.uuid, amount_cents: 100 };
    assert.deepStrictEqual([boundStatus(fakeEv, verified), boundStatus(fakeEv, legacy)], [boundStatus(realEv, verified), boundStatus(realEv, legacy)], `${L}: the fake default binds like production (verified ⇒ bound, legacy ⇒ unbound); fake ${JSON.stringify(fakeEv)}`);
  });
  await cell('SDK-D4-STORED-TOTAL', async (L) => {
    // CORE-Δ row 20 (PLAN-sdk-d4-r11 §A4): placeOriginal charges ONLY the stored order total — any other amount is refused before
    // any record, journal or PSP call
    for (const amt of [9999, 10001, 1]) {
      const w = world({ seed: { orders: { [OID]: order({ total_cents: 10000 }) } } });
      const r = await C().placeOriginal(w.deps, { orderId: OID, attempt_id: 'att_stored_total_0001', token: 'T', amount_cents: amt });
      assert.ok(r.outcome === 'refused' && r.reason === 'amount_mismatch' && w.fake.callCount('authorize') === 0 && w.rec() == null, `${L}: ${amt} ≠ the stored 10000 ⇒ refused amount_mismatch, zero PSP calls, no record (got ${JSON.stringify(r)})`);
    }
    const w = world({ seed: { orders: { [OID]: order({ total_cents: 10000 }) } } });
    const ok = await C().placeOriginal(w.deps, { orderId: OID, attempt_id: 'att_stored_total_0002', token: 'T', amount_cents: 10000 });
    assert.ok(ok.outcome !== 'refused' && w.fake.callCount('authorize') === 1, `${L}: the stored total ⇒ dispatched (got ${JSON.stringify(ok)})`);
  });
  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nsdk coordinator: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
