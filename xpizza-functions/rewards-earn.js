'use strict';

// Impure earn engine (Phase A) — Admin-SDK writes ONLY. Mark-before-credit (the notifyPickupReady /
// order-received pattern): claim an idempotency marker via transaction BEFORE mutating balance, so a
// duplicate trigger / retry can't double-credit. Balance + lifetime are per-LEAF transactions (never a
// whole-node write) so a concurrent ledger push can't be clobbered. Immutable append-only ledger, every
// entry stamped with config_version. All three functions fail-open (log, never throw) — earn is additive,
// not money-path. Timestamps come from the `now` argument (no ServerValue dep → unit/emulator-testable).
const { computeEarn, ledgerEntry, REWARDS_CONFIG } = require('./rewards-core');

async function applyDelta(db, uid, rid, delta) {
  await db.ref(`user_rewards/${uid}/${rid}/balance`).transaction((cur) => (Number(cur) || 0) + delta);
  if (delta > 0) await db.ref(`user_rewards/${uid}/${rid}/lifetime`).transaction((cur) => (Number(cur) || 0) + delta);   // lifetime = cumulative EARNED; a clawback reduces balance only
}
async function pushLedger(db, uid, rid, entry) {
  await db.ref(`user_rewards/${uid}/${rid}/ledger`).push(entry);
}

// Credit earn for a completed order. NO-OP for a guest (no customer_uid) or a zero-delta order. Marker
// stores {at, delta} so reversal is a single read. At-most-once via the marker claim.
async function creditEarnForOrder(db, { orderId, order, now }) {
  try {
    if (!order || !order.customer_uid) return { credited: false, delta: 0 };
    const uid = order.customer_uid;
    const rid = order.restaurant_id || 'x_pizza';
    const { delta } = computeEarn({ items: order.items, subtotalCents: Number(order.subtotal_cents), restaurantId: rid });
    if (!Number.isInteger(delta) || delta <= 0) return { credited: false, delta: 0 };
    let claim;
    try { claim = await db.ref(`orders/${orderId}/rewards_earned_at`).transaction((cur) => (cur ? undefined : { at: now, delta })); }
    catch (e) { console.warn(`rewards earn: claim failed ${orderId}`, e && e.message); return { credited: false, delta: 0 }; }
    if (!claim.committed) return { credited: false, delta: 0 };   // already earned
    await applyDelta(db, uid, rid, delta);
    await pushLedger(db, uid, rid, ledgerEntry({ type: 'earn', delta, orderId, now }));
    return { credited: true, delta };
  } catch (e) { console.error(`rewards earn: failed ${orderId}`, e && e.message); return { credited: false, delta: 0 }; }
}

// Welcome bonus — once per phone_hash per brand. The reward_welcome/{phoneHash}/{rid} tombstone survives
// account deletion (account-lib does NOT delete it) → un-farmable.
async function creditWelcome(db, { uid, phoneHash, restaurantId, now }) {
  try {
    if (!uid || !phoneHash) return { credited: false };
    const cfg = REWARDS_CONFIG[restaurantId];
    if (!cfg || !(cfg.welcome > 0)) return { credited: false };
    let claim;
    try { claim = await db.ref(`reward_welcome/${phoneHash}/${restaurantId}`).transaction((cur) => (cur ? undefined : now)); }
    catch (e) { console.warn(`rewards welcome: claim failed`, e && e.message); return { credited: false }; }
    if (!claim.committed) return { credited: false };   // already welcomed on this brand
    await applyDelta(db, uid, restaurantId, cfg.welcome);
    await pushLedger(db, uid, restaurantId, ledgerEntry({ type: 'welcome', delta: cfg.welcome, now }));
    return { credited: true };
  } catch (e) { console.error(`rewards welcome: failed`, e && e.message); return { credited: false }; }
}

// Reverse earn on refund. Idempotent (its own rewards_reversed_at claim); only if the order actually
// earned (reads the earn marker's stored delta). No-op if never earned or already reversed.
async function reverseEarnForOrder(db, { orderId, order, now }) {
  try {
    if (!order || !order.customer_uid) return { reversed: false };
    const uid = order.customer_uid;
    const rid = order.restaurant_id || 'x_pizza';
    const earn = (await db.ref(`orders/${orderId}/rewards_earned_at`).get()).val();
    const earned = earn && Number(earn.delta);
    if (!Number.isFinite(earned) || earned <= 0) return { reversed: false };   // never earned → nothing to reverse
    let claim;
    try { claim = await db.ref(`orders/${orderId}/rewards_reversed_at`).transaction((cur) => (cur ? undefined : now)); }
    catch (e) { console.warn(`rewards reverse: claim failed ${orderId}`, e && e.message); return { reversed: false }; }
    if (!claim.committed) return { reversed: false };   // already reversed
    await applyDelta(db, uid, rid, -earned);
    await pushLedger(db, uid, rid, ledgerEntry({ type: 'clawback', delta: -earned, orderId, now }));
    return { reversed: true };
  } catch (e) { console.error(`rewards reverse: failed ${orderId}`, e && e.message); return { reversed: false }; }
}

module.exports = { creditEarnForOrder, creditWelcome, reverseEarnForOrder };
