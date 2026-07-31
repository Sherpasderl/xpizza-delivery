'use strict';

// Impure earn engine (Phase A) — Admin-SDK writes ONLY. Crash-safe + idempotent by construction:
// EVERY mutation is a SINGLE transaction on user_rewards/{uid}/{rid} keyed by a DETERMINISTIC ledger id
// (earn_${orderId} / welcome_${phoneHash}_${rid} / reverse_${orderId}). Inside the transaction: if that
// ledger key already exists → abort unchanged (idempotent); else apply balance + lifetime + the ledger
// entry TOGETHER (no partial-state window, and a crash-retry re-applies because the key isn't there yet).
// The ledger key is the sole authority — there is no separate order-node marker to lose or desync.
//
// Guards (codex R1):
//   • deleted_uids/{uid} tombstone → NEVER recreate a purged node (no zombie ledger after account deletion).
//   • reversal clamps balance to >= 0 and NEVER recreates an absent node; lifetime never decrements.
// All functions fail-open (log, never throw) — earn is additive, not money-path. Timestamps from `now`.
const { computeEarn, ledgerEntry, REWARDS_CONFIG } = require('./rewards-core');

async function isDeleted(db, uid) {
  return (await db.ref(`deleted_uids/${uid}`).get()).val() != null;   // user-initiated deletion tombstone
}

// Atomic CREDIT (positive delta: earn / welcome) on the per-brand node, idempotent on `ledgerId`.
// Applies balance + lifetime + ledger entry in ONE transaction. Returns { applied } — true only when THIS
// call landed the entry (a duplicate/idempotent retry returns false). Creates the node on first credit.
//
// TOCTOU close (codex R2): the caller's pre-guard reads deleted_uids BEFORE this tx, so a deletion can land
// in the gap and this tx would recreate a just-purged node. We RE-CHECK deleted_uids AFTER committing and
// compensate — null user_rewards/{uid} — if it's now tombstoned. Deletion writes the tombstone and the
// user_rewards/{uid} null ATOMICALLY (account-lib's single update map), so this read either sees the
// tombstone (→ we purge our zombie) or the deletion's own null removes the node. No residual window.
async function creditNode(db, uid, rid, ledgerId, delta, entry) {
  const ref = db.ref(`user_rewards/${uid}/${rid}`);
  const tx = await ref.transaction((cur) => {
    cur = cur || {};
    if (cur.ledger && cur.ledger[ledgerId] !== undefined) return;                 // already applied → idempotent abort
    const next = { ...cur, balance: (Number(cur.balance) || 0) + delta, ledger: { ...(cur.ledger || {}), [ledgerId]: entry } };
    next.lifetime = (Number(cur.lifetime) || 0) + (delta > 0 ? delta : 0);         // lifetime = cumulative EARNED only
    return next;
  });
  if (tx.committed && await isDeleted(db, uid)) {                                  // a deletion raced in around our write
    await db.ref(`user_rewards/${uid}`).set(null);                                 // compensate: purge the recreated zombie node
    return { applied: false };
  }
  return { applied: !!tx.committed };
}

// Credit earn for a completed order. NO-OP for guest / zero-delta / a tombstoned (deleted) uid. At-most-once
// via the earn_${orderId} ledger key — which is ALSO the authoritative earned amount the reversal reads back.
async function creditEarnForOrder(db, { orderId, order, now }) {
  try {
    if (!order || !order.customer_uid) return { credited: false, delta: 0 };
    const uid = order.customer_uid;
    const rid = order.restaurant_id || 'x_pizza';
    // v2: NO redemption adjustment. Both brands are ADD-FREE — the free item never enters order.items (X. Pizza
    // punch counts Σqty of the PAID cart only) and is a 0-price line absent from subtotal_cents (La Musa points),
    // so computeEarn over the PAID order already earns the correct amount (design-gate refinement #7).
    const { delta: earnDelta } = computeEarn({ items: order.items, subtotalCents: Number(order.subtotal_cents), restaurantId: rid });
    if (!Number.isInteger(earnDelta) || earnDelta <= 0) return { credited: false, delta: 0 };
    if (await isDeleted(db, uid)) return { credited: false, delta: 0 };            // never recreate a purged node
    const { applied } = await creditNode(db, uid, rid, `earn_${orderId}`, earnDelta, ledgerEntry({ type: 'earn', delta: earnDelta, orderId, now }));
    return { credited: applied, delta: applied ? earnDelta : 0 };
  } catch (e) { console.error(`rewards earn: failed ${orderId}`, e && e.message); return { credited: false, delta: 0 }; }
}

// Welcome bonus — once per phone_hash per brand. The reward_welcome/{phoneHash}/{rid} tombstone (server-only,
// survives account deletion — account-lib does NOT delete it) is the cross-uid un-farmable gate; the
// welcome_${phoneHash}_${rid} ledger key makes the balance apply crash-safe within the uid.
async function creditWelcome(db, { uid, phoneHash, restaurantId, now }) {
  try {
    if (!uid || !phoneHash) return { credited: false };
    const cfg = REWARDS_CONFIG[restaurantId];
    if (!cfg || !(cfg.welcome > 0)) return { credited: false };
    if (await isDeleted(db, uid)) return { credited: false };                      // never recreate a purged node
    let claim;
    try { claim = await db.ref(`reward_welcome/${phoneHash}/${restaurantId}`).transaction((cur) => (cur ? undefined : now)); }
    catch (e) { console.warn(`rewards welcome: claim failed`, e && e.message); return { credited: false }; }
    if (!claim.committed) return { credited: false };                              // already welcomed on this brand (any uid)
    const { applied } = await creditNode(db, uid, restaurantId, `welcome_${phoneHash}_${restaurantId}`, cfg.welcome,
      ledgerEntry({ type: 'welcome', delta: cfg.welcome, now }));
    return { credited: applied };
  } catch (e) { console.error(`rewards welcome: failed`, e && e.message); return { credited: false }; }
}

// Reverse earn on refund/cancel. Idempotent (reverse_${orderId} ledger key), self-guarded (no-op unless the
// order actually earned — reads the authoritative earn_${orderId} entry), NEVER recreates an absent/deleted
// node. A clawback reclaims only UNCOMMITTED balance (balance − reserved), so it can never drop balance below
// the points already held by an in-flight redemption — maintaining the balance >= reserved invariant the B1
// reservation layer depends on (Phase-B1 money-gate: a clawback of the earning order must not under-
// collateralize a live reserve → free discount + minted points). Lifetime is untouched (clawback ≠ un-earn).
async function reverseEarnForOrder(db, { orderId, order, now }) {
  try {
    if (!order || !order.customer_uid) return { reversed: false };
    const uid = order.customer_uid;
    const rid = order.restaurant_id || 'x_pizza';
    if (await isDeleted(db, uid)) return { reversed: false };                      // purged node → nothing to reverse
    const earnEntry = (await db.ref(`user_rewards/${uid}/${rid}/ledger/earn_${orderId}`).get()).val();
    const earned = earnEntry && Number(earnEntry.delta);
    if (!Number.isFinite(earned) || earned <= 0) return { reversed: false };       // never earned → no-op
    const reverseId = `reverse_${orderId}`;
    const ref = db.ref(`user_rewards/${uid}/${rid}`);
    const tx = await ref.transaction((cur) => {
      if (cur === null) return null;                                               // null-first-safe; absent → no recreate
      if (cur.ledger && cur.ledger[reverseId] !== undefined) return;               // already reversed → idempotent abort
      const oldBal = Number(cur.balance) || 0;
      const reserved = Number(cur.reserved) || 0;
      const reduction = Math.min(earned, Math.max(0, oldBal - reserved));          // reclaim ONLY uncommitted balance
      const balance = oldBal - reduction;                                          // ≥ reserved (and ≥ 0); never mints
      return { ...cur, balance, ledger: { ...(cur.ledger || {}), [reverseId]: ledgerEntry({ type: 'clawback', delta: -reduction, orderId, now }) } };   // delta = ACTUAL reduction → Σledger survives the clamp
    });
    const v = tx.snapshot.val();
    return { reversed: !!(tx.committed && v && v.ledger && v.ledger[reverseId] !== undefined) };   // true only if the clawback landed now
  } catch (e) { console.error(`rewards reverse: failed ${orderId}`, e && e.message); return { reversed: false }; }
}

module.exports = { creditEarnForOrder, creditWelcome, reverseEarnForOrder };
