'use strict';
// D4 S2 (PLAN-sdk-d4-r5) — the STANDALONE parts: decline buckets (§7), the card-availability flag (§9), the C6 subject arbiter
// (W2), safeToSwitch (row 9), and the §4 status resolver. Every response body the resolver builds is read by the CUSTOMER APP's
// real readPlacement (exact keys per outcome), so the server and the client compose for real. No status amount is relied on.
// Run: node payments/sdk/d4-s2.test.js
const assert = require('assert');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const PC = require('../../../customer-app/capp-pay-card.js');

const OID = 'tb_sdk_s2';
let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const B = () => require('./decline-buckets');
const FLAG = () => require('./sdk-pay-flag');
const SUB = () => require('./subject');
const ST = () => require('./status');
const C = () => require('./coordinator');

const T0 = 1_000_000;
const order = (o = {}) => ({ payment_flow: 'sdk_auth_v1', status: 'pending_payment', pay_deadline_at: T0 + 15 * 60 * 1000, restaurant_id: 'tb_rest', ...o });
const att = (leg_id, at, extra = {}) => ({ leg_id, token_hash: 'h', card_ref: 'new', display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 }, save: false, amount_cents: 10000, at, ...extra });
const op = (leg_id, n, result) => ({ [`${OID}:${leg_id}:auth:${n}`]: { leg_id, action: 'auth', amount_cents: 10000, dispatched_at: T0, ...(result === undefined ? {} : { result }) } });
const rec = (o = {}) => ({ flow: 'sdk_auth_v1', phase: 'open', ttl_at: T0 + 15 * 60 * 1000, legs: {}, ops: {}, attempts: {}, ...o });

(async () => {
  await cell('SDK-D4-BUCKETS', async (L) => {
    const b = B().bucketOf;
    assert.strictEqual(b({ kind: 'definitive_decline', code: 'ANY-UNMAPPED' }), 'hard', `${L}: an unmapped code ⇒ hard`);
    assert.strictEqual(b({ kind: 'definitive_decline', code: null }), 'hard', `${L}: no code ⇒ hard`);
    assert.strictEqual(b({ kind: 'token_expired_confirmed' }), 'token_expired', `${L}: token_expired_confirmed ⇒ token_expired`);
    assert.strictEqual(b({ kind: 'requires_action' }), 'hard', `${L}: a challenged token charge ⇒ declined / hard (Q3)`);
    assert.deepStrictEqual(Object.keys(B().TABLE), [], `${L}: the table starts EMPTY (no invented BAC codes)`);
    assert.ok(Object.isFrozen(B().TABLE), `${L}: frozen`);
  });

  await cell('SDK-D4-SDKPAY-FLAG', async (L) => {
    const db = makeHonestDb({});
    const F = FLAG();
    assert.deepStrictEqual(await F.sdkPayStatusCore(db), { available: false, retry_after_s: 300 }, `${L}: absent ⇒ unavailable (fail-closed)`);
    assert.strictEqual(await F.newAttemptsAllowed(db, 'tb_rest'), false, `${L}: absent ⇒ no new attempt`);
    db.setAt('platform_config/sdk_pay', { available: true, retry_after_s: 60, restaurants: { tb_rest: true } });
    assert.deepStrictEqual(await F.sdkPayStatusCore(db), { available: true, retry_after_s: 60 }, `${L}: the exact client keys`);
    assert.strictEqual(await F.newAttemptsAllowed(db, 'tb_rest'), true, `${L}: an allowlisted restaurant ⇒ allowed`);
    assert.strictEqual(await F.newAttemptsAllowed(db, 'other_rest'), false, `${L}: a restaurant NOT on the allowlist ⇒ refused`);
    db.setAt('platform_config/sdk_pay', { available: true, retry_after_s: 60 });
    assert.strictEqual(await F.newAttemptsAllowed(db, 'tb_rest'), false, `${L}: no allowlist ⇒ none (absent ⇒ none)`);
    db.setAt('platform_config/sdk_pay', { available: 'yes', retry_after_s: 'x', restaurants: { tb_rest: true } });
    assert.deepStrictEqual(await F.sdkPayStatusCore(db), { available: false, retry_after_s: 300 }, `${L}: malformed ⇒ unavailable, default retry`);
  });

  await cell('SDK-D4-SAFE-TO-SWITCH', async (L) => {
    const s = C().safeToSwitch;
    const cancelled = order({ status: 'cancelled', payment_cancel: { kind: 'cancel', at: T0 } });
    assert.strictEqual(s(rec({ phase: 'cancelled' }), cancelled), true, `${L}: cancelled + fenced + nothing live ⇒ safe`);
    assert.strictEqual(s(rec({ phase: 'open' }), cancelled), false, `${L}: the record not fenced ⇒ not safe`);
    assert.strictEqual(s(rec({ phase: 'cancelled' }), order()), false, `${L}: the order not cancelled ⇒ not safe`);
    assert.strictEqual(s(rec({ phase: 'cancelled', ops: op('L1', 1) }), cancelled), false, `${L}: an unanswered op ⇒ not safe`);
    assert.strictEqual(s(rec({ phase: 'cancelled', ops: op('L1', 1, { kind: 'unknown' }), legs: { L1: { kind: 'original', state: 'unknown' } } }), cancelled), false, `${L}: an unknown op ⇒ not safe`);
    for (const st of ['approved', 'requires_action', 'sent', 'unknown']) assert.strictEqual(s(rec({ phase: 'cancelled', legs: { L1: { kind: 'original', state: st, role: 'surplus' } } }), cancelled), false, `${L}: a ${st} leg ⇒ not safe`);
    for (const st of ['voided', 'expired', 'declined']) assert.strictEqual(s(rec({ phase: 'cancelled', legs: { L1: { kind: 'original', state: st } } }), cancelled), true, `${L}: a ${st} leg ⇒ safe`);
    assert.strictEqual(s(rec({ phase: 'cancelled', lock: { reason: 'manual_reconciliation' } }), cancelled), false, `${L}: a lock ⇒ not safe`);
    assert.strictEqual(s(null, cancelled), false, `${L}: no record ⇒ not safe (W4: the cancel creates the fence first)`);
  });

  await cell('SDK-D4-SUBJECT-CLAIM', async (L) => {
    const db = makeHonestDb({});
    const S = SUB();
    const deps = { db, clock: () => T0 };
    const resolved = async () => false;
    assert.strictEqual(S.subjectKey({ uid: 'abc' }), 'u_abc', `${L}: member key`);
    assert.strictEqual(S.subjectKey({ phoneHash: 'f00d' }), 'p_f00d', `${L}: guest key`);
    assert.deepStrictEqual(await S.claimSubject(deps, 'u_abc', 'ord_1', resolved), { ok: true }, `${L}: absent ⇒ taken`);
    assert.deepStrictEqual(await S.claimSubject(deps, 'u_abc', 'ord_1', resolved), { ok: true }, `${L}: the same order ⇒ kept`);
    const r = await S.claimSubject(deps, 'u_abc', 'ord_2', resolved);
    assert.deepStrictEqual([r.ok, r.held], [false, 'ord_1'], `${L}: another unresolved order ⇒ refused (previous_payment_unresolved)`);
    const r2 = await S.claimSubject(deps, 'u_abc', 'ord_2', async (id) => id === 'ord_1');
    assert.ok(r2.ok && db.getAt('sdk_checkout_subject/u_abc').order_id === 'ord_2', `${L}: a RESOLVED held order is replaced`);
    await S.releaseSubject(deps, 'u_abc', 'ord_1');
    assert.strictEqual(db.getAt('sdk_checkout_subject/u_abc').order_id, 'ord_2', `${L}: a release for another order never deletes the current claim`);
    await S.releaseSubject(deps, 'u_abc', 'ord_2');
    assert.strictEqual(db.getAt('sdk_checkout_subject/u_abc'), null, `${L}: the owner's release deletes it`);
  });

  await cell('SDK-D4-SUBJECT-CONCURRENT', async (L) => {
    const db = makeHonestDb({});
    const deps = { db, clock: () => T0 };
    const out = await Promise.all([SUB().claimSubject(deps, 'u_x', 'ord_a', async () => false), SUB().claimSubject(deps, 'u_x', 'ord_b', async () => false)]);
    assert.strictEqual(out.filter((o) => o.ok).length, 1, `${L}: two concurrent claims of different orders ⇒ exactly one admitted (got ${JSON.stringify(out)})`);
  });

  await cell('SDK-D4-SUBJECT-REPLACE-CAS', async (L) => {
    // the held order resolves, but a THIRD claim replaces it between the check and the swap: the swap must not delete that one
    const db = makeHonestDb({ sdk_checkout_subject: { u_y: { order_id: 'ord_1', at: T0 } } });
    const deps = { db, clock: () => T0 };
    const r = await SUB().claimSubject(deps, 'u_y', 'ord_2', async () => { db.setAt('sdk_checkout_subject/u_y', { order_id: 'ord_3', at: T0 + 1 }); return true; });
    assert.ok(!r.ok && db.getAt('sdk_checkout_subject/u_y').order_id === 'ord_3', `${L}: the replacement claim survives (got ${JSON.stringify(r)}, now ${JSON.stringify(db.getAt('sdk_checkout_subject/u_y'))})`);
  });

  await cell('SDK-D4-STATUS-TABLE', async (L) => {
    const R = (o, r, opts) => ST().resolveStatus(OID, o, r, { now: T0, ...opts });
    const read = (x) => PC.readPlacement(x.body);
    // row 1: placed (with the winning attempt's card)
    const placed = R(order({ payment_placed: { leg_id: 'L1', at: T0 }, tracking_token: 'tt_1' }), rec({ legs: { L1: { kind: 'original', state: 'approved', role: 'committed' } }, attempts: { att_aaaaaaaaaaaaaaaa: att('L1', T0) } }));
    assert.strictEqual(read(placed).outcome, 'placed', `${L}: placed ⇒ the client reads placed (${JSON.stringify(placed)})`);
    assert.deepStrictEqual(placed.body.card, { brand: 'visa', last4: '4242' }, `${L}: the card label = the WINNING attempt's display`);
    // row 2 beats an unknown op: the manual lock
    const ur = R(order(), rec({ lock: { reason: 'manual_reconciliation' }, legs: { L1: { kind: 'original', state: 'unknown' } }, ops: op('L1', 1, { kind: 'unknown' }), attempts: { att_aaaaaaaaaaaaaaaa: att('L1', T0) } }));
    assert.strictEqual(read(ur).outcome, 'under_review', `${L}: manual lock beats unknown`);
    // row 3: cancelled / past the deadline
    const ex = R(order({ status: 'cancelled', payment_cancel: { kind: 'expire', at: T0 } }), rec({ phase: 'cancelled' }));
    assert.deepStrictEqual([read(ex).outcome, ex.body.safe_to_switch], ['expired', true], `${L}: cancelled ⇒ expired + safe_to_switch`);
    const late = R(order(), rec(), { now: T0 + 15 * 60 * 1000 });
    assert.deepStrictEqual([read(late).outcome, late.body.safe_to_switch], ['expired', false], `${L}: past the deadline, not yet cancelled ⇒ expired, not yet safe`);
    // row 4: approved but unplaced ⇒ the caller decides
    const dec = R(order(), rec({ legs: { L1: { kind: 'original', state: 'approved', role: 'committed' } }, attempts: { att_aaaaaaaaaaaaaaaa: att('L1', T0) } }));
    assert.deepStrictEqual(dec, { kind: 'decide', leg_id: 'L1' }, `${L}: approved + unplaced ⇒ decidePlacement`);
    // row 5: unanswered / unknown ⇒ bank_pending
    const bp = R(order(), rec({ legs: { L1: { kind: 'original', state: 'sent' } }, ops: op('L1', 1), attempts: { att_aaaaaaaaaaaaaaaa: att('L1', T0) } }));
    assert.strictEqual(read(bp).outcome, 'bank_pending', `${L}: an unanswered op ⇒ bank_pending`);
    // row 6: a challenged original (Q3) ⇒ declined / hard — never bank_pending
    const ra = R(order(), rec({ legs: { L1: { kind: 'original', state: 'requires_action', role: 'none' } }, ops: op('L1', 1, { kind: 'requires_action' }), attempts: { att_aaaaaaaaaaaaaaaa: att('L1', T0) } }));
    assert.deepStrictEqual([read(ra).outcome, read(ra).decline], ['declined', 'hard'], `${L}: declined / hard, never bank_pending (got ${JSON.stringify(ra)})`);
    // row 7: declined + its bucket; the newest attempt decides
    const dc = R(order(), rec({ legs: { L1: { kind: 'original', state: 'declined' }, L2: { kind: 'original', state: 'declined' } }, ops: { ...op('L1', 1, { kind: 'definitive_decline', code: 'Z' }), ...op('L2', 2, { kind: 'token_expired_confirmed' }) }, attempts: { att_aaaaaaaaaaaaaaaa: att('L1', T0), att_bbbbbbbbbbbbbbbb: att('L2', T0 + 5) } }));
    assert.deepStrictEqual([read(dc).outcome, read(dc).decline, dc.body.attempt_id], ['declined', 'token_expired', 'att_bbbbbbbbbbbbbbbb'], `${L}: the LATEST attempt's bucket`);
    assert.ok(!JSON.stringify(dc.body).includes('"Z"'), `${L}: never a raw code`);
    // a REPLAY applies the rows to THAT attempt
    const rp = R(order(), rec({ legs: { L1: { kind: 'original', state: 'declined' }, L2: { kind: 'original', state: 'sent' } }, ops: { ...op('L1', 1, { kind: 'definitive_decline' }), ...op('L2', 2) }, attempts: { att_aaaaaaaaaaaaaaaa: att('L1', T0), att_bbbbbbbbbbbbbbbb: att('L2', T0 + 5) } }), { attempt_id: 'att_aaaaaaaaaaaaaaaa' });
    assert.deepStrictEqual([read(rp).outcome, rp.body.attempt_id], ['declined', 'att_aaaaaaaaaaaaaaaa'], `${L}: a replay of attempt 1 answers attempt 1`);
    // placed but not yet materialized (no tracking token) keeps the client polling, never a fake «placed»
    const pending = R(order({ payment_placed: { leg_id: 'L1', at: T0 } }), rec({ legs: { L1: { kind: 'original', state: 'approved', role: 'committed' } }, attempts: { att_aaaaaaaaaaaaaaaa: att('L1', T0) } }));
    assert.strictEqual(read(pending).outcome, 'bank_pending', `${L}: placed but no tracking token yet ⇒ bank_pending (polling), never placed without its token`);
    // no attempt at all
    assert.deepStrictEqual(R(order(), rec()), { kind: 'no_attempt' }, `${L}: no attempt ⇒ the handler decides (never a guessed outcome)`);
  });

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-s2: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
