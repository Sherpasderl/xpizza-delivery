'use strict';
// Portal 1D · D4-b — EVERY LEGACY BINDING HASH IS BYTE-IDENTICAL TO PRE-D4-b CODE (plan: "Frozen legacy
// hashes"; relay hard constraint 2). The golden (catalog/d4b-legacy-hashes.golden.json) was captured ONCE
// from the REAL writers on unmodified main 717f97e by test/d4b-capture-legacy-goldens.js, which refuses to
// run on any other commit. This test re-runs the SAME writers on the SAME inputs and requires every hash
// byte-for-byte — and each golden has a SENSITIVITY PARTNER, so a comparison that could not fail is caught.
const assert = require('assert');
const { captureLegacyHashes } = require('../test/d4b-legacy-capture');
const GOLDEN = require('./d4b-legacy-hashes.golden.json');
const F = require('../test/d4b-legacy-fixtures');
const { cartFingerprint, normalizeCartForFingerprint, verifyQuoteToken } = require('../quote-token');
const { issueQuote } = require('../quote-issue');
const { computeRedemption, redemptionFingerprint } = require('../rewards-redeem');
const { orderFingerprint } = require('../pixelpay-charge');
const { reserveRedemption } = require('../rewards-reserve');
const { REDEMPTION_CONFIG_VERSION } = require('../rewards-redeem-config');
const { createFakeRtdb } = require('../test/d4b-fake-rtdb');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  assert.strictEqual(GOLDEN._provenance.captured_at_commit, '717f97e911774aa03fa285b54ee5af576067ba1a', 'premise — captured at the D4-b base');
  const now = await captureLegacyHashes();
  const kinds = Object.keys(GOLDEN.values.x_pizza);
  assert.strictEqual(kinds.length, 10);
  let compared = 0;
  for (const rid of F.RIDS) {
    for (const k of kinds) {
      assert.strictEqual(now[rid][k], GOLDEN.values[rid][k], `🔴 ${rid}.${k} changed from the pre-D4-b writer`);
      assert.match(GOLDEN.values[rid][k], /^[0-9a-f]{24}([0-9a-f]{40})?$/, `premise — ${rid}.${k} is a real digest`);
      compared += 1;
    }
    // all distinct (a constant writer would make every golden equal)
    assert.strictEqual(new Set(Object.values(GOLDEN.values[rid])).size, kinds.length, `${rid}: every golden is a different digest`);
  }
  // the B.1 collision pair: two lines {A,1,[E]} and one line {A,2,[E]} are DIFFERENT legacy carts
  for (const rid of F.RIDS) assert.notStrictEqual(GOLDEN.values[rid].quote_collision_two_lines, GOLDEN.values[rid].quote_collision_one_line);
  ok(`${compared} legacy hashes (quote ×4, redemption, order/payment ×4, reservation bindingFp) for both Restaurants reproduce the 717f97e goldens byte-for-byte; all distinct; the collision pair stays distinct`);

  // ── SENSITIVITY PARTNERS — each golden moves when its input moves ─────────────────────────────────
  for (const rid of F.RIDS) {
    const tables = F.tablesFor(rid), carts = F.cartsFor(rid);
    const red = computeRedemption({ redeem: F.redeemFor(rid), items: carts.plain, restaurantId: rid, tables });
    const norm = normalizeCartForFingerprint(carts.plain, rid);
    assert.strictEqual(cartFingerprint(norm, null), GOLDEN.values[rid].quote_plain, 'premise — the pure hasher reproduces the token value');
    const bumped = carts.plain.map((l, i) => (i === 0 ? { ...l, qty: l.qty + 1 } : l));
    assert.notStrictEqual(cartFingerprint(normalizeCartForFingerprint(bumped, rid), null), GOLDEN.values[rid].quote_plain, 'quote: a qty change moves it');
    const otherReward = { ...red, freeItems: red.freeItems.map((fi) => ({ ...fi, qty: fi.qty + 1 })) };
    assert.notStrictEqual(cartFingerprint(norm, otherReward), GOLDEN.values[rid].quote_reward, 'quote: a reward change moves it');
    assert.notStrictEqual(redemptionFingerprint({ ...red.canonical, config_version: red.canonical.config_version + 1 }), GOLDEN.values[rid].redemption_fp, 'redemption: config moves it');
    assert.notStrictEqual(orderFingerprint(F.ORDER_ID, 1, 'x', ''), GOLDEN.values[rid].order_fp_plain);
    assert.notStrictEqual(GOLDEN.values[rid].order_fp_plain, GOLDEN.values[rid].order_fp_scheduled, 'order: the scheduled extra moves it');
    assert.notStrictEqual(GOLDEN.values[rid].order_fp_plain, GOLDEN.values[rid].order_fp_redemption, 'order: the redemption moves it');
    const rdb = createFakeRtdb({ user_rewards: { [F.UID]: { [rid]: { balance: 100000, reserved: 0 } } } });
    await reserveRedemption(rdb, { uid: F.UID, rid, orderId: F.ORDER_ID, cost: red.cost, canonical: red.canonical,
      orderFingerprint: GOLDEN.values[rid].order_fp_plain, configVersion: REDEMPTION_CONFIG_VERSION, now: F.NOW });
    assert.notStrictEqual(rdb.dump().user_rewards[F.UID][rid].reservations[F.ORDER_ID].fp, GOLDEN.values[rid].reservation_binding_fp, 'reservation: a different order binding moves it');
  }
  ok('sensitivity partners: qty, reward, config, schedule, redemption and the order binding each move their golden');

  // ── NO WRITER STORES ANYTHING NEW (constraint 1): no format tag on any legacy artifact ────────────
  for (const rid of F.RIDS) {
    const tables = F.tablesFor(rid), carts = F.cartsFor(rid);
    const q = issueQuote({ items: carts.plain, reward: null, rid, tables, nowMs: F.NOW });
    const v = verifyQuoteToken(q.quote_token, process.env.QUOTE_TOKEN_SECRET, F.NOW + 1);
    assert.deepStrictEqual(Object.keys(v.payload).sort(), ['cart_fingerprint', 'components', 'customer_id', 'expires_at', 'issued_at', 'net_total_cents', 'quote_id', 'redemption_ref', 'rid'],
      `🔴 ${rid}: the signed quote payload gained or lost a field`);
    const red = computeRedemption({ redeem: F.redeemFor(rid), items: carts.plain, restaurantId: rid, tables });
    assert.ok(!('fp_format' in red.canonical) && !('v' in red.canonical), `🔴 ${rid}: the reward canonical is tagged`);
    const rdb = createFakeRtdb({ user_rewards: { [F.UID]: { [rid]: { balance: 100000, reserved: 0 } } } });
    await reserveRedemption(rdb, { uid: F.UID, rid, orderId: F.ORDER_ID, cost: red.cost, canonical: red.canonical,
      orderFingerprint: GOLDEN.values[rid].order_fp_redemption, configVersion: REDEMPTION_CONFIG_VERSION, now: F.NOW });
    const rec = rdb.dump().user_rewards[F.UID][rid].reservations[F.ORDER_ID];
    assert.deepStrictEqual(Object.keys(rec).sort(), ['canonical', 'config_version', 'cost', 'created_at', 'fp', 'order_fingerprint', 'seq', 'state', 'updated_at'],
      `🔴 ${rid}: the reservation record gained or lost a field (RTDB drops the null attempt_id/hosted_expires_at)`);
  }
  ok('no writer stores anything new: the signed quote payload, the reward canonical and the stored reservation record carry exactly today\'s fields — no fp_format / v anywhere');

  console.log(`d4b-legacy-hashes: OK (${n})`);
})().catch((e) => { console.error('d4b-legacy-hashes FAILED:', e); process.exit(1); });
