'use strict';
// D4 CORE-Δ row 24 (PLAN-sdk-d4-r11 §A0000 r10 + §A00000 r11; 5f-owned rewards-reserve.js) — a reward hold whose order is an
// SDK card order. SDK orders never redeem (§A00), so a hold on one is a hosted request's orphan that the SDK order took the id of:
//   adopted (order.redemption structurally EQUAL to rec.canonical) ⇒ today's coordinator-owned skip;
//   present but UNEQUAL ⇒ held + one create-once alert, never released / consumed;
//   NOT adopted ⇒ released only when the hold is past its expiry AND the SDK order is TERMINAL; else held (audited);
//   the r11 repair: a non-adopted expired hold whose SDK order is still pending past pay_deadline_at with NO due entry gets ONE
//   create-once payment_sdk_due entry (nothing else written), so the SDK sweeper expires the order and the next sweep releases.
// Cash / hosted / absent-order reservations are byte-identical to the base (the goldens run the BASE module beside the tip).
// The holds come from the REAL reserveRedemption; terminal states from the REAL SDK sweeper / cancelSdkOrder.
// Run: node payments/sdk/d4-row24.test.js
const assert = require('assert');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const { makeAdapter } = require('./psp-adapter');
const { makeFakePsp } = require('./fake-adapter');
const RR = require('../../rewards-reserve');
const C = require('./coordinator');
const SW = require('./sweeper');

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const X = 'tb_row24_x';
const UID = 'tb_uid24'; const RID = 'tb_rest';
const T0 = 1_800_000_000_000;
const MIN = 60 * 1000;
const CANON = { reward_id: 'rw_pizza', cost: 8, item: 'Pizza personal' };
const sdkOrder = (o = {}) => ({ payment_flow: 'sdk_auth_v1', payment_method: 'online', payment_status: 'pending', status: 'pending_payment', restaurant_id: RID, order_type: 'delivery', total: 100, total_cents: 10000, customer_uid: UID, created_at: T0, pay_deadline_at: T0 + 15 * MIN, ...o });
const RES = `user_rewards/${UID}/${RID}`;

function world({ order = sdkOrder(), extra = {} } = {}) {
  let t = T0;
  const db = makeHonestDb({ user_rewards: { [UID]: { [RID]: { balance: 100, reserved: 0 } } }, ...(order ? { orders: { [X]: order } } : {}), ...extra }, { now: () => t });
  const fake = makeFakePsp({}, {});
  const deps = { db, psp: makeAdapter(fake.impl), clock: () => t, voidEligible: () => false, ppNamespace: 'sandbox', goLive: async () => {}, releaseResources: async () => {} };
  return { db, deps, fake, now: () => t, at: (ms) => { t = ms; } };
}
// the hosted redeeming request that reserved, then crashed (never attached, never created its order): the REAL writer
const hostedReserve = (w, { hostedExpiresAt = T0 + 10 * MIN, canonicalFmt = false } = {}) => RR.reserveRedemption(w.db, {
  uid: UID, rid: RID, orderId: X, cost: 8, canonical: CANON, orderFingerprint: 'ofp_x', configVersion: 2, now: w.now(), hostedExpiresAt,
  ...(canonicalFmt ? { selectedFormat: 'canonical', canonicalBinding: () => ({ ok: true, fp: 'c1fp_x', canonical: CANON, order_fingerprint: 'c1:ofp_x', fp_format: 'canonical' }) } : {}) });
const sweep = (w) => RR.sweepStaleReservations(w.db, { now: w.now() });
const state = (w) => w.db.getAt(`${RES}/reservations/${X}/state`);
const releases = (w) => Object.values(w.db.getAt(`${RES}/ledger`) || {}).filter((e) => e && e.type === 'release').length;

(async () => {
  await cell('SDK-D4-LOST-ENROLMENT-REPAIRED', async (L) => {
    const w = world();
    assert.ok((await hostedReserve(w)).ok, `${L}: premise — the real hosted reserve`);
    assert.strictEqual(w.db.getAt(`payment_sdk_due/${X}`), null, `${L}: premise — the enrolment was retired (no due entry)`);
    w.at(T0 + 60 * MIN);
    await sweep(w);
    assert.strictEqual(w.db.getAt(`payment_sdk_due/${X}`), T0 + 60 * MIN, `${L}: the reward sweep REPAIRS the enrolment (one due entry = now)`);
    assert.strictEqual(state(w), 'reserved', `${L}: the hold is still held while X is pending`);
    await SW.sweepSdkPayments(w.deps);
    assert.strictEqual(w.db.getAt(`orders/${X}/payment_cancel/kind`), 'expire', `${L}: the SDK sweeper visits the repaired entry and EXPIRES X (record-less, past its deadline)`);
    const out = await sweep(w);
    assert.ok(state(w) === 'released' && w.db.getAt(`${RES}/reserved`) === 0 && w.db.getAt(`${RES}/balance`) === 100 && releases(w) === 1 && out.released.length === 1,
      `${L}: the NEXT reward sweep releases the hold exactly once (balance + reserved restored, ledger release) (${JSON.stringify(out)})`);
    await sweep(w);
    assert.strictEqual(releases(w), 1, `${L}: never a second release`);
  });

  await cell('SDK-D4-REPAIR-ONLY-WHEN-DUE', async (L) => {
    const cases = [
      ['before pay_deadline_at', sdkOrder({ pay_deadline_at: T0 + 90 * MIN }), {}],
      ['placed / live', sdkOrder({ status: 'new', payment_status: 'authorized', payment_placed: { leg_id: 'L1', at: T0 + MIN } }), {}],
      ['a due entry already present', sdkOrder(), { payment_sdk_due: { [X]: 123 } }],
    ];
    for (const [label, order, extra] of cases) {
      const w = world({ order, extra });
      await hostedReserve(w);
      w.at(T0 + 60 * MIN);
      await sweep(w);
      const due = w.db.getAt(`payment_sdk_due/${X}`);
      assert.strictEqual(due, extra.payment_sdk_due ? 123 : null, `${L}: ${label} ⇒ no repair write (the due entry untouched / absent; got ${due})`);
    }
  });

  await cell('SDK-D4-REPAIR-WRITES-NOTHING-ELSE', async (L) => {
    const w = world();
    await hostedReserve(w);
    w.at(T0 + 60 * MIN);
    const before = JSON.stringify({ o: w.db.getAt(`orders/${X}`), r: w.db.getAt(RES), p: w.db.getAt(`payment_sdk/${X}`), a: w.db.getAt('dispatcher_alerts') });
    await sweep(w);
    const after = JSON.stringify({ o: w.db.getAt(`orders/${X}`), r: w.db.getAt(RES), p: w.db.getAt(`payment_sdk/${X}`), a: w.db.getAt('dispatcher_alerts') });
    assert.strictEqual(after, before, `${L}: the repair changes no byte of orders/{X}, the reservation, payment_sdk/{X} or the alerts`);
  });

  await cell('SDK-D4-ORPHAN-HOLD-SDK-TERMINAL-RELEASED', async (L) => {
    for (const label of ['delivered', 'cancelled']) {
      const w = world({ order: label === 'delivered' ? sdkOrder({ status: 'delivered', payment_placed: { leg_id: 'L1', at: T0 + MIN } }) : sdkOrder() });
      await hostedReserve(w);
      if (label === 'cancelled') { const c = await C.cancelSdkOrder(w.deps, { orderId: X, kind: 'cancel' }); assert.ok(w.db.getAt(`orders/${X}/payment_cancel/kind`) === 'cancel', `${L}: premise — the REAL cancel (${JSON.stringify(c)})`); }
      w.at(T0 + 60 * MIN);
      const out = await sweep(w);
      assert.ok(state(w) === 'released' && releases(w) === 1 && out.released.length === 1, `${L}: ${label} SDK order + an expired non-adopted hold ⇒ released once (${JSON.stringify(out)})`);
      await sweep(w);
      assert.strictEqual(releases(w), 1, `${L}: ${label}: released ONCE`);
    }
  });

  await cell('SDK-D4-ORPHAN-HOLD-SDK-LIVE-HELD', async (L) => {
    const w = world({ order: sdkOrder({ status: 'new', payment_status: 'authorized', payment_placed: { leg_id: 'L1', at: T0 + MIN } }) });
    await hostedReserve(w);
    w.at(T0 + 3 * 24 * 60 * MIN);
    const out = await sweep(w);
    const rec = await RR.sweepConsumeRecovery(w.db, { now: w.now() });
    assert.ok(state(w) === 'reserved' && out.released.length === 0 && out.audited.some((a) => a.kind === 'sdk_nonadopted_held') && rec.consumed.length === 0,
      `${L}: a placed, LIVE SDK order ⇒ the hold is HELD past its expiry (audited, not released, not consumed) (${JSON.stringify({ out, rec })})`);
  });

  await cell('SDK-D4-ORPHAN-HOLD-SDK-NOT-EXPIRED-HELD', async (L) => {
    // online: hosted_expires_at still ahead; cash-shaped (no hosted expiry): younger than CASH_STALE_MS
    for (const [label, opts, at] of [['online', { hostedExpiresAt: T0 + 120 * MIN }, T0 + 60 * MIN], ['cash-shaped', { hostedExpiresAt: null }, T0 + 60 * MIN]]) {
      const w = world({ order: sdkOrder({ status: 'cancelled', payment_cancel: { kind: 'cancel', at: T0 + MIN } }) });
      await hostedReserve(w, opts);
      w.at(at);
      const out = await sweep(w);
      assert.ok(state(w) === 'reserved' && out.released.length === 0, `${L}: ${label}: a TERMINAL SDK order but the hold not yet past its expiry ⇒ held (${JSON.stringify(out)})`);
    }
    // non-vacuity: the cash-shaped hold IS released once past CASH_STALE_MS
    const w = world({ order: sdkOrder({ status: 'cancelled', payment_cancel: { kind: 'cancel', at: T0 + MIN } }) });
    await hostedReserve(w, { hostedExpiresAt: null });
    w.at(T0 + RR.CASH_STALE_MS + MIN);
    await sweep(w);
    assert.strictEqual(state(w), 'released', `${L}: premise — the cash-shaped hold is released past CASH_STALE_MS`);
  });

  await cell('SDK-D4-BINDING-MISMATCH-HELD', async (L) => {
    for (const [label, redemption] of [['a different reward', { ...CANON, reward_id: 'rw_other' }], ['a type-only difference (8 vs "8")', { ...CANON, cost: '8' }], ['an extra key', { ...CANON, extra: 1 }]]) {
      const w = world({ order: sdkOrder({ status: 'cancelled', payment_cancel: { kind: 'cancel', at: T0 + MIN }, redemption }) });
      await hostedReserve(w);
      w.at(T0 + 60 * MIN);
      const out = await sweep(w);
      const alert = w.db.getAt(`dispatcher_alerts/reward_binding_mismatch_${X}`);
      assert.ok(state(w) === 'reserved' && out.released.length === 0 && alert && alert.kind === 'reward_binding_mismatch', `${L}: ${label} ⇒ HELD + the alert, never released (${JSON.stringify({ out, alert })})`);
      w.at(T0 + 70 * MIN);
      await sweep(w);
      assert.deepStrictEqual(w.db.getAt(`dispatcher_alerts/reward_binding_mismatch_${X}`), alert, `${L}: ${label}: the alert is create-once (a later sweep leaves it as it is)`);
      const rec = await RR.sweepConsumeRecovery(w.db, { now: w.now() });
      assert.ok(state(w) === 'reserved' && rec.consumed.length === 0, `${L}: ${label}: never consumed`);
    }
  });

  await cell('SDK-D4-ADOPTED-EQUAL-C1', async (L) => {
    for (const [label, canonicalFmt] of [['legacy', false], ['canonical (c1:)', true]]) {
      const w = world({ order: sdkOrder({ status: 'cancelled', payment_cancel: { kind: 'cancel', at: T0 + MIN }, redemption: { ...CANON } }) });
      const r = await hostedReserve(w, { canonicalFmt });
      assert.ok(r.ok && (!canonicalFmt || w.db.getAt(`${RES}/reservations/${X}/order_fingerprint`) === 'c1:ofp_x'), `${L}: ${label}: premise — the real reserve (${JSON.stringify(r)})`);
      w.at(T0 + 60 * MIN);
      const out = await sweep(w);
      assert.ok(state(w) === 'reserved' && out.released.length === 0 && out.audited.some((a) => a.kind === 'sdk_flow_coordinator') && !w.db.getAt('dispatcher_alerts'),
        `${L}: ${label}: an EQUAL redemption ⇒ adopted (today's coordinator-owned skip): not released, no alert (${JSON.stringify(out)})`);
    }
  });

  // ── scope 1: cash / hosted / absent-order reservations — the BASE module and the tip act byte-identically ──
  await cell('SDK-D4-REWARD-SWEEP-GOLDENS', async (L) => {
    const repo = path.resolve(__dirname, '..', '..', '..');
    const file = path.resolve(__dirname, '..', '..', 'rewards-reserve.js');
    const baseSrc = execFileSync('git', ['-C', repo, 'show', '53edc481:xpizza-functions/rewards-reserve.js'], { encoding: 'utf8' });
    const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file)); m._compile(baseSrc, file);
    const BASE = m.exports;
    assert.notStrictEqual(BASE.sweepStaleReservations, RR.sweepStaleReservations, `${L}: premise — two distinct modules`);
    const H = 60 * MIN;
    const legacy = (o) => ({ payment_method: 'cash', status: 'new', restaurant_id: RID, order_type: 'delivery', total: 100, created_at: T0, ...o });
    const online = (o) => ({ payment_method: 'online', status: 'pending_payment', payment_status: 'pending', restaurant_id: RID, order_type: 'delivery', total: 100, created_at: T0, ...o });
    const rec = (o) => ({ state: 'reserved', cost: 8, fp: 'fp', canonical: CANON, order_fingerprint: 'ofp', config_version: 2, attempt_id: null, hosted_expires_at: null, created_at: T0, updated_at: T0, seq: 1, ...o });
    const fixtures = {
      cash_cancelled: [legacy({ status: 'cancelled' }), rec()], cash_absent: [null, rec()], cash_live_7h: [legacy(), rec()], cash_live_25h: [legacy(), rec({ created_at: T0 - 20 * H })],
      sched_overdue: [legacy({ status: 'scheduled', release_at: T0 - 10 * H }), rec()], sched_ahead: [legacy({ status: 'scheduled', release_at: T0 + 10 * H }), rec()],
      cash_nonredeeming_live: [legacy({ status: 'preparing' }), rec({ created_at: T0 + 6 * H })],
      online_failed: [online({ payment_status: 'failed' }), rec({ hosted_expires_at: T0 + H })], online_manual: [online({ payment_status: 'manual_reconciliation' }), rec({ hosted_expires_at: T0 + H })],
      online_absent: [null, rec({ hosted_expires_at: T0 + H })], online_live_paid: [online({ payment_status: 'confirmed', status: 'preparing' }), rec({ hosted_expires_at: T0 + H })],
      online_not_expired: [online(), rec({ hosted_expires_at: T0 + 30 * H })], online_delivered: [online({ payment_status: 'confirmed', status: 'delivered' }), rec({ hosted_expires_at: T0 + H })],
    };
    const seed = () => { const orders = {}; const reservations = {}; for (const [id, [o, r]] of Object.entries(fixtures)) { if (o) orders[`g_${id}`] = o; reservations[`g_${id}`] = r; }
      return { orders, user_rewards: { [UID]: { [RID]: { balance: 500, reserved: 8 * Object.keys(fixtures).length, reservations } } } }; };
    const run = async (mod) => { const db = makeHonestDb(seed(), { now: () => T0 + 7 * H }); const a = await mod.sweepStaleReservations(db, { now: T0 + 7 * H }); const b = await mod.sweepConsumeRecovery(db, { now: T0 + 7 * H }); return JSON.stringify({ a, b, root: db.root }); };
    const [b, t] = [await run(BASE), await run(RR)];
    assert.ok(JSON.parse(b).a.released.length >= 4 && JSON.parse(b).b.consumed.length >= 2, `${L}: premise — the fixtures exercise release AND consume (${b.slice(0, 200)})`);
    assert.strictEqual(t, b, `${L}: cash / hosted / absent-order reservations — the tip's sweeps act byte-identically to the base (actions + the whole tree)`);
  });

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-row24: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
