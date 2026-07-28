/**
 * Emulator behavioral suite for the reservation lifecycle (rewards-reserve.js) — the money spine. Run:
 *   firebase emulators:exec --only database --project demo-xpizza "node test/rewards-reserve.emulator.test.js"
 * Admin-context db (rules disabled). Asserts debit-first/idempotent reserve, conflict/insufficient no-debit,
 * deleted_uids pre-guard + post-commit TOCTOU, consume/held_paid/release/refuse, the single reversal API's
 * state branches, re-reserve-after-release, the Σledger.delta===balance invariant, and the orphan sweep.
 */
const assert = require('assert');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const R = require('../rewards-reserve');
const { creditEarnForOrder, reverseEarnForOrder } = require('../rewards-earn');   // real Phase-A mutators for the cross-module chain

const NOW = 1_700_000_000_000;

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: '{ "rules": { ".read": true, ".write": true } }' } });
  let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    const P = (u, r = 'x_pizza') => `user_rewards/${u}/${r}`;
    const bal = async (u, r) => (await db.ref(`${P(u, r)}/balance`).get()).val();
    const rsv = async (u, r) => (await db.ref(`${P(u, r)}/reserved`).get()).val() || 0;
    const st = async (u, o, r = 'x_pizza') => { const v = (await db.ref(`${P(u, r)}/reservations/${o}/state`).get()).val(); return v; };
    const node = async (u) => (await db.ref(`user_rewards/${u}`).get()).val();
    const ledgerSum = async (u, r = 'x_pizza') => { const l = (await db.ref(`${P(u, r)}/ledger`).get()).val() || {}; return Object.values(l).reduce((s, e) => s + (Number(e.delta) || 0), 0); };
    // seed includes the earn ledger entry that produced the balance (as Phase A would) so the
    // Σledger.delta === balance invariant is faithful, not artificially pre-violated.
    const seed = async (u, points, r = 'x_pizza') => db.ref(P(u, r)).set({ balance: points, lifetime: points, ledger: { seed_earn: { type: 'earn', delta: points, cost: 0, order_id: null, state: 'earned', ts: NOW } } });
    const canon = (over = {}) => ({ restaurant_id: 'x_pizza', model: 'discount', type: 'discount_cheapest_pizza', config_version: 1, cost: 8, discount_cents: 29900, free_item_key: 'Margherita', ...over });
    const reserve = (u, o, { c = canon(), cost = 8, fp = 'FP1', cv = 1 } = {}) => R.reserveRedemption(db, { uid: u, rid: 'x_pizza', orderId: o, cost, canonical: c, orderFingerprint: fp, configVersion: cv, now: NOW });

    // 1 — fresh reserve debits AVAILABLE (not balance), writes record + ledger; Σledger.delta === balance
    await seed('uA', 100);
    const r1 = await reserve('uA', 'O1');
    assert.deepStrictEqual({ ok: r1.ok, action: r1.action, state: r1.state }, { ok: true, action: 'created', state: 'reserved' });
    assert.strictEqual(await bal('uA'), 100); assert.strictEqual(await rsv('uA'), 8); assert.strictEqual(await st('uA', 'O1'), 'reserved');
    assert.strictEqual(await ledgerSum('uA'), 100); ok('reserve: balance untouched (100), reserved=8, record reserved, Σledger.delta===balance (reserve delta 0)');

    // 2 — same order, SAME canonical → idempotent reused, NO re-debit
    const r2 = await reserve('uA', 'O1');
    assert.deepStrictEqual({ ok: r2.ok, action: r2.action }, { ok: true, action: 'reused' });
    assert.strictEqual(await rsv('uA'), 8); ok('reserve idempotent (same canonical) → reused, reserved still 8 (no re-debit)');

    // 3 — same order, DIFFERENT binding (fingerprint) → conflict, NO debit
    const r3 = await reserve('uA', 'O1', { fp: 'FP-OTHER' });
    assert.deepStrictEqual(r3, { ok: false, reason: 'reservation_conflict' });
    assert.strictEqual(await rsv('uA'), 8); ok('reserve same order, different fingerprint → reservation_conflict, reserved unchanged (no debit)');

    // 4 — insufficient AVAILABLE → no debit
    await seed('uB', 5);
    const r4 = await reserve('uB', 'O1');
    assert.deepStrictEqual(r4, { ok: false, reason: 'insufficient' });
    assert.strictEqual(await rsv('uB'), 0); assert.strictEqual(await bal('uB'), 5); ok('reserve insufficient available → insufficient, no debit');
    // available accounts for existing holds: balance 100, reserved 8 → only 92 available; a 93 cost fails
    const r4b = await reserve('uA', 'O2', { c: canon({ free_item_key: 'X' }), cost: 93, fp: 'FP2' });
    assert.strictEqual(r4b.reason, 'insufficient'); assert.strictEqual(await rsv('uA'), 8); ok('reserve honors available = balance − reserved (92 free → cost 93 rejected)');

    // 5 — config_version mismatch → non-payable, no debit
    assert.deepStrictEqual(await reserve('uA', 'O3', { cv: 2, fp: 'FP3' }), { ok: false, reason: 'config_version_mismatch' });
    assert.strictEqual(await rsv('uA'), 8); ok('reserve config_version mismatch → non-payable, no debit');

    // 6 — deleted_uids PRE-guard: tombstoned before reserve → refused, node untouched
    await seed('uDel', 100); await db.ref('deleted_uids/uDel').set(NOW);
    assert.deepStrictEqual(await reserve('uDel', 'O1'), { ok: false, reason: 'deleted' });
    assert.strictEqual(await rsv('uDel'), 0); ok('reserve pre-guard: tombstoned uid → deleted, no reserve');

    // 7 — deleted_uids POST-commit TOCTOU: deletion lands BETWEEN pre-guard and post-recheck → node purged,
    //     points not stranded. db.ref shim: deleted_uids read null on #1 (pre), tombstoned on #2 (post).
    await seed('uRace', 100);
    let reads = 0;
    const raceDb = { ref: (path) => (path === 'deleted_uids/uRace') ? { get: async () => { reads += 1; return { val: () => (reads >= 2 ? NOW : null) }; } } : db.ref(path) };
    const rRace = await R.reserveRedemption(raceDb, { uid: 'uRace', rid: 'x_pizza', orderId: 'O1', cost: 8, canonical: canon(), orderFingerprint: 'FP1', configVersion: 1, now: NOW });
    assert.deepStrictEqual(rRace, { ok: false, reason: 'deleted' });
    assert.strictEqual(await node('uRace'), null); assert.strictEqual(reads, 2); ok('reserve post-commit TOCTOU: racing deletion → node purged, hold not stranded (both reads ran)');

    // 8 — consume realizes the debit once (never negative); 2nd consume no-op
    const c1 = await R.consumeRedemption(db, { uid: 'uA', rid: 'x_pizza', orderId: 'O1', now: NOW });
    assert.strictEqual(c1.action, 'applied'); assert.strictEqual(await bal('uA'), 92); assert.strictEqual(await rsv('uA'), 0); assert.strictEqual(await st('uA', 'O1'), 'consumed');
    assert.strictEqual(await ledgerSum('uA'), 92); ok('consume: balance 100→92, reserved 8→0, state consumed, Σledger.delta===balance (92)');
    const c2 = await R.consumeRedemption(db, { uid: 'uA', rid: 'x_pizza', orderId: 'O1', now: NOW + 1 });
    assert.strictEqual(c2.action, 'noop'); assert.strictEqual(await bal('uA'), 92); ok('consume 2nd call → noop (no double-debit)');

    // 9 — release refuses a consumed reservation
    assert.deepStrictEqual(await R.releaseRedemption(db, { uid: 'uA', rid: 'x_pizza', orderId: 'O1', now: NOW }), { ok: false, reason: 'invalid_state', state: 'consumed' });
    ok('release refuses consumed → invalid_state');

    // 10 — markHeldPaid keeps points reserved; release REFUSES held_paid; consume realizes it once
    await seed('uH', 100);
    await reserve('uH', 'OH');
    const h1 = await R.markHeldPaid(db, { uid: 'uH', rid: 'x_pizza', orderId: 'OH', now: NOW });
    assert.strictEqual(h1.action, 'applied'); assert.strictEqual(await st('uH', 'OH'), 'held_paid'); assert.strictEqual(await rsv('uH'), 8); assert.strictEqual(await bal('uH'), 100); ok('markHeldPaid: reserved held (8), balance unchanged (100), state held_paid');
    assert.deepStrictEqual(await R.releaseRedemption(db, { uid: 'uH', rid: 'x_pizza', orderId: 'OH', now: NOW }), { ok: false, reason: 'invalid_state', state: 'held_paid' });
    ok('release refuses held_paid → invalid_state');
    assert.strictEqual((await R.consumeRedemption(db, { uid: 'uH', rid: 'x_pizza', orderId: 'OH', now: NOW })).action, 'applied');
    assert.strictEqual(await bal('uH'), 92); assert.strictEqual(await rsv('uH'), 0); ok('held_paid → consume realizes debit (92), reserved 0');

    // 11 — release returns points to available (reserved→released, balance unchanged); re-reserve after release
    await seed('uR', 100);
    await reserve('uR', 'OR');
    assert.strictEqual((await R.releaseRedemption(db, { uid: 'uR', rid: 'x_pizza', orderId: 'OR', now: NOW })).action, 'applied');
    assert.strictEqual(await rsv('uR'), 0); assert.strictEqual(await bal('uR'), 100); assert.strictEqual(await st('uR', 'OR'), 'released'); ok('release: reserved→0, balance 100 (points back to available), state released');
    const rr = await reserve('uR', 'OR');   // same order+canonical, now released → re-reserve FRESH (new debit)
    assert.strictEqual(rr.action, 're_reserved'); assert.strictEqual(await rsv('uR'), 8); assert.strictEqual(await st('uR', 'OR'), 'reserved'); ok('released reservation → re_reserved fresh (new debit), never a discounted checkout on a dead hold');

    // 12 — reverseRedemptionForRefund: consumed → refund credits balance once; retry no double
    await seed('uRf', 100); await reserve('uRf', 'OC'); await R.consumeRedemption(db, { uid: 'uRf', rid: 'x_pizza', orderId: 'OC', now: NOW });
    assert.strictEqual(await bal('uRf'), 92);
    const rev1 = await R.reverseRedemptionForRefund(db, { uid: 'uRf', rid: 'x_pizza', orderId: 'OC', disposition: 'refund', now: NOW });
    assert.strictEqual(rev1.action, 'refunded'); assert.strictEqual(await bal('uRf'), 100); assert.strictEqual(await st('uRf', 'OC'), 'refunded'); ok('reverse(refund) consumed → balance +cost once (100), state refunded');
    assert.strictEqual((await R.reverseRedemptionForRefund(db, { uid: 'uRf', rid: 'x_pizza', orderId: 'OC', disposition: 'refund', now: NOW + 1 })).action, 'noop');
    assert.strictEqual(await bal('uRf'), 100); ok('reverse(refund) retry → noop (no double-credit)');

    // 13 — reverse(refund) on held_paid → releases the hold, balance UNCHANGED (points were never spent)
    await seed('uHR', 100); await reserve('uHR', 'OHR'); await R.markHeldPaid(db, { uid: 'uHR', rid: 'x_pizza', orderId: 'OHR', now: NOW });
    const rev2 = await R.reverseRedemptionForRefund(db, { uid: 'uHR', rid: 'x_pizza', orderId: 'OHR', disposition: 'refund', now: NOW });
    assert.strictEqual(rev2.action, 'released_held'); assert.strictEqual(await rsv('uHR'), 0); assert.strictEqual(await bal('uHR'), 100); assert.strictEqual(await st('uHR', 'OHR'), 'released'); ok('reverse(refund) held_paid → hold released, balance UNCHANGED (no double-credit)');

    // 14 — reverse(sale) on held_paid → consumes the debit (manual finalize-to-sale)
    await seed('uS', 100); await reserve('uS', 'OS'); await R.markHeldPaid(db, { uid: 'uS', rid: 'x_pizza', orderId: 'OS', now: NOW });
    const rev3 = await R.reverseRedemptionForRefund(db, { uid: 'uS', rid: 'x_pizza', orderId: 'OS', disposition: 'sale', now: NOW });
    assert.strictEqual(rev3.action, 'consumed'); assert.strictEqual(await bal('uS'), 92); assert.strictEqual(await rsv('uS'), 0); assert.strictEqual(await st('uS', 'OS'), 'consumed'); ok('reverse(sale) held_paid → consumed (balance −cost once), state consumed');

    // 15 — reverse(refund) reserved-unpaid → release; absent → noop
    await seed('uU', 100); await reserve('uU', 'OU');
    assert.strictEqual((await R.reverseRedemptionForRefund(db, { uid: 'uU', rid: 'x_pizza', orderId: 'OU', disposition: 'refund', now: NOW })).action, 'released');
    assert.strictEqual(await rsv('uU'), 0); ok('reverse(refund) reserved-unpaid → released');
    assert.strictEqual((await R.reverseRedemptionForRefund(db, { uid: 'uU', rid: 'x_pizza', orderId: 'NOPE', disposition: 'refund', now: NOW })).absent, true); ok('reverse absent reservation → benign noop');

    // 16 — attachAttempt records attempt_id + hosted_expires_at (money-neutral)
    await seed('uAt', 100); await reserve('uAt', 'OA');
    await R.attachAttempt(db, { uid: 'uAt', rid: 'x_pizza', orderId: 'OA', attemptId: 'att_1', hostedExpiresAt: NOW + 1000, now: NOW });
    const recA = (await db.ref(`${P('uAt')}/reservations/OA`).get()).val();
    assert.strictEqual(recA.attempt_id, 'att_1'); assert.strictEqual(recA.hosted_expires_at, NOW + 1000); assert.strictEqual(recA.state, 'reserved'); assert.strictEqual(await rsv('uAt'), 8); ok('attachAttempt: attempt_id + hosted_expires_at set, state reserved, money-neutral');

    // 17 — sweep releases RESERVED orphans only (online-expired, cash-cancelled, cash-orphan); never held/consumed.
    // Reset the tree first — the sweep scans ALL user_rewards, and prior cases left live reservations behind.
    await db.ref('user_rewards').set(null); await db.ref('orders').set(null);
    await db.ref('user_rewards/uSw/x_pizza').set({
      balance: 100, reserved: 40,
      reservations: {
        ONLINE_EXP: { state: 'reserved', cost: 8, seq: 1, created_at: NOW - 10, hosted_expires_at: NOW - 1 },   // expired
        ONLINE_LIVE: { state: 'reserved', cost: 8, seq: 1, created_at: NOW - 10, hosted_expires_at: NOW + 10_000 }, // live
        CASH_ORPHAN: { state: 'reserved', cost: 8, seq: 1, created_at: NOW - 10 },                                 // no order
        CASH_LIVE: { state: 'reserved', cost: 8, seq: 1, created_at: NOW - 10 },                                   // live young
        HELD: { state: 'held_paid', cost: 8, seq: 1, created_at: NOW - 10 },
        DONE: { state: 'consumed', cost: 8, seq: 1, created_at: NOW - 10 },
      },
    });
    await db.ref('orders/CASH_LIVE/status').set('preparing');   // live → keep
    const sweep = await R.sweepStaleReservations(db, { now: NOW });
    const releasedIds = sweep.released.map((x) => x.orderId).sort();
    assert.deepStrictEqual(releasedIds, ['CASH_ORPHAN', 'ONLINE_EXP']);
    assert.strictEqual(await st('uSw', 'ONLINE_EXP'), 'released'); assert.strictEqual(await st('uSw', 'CASH_ORPHAN'), 'released');
    assert.strictEqual(await st('uSw', 'ONLINE_LIVE'), 'reserved'); assert.strictEqual(await st('uSw', 'CASH_LIVE'), 'reserved');
    assert.strictEqual(await st('uSw', 'HELD'), 'held_paid'); assert.strictEqual(await st('uSw', 'DONE'), 'consumed');
    assert.strictEqual(await rsv('uSw'), 40 - 8 - 8); ok('sweep: releases online-expired + cash-orphan reserved only; leaves live/held/consumed; reserved decremented by released holds');

    // 18 — sweep audits (does NOT release) an aged-but-still-live cash order
    await db.ref('user_rewards/uSw2/x_pizza').set({ balance: 100, reserved: 8, reservations: { CASH_AGED: { state: 'reserved', cost: 8, seq: 1, created_at: NOW - (R.CASH_STALE_MS + 1) } } });
    await db.ref('orders/CASH_AGED/status').set('preparing');
    const sweep2 = await R.sweepStaleReservations(db, { now: NOW });
    assert.ok(sweep2.audited.some((a) => a.orderId === 'CASH_AGED'));
    assert.ok(!sweep2.released.some((x) => x.orderId === 'CASH_AGED'));
    assert.strictEqual(await st('uSw2', 'CASH_AGED'), 'reserved'); ok('sweep: aged-but-live cash order → audited, NOT auto-released (never strand a live order)');

    // 26 — [money-gate cross-module chain] the exact reported chain: earn X → reserve Y → clawback X →
    //      consume Y → refund Y. Assert NO free discount (consume debits full cost) and NO minting (refund
    //      credits only debit_applied). Uses the REAL Phase-A creditEarn/reverseEarn on the same node.
    await db.ref('user_rewards').set(null); await db.ref('orders').set(null); await db.ref('deleted_uids').set(null);
    await db.ref('orders/X').set({ customer_uid: 'uZ', restaurant_id: 'x_pizza', items: [{ qty: 8 }] });   // 8 pizzas → 8 punches
    assert.strictEqual((await creditEarnForOrder(db, { orderId: 'X', order: (await db.ref('orders/X').get()).val(), now: NOW })).credited, true);
    assert.strictEqual(await bal('uZ'), 8);
    assert.strictEqual((await reserve('uZ', 'Y')).action, 'created'); assert.strictEqual(await rsv('uZ'), 8);   // reserve 8 → available 0
    await reverseEarnForOrder(db, { orderId: 'X', order: (await db.ref('orders/X').get()).val(), now: NOW + 1 });   // X refunded → clawback
    assert.strictEqual(await bal('uZ'), 8); assert.ok((await bal('uZ')) >= (await rsv('uZ'))); ok('chain: clawback of the earning order cannot under-collateralize the live reserve (balance 8 ≥ reserved 8)');
    await R.consumeRedemption(db, { uid: 'uZ', rid: 'x_pizza', orderId: 'Y', now: NOW + 2 });                 // Y completes → consume
    assert.strictEqual(await bal('uZ'), 0);
    assert.strictEqual((await db.ref(`${P('uZ')}/reservations/Y/debit_applied`).get()).val(), 8); ok('chain: consume debits the FULL cost (debit_applied 8, no free discount)');
    await R.reverseRedemptionForRefund(db, { uid: 'uZ', rid: 'x_pizza', orderId: 'Y', disposition: 'refund', now: NOW + 3 });   // Y refunded
    assert.strictEqual(await bal('uZ'), 8); assert.strictEqual(await ledgerSum('uZ'), 8); ok('chain: refund credits only debit_applied (8) → NO minting; Σledger.delta===balance');

    // 27 — [Part 2/3 belt-and-suspenders] even if balance < reserved somehow (invariant violated), consume
    //      debits only what's there (no silent free discount → alerted) and refund credits only debit_applied.
    await db.ref('dispatcher_alerts').set(null);
    await db.ref('user_rewards/uUC/x_pizza').set({ balance: 3, reserved: 8, lifetime: 8,
      reservations: { OU: { state: 'reserved', cost: 8, seq: 1, fp: 'X', created_at: NOW } }, ledger: { seed: { type: 'earn', delta: 3, ts: NOW } } });
    await R.consumeRedemption(db, { uid: 'uUC', rid: 'x_pizza', orderId: 'OU', now: NOW });
    assert.strictEqual(await bal('uUC'), 0);
    assert.strictEqual((await db.ref(`${P('uUC')}/reservations/OU/debit_applied`).get()).val(), 3); ok('safety-net: under-collateralized consume debits only 3 (not 8), records debit_applied=3');
    const alerts = Object.values((await db.ref('dispatcher_alerts').get()).val() || {});
    assert.ok(alerts.some((a) => a.type === 'rewards_undercollateralized' && a.order_id === 'OU' && a.shortfall === 5)); ok('safety-net: under-collateralization → dispatcher alert (shortfall 5), not a silent free discount');
    await R.reverseRedemptionForRefund(db, { uid: 'uUC', rid: 'x_pizza', orderId: 'OU', disposition: 'refund', now: NOW + 1 });
    assert.strictEqual(await bal('uUC'), 3); ok('safety-net: refund credits only debit_applied (3), NOT cost (8) → no minting');

    // ── [T6 R1] online binds hosted_expires_at AT RESERVE → an unattached hold is sweep-visible immediately ──
    await db.ref('user_rewards').set(null); await db.ref('orders').set(null);
    await seed('uHE', 100);
    await R.reserveRedemption(db, { uid: 'uHE', rid: 'x_pizza', orderId: 'OHE', cost: 8, canonical: canon(), orderFingerprint: 'FPHE', configVersion: 1, now: NOW, hostedExpiresAt: NOW - 1 });
    assert.strictEqual((await db.ref(`${P('uHE')}/reservations/OHE/hosted_expires_at`).get()).val(), NOW - 1);
    assert.strictEqual((await db.ref(`${P('uHE')}/reservations/OHE/attempt_id`).get()).val(), null); ok('online reserve binds hosted_expires_at at RESERVE (attempt_id still null — attach refines later)');
    const sweepHE = await R.sweepStaleReservations(db, { now: NOW });   // NO attachAttempt ever ran
    assert.ok(sweepHE.released.some((x) => x.orderId === 'OHE' && x.kind === 'online_expired'));
    assert.strictEqual(await st('uHE', 'OHE'), 'released'); ok('unattached online hold → sweep releases on expiry (no orphan even if attach never lands — crash/attach-fail closed)');
    // cash reserve (no hostedExpiresAt) stays null → its sweep branch stays order-status-driven, unchanged
    await seed('uCa', 100);
    await R.reserveRedemption(db, { uid: 'uCa', rid: 'x_pizza', orderId: 'OCA', cost: 8, canonical: canon(), orderFingerprint: 'FPCA', configVersion: 1, now: NOW });
    assert.strictEqual((await db.ref(`${P('uCa')}/reservations/OCA/hosted_expires_at`).get()).val(), null); ok('cash reserve leaves hosted_expires_at null (order-status-driven sweep, unchanged)');
  });

  await env.cleanup();
  console.log(`\nrewards-reserve: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
