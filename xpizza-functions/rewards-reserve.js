'use strict';

// Rewards Phase B1 — redemption reservation lifecycle (THE money spine). Admin-SDK ONLY. Mirrors
// payment_attempts (reserve → consume-on-completion → release-on-failure, keyed by order_id) and reuses the
// Phase-A discipline: EVERY mutation is ONE atomic transaction on user_rewards/{uid}/{rid}, so balance +
// reserved + the reservation record + the audit ledger move together. Idempotency is enforced by the
// reservation STATE MACHINE (a transition fires only from its allowed prior state; a repeat is a no-op).
//
// State model on user_rewards/{uid}/{rid}:
//   balance   — spendable points (Phase A).       reserved — points HELD by open reservations (not yet spent).
//   available = balance - reserved                 (what a fresh reserve must cover).
//   reservations/{orderId} = { state, cost, fp, canonical, order_fingerprint, config_version, attempt_id,
//                              hosted_expires_at, created_at, updated_at, seq }
//   ledger/rsv_{orderId}_{seq} = { type, delta, cost, order_id, state, ts }   (delta = the BALANCE change;
//   reserve/release/held_paid are delta 0, so Σ ledger.delta === balance holds throughout — a gate invariant.)
//
// States: reserved → consumed | released ; plus held_paid (money captured, awaiting dispatcher resolve) and
// refunded (a consumed redemption reversed). Debit is realized (balance−=cost) only at CONSUME; reserve just
// moves points into `reserved`. deleted_uids: a single-node txn can't read it atomically → pre-read guard +
// post-commit recheck that compensates (purge the recreated node) — same as Phase A.
const crypto = require('crypto');
const { REDEMPTION_CONFIG_VERSION } = require('./rewards-redeem-config');

// Cash reservations have no hosted-checkout expiry; a cash order still 'reserved' this long after create with
// no terminal state is treated as an orphan candidate by the sweep (policy — tune with ops).
const CASH_STALE_MS = 6 * 60 * 60 * 1000;   // 6h — a live cash hold past this is SURFACED (held + durable alert) for ops
const CASH_LIVE_SLA_MS = 24 * 60 * 60 * 1000;   // 24h [F/#22] — a still-live cash hold a full service-day past any real cash-order lifecycle is definitively abandoned → AUTO-release (the consume-after-release backstop covers a botched late completion)
const SCHED_OVERDUE_GRACE_MS = 6 * 60 * 60 * 1000;   // 6h [F/#22] — grace past a scheduled order's release_at before its still-un-materialized (never-delivered → never-consumed → mint-safe) hold is auto-released
const TERMINAL_CANCEL = new Set(['cancelled']);
const LIVE_STATES = new Set(['new', 'preparing', 'ready', 'out_for_delivery', 'scheduled', 'releasing', 'pending_payment']);

async function isDeleted(db, uid) {
  return (await db.ref(`deleted_uids/${uid}`).get()).val() != null;
}

// Deterministic binding hash: same order_id may be reused ONLY for the exact same {order, reward, version}.
function bindingFp({ canonical, orderFingerprint, configVersion }) {
  const stable = JSON.stringify({
    c: canonical ? Object.keys(canonical).sort().reduce((o, k) => (o[k] = canonical[k], o), {}) : null,
    o: orderFingerprint || null,
    v: configVersion,
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}

const ledgerKey = (orderId, seq) => `rsv_${orderId}_${seq}`;
const entry = (type, delta, cost, orderId, state, ts) => ({ type, delta, cost, order_id: orderId, state, ts });

// Part 3 (money-gate): a consume that debits LESS than cost means the reserve was under-collateralized (a
// concurrent Phase-A clawback should now be prevented by the reserve-aware clamp, but this surfaces any
// residual instead of silently granting a free discount). Best-effort dispatcher alert; never blocks consume.
async function alertIfUndercollateralized(db, { uid, rid, orderId, now }) {
  try {
    const rec = (await db.ref(`user_rewards/${uid}/${rid}/reservations/${orderId}`).get()).val();
    if (rec && Number(rec.debit_applied) < Number(rec.cost)) {
      await db.ref('dispatcher_alerts').push({ type: 'rewards_undercollateralized', order_id: orderId, uid, rid,
        cost: Number(rec.cost), debit_applied: Number(rec.debit_applied), shortfall: Number(rec.cost) - Number(rec.debit_applied), created_at: now });
    }
  } catch (e) { console.warn('rewards undercollateralized alert failed', e && e.message); }
}

// ── reserveRedemption ─────────────────────────────────────────────────────────────────────────────────
// Debit-first (into `reserved`) + idempotent by order_id + bound to the canonical/fingerprint. Returns
// explicit `action` so the online handler knows if IT owns the hold: created/re_reserved = this call took the
// debit (release on abandon); reused = a pre-existing hold (NEVER release on failure).
async function reserveRedemption(db, { uid, rid, orderId, cost, canonical, orderFingerprint, configVersion, now, hostedExpiresAt = null }) {
  try {
    if (!uid || !rid || !orderId || !(Number.isInteger(cost) && cost > 0)) return { ok: false, reason: 'bad_request' };
    if (!Number.isInteger(configVersion) || configVersion !== REDEMPTION_CONFIG_VERSION) return { ok: false, reason: 'config_version_mismatch' };
    if (await isDeleted(db, uid)) return { ok: false, reason: 'deleted' };
    const fp = bindingFp({ canonical, orderFingerprint, configVersion });

    let outcome = null;
    const ref = db.ref(`user_rewards/${uid}/${rid}`);
    const tx = await ref.transaction((cur) => {
      outcome = null;
      // null-first-safe (mirrors cancel-order-core finalize): pass RTDB's speculative null so the txn proceeds
      // to real server data instead of aborting. A truly-absent node = no points earned = insufficient (never
      // create the node here — points only exist because Phase A earn/welcome created it).
      if (cur === null) return null;
      const reservations = cur.reservations || {};
      const rec = reservations[orderId];
      const balance = Number(cur.balance) || 0;
      const reserved = Number(cur.reserved) || 0;

      if (rec) {
        if (rec.fp !== fp) { outcome = { ok: false, reason: 'reservation_conflict' }; return; }   // different order/reward → conflict, NO debit
        if (rec.state === 'reserved' || rec.state === 'held_paid' || rec.state === 'consumed') {   // active/progressing/terminal → idempotent, NO re-debit
          outcome = { ok: true, action: 'reused', state: rec.state }; return;
        }
        if (rec.state !== 'released') { outcome = { ok: false, reason: 'reservation_conflict' }; return; }   // refunded/unknown → don't re-issue a hold
        // released → treat as NO active hold: re-reserve fresh (new available check + new debit)
        if (balance - reserved < cost) { outcome = { ok: false, reason: 'insufficient' }; return; }
        const seq = (Number(rec.seq) || 0) + 1;
        outcome = { ok: true, action: 're_reserved', state: 'reserved' };
        return writeReserve(cur, orderId, rec, fp, canonical, orderFingerprint, configVersion, cost, seq, now, hostedExpiresAt);
      }
      // fresh reserve
      if (balance - reserved < cost) { outcome = { ok: false, reason: 'insufficient' }; return; }
      outcome = { ok: true, action: 'created', state: 'reserved' };
      return writeReserve(cur, orderId, null, fp, canonical, orderFingerprint, configVersion, cost, 1, now, hostedExpiresAt);
    });

    const res = outcome || { ok: false, reason: 'insufficient' };   // outcome null ⟺ node absent ⟺ no points
    // TOCTOU: a deletion racing around our debit would recreate a purged node → compensate (mirror Phase A).
    if (res.ok && (res.action === 'created' || res.action === 're_reserved') && await isDeleted(db, uid)) {
      await db.ref(`user_rewards/${uid}`).set(null);
      return { ok: false, reason: 'deleted' };
    }
    return res;
  } catch (e) { console.error(`reserveRedemption: failed ${orderId}`, e && e.message); return { ok: false, reason: 'error' }; }
}

function writeReserve(cur, orderId, prevRec, fp, canonical, orderFingerprint, configVersion, cost, seq, now, hostedExpiresAt = null) {
  const rec = {
    state: 'reserved', cost, fp, canonical: canonical || null, order_fingerprint: orderFingerprint || null,
    // Online binds hosted_expires_at AT RESERVE (a deterministic nowTs + HOSTED_TTL bound) so an unattached
    // hold is sweep-visible as an ONLINE hold immediately — the online-expiry sweep reclaims it whether or not
    // attachAttempt ever lands (crash/attach-fail). attachAttempt later refines it to the exact attempt expiry.
    // Cash passes null (its sweep branch is order-status-driven and already reclaims cash orphans).
    config_version: configVersion, attempt_id: null, hosted_expires_at: (hostedExpiresAt != null ? hostedExpiresAt : null),
    created_at: (prevRec && prevRec.created_at) || now, updated_at: now, seq,
  };
  return {
    ...cur,
    reserved: (Number(cur.reserved) || 0) + cost,                         // balance unchanged; points HELD
    reservations: { ...(cur.reservations || {}), [orderId]: rec },
    ledger: { ...(cur.ledger || {}), [ledgerKey(orderId, seq)]: entry('reserve', 0, cost, orderId, 'reserved', now) },
  };
}

// ── generic state transition (consume / release / markHeldPaid / attach) ────────────────────────────────
// Atomic on the node. Idempotent: already in `to` → noop ok; absent record/node → noop (nothing to do);
// wrong prior state → { ok:false, reason:'invalid_state' }. applyMoney(cur, rec, seq) returns the next node.
async function runTransition(db, { uid, rid, orderId, from, to }, applyMoney) {
  if (!uid || !rid || !orderId) return { ok: false, reason: 'bad_request' };
  let outcome = null;
  const ref = db.ref(`user_rewards/${uid}/${rid}`);
  const tx = await ref.transaction((cur) => {
    outcome = null;
    if (cur === null) return null;                                        // null-first-safe; absent node → no recreate
    const rec = (cur.reservations || {})[orderId];
    if (!rec) { outcome = { ok: true, action: 'noop', absent: true }; return; }
    if (rec.state === to) { outcome = { ok: true, action: 'noop', state: to }; return; }   // idempotent
    if (!from.includes(rec.state)) { outcome = { ok: false, reason: 'invalid_state', state: rec.state }; return; }
    const seq = (Number(rec.seq) || 0) + 1;
    outcome = { ok: true, action: 'applied', state: to };
    return applyMoney(cur, rec, seq);
  });
  if (outcome) return outcome;
  return tx.committed ? { ok: true, action: 'noop', absent: true } : { ok: false, reason: 'aborted' };
}

// consumed: realize the debit. balance−=cost, reserved−=cost (both clamped ≥0). from reserved|held_paid.
// Records debit_applied = the points ACTUALLY taken (== cost when collateralized), so a later refund can
// credit back only what was debited — never mints (Part 2). Alerts if under-collateralized (Part 3).
async function consumeRedemption(db, { uid, rid, orderId, now }) {
  const res = await runTransition(db, { uid, rid, orderId, from: ['reserved', 'held_paid'], to: 'consumed' }, (cur, rec, seq) => {
    const cost = Number(rec.cost) || 0;
    const oldBal = Number(cur.balance) || 0, newBal = Math.max(0, oldBal - cost);
    const newRes = Math.max(0, (Number(cur.reserved) || 0) - cost);
    return {
      ...cur, balance: newBal, reserved: newRes,
      reservations: { ...cur.reservations, [orderId]: { ...rec, state: 'consumed', debit_applied: oldBal - newBal, updated_at: now, seq } },
      ledger: { ...(cur.ledger || {}), [ledgerKey(orderId, seq)]: entry('redeem', newBal - oldBal, cost, orderId, 'consumed', now) },
    };
  });
  if (res.ok && res.action === 'applied') await alertIfUndercollateralized(db, { uid, rid, orderId, now });
  // [F/#22 mint backstop] a consume attempt on an ALREADY-RELEASED hold means an order reached delivered/completed
  // AFTER its hold was released (F's SLA auto-release, or a manual dispatch release). NEVER silent — alert so ops
  // catches the rare botched late-completion of a dead order before it becomes a mint (free item + points already returned/re-spent).
  if (res && res.reason === 'invalid_state' && res.state === 'released') {
    try { await db.ref(`dispatcher_alerts/reward_consume_after_release_${orderId}`).set({ kind: 'reward_consume_after_release', order_id: orderId, uid, rid, ts: now }); } catch (_) {}
    console.warn(`reward_consume_after_release: ${orderId} — consume attempted on a released hold (F backstop)`);
  }
  return res;
}

// held_paid: money captured, points STILL held (reserved unchanged) — dispatcher will resolve. from reserved.
async function markHeldPaid(db, { uid, rid, orderId, now }) {
  return runTransition(db, { uid, rid, orderId, from: ['reserved'], to: 'held_paid' }, (cur, rec, seq) => ({
    ...cur,
    reservations: { ...cur.reservations, [orderId]: { ...rec, state: 'held_paid', updated_at: now, seq } },
    ledger: { ...(cur.ledger || {}), [ledgerKey(orderId, seq)]: entry('held_paid', 0, Number(rec.cost) || 0, orderId, 'held_paid', now) },
  }));
}

// released: return the held points to available. reserved−=cost, balance unchanged. REFUSES held_paid/consumed.
async function releaseRedemption(db, { uid, rid, orderId, now }) {
  return runTransition(db, { uid, rid, orderId, from: ['reserved'], to: 'released' }, (cur, rec, seq) => {
    const newRes = Math.max(0, (Number(cur.reserved) || 0) - (Number(rec.cost) || 0));
    return {
      ...cur, reserved: newRes,
      reservations: { ...cur.reservations, [orderId]: { ...rec, state: 'released', updated_at: now, seq } },
      ledger: { ...(cur.ledger || {}), [ledgerKey(orderId, seq)]: entry('release', 0, Number(rec.cost) || 0, orderId, 'released', now) },
    };
  });
}

// attach the claimed payment attempt to the reservation (after acquireHostedAttempt). Money-neutral.
async function attachAttempt(db, { uid, rid, orderId, attemptId, hostedExpiresAt, now }) {
  return runTransition(db, { uid, rid, orderId, from: ['reserved'], to: '__attach__' }, (cur, rec, seq) => ({
    ...cur,
    reservations: { ...cur.reservations, [orderId]: { ...rec, attempt_id: attemptId || null, hosted_expires_at: hostedExpiresAt || null, updated_at: now, seq } },
  }));
}

// ── reverseRedemptionForRefund — the SINGLE reversal API (cancel / refund / manual-resolve) ─────────────
// State-specific + idempotent by order_id. disposition 'refund' (default) | 'sale'. NEVER open-code balance
// math elsewhere. No-op on absent / already-reversed.
async function reverseRedemptionForRefund(db, { uid, rid, orderId, disposition = 'refund', now }) {
  if (!uid || !rid || !orderId) return { ok: false, reason: 'bad_request' };
  let outcome = null, consumed = false;
  const ref = db.ref(`user_rewards/${uid}/${rid}`);
  const tx = await ref.transaction((cur) => {
    outcome = null; consumed = false;
    if (cur === null) return null;                                        // absent node → nothing to reverse
    const rec = (cur.reservations || {})[orderId];
    if (!rec) { outcome = { ok: true, action: 'noop', absent: true }; return; }
    const cost = Number(rec.cost) || 0;
    const seq = (Number(rec.seq) || 0) + 1;
    const setRec = (state, extra = {}) => ({ ...cur.reservations, [orderId]: { ...rec, state, updated_at: now, seq, ...extra } });
    const withLedger = (next, type, delta, state) => ({ ...next, ledger: { ...(cur.ledger || {}), [ledgerKey(orderId, seq)]: entry(type, delta, cost, orderId, state, now) } });

    if (disposition === 'sale') {
      // manual finalize-to-sale: realize the debit (consume) from a held/reserved hold.
      if (rec.state === 'consumed') { outcome = { ok: true, action: 'noop', state: 'consumed' }; return; }
      if (rec.state === 'reserved' || rec.state === 'held_paid') {
        const oldBal = Number(cur.balance) || 0, newBal = Math.max(0, oldBal - cost);
        const newRes = Math.max(0, (Number(cur.reserved) || 0) - cost);
        outcome = { ok: true, action: 'consumed', state: 'consumed' }; consumed = true;
        return withLedger({ ...cur, balance: newBal, reserved: newRes, reservations: setRec('consumed', { debit_applied: oldBal - newBal }) }, 'redeem', newBal - oldBal, 'consumed');
      }
      outcome = { ok: true, action: 'noop', state: rec.state }; return;   // released/refunded → nothing to sell
    }

    // disposition 'refund' (default)
    if (rec.state === 'consumed') {                                        // spent → return ONLY what was actually debited (Part 2: never mint)
      const back = Number.isFinite(Number(rec.debit_applied)) ? Number(rec.debit_applied) : cost;
      outcome = { ok: true, action: 'refunded', state: 'refunded' };
      return withLedger({ ...cur, balance: (Number(cur.balance) || 0) + back, reservations: setRec('refunded') }, 'refund', back, 'refunded');
    }
    if (rec.state === 'held_paid') {                                       // paid-but-not-spent → release hold, NO balance credit
      outcome = { ok: true, action: 'released_held', state: 'released' };
      return withLedger({ ...cur, reserved: Math.max(0, (Number(cur.reserved) || 0) - cost), reservations: setRec('released') }, 'release', 0, 'released');
    }
    if (rec.state === 'reserved') {                                        // unpaid hold → release
      outcome = { ok: true, action: 'released', state: 'released' };
      return withLedger({ ...cur, reserved: Math.max(0, (Number(cur.reserved) || 0) - cost), reservations: setRec('released') }, 'release', 0, 'released');
    }
    outcome = { ok: true, action: 'noop', state: rec.state }; return;      // released/refunded → idempotent no-op
  });
  const res = outcome || (tx.committed ? { ok: true, action: 'noop', absent: true } : { ok: false, reason: 'aborted' });
  if (consumed) await alertIfUndercollateralized(db, { uid, rid, orderId, now });   // sale-finalize consume → same Part-3 guard
  return res;
}

// ── sweepStaleReservations — release RESERVED orphans (never touches held_paid/consumed) ────────────────
// online: past hosted_expires_at → release. cash (no attempt): order absent/cancelled → release; still-live
// but aged past CASH_STALE_MS → audit only (never auto-release a possibly-live order). Returns the actions.
// NOTE (scale): scans user_rewards. Pre-launch volume is fine; a flat reservation index is the graduation
// path if the rewards tree grows (same class as the Phase-A ledger-compaction note).
async function sweepStaleReservations(db, { now }) {
  const released = [], audited = [];
  try {
    const all = (await db.ref('user_rewards').get()).val() || {};
    for (const uid of Object.keys(all)) {
      const brands = all[uid] || {};
      for (const rid of Object.keys(brands)) {
        const reservations = (brands[rid] && brands[rid].reservations) || {};
        for (const orderId of Object.keys(reservations)) {
          const rec = reservations[orderId];
          if (!rec || rec.state !== 'reserved') continue;                 // only reserved orphans
          if (rec.hosted_expires_at != null) {                            // online checkout
            if (Number(rec.hosted_expires_at) < now) {
              // Expired ≠ necessarily abandoned: a PAID order whose primary consume fail-opened ALSO has an
              // expired expiry + a reserved hold. Consult the order — if it realized (paid + live/terminal),
              // do NOT release (leave it for consume-recovery).
              const order = (await db.ref(`orders/${orderId}`).get()).val();
              if (consumeEligible(order)) continue;                       // paid + live → realized, not abandoned
              // [C] CONSERVATIVE: release ONLY a DEFINITIVELY-not-captured hold. An AMBIGUOUS one
              // (manual_reconciliation / still pending / unknown) MIGHT be paid-but-lost → releasing it risks a
              // MINT (re-spend, then a dispatcher reconciles the original as paid → consume no-ops on the freed
              // hold) and is exactly B's release-race. HOLD it (audit); the dispatcher / the deferred
              // hosted-abandon auto-release (pending PixelPay's non-paid-callback answer) own the ambiguous case.
              if (!definitivelyNotCaptured(order)) { audited.push({ uid, rid, orderId, status: order && order.payment_status, kind: 'online_ambiguous_held' }); continue; }
              await releaseRedemption(db, { uid, rid, orderId, now }); released.push({ uid, rid, orderId, kind: 'online_not_captured' });
            }
            continue;
          }
          // cash / scheduled (no hosted expiry): consult the FULL order (need release_at / materialized_at too).
          const order = (await db.ref(`orders/${orderId}`).get()).val();
          const status = order && order.status;
          if (status == null || TERMINAL_CANCEL.has(status)) { await releaseRedemption(db, { uid, rid, orderId, now }); await db.ref(`dispatcher_alerts/reward_hold_stale_${orderId}`).remove().catch(() => {}); released.push({ uid, rid, orderId, kind: status == null ? 'cash_orphan' : 'cash_cancelled' }); continue; }
          // [F/#22] Scheduled: LEGITIMATE until its slot — NEVER flag before release_at. Only stale when PAST
          // release_at + grace AND still un-materialized (→ it never released/delivered → never consumed → mint-safe auto-return).
          if (status === 'scheduled' || status === 'releasing') {
            const releaseAt = Number(order.release_at) || 0;
            if (releaseAt && now > releaseAt + SCHED_OVERDUE_GRACE_MS && !order.materialized_at) {
              await releaseRedemption(db, { uid, rid, orderId, now }); await db.ref(`dispatcher_alerts/reward_hold_stale_${orderId}`).remove().catch(() => {});
              released.push({ uid, rid, orderId, kind: 'scheduled_overdue' });
            }
            continue;   // before release_at (or already materialized) → legit; never flag/release
          }
          // [F/#22] Cash live (new/preparing/ready/out_for_delivery) — HYBRID: auto-release past a long SLA;
          // hold + a durable per-order escalating alert in the 6h→SLA window so ops can release early (never orphaned).
          if (LIVE_STATES.has(status)) {
            const age = now - (Number(rec.created_at) || 0);
            if (age > CASH_LIVE_SLA_MS) {
              // definitively abandoned → AUTO-release. A botched late-completion is caught by the consumeRedemption
              // consume-after-release backstop → never a silent mint (free item + already-returned-and-respent points).
              await releaseRedemption(db, { uid, rid, orderId, now }); await db.ref(`dispatcher_alerts/reward_hold_stale_${orderId}`).remove().catch(() => {});
              released.push({ uid, rid, orderId, kind: 'cash_live_sla_released', age_ms: age });
            } else if (age > CASH_STALE_MS) {
              audited.push({ uid, rid, orderId, status, age_ms: age });
              await db.ref(`dispatcher_alerts/reward_hold_stale_${orderId}`).update({ kind: 'reward_hold_stale', order_id: orderId, uid, rid, status, age_ms: age, updated_at: now }).catch(() => {});   // durable, keyed → re-fired each run until resolved
            }
          }
        }
      }
    }
  } catch (e) { console.error('sweepStaleReservations: failed', e && e.message); }
  return { released, audited };
}

// States where an ONLINE order has materialized live (paid + not pending/scheduled/cancelled).
const ONLINE_LIVE = new Set(['new', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'completed']);
const TERMINAL_DONE = new Set(['delivered', 'completed']);

// Is a reservation's order "realized" (money captured + order live/terminal) → the hold should be CONSUMED?
//   delivered/completed → yes (cash primary consume happens here; online is idempotent). online materialized-
//   live (payment_status confirmed + a live status) → yes (online primary consume happens at confirm).
function consumeEligible(order) {
  if (!order) return false;
  if (TERMINAL_DONE.has(order.status)) return true;
  if (order.payment_method === 'online' && order.payment_status === 'confirmed' && ONLINE_LIVE.has(order.status)) return true;
  return false;
}

// [C] Is an online order DEFINITIVELY not captured → safe to fast-release its hold (nothing can later reconcile
// it as paid and mint on the freed points)? YES only for: an ABSENT order (orphan — no order to materialize),
// payment_status 'failed' (the confirm path queried PixelPay and got declined/reversed/capture-failed — a
// DEFINITIVE not-captured; stale-hosted is 'manual_reconciliation', NEVER 'failed', by decision I6), or a
// cancelled order (the cancel path owns the reversal). Everything else (manual_reconciliation / pending /
// unknown) is AMBIGUOUS (paid-but-lost is possible) → NEVER release from the sweep.
function definitivelyNotCaptured(order) {
  if (!order) return true;                                          // orphan — no order that could reconcile-as-paid
  if (order.payment_status === 'failed') return true;              // confirm path queried PixelPay → declined
  if (TERMINAL_CANCEL.has(order.status)) return true;             // cancelled → cancelOrderCore owns the reversal
  return false;
}

// settleRedemptionAtConfirm — map a confirm/webhook disposition onto the reservation of a REDEEMED order:
//   'consume' (paid + live → realize the debit), 'hold' (paid but manual_review → dispatcher resolves),
//   'release' (unpaid abandon → free the hold). Fail-open — NEVER blocks the payment/materialize. No-op for a
//   non-redeemed order (no order.redemption). All three primitives are idempotent, so re-entry is safe.
async function settleRedemptionAtConfirm(db, { orderId, order, disposition, now }) {
  try {
    if (!order || !order.redemption || !order.customer_uid) return { ok: false, skipped: true };
    const args = { uid: order.customer_uid, rid: order.restaurant_id || 'x_pizza', orderId, now };
    if (disposition === 'consume') return await consumeRedemption(db, args);
    if (disposition === 'hold') return await markHeldPaid(db, args);
    if (disposition === 'release') return await releaseRedemption(db, args);
    return { ok: false, skipped: true };
  } catch (e) { console.warn(`settleRedemptionAtConfirm(${disposition}) failed for ${orderId}`, e && e.message); return { ok: false, error: true }; }
}

// A hold is SECURED iff the reservation is now held_paid (applied or idempotent-noop) OR already consumed
// (the punch was legitimately spent on a sale — not a mint). Anything else (released/refunded/absent/aborted/
// error) means the hold was NOT secured.
function redemptionHoldSecured(r) {
  if (!r) return false;
  if (r.state === 'held_paid') return true;
  if (r.reason === 'invalid_state' && r.state === 'consumed') return true;
  return false;
}

// holdRedemptionForManual — [B] secure a POSSIBLY-PAID redeemed order's hold as held_paid at a
// manual_reconciliation entry. If the hold could NOT be secured because a release sweep won the race and freed
// it (reserved→released before markHeldPaid committed), the punches are re-spendable and a later materialization
// would silently MINT a free item — so ALERT (reward_hold_lost_possibly_paid) and let ops catch it before
// materialization. Re-acquiring is UNSAFE (the freed points may already be re-spent) → escalate, never silent.
// No-op for a non-redeemed order (skipped). Returns the settle result. (C eliminates the race at its source.)
async function holdRedemptionForManual(db, { orderId, order, now, alert }) {
  const r = await settleRedemptionAtConfirm(db, { orderId, order, disposition: 'hold', now });
  if (r && r.skipped !== true && !redemptionHoldSecured(r) && typeof alert === 'function') {
    await alert('reward_hold_lost_possibly_paid', { orderId, state: (r && r.state) || null, reason: (r && r.reason) || null });
  }
  return r;
}

// reverseRedemptionForOrder — thin wrapper (cancelOrderCore + resolve-manual) that maps an ORDER onto the
// single reverseRedemptionForRefund helper — never open-codes balance math. Fail-open; no-op for a
// non-redeemed order. disposition 'refund' (state-branch: consumed→credit debit_applied, held_paid→release
// NO-credit, reserved→release) | 'sale' (held_paid/reserved→consume). Idempotent, keyed by order_id.
async function reverseRedemptionForOrder(db, { orderId, order, disposition = 'refund', now }) {
  try {
    if (!order || !order.redemption || !order.customer_uid) return { ok: false, skipped: true };
    return await reverseRedemptionForRefund(db, { uid: order.customer_uid, rid: order.restaurant_id || 'x_pizza', orderId, disposition, now });
  } catch (e) { console.warn(`reverseRedemptionForOrder(${disposition}) failed for ${orderId}`, e && e.message); return { ok: false, error: true }; }
}

// sweepConsumeRecovery — backstop for the NON-atomic (orders/* vs user_rewards/*) consume: an order can reach
// materialized/delivered/completed while its consume failed, leaving the hold stuck 'reserved'. Find those and
// CONSUME (idempotent — primary + recovery both run safely). Alerts (aged) when a stuck hold was old. Never
// touches held_paid/consumed/released. Counterpart to sweepStaleReservations (abandon → release).
async function sweepConsumeRecovery(db, { now, staleMs = CASH_STALE_MS }) {
  const consumed = [], aged = [];
  try {
    const all = (await db.ref('user_rewards').get()).val() || {};
    for (const uid of Object.keys(all)) {
      const brands = all[uid] || {};
      for (const rid of Object.keys(brands)) {
        const reservations = (brands[rid] && brands[rid].reservations) || {};
        for (const orderId of Object.keys(reservations)) {
          const rec = reservations[orderId];
          if (!rec || rec.state !== 'reserved') continue;
          const order = (await db.ref(`orders/${orderId}`).get()).val();
          if (!consumeEligible(order)) continue;
          const r = await consumeRedemption(db, { uid, rid, orderId, now });   // idempotent
          if (r && r.action === 'applied') {
            consumed.push({ uid, rid, orderId, status: order.status });
            if ((now - (Number(rec.created_at) || 0)) > staleMs) aged.push({ uid, rid, orderId, status: order.status });   // stuck a long time → flag
          }
        }
      }
    }
  } catch (e) { console.error('sweepConsumeRecovery: failed', e && e.message); }
  return { consumed, aged };
}

module.exports = {
  reserveRedemption, attachAttempt, consumeRedemption, markHeldPaid, releaseRedemption,
  reverseRedemptionForRefund, reverseRedemptionForOrder, sweepStaleReservations, settleRedemptionAtConfirm,
  holdRedemptionForManual, redemptionHoldSecured, sweepConsumeRecovery, consumeEligible, CASH_STALE_MS,
};
