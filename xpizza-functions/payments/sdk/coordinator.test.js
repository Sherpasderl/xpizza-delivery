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
const order = (o = {}) => ({ restaurant_id: 'tb_rest', payment_flow: 'sdk_auth_v1', status: 'pending_payment', created_at: 1000, ...o });
function world({ seed = {}, script = {}, hooks = {}, eligible = () => false, t0 = 100000 } = {}) {
  let t = t0;
  const db = makeHonestDb({ orders: { [OID]: order() }, ...seed }, { now: () => t, ...hooks });
  const fake = makeFakePsp(script);
  const deps = { db, psp: makeAdapter(fake.impl), now: () => t, voidEligible: eligible, release: async () => { deps.released = (deps.released || 0) + 1; } };
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
    assert.ok(again.outcome === 'refused' && w.fake.count('authorize') === 1, `${L}: a second placement is refused — still ONE authorize (got ${JSON.stringify(again)})`);
  });
  await cell('SDK-RECONCILE-NO-UUID-MANUAL', async (L) => {
    const w = world({ script: { authorize: [{ lost: true }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    w.tick(3 * 60 * 1000);
    await C().reconcile(w.deps, { orderId: OID });
    assert.strictEqual(w.rec().lock.reason, 'manual_reconciliation', `${L}: an unknown auth with NO uuid → manual_reconciliation (got ${JSON.stringify(w.rec().lock)})`);
    assert.ok(w.fake.count('status') === 0 && w.fake.count('authorize') === 1, `${L}: no status (no uuid), no retry`);
  });
  await cell('SDK-RECONCILE-BOUND-STATUS-RESOLVES', async (L) => {
    // approved with a mismatched amount → adapter says unknown WITH a uuid; status (bound, authorized) resolves it
    const w = world({ script: { authorize: [{ outcome: 'approved', uuid: 'P-77', amount_cents: 9999, effect: (st) => { st['P-77'] = { state: 'authorized', amount_cents: 10000 }; } }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(w.rec().lock, `${L}: PREMISE — locked on the mismatched answer`);
    w.tick(3 * 60 * 1000);
    await C().reconcile(w.deps, { orderId: OID });
    const l1 = legs(w.rec())[0];
    assert.ok(!w.rec().lock && l1.state === 'approved' && l1.pp_uuid === 'P-77', `${L}: bound evidence resolves the op (got ${JSON.stringify({ lock: w.rec().lock, l1 })})`);
    assert.ok(w.fake.count('authorize') === 1 && w.fake.calls.filter((c) => c.action === 'status').every((c) => c.uuid === 'P-77'), `${L}: one authorize, status by uuid`);
  });
  await cell('SDK-RECONCILE-MISMATCHED-STATUS-KEEPS-LOCK', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'approved', uuid: 'P-78', amount_cents: 9999, effect: (st) => { st['P-78'] = { state: 'authorized', amount_cents: 9999 }; } }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    w.tick(3 * 60 * 1000);
    await C().reconcile(w.deps, { orderId: OID });
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
    assert.strictEqual(w.fake.count('capture'), 1, `${L}: idempotent — a second settle captures nothing`);
  });
  await cell('SDK-TERMINAL-COMPLETED-ALSO-SETTLES', async (L) => {
    const w = await placed();
    await w.db.ref(`orders/${OID}/status`).set('completed');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.strictEqual(w.fake.count('capture'), 1, `${L}: 'completed' (merchant handed) is terminal too`);
  });
  await cell('SDK-TERMINAL-NOT-TERMINAL-NOOP', async (L) => {
    const w = await placed();
    await w.db.ref(`orders/${OID}/status`).set('preparing');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.fake.count('capture') === 0 && !w.ord().payment_terminal && w.rec().phase === 'open', `${L}: a live order is not settled`);
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
    assert.strictEqual(w.fake.count('capture'), 1, `${L}: exactly ONE capture call for L1 (got ${w.fake.count('capture')})`);
    assert.strictEqual(legs(w.rec())[0].state, 'captured', `${L}: captured once`);
  });
  await cell('SDK-LOST-CAPTURE-INCONCLUSIVE-KEEPS-LOCK', async (L) => {
    const w = await placed({ script: { capture: [{ lost: true }], status: [{ state: 'inconclusive' }] } });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.rec().lock, `${L}: PREMISE — the lost capture locks`);
    w.tick(3 * 60 * 1000);
    await C().reconcile(w.deps, { orderId: OID });
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.rec().lock && w.fake.count('capture') === 1, `${L}: inconclusive status → lock kept, NO second capture (got lock ${JSON.stringify(w.rec().lock)}, captures ${w.fake.count('capture')})`);
    assert.ok(!R.isFinanciallyClosed(w.rec(), w.ord()), `${L}: not closed`);
  });
  await cell('SDK-LOST-CAPTURE-BOUND-STATUS-CAPTURED', async (L) => {
    const w = await placed({ script: { capture: [{ lost: true }] } });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    w.tick(3 * 60 * 1000);
    await C().reconcile(w.deps, { orderId: OID });
    assert.ok(!w.rec().lock && legs(w.rec())[0].state === 'captured' && w.fake.count('capture') === 1, `${L}: the PSP did capture → status (bound, captured) resolves it; never a second capture`);
  });

  // ── adjustments (§2.10 via §4: proposal → order commit → projection) ──
  const committedIds = (rec) => Object.entries((rec && rec.legs) || {}).filter(([, l]) => l.role === 'committed').map(([id]) => id).sort();
  const deliver = async (w) => { await w.db.ref(`orders/${OID}/status`).set('delivered'); return C().settleTerminal(w.deps, { orderId: OID }); };
  const live = async (w) => { await w.db.ref(`orders/${OID}/status`).set('preparing'); };
  await cell('SDK-RULE4-UNDER-PRODUCTION-STUB', async (L) => {
    const w = await placed(); await live(w);
    const r = await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000 });
    assert.strictEqual(r.outcome, 'rule4', `${L}: the production stub makes every leg ineligible → rule 4 (got ${JSON.stringify(r)})`);
    assert.ok(w.fake.count('authorize') === 1 && w.fake.count('void') === 0, `${L}: no auth B, no void`);
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
    await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000 });
    await C().recordConsent(w.deps, { orderId: OID, adjustment_id: 'adj1', new_total_cents: 9000 });
    const c = w.rec().consent;
    const r = await C().applyIncrease(w.deps, { orderId: OID, adjustment_id: 'adj1', order_revision: c.order_revision, new_total_cents: 9000, accept: true });
    assert.strictEqual(r.outcome, 'committed', `${L}: committed (got ${JSON.stringify(r)})`);
    assert.strictEqual(w.fake.count('authorize'), 1, `${L}: delta_needed 0 → NO delta auth`);
    assert.deepStrictEqual([w.rec().fulfillment_total_cents, w.rec().derived.refund_liability, w.rec().derived.delta_needed], [9000, 1000, 0], `${L}: the liability shrinks to 1000`);
    await deliver(w);
    assert.deepStrictEqual([w.fake.count('capture'), Object.values(w.rec().obligations).map((o) => o.amount_cents).join()], [1, '1000'], `${L}: one capture of 10000, one obligation of 1000`);
  });
  await cell('SDK-INCREASE-DELTA-AUTH', async (L) => {
    const w = await placed(); await live(w);
    await C().recordConsent(w.deps, { orderId: OID, adjustment_id: 'adj1', new_total_cents: 12500 });
    const c = w.rec().consent;
    assert.ok(c.expires_at - w.at() === C().CONSENT_WINDOW_MS && C().CONSENT_WINDOW_MS === 3 * 60 * 1000, `${L}: the consent window is the 3-minute constant (owner 11-07)`);
    const r = await C().applyIncrease(w.deps, { orderId: OID, adjustment_id: 'adj1', order_revision: c.order_revision, new_total_cents: 12500, accept: true });
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
    const bad = await C().applyIncrease(w.deps, { orderId: OID, adjustment_id: 'adj1', order_revision: c.order_revision + 1, new_total_cents: 12000, accept: true });
    assert.ok(bad.outcome === 'rejected' && w.fake.count('authorize') === 1, `${L}: a mismatched revision is rejected (got ${JSON.stringify(bad)})`);
    await C().recordConsent(w.deps, { orderId: OID, adjustment_id: 'adj2', new_total_cents: 12000 });
    w.tick(C().CONSENT_WINDOW_MS + 1);
    const late = await C().applyIncrease(w.deps, { orderId: OID, adjustment_id: 'adj2', order_revision: w.rec().consent.order_revision, new_total_cents: 12000, accept: true });
    assert.ok(late.outcome === 'rejected' && w.fake.count('authorize') === 1, `${L}: a LATE consent is rejected, no auth (got ${JSON.stringify(late)})`);
    await C().recordConsent(w.deps, { orderId: OID, adjustment_id: 'adj3', new_total_cents: 12000 });
    await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 9000 });
    assert.strictEqual(w.rec().consent.state, 'expired', `${L}: a later edit invalidates a pending consent`);
  });
  await cell('SDK-DELTA-DECLINED-ORDER-UNCHANGED', async (L) => {
    const w = await placed({ script: { authorize: [{}, { outcome: 'definitive_decline', code: '51' }] } }); await live(w);
    await C().recordConsent(w.deps, { orderId: OID, adjustment_id: 'adj1', new_total_cents: 12000 });
    const r = await C().applyIncrease(w.deps, { orderId: OID, adjustment_id: 'adj1', order_revision: w.rec().consent.order_revision, new_total_cents: 12000, accept: true });
    assert.strictEqual(r.outcome, 'declined', `${L}: declined (got ${JSON.stringify(r)})`);
    assert.deepStrictEqual([committedIds(w.rec()).join(), w.rec().fulfillment_total_cents, w.rec().derived.refund_liability, (w.ord().payment_commit || {}).revision || 0], ['L1', 10000, 0, 0], `${L}: the order stays as it was, nothing to refund`);
  });
  // test-only injected eligibility: reach the replacement-B path (production stays fail-closed)
  const ELIGIBLE = () => true;
  const withDeltas = async (opts = {}) => {
    const w = await placed({ eligible: ELIGIBLE, ...opts }); await live(w);
    for (const [id, tot] of [['a1', 12000], ['a2', 13000]]) {
      await C().recordConsent(w.deps, { orderId: OID, adjustment_id: id, new_total_cents: tot });
      await C().applyIncrease(w.deps, { orderId: OID, adjustment_id: id, order_revision: w.rec().consent.order_revision, new_total_cents: tot, accept: true });
    }
    return w;
  };
  await cell('SDK-B-REPLACES-WHOLE-SET-NEVER-REVERTS', async (L) => {
    const w = await withDeltas({ script: { void: [{}, { outcome: 'refused' }, { lost: true }] } });
    assert.deepStrictEqual(committedIds(w.rec()), ['L1', 'L2', 'L3'], `${L}: PREMISE — original + 2 deltas committed (got ${committedIds(w.rec())})`);
    const r = await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 9000 });
    assert.strictEqual(r.outcome, 'replaced', `${L}: replaced (got ${JSON.stringify(r)})`);
    const lastAuth = w.fake.calls.filter((c) => c.action === 'authorize').pop();
    assert.deepStrictEqual([lastAuth.token, lastAuth.amount_cents], [TOKEN, 9000], `${L}: ONE auth B for the new total`);
    assert.deepStrictEqual(committedIds(w.rec()), ['L4'], `${L}: B is the ONLY committed leg`);
    assert.deepStrictEqual(['L1', 'L2', 'L3'].map((id) => w.rec().legs[id].role), ['surplus', 'surplus', 'surplus'], `${L}: the WHOLE old set is surplus`);
    assert.strictEqual(w.fake.count('void'), 3, `${L}: each surplus leg voided once (one ok, one refused, one lost)`);
    w.tick(3 * 60 * 1000); await C().reconcile(w.deps, { orderId: OID });
    assert.deepStrictEqual(committedIds(w.rec()), ['L4'], `${L}: a failed / unknown void NEVER restores S (got ${committedIds(w.rec())})`);
    await deliver(w);
    assert.deepStrictEqual(w.fake.calls.filter((c) => c.action === 'capture').map((c) => c.amount_cents), [9000], `${L}: only B is captured; surplus never`);
  });
  await cell('SDK-UNKNOWN-B-LIVE-BECOMES-SURPLUS', async (L) => {
    const w = await placed({ eligible: ELIGIBLE, script: { authorize: [{}, { lost: true, outcome: 'approved', uuid: 'P-B', amount_cents: 8000, effect: (st) => { st['P-B'] = { state: 'authorized', amount_cents: 8000 }; } }] } }); await live(w);
    const r = await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000 });
    assert.strictEqual(r.outcome, 'unknown', `${L}: B unknown (got ${JSON.stringify(r)})`);
    await C().reconcile(w.deps, { orderId: OID });
    assert.ok(w.rec().lock && w.rec().lock.reason === 'manual_reconciliation', `${L}: no uuid for a lost B → manual (the lost-UUID lookup is §7.V)`);
    // the same with a uuid known (an amount-mismatched answer): status says live → B surplus, S committed
    const w2 = await placed({ eligible: ELIGIBLE, script: { authorize: [{}, { outcome: 'approved', uuid: 'P-B2', amount_cents: 1, effect: (st) => { st['P-B2'] = { state: 'authorized', amount_cents: 8000 }; } }] } }); await live(w2);
    await C().requestDecrease(w2.deps, { orderId: OID, new_total_cents: 8000 });
    w2.tick(3 * 60 * 1000); await C().reconcile(w2.deps, { orderId: OID });
    assert.deepStrictEqual([committedIds(w2.rec()).join(), w2.rec().legs.L2.role, w2.rec().legs.L2.state, w2.rec().fulfillment_total_cents], ['L1', 'surplus', 'approved', 10000], `${L}: B found live → SURPLUS; S stays committed; the total unchanged (got ${JSON.stringify(w2.rec().legs.L2)})`);
    await deliver(w2);
    assert.deepStrictEqual(w2.fake.calls.filter((c) => c.action === 'capture').map((c) => c.amount_cents), [10000], `${L}: only S captured`);
  });
  await cell('SDK-ADJUSTMENT-LOSES-TO-TERMINAL', async (L) => {
    let release; const gate = new Promise((r) => { release = r; });
    const w = await placed({ eligible: ELIGIBLE, script: { authorize: [{}, { pause: gate }] } }); await live(w);
    const adj = C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000 });
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
    await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000 }).catch(() => {});
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
    await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 8000 }).catch(() => {});
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
    const r = await C().cancel(w.deps, { orderId: OID, kind: 'cancel' });
    assert.strictEqual(r.outcome, 'cancelled', `${L}: cancelled (got ${JSON.stringify(r)})`);
    assert.ok(w.ord().status === 'cancelled' && w.ord().payment_cancel && w.ord().payment_cancel.kind === 'cancel', `${L}: the order decision (status + payment_cancel) committed`);
    assert.deepStrictEqual([w.rec().phase, w.rec().legs.L1.role, w.rec().legs.L1.state], ['cancelled', 'surplus', 'approved'], `${L}: the hold is SURPLUS, tracked (not voided under the stub)`);
    assert.deepStrictEqual([w.fake.count('void'), w.fake.count('capture'), w.deps.released], [0, 0, 1], `${L}: no void (production stub), no capture, released once`);
    assert.ok(!R.isFinanciallyClosed(w.rec(), w.ord()), `${L}: a live hold keeps it open until expiry is confirmed`);
  });
  await cell('SDK-CANCEL-LOSES-TO-TERMINAL', async (L) => {
    const w = await placed();
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    const r = await C().cancel(w.deps, { orderId: OID, kind: 'cancel' });
    assert.strictEqual(r.outcome, 'lost_to_terminal', `${L}: the terminal write won (got ${JSON.stringify(r)})`);
    assert.ok(!w.ord().payment_cancel && w.fake.count('capture') === 1 && !w.deps.released && w.rec().legs.L1.role === 'committed', `${L}: settled as terminal, nothing released or reclassified`);
  });
  await cell('SDK-TERMINAL-AFTER-COMMITTED-CANCEL', async (L) => {
    const w = await placed(); await live(w);
    await C().cancel(w.deps, { orderId: OID, kind: 'cancel' });
    await w.db.ref(`orders/${OID}/status`).set('delivered');   // an override AFTER the cancel decision
    const r = await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(r.outcome === 'manual' && w.fake.count('capture') === 0, `${L}: never captured automatically (got ${JSON.stringify(r)})`);
    assert.ok(w.rec().lock && w.rec().lock.reason === 'manual_reconciliation' && alerts(w.db).some((x) => x.type === 'payment_sdk_terminal_after_cancel'), `${L}: manual + alert`);
  });
  await cell('SDK-CANCEL-TERMINAL-AT-EACH-BOUNDARY', async (L) => {
    // a terminal write lands right AFTER the cancel's order decision (before stop / classify / cleanup)
    let fired = false;
    const w = await placed({ hooks: { beforeTx: async (p, api) => { if (p === `payment_sdk/${OID}` && api.getAt(`orders/${OID}/payment_cancel`) && !fired) { fired = true; api.setAt(`orders/${OID}/status`, 'delivered'); } } } }); await live(w);
    const r = await C().cancel(w.deps, { orderId: OID, kind: 'cancel' });
    assert.ok(fired && r.outcome === 'cancelled', `${L}: the cancel had already won (got ${JSON.stringify(r)})`);
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.fake.count('capture') === 0 && w.rec().legs.L1.role === 'surplus', `${L}: the later terminal write does not reopen money`);
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
    await C().cancel(w.deps, { orderId: OID, kind: 'expire' });   // the sweeper's resume
    assert.deepStrictEqual([w.ord().status, w.rec().legs.L1.role, w.fake.count('capture')], ['cancelled', 'surplus', 0], `${L}: surplus, never captured`);
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
  await cell('SDK-INTERRUPTED-CLEANUP-RESUMED', async (L) => {
    const w = await placed(); await live(w);
    let n = 0; w.deps.release = async () => { n += 1; if (n === 1) throw new Error('crash mid-cleanup'); };
    await C().cancel(w.deps, { orderId: OID, kind: 'cancel' }).catch(() => {});
    assert.ok(!(w.rec().cleanup && w.rec().cleanup.done_at), `${L}: PREMISE — cleanup not done`);
    w.tick(3 * 60 * 1000);
    await C().cancel(w.deps, { orderId: OID, kind: 'cancel' });
    assert.ok(n === 2 && w.rec().cleanup && w.rec().cleanup.done_at, `${L}: the resume finishes the cleanup (calls ${n})`);
  });
  // ── the durable sweeper + due index (§5) ──
  const SW = () => require('./sweeper');
  const due = (w, id = OID) => w.db.getAt(`payment_sdk_due/${id}`);
  await cell('SDK-SWEEP-SETTLES-MISSING-TRIGGER-THEN-REMOVES', async (L) => {
    const w = await placed();
    await w.db.ref(`orders/${OID}/status`).set('delivered');   // the trigger never ran
    w.tick(60 * 1000);
    await SW().sweepSdkPayments(w.deps);
    assert.ok(w.fake.count('capture') === 1 && w.rec().legs.L1.state === 'captured', `${L}: found on the due visit and settled (captures ${w.fake.count('capture')})`);
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
    assert.strictEqual(w.fake.count('capture'), 1, `${L}: exactly one capture (got ${w.fake.count('capture')})`);
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
  await cell('SDK-SWEEP-OBLIGATION-AFTER-CRASH', async (L) => {
    let crash = false; let thrown = false;
    const w = await placed({ hooks: { beforeTx: async (p, api) => { if (crash && !thrown && p === `payment_sdk/${OID}` && api.getAt(`payment_sdk/${OID}/legs/L1/state`) === 'captured') { thrown = true; throw new Error('crash after the capture'); } } } });
    await live(w);
    await C().requestDecrease(w.deps, { orderId: OID, new_total_cents: 7000 });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    crash = true;
    await C().settleTerminal(w.deps, { orderId: OID }).catch(() => {});
    assert.ok(thrown && !w.rec().obligations, `${L}: PREMISE — captured, the obligation not yet written`);
    w.tick(60 * 1000);
    await SW().sweepSdkPayments(w.deps); await SW().sweepSdkPayments(w.deps);
    assert.deepStrictEqual(Object.values(w.rec().obligations || {}).map((o) => o.amount_cents), [3000], `${L}: the sweeper opens the obligation ONCE`);
    assert.strictEqual(w.fake.count('capture'), 1, `${L}: no second capture`);
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
    await C().cancel(w.deps, { orderId: OID, kind: 'cancel' });
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
    assert.ok(w.fake.count('authorize') === 0 && !(w.rec() && w.rec().ops), `${L}: no enrol → nothing journaled, no PSP call`);
  });
  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nsdk coordinator: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
