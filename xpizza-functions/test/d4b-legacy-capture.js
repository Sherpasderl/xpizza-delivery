'use strict';
// Portal 1D · D4-b — compute every LEGACY binding hash through the REAL writers, for both Restaurants:
//   • the quote's cart_fingerprint, read out of a REAL signed token from issueQuote (plain + reward + the
//     B.1 collision pair);
//   • redemptionFingerprint over the REAL computeRedemption canonical;
//   • the order/payment fingerprint through the REAL createOrder recompute (computeIncomingFingerprint),
//     ASAP and scheduled, plain and redemption (the redemption path runs the real prepareRedemption);
//   • the reservation bindingFp as STORED by the real reserveRedemption (it is not exported — the stored
//     record is the artifact the CAS compares, so that is what is frozen).
// Used by test/d4b-capture-legacy-goldens.js (ONCE, on unmodified main 717f97e) and by
// catalog/d4b-legacy-hashes.test.js (every gate run), so both see exactly one computation.
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'd4b-golden-secret';
const { issueQuote } = require('../quote-issue');
const { computeRedemption, redemptionFingerprint } = require('../rewards-redeem');
const { computeIncomingFingerprint } = require('../createorder-classify');
const { prepareRedemption } = require('../rewards-redeem-intake');
const { orderFingerprint } = require('../pixelpay-charge');
const { orderBreakdownCents } = require('../order-money');
const { computeServerTotal } = require('../menu-pricing');
const SCHED = require('../scheduled-orders');
const { reserveRedemption } = require('../rewards-reserve');
const { REDEMPTION_CONFIG_VERSION } = require('../rewards-redeem-config');
const { createFakeRtdb } = require('./d4b-fake-rtdb');
const F = require('./d4b-legacy-fixtures');

const tokenFp = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).cart_fingerprint;

async function captureLegacyHashes() {
  const out = {};
  for (const rid of F.RIDS) {
    const tables = F.tablesFor(rid), carts = F.cartsFor(rid), redeem = F.redeemFor(rid);
    const o = {};
    const red = computeRedemption({ redeem, items: carts.plain, restaurantId: rid, tables });
    if (!red.ok) throw new Error(`fixture redeem rejected for ${rid}: ${red.reason}`);
    // — quote cart_fingerprint, from a real signed token —
    const q = (items, reward) => { const r = issueQuote({ items, reward, rid, tables, nowMs: F.NOW }); if (!r.ok || !r.quote_token) throw new Error(`quote not issued for ${rid}: ${JSON.stringify(r)}`); return tokenFp(r.quote_token); };
    o.quote_plain = q(carts.plain, null);
    o.quote_reward = q(carts.plain, red);
    o.quote_collision_two_lines = q(carts.collisionTwo, null);
    o.quote_collision_one_line = q(carts.collisionOne, null);
    // — redemption fingerprint —
    o.redemption_fp = redemptionFingerprint(red.canonical);
    // — order / payment fingerprint, through the real createOrder recompute —
    const db = createFakeRtdb({ config: { redemption_enabled: true } });
    const deps = { orderBreakdownCents, prepareRedemption, orderFingerprint, schedFingerprintExtra: SCHED.fingerprintExtra, db, tables, eligible: null };
    const serverTotal = computeServerTotal(carts.plain, rid, tables).total;   // the REAL total (lempiras) — what createOrder passes
    const base = { orderId: F.ORDER_ID, restaurantId: rid, total: serverTotal, itemsText: `2x ${carts.plain[0].name} | 1x ${carts.plain[1].name}`, items: carts.plain, customerUid: F.UID, orderType: 'delivery' };
    o.order_fp_plain = await computeIncomingFingerprint({ ...base, redeem: null, scheduledForRaw: undefined }, deps);
    o.order_fp_scheduled = await computeIncomingFingerprint({ ...base, redeem: null, scheduledForRaw: F.SCHEDULED_FOR }, deps);
    o.order_fp_redemption = await computeIncomingFingerprint({ ...base, redeem, scheduledForRaw: undefined }, deps);
    o.order_fp_redemption_scheduled = await computeIncomingFingerprint({ ...base, redeem, scheduledForRaw: F.SCHEDULED_FOR }, deps);
    for (const k of ['order_fp_plain', 'order_fp_scheduled', 'order_fp_redemption', 'order_fp_redemption_scheduled']) {
      if (typeof o[k] !== 'string' || !/^[0-9a-f]{64}$/.test(o[k])) throw new Error(`${rid}.${k} did not produce a fingerprint (${o[k]})`);
    }
    // — reservation bindingFp, as stored by the real reserveRedemption —
    const rdb = createFakeRtdb({ user_rewards: { [F.UID]: { [rid]: { balance: 100000, reserved: 0 } } } });
    const rr = await reserveRedemption(rdb, { uid: F.UID, rid, orderId: F.ORDER_ID, cost: red.cost, canonical: red.canonical,
      orderFingerprint: o.order_fp_redemption, configVersion: REDEMPTION_CONFIG_VERSION, now: F.NOW });
    if (!rr.ok) throw new Error(`reserve failed for ${rid}: ${rr.reason}`);
    o.reservation_binding_fp = rdb.dump().user_rewards[F.UID][rid].reservations[F.ORDER_ID].fp;
    out[rid] = o;
  }
  return out;
}

module.exports = { captureLegacyHashes };
