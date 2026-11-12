'use strict';
// SDK payment coordinator — the ONE writer of payment_sdk/{orderId} (PLAN-capp-native-shell-and-payments §2.11;
// BRIEF-sdk-payment-coordinator r5). Every PSP call is journaled by a record CAS BEFORE it is made and answered by another CAS
// after; an unknown outcome LOCKS the record (no new money op until a bound status answer resolves it). Decisions that race
// the order's own life (going live, adjusting, cancelling, settling) are won by a transaction on orders/{id} (§4, §4a, §8).
// deps: { db, psp (makeAdapter), clock(), voidEligible(leg, now), cancelVoidEligible(leg, now), releaseResources(deps, orderId, order), goLive(deps, orderId) }.
const R = require('./record');
const F = require('./flow');
const { boundStatus } = require('./psp-adapter');

const RECONCILE_AFTER_MS = 2 * 60 * 1000;   // an unanswered op older than this is reconciled (> the PSP call timeout)
const UNKNOWN_ALERT_MS = 10 * 60 * 1000;
const OBLIGATION_DUE_MS = 3 * 24 * 3600 * 1000;

const readOrder = async (db, orderId) => (await db.ref(`orders/${orderId}`).once('value')).val();
const readRecord = async (db, orderId) => (await db.ref(`payment_sdk/${orderId}`).once('value')).val();
const enrol = (deps, orderId) => deps.db.ref(`payment_sdk_due/${orderId}`).set(deps.clock());
const isSdk = (order) => !!order && order.payment_flow === 'sdk_auth_v1';
const isTerminalOrder = (order) => !!order && R.TERMINAL.includes(order.status);

// A deterministic, create-once alert (never duplicated by retries or sweeps).
async function alertOnce(deps, kind, orderId, detail, suffix) {
  const key = `sdkpay_${kind}_${orderId}${suffix ? `_${suffix}` : ''}`;
  try {
    await deps.db.ref(`dispatcher_alerts/${key}`).transaction((cur) => (cur == null ? { type: `payment_sdk_${kind}`, detail: { orderId, ...(detail || {}) }, created_at: deps.clock() } : undefined));
  } catch (_) { /* best-effort: the record still carries the condition and the sweeper re-raises it */ }
}

// A present decision marker of the wrong shape (Codex r1 #1) is never acted on: the record locks for a person, once alerted.
async function markerGuard(deps, orderId, order) {
  const f = F.markerFault(order);
  if (!f) return false;
  await R.casRecord(deps.db, orderId, (r) => { if (r.lock && r.lock.reason === 'manual_reconciliation') return undefined; lockFor(r, 'manual_reconciliation', null, deps.clock()); return r; });
  await alertOnce(deps, 'malformed_marker', orderId, { field: f }, f);
  return true;
}

// One transaction on orders/{id}: mutate(cur) returns the next order or undefined (refuse). Null-first safe.
// The result of a decision transaction on orders/{id}: won only if it committed AND this updater produced the value.
// (Each decision runs its OWN literal transaction below, so the write census sees exactly the fields it writes.)
const decision = (res, box) => ({ won: !!(res && res.committed && box.won), order: res && res.snapshot ? res.snapshot.val() : null });

// ── journal → call → answer ───────────────────────────────────────────────────────────────────────────────────────────
// pre(rec) mutates the record for this op (or returns undefined to refuse); call(opId, rec) talks to the PSP; apply(rec, leg,
// out, opId) records the answer. A money op is refused while the record is locked or any money op is unanswered.
async function dispatch(deps, orderId, { legId, action, amount_cents, pre, call, apply }) {
  const now = deps.clock();
  const lid = () => (typeof legId === 'function' ? legId() : legId);   // a new leg's id is known only after pre()
  await enrol(deps, orderId);                         // enrol BEFORE work (§5): a crash after this leaves only a due entry
  let opId = null;
  const j = await R.casRecord(deps.db, orderId, (rec) => {
    if (rec.lock || R.unansweredMoneyOps(rec).length) return undefined;
    const r2 = pre.call(null, rec);
    if (!r2) return undefined;
    const n = Object.keys(R.opsOf(r2)).length + 1;
    opId = `${orderId}:${lid()}:${action}:${n}`;
    r2.ops = { ...R.opsOf(r2), [opId]: { leg_id: lid(), action, amount_cents: amount_cents || null, binding: { order_id: orderId, revision: r2.committed_revision || 0, leg_id: lid() }, dispatched_at: now, result: null } };
    return r2;
  });
  if (!j.applied) return { dispatched: false, record: j.record };
  const out = await call.call(null, opId, j.record);
  const done = await R.casRecord(deps.db, orderId, (rec) => {
    const op = R.opsOf(rec)[opId];
    if (!op || op.result) return undefined;           // already answered (reconciled) — a stale result is ignored
    op.result = { kind: out.outcome, code: out.code || null, at: deps.clock() };
    apply.call(null, rec, R.legsOfRecord(rec)[lid()], out, opId);
    return rec;
  });
  return { dispatched: true, out, opId, record: done.record };
}

const lockFor = (rec, reason, opId, now) => { rec.lock = { reason, op_id: opId || null, at: now }; };

function applyAuth(deps, rec, leg, out, opId) {
  if (!leg) return;
  if (out.uuid) leg.pp_uuid = out.uuid;
  if (out.outcome === 'approved') { leg.state = 'approved'; leg.role = rec.phase === 'cancelled' || rec.frozen ? 'surplus' : leg.kind === 'original' ? 'committed' : 'pending'; }
  else if (out.outcome === 'definitive_decline' || out.outcome === 'token_expired_confirmed') { leg.state = 'declined'; leg.role = 'none'; }
  // D4 row 17 (Q3, OWNER 11-10 «3DS on re-auth = decline»): an ORIGINAL leg the bank challenges ends its attempt — no record
  // lock (the customer may retry with another card at once); the sweeper's bound evidence settles the leg (S2). Other legs keep the lock.
  else if (out.outcome === 'requires_action') { leg.state = 'requires_action'; if (leg.kind === 'original') leg.role = 'none'; else lockFor(rec, 'requires_action', opId, deps.clock()); }
  else { leg.state = 'unknown'; lockFor(rec, 'unknown_op', opId, deps.clock()); }
}
function applyCapture(deps, rec, leg, out, opId) {
  if (!leg) return;
  if (out.outcome === 'captured') { leg.state = 'captured'; leg.captured_at = deps.clock(); }
  else if (out.outcome === 'declined') lockFor(rec, 'manual_reconciliation', opId, deps.clock());   // capture failure ⇒ a person
  else lockFor(rec, 'unknown_op', opId, deps.clock());
}
function applyVoid(deps, rec, leg, out, opId) {
  if (!leg) return;
  if (out.outcome === 'voided') leg.state = 'voided';
  else if (out.outcome === 'unknown') lockFor(rec, 'unknown_op', opId, deps.clock());
  // refused: the leg stays approved (surplus), tracked to its expiry
}

// The refund obligation, opened INSIDE the CAS that confirms the last capture of the frozen set (Codex r1 #4): deterministic id
// ⇒ created once. Returns { id, amount_cents } when this CAS opened it.
function obligationIn(r, now) {
  if (!r.frozen) return null;
  const set = r.frozen.capture_set || [];
  if (set.some((id) => !R.legsOfRecord(r)[id] || R.legsOfRecord(r)[id].state !== 'captured')) return null;
  const liability = R.derive(r).refund_liability;
  if (liability <= 0) return null;
  const id = `refund_${r.frozen.revision}`;
  if (r.obligations && r.obligations[id]) return null;
  r.obligations = { ...(r.obligations || {}), [id]: { kind: 'refund', amount_cents: liability, reason: r.rule4 ? 'rule4_no_void' : 'liability', owner: 'operator', due_at: now + OBLIGATION_DUE_MS, state: 'open' } };
  return { id, amount_cents: liability };
}

function newLeg(rec, kind, amount_cents, now) {
  const id = `L${Object.keys(R.legsOfRecord(rec)).length + 1}`;
  rec.legs = { ...R.legsOfRecord(rec), [id]: { kind, amount_cents, role: 'none', state: 'journaled', created_at: now, hold_expires_at: now + R.HOLD_MS } };
  return id;
}

// ── placement (§2.11: the order goes live on an APPROVED original leg; the go-live decision is an order transaction) ─────
// D4 S1 (PLAN-sdk-d4-r4 rows 1–6): one ATTEMPT per intentional try (attempt_id, client-chosen); the attempt claim is IN the
// journal CAS (attempts/{id} + the leg + the op, together); a known attempt is a REPLAY (no dispatch); the per-attempt provider
// reference is computed ONCE (C5); the order's immutable pay_deadline_at fences the claim and the placement.
const ATTEMPT_RE = /^[A-Za-z0-9_-]{16,64}$/;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
// C5: 'sdk' + base32(sha256(ns ‖ 0 ‖ namespace ‖ 0 ‖ order ‖ 0 ‖ attempt))[0:26] — NUL-separated (unambiguous), namespaced, no '-'
function ppRef(namespace, orderId, attemptId) {
  const h = require('crypto').createHash('sha256').update(['sdk_auth_v1', namespace, orderId, attemptId].join('\0')).digest();
  let bits = ''; for (const byte of h) bits += byte.toString(2).padStart(8, '0');
  let out = ''; for (let i = 0; i + 5 <= bits.length && out.length < 26; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return `sdk${out}`;
}
// an original attempt has ENDED (a new one may start) when its leg was declined or the bank challenged it (row 17)
const originalEnded = (l) => l.kind !== 'original' || l.state === 'declined' || l.state === 'requires_action';
const deadlineOf = (order, rec) => (order && Number.isFinite(order.pay_deadline_at) ? order.pay_deadline_at : rec && Number.isFinite(rec.ttl_at) ? rec.ttl_at : null);
const payerOf = (order) => ({ name: typeof order.customer_name === 'string' && order.customer_name ? order.customer_name : 'Cliente', email: typeof order.customer_email === 'string' && order.customer_email ? order.customer_email : null });

async function placeOriginal(deps, { orderId, attempt_id, token, amount_cents, authentication_identifier = null, card = null }) {
  const now = deps.clock();
  if (!R.isCentsInt(amount_cents) || amount_cents <= 0 || typeof token !== 'string' || !token) return { outcome: 'refused', reason: 'bad_input' };
  if (typeof attempt_id !== 'string' || !ATTEMPT_RE.test(attempt_id)) return { outcome: 'refused', reason: 'bad_attempt' };
  if (authentication_identifier !== null && (typeof authentication_identifier !== 'string' || !authentication_identifier)) return { outcome: 'refused', reason: 'bad_input' };
  // a RETRANSMISSION of a known attempt never dispatches again — its outcome is that attempt's (the S2 resolver)
  const rec0 = await readRecord(deps.db, orderId);
  const known = (r) => !!(r && r.attempts && r.attempts[attempt_id]);
  if (known(rec0)) return { outcome: 'replay', attempt_id, leg_id: rec0.attempts[attempt_id].leg_id };
  const order = await readOrder(deps.db, orderId);
  if (!isSdk(order) || order.status !== 'pending_payment' || order.payment_cancel || order.payment_placed || F.markerFault(order)) return { outcome: 'refused', reason: 'order_state' };
  if (order.scheduled_for != null) return { outcome: 'refused', reason: 'scheduled_unsupported' };   // a LOGGED card-launch gate (ruling #9)
  const deadline = deadlineOf(order, null);   // enforced IN the claim CAS below (the one authoritative check)
  await enrol(deps, orderId);
  await R.createRecord(deps.db, orderId, { flow: 'sdk_auth_v1', phase: 'open', committed_revision: 0, fulfillment_total_cents: amount_cents, created_at: now, ttl_at: deadline != null ? deadline : now + R.TTL_MS });
  const ref = ppRef(deps.ppNamespace || 'unconfigured', orderId, attempt_id);
  const tokenHash = require('crypto').createHash('sha256').update(token).digest('hex');
  let legId = null; let replay = null; let late = false;
  const d = await dispatch(deps, orderId, {
    action: 'auth',
    legId: () => legId,
    amount_cents,
    pre: (rec) => {
      replay = null; late = false;
      if (known(rec)) { replay = rec.attempts[attempt_id].leg_id; return undefined; }
      if (rec.phase !== 'open') return undefined;
      const dl = deadlineOf(order, rec);
      if (dl != null && deps.clock() >= dl) { late = true; return undefined; }
      if (!Object.values(R.legsOfRecord(rec)).every(originalEnded)) return undefined;
      legId = newLeg(rec, 'original', amount_cents, now);
      Object.assign(rec.legs[legId], { state: 'sent', attempt_id, pp_ref: ref });
      rec.attempts = { ...(rec.attempts || {}), [attempt_id]: { leg_id: legId, token_hash: tokenHash, card_ref: card && card.card_ref ? card.card_ref : 'new', display: card && card.display ? card.display : null, save: !!(card && card.save), amount_cents, at: now } };
      rec.token = token;
      rec.fulfillment_total_cents = amount_cents;
      return rec;
    },
    call: (opId) => deps.psp.pspAuthorize({ token, amount_cents, op_id: opId, ref, authentication_identifier, payer: payerOf(order) }),
    apply: (rec, leg, out, opId) => applyAuth(deps, rec, leg, out, opId),
  });
  if (!d.dispatched) {
    if (replay) return { outcome: 'replay', attempt_id, leg_id: replay };
    if (late) return { outcome: 'refused', reason: 'past_deadline' };
    const r1 = await readRecord(deps.db, orderId);
    if (known(r1)) return { outcome: 'replay', attempt_id, leg_id: r1.attempts[attempt_id].leg_id };
    return { outcome: 'refused', reason: 'locked_or_busy' };
  }
  if (d.out.outcome !== 'approved') return { outcome: d.out.outcome === 'requires_action' ? 'requires_action' : d.out.outcome === 'unknown' ? 'unknown' : 'declined', leg_id: legId };
  return decidePlacement(deps, orderId, legId);
}

// D4 row 6: THE placement decision for an approved original — shared by placeOriginal and the sweeper (resolveOriginals, S2).
// Only a leg whose OWN authorization answered approved (role committed) can place an order: a surplus / challenge leg never
// does. SAME WINNER: an order already placed by THIS leg is `placed`. A transaction that does not win NEVER by itself implies
// surplus: only an order seen cancelled, past its deadline or placed by ANOTHER leg makes this leg surplus.
async function decidePlacement(deps, orderId, legId) {
  const rec = await readRecord(deps.db, orderId);
  const leg = rec && R.legsOfRecord(rec)[legId];
  if (leg && leg.kind === 'original' && leg.state === 'approved' && leg.role === 'surplus' && !leg.from_challenge) return { outcome: 'late_surplus', leg_id: legId };   // already surplus (an approval after a cancel / expiry): never placed
  if (!leg || leg.kind !== 'original' || leg.state !== 'approved' || leg.role !== 'committed' || leg.from_challenge) return { outcome: 'refused', reason: 'leg_not_placeable', leg_id: legId };
  const box = { won: false, same: false, demote: false };
  const decided = decision(await deps.db.ref(`orders/${orderId}`).transaction((cur) => {
    box.won = false; box.same = false; box.demote = false;
    if (cur == null) return null;
    if (cur.payment_placed && cur.payment_placed.leg_id === legId && !F.markerFault(cur)) { box.same = true; return undefined; }
    if (F.markerFault(cur)) return undefined;
    if (cur.payment_cancel || cur.status === 'cancelled' || cur.payment_placed) { box.demote = true; return undefined; }
    const dl = deadlineOf(cur, rec);
    if (dl != null && deps.clock() >= dl) { box.demote = true; return undefined; }
    if (cur.status !== 'pending_payment') return undefined;
    box.won = true;
    return { ...cur, payment_placed: { leg_id: legId, at: deps.clock() } };
  }), box);
  if (decided.won || box.same) {
    // go live through the shared materialization (ruling #9 A); a failure here is re-driven by the sweeper
    if (decided.won) { try { await deps.goLive(deps, orderId); } catch (e) { console.error(`sdk go-live deferred to the sweeper for ${orderId}: ${e && e.message}`); } }
    return { outcome: 'placed', leg_id: legId };
  }
  if (!box.demote) return { outcome: 'refused', reason: 'order_state', leg_id: legId };
  // the order decided otherwise (cancelled / past the deadline / another leg placed it): the approved hold is SURPLUS, never captured
  await R.casRecord(deps.db, orderId, (r) => { const l = R.legsOfRecord(r)[legId]; if (!l || l.state !== 'approved' || l.role === 'surplus') return undefined; l.role = 'surplus'; return r; });
  return { outcome: 'late_surplus', leg_id: legId };
}

// ── reconciliation: status queries never resolve an op implicitly; a separate CAS does, on BOUND definitive evidence ─────
async function reconcileSdkOps(deps, { orderId }) {
  const now = deps.clock();
  const rec = await readRecord(deps.db, orderId);
  if (!rec) return { reconciled: 0 };
  let reconciled = 0;
  await R.casRecord(deps.db, orderId, (r) => {
    let changed = false;
    for (const o of Object.values(R.opsOf(r))) if (o.action === 'status' && !o.result && now - o.dispatched_at >= RECONCILE_AFTER_MS) { o.result = { kind: 'abandoned', at: now }; changed = true; }
    return changed ? r : undefined;
  });
  for (const [opId, op] of Object.entries(R.opsOf(rec))) {
    if (!R.MONEY_ACTIONS.includes(op.action)) continue;
    const unanswered = !op.result && now - op.dispatched_at >= RECONCILE_AFTER_MS;
    const unknown = op.result && op.result.kind === 'unknown';
    if (!unanswered && !unknown) continue;
    const leg = R.legsOfRecord(rec)[op.leg_id];
    if (!leg || !leg.pp_uuid) {
      // no uuid: the lost-UUID lookup (§7.V) is out of scope → a person; the lock stays
      await R.casRecord(deps.db, orderId, (r) => { if (r.lock && r.lock.reason === 'manual_reconciliation' && r.lock.op_id === opId) return undefined; lockFor(r, 'manual_reconciliation', opId, now); return r; });
      await alertOnce(deps, 'manual_reconciliation', orderId, { op_id: opId, why: 'no_uuid' }, opId.replace(/[^A-Za-z0-9_-]/g, '_'));
      continue;
    }
    // journal the status query (allowed while locked), ask, record its answer
    let sId = null;
    await R.casRecord(deps.db, orderId, (r) => { sId = `${orderId}:${op.leg_id}:status:${Object.keys(R.opsOf(r)).length + 1}`; r.ops = { ...R.opsOf(r), [sId]: { leg_id: op.leg_id, action: 'status', of: opId, dispatched_at: now, result: null } }; return r; });
    const ev = await deps.psp.pspStatus({ uuid: leg.pp_uuid });
    await R.casRecord(deps.db, orderId, (r) => { const s = R.opsOf(r)[sId]; if (!s || s.result) return undefined; s.result = { kind: ev.state, at: deps.clock() }; return r; });
    if (!boundStatus(ev, leg)) {
      if (now - op.dispatched_at >= UNKNOWN_ALERT_MS) await alertOnce(deps, 'unknown_op', orderId, { op_id: opId }, opId.replace(/[^A-Za-z0-9_-]/g, '_'));
      continue;                                        // inconclusive / unbound → the lock stays, no retry
    }
    let opened = null;
    const res = await R.casRecord(deps.db, orderId, (r) => {
      opened = null;
      const o = R.opsOf(r)[opId]; const l = R.legsOfRecord(r)[op.leg_id];
      if (!o || !l || (o.result && o.result.kind !== 'unknown')) return undefined;
      const st = ev.state;
      let kind = null;
      if (o.action === 'auth') {
        // a B / delta found live after its flow returned is SURPLUS; so is ANY approval found after a cancel or outside the frozen set
        if (st === 'authorized') { l.state = 'approved'; l.role = r.phase === 'cancelled' ? 'surplus' : r.frozen ? ((r.frozen.capture_set || []).includes(op.leg_id) ? 'committed' : 'surplus') : l.kind === 'original' ? 'committed' : 'surplus'; kind = 'approved'; }
        else if (st === 'declined') { l.state = 'declined'; l.role = 'none'; kind = 'definitive_decline'; }
        else if (st === 'voided' || st === 'expired') { l.state = st; kind = st; }
      } else if (o.action === 'capture') {
        // an `authorized` snapshot never resolves an unanswered capture (it may still land): the lock stays until evidence
        if (st === 'captured') { l.state = 'captured'; l.captured_at = now; kind = 'captured'; }
      } else if (o.action === 'void') {
        if (st === 'voided') { l.state = 'voided'; kind = 'voided'; }
        else if (st === 'authorized') kind = 'refused';
        else if (st === 'expired') { l.state = 'expired'; kind = 'expired'; }
      }
      if (!kind) return undefined;                     // evidence that does not fit this op → stays locked for a person
      o.result = { kind, code: null, at: now, via: sId };
      if (r.lock && r.lock.op_id === opId && r.lock.reason !== 'manual_reconciliation') r.lock = null;
      opened = kind === 'captured' ? obligationIn(r, now) : null;
      return r;
    });
    if (res.applied) reconciled += 1;
    if (res.applied && opened) await alertOnce(deps, 'refund_obligation', orderId, opened, opened.id);
    if (!res.applied && now - op.dispatched_at >= UNKNOWN_ALERT_MS) await alertOnce(deps, 'unknown_op', orderId, { op_id: opId }, opId.replace(/[^A-Za-z0-9_-]/g, '_'));
  }
  return { reconciled };
}

// A FULFILLED SDK order's redemption still reserved is consumed with the SAME primitive the shared go-live's already-confirmed
// branch uses (never left reserved forever: the legacy reward sweeps skip SDK orders). Only `reserved` is consumed — consumed /
// released / held_paid are left to their owners. Idempotent.
async function consumeFulfilledRedemption(deps, orderId, order) {
  if (!F.terminalConsumeDue(order)) return null;
  const st = (await deps.db.ref(`user_rewards/${order.customer_uid}/${order.restaurant_id}/reservations/${orderId}/state`).once('value')).val();
  if (st !== 'reserved') return null;
  return require('../../rewards-reserve').settleRedemptionAtConfirm(deps.db, { orderId, order, disposition: 'consume', now: deps.clock() });
}

// ── terminal settlement (§4, §4a, §6): payment_terminal → recover → freeze → capture the frozen set → obligations ───────
async function settleTerminal(deps, { orderId }) {
  const now = deps.clock();
  let order = await readOrder(deps.db, orderId);
  let rec = await readRecord(deps.db, orderId);
  if (!rec || !isSdk(order)) return { outcome: 'none' };
  if (await markerGuard(deps, orderId, order)) return { outcome: 'manual' };
  if (!isTerminalOrder(order) && !order.payment_terminal) return { outcome: 'not_terminal' };
  if (order.payment_cancel && !order.payment_terminal) {
    // a terminal status written after a committed cancel decision (an override): never captured automatically
    await R.casRecord(deps.db, orderId, (r) => { if (r.lock && r.lock.reason === 'manual_reconciliation') return undefined; lockFor(r, 'manual_reconciliation', null, now); return r; });
    await alertOnce(deps, 'terminal_after_cancel', orderId, {});
    return { outcome: 'manual' };
  }
  if (!order.payment_terminal) {
    const box = { won: false };
    const t = decision(await deps.db.ref(`orders/${orderId}`).transaction((cur) => {
      box.won = false;
      if (cur == null) return null;
      if (cur.payment_terminal || F.markerFault(cur)) return undefined;
      if (!R.TERMINAL.includes(cur.status) || cur.payment_cancel) return undefined;
      box.won = true;
      return { ...cur, payment_terminal: { revision: (cur.payment_commit && cur.payment_commit.revision) || 0, at: deps.clock() } };
    }), box);
    order = t.order || await readOrder(deps.db, orderId);
    if (!order || !order.payment_terminal) return { outcome: 'not_terminal' };
  }
  if (!isTerminalOrder(order)) {
    // a SERVER writer moved the order back after the terminal decision (Codex r1 #12): the condition is persisted for a person;
    // the frozen set still settles exactly once
    await R.casRecord(deps.db, orderId, (r) => { if (r.manual_review) return undefined; r.manual_review = { reason: 'status_reversal_after_terminal', status: order.status || null, at: now }; return r; });
    await alertOnce(deps, 'status_reversal_after_terminal', orderId, { status: order.status || null });
  }
  await recoverProjection(deps, orderId, order);
  await classifyLostProposals(deps, orderId, order);
  const fr = await R.casRecord(deps.db, orderId, (r) => {
    if (r.phase !== 'open' && r.phase !== 'adjusting') return undefined;
    const set = Object.entries(R.legsOfRecord(r)).filter(([, l]) => l.role === 'committed' && (l.state === 'approved' || l.state === 'captured')).map(([id]) => id);
    for (const l of Object.values(R.legsOfRecord(r))) if (l.role === 'pending') l.role = 'surplus';   // a late approval outside the set
    r.phase = 'frozen';
    r.frozen = { revision: r.committed_revision || 0, fulfillment_total_cents: r.fulfillment_total_cents, capture_set: set, at: now };
    if (r.consent && r.consent.state === 'pending') r.consent.state = 'expired';
    return r;
  });
  rec = fr.record || await readRecord(deps.db, orderId);
  if (!rec || !rec.frozen) return { outcome: 'not_frozen' };
  for (const legId of rec.frozen.capture_set || []) {
    const leg = R.legsOfRecord(rec)[legId];
    if (!leg || leg.state !== 'approved') continue;
    let opened = null;
    const d = await dispatch(deps, orderId, {
      legId, action: 'capture', amount_cents: leg.amount_cents,
      pre: (r) => { const l = R.legsOfRecord(r)[legId]; if (r.phase !== 'frozen' || !l || l.state !== 'approved' || !(r.frozen.capture_set || []).includes(legId)) return undefined; return r; },
      call: (opId) => deps.psp.pspCapture({ uuid: leg.pp_uuid, amount_cents: leg.amount_cents, op_id: opId }),
      apply: (r, l, out, opId) => { applyCapture(deps, r, l, out, opId); opened = l && l.state === 'captured' ? obligationIn(r, deps.clock()) : null; },
    });
    if (d.record) rec = d.record;
    if (opened) await alertOnce(deps, 'refund_obligation', orderId, opened, opened.id);
  }
  await openObligations(deps, orderId);
  await consumeFulfilledRedemption(deps, orderId, await readOrder(deps.db, orderId));
  return { outcome: 'settled' };
}

// Obligations open in the step that follows the LAST confirmed capture; deterministic id ⇒ created once.
async function openObligations(deps, orderId) {
  const now = deps.clock();
  let opened = null;
  await R.casRecord(deps.db, orderId, (r) => { opened = obligationIn(r, now); return opened ? r : undefined; });
  if (opened) await alertOnce(deps, 'refund_obligation', orderId, opened, opened.id);
  return opened;
}

async function completeObligation(deps, { orderId, obligationId, state, bank_ref }) {
  if (!['done', 'verified'].includes(state)) return { applied: false };
  const res = await R.casRecord(deps.db, orderId, (r) => {
    const o = r.obligations && r.obligations[obligationId];
    if (!o || o.state === 'verified' || (o.state === 'open' && state === 'verified' && !bank_ref && !o.bank_ref)) return undefined;
    o.state = state; if (bank_ref) o.bank_ref = bank_ref;
    return r;
  });
  return { applied: res.applied };
}

// ── adjustments (§2.10 through §4): proposal (payment side, immutable) → commit (orders txn) → projection (record CAS) ──
const CONSENT_WINDOW_MS = 3 * 60 * 1000;   // owner 2026-11-07: the increase consent window
const revOf = (order) => (order && order.payment_commit && order.payment_commit.revision) || 0;
const committedLegIds = (rec) => Object.entries(R.legsOfRecord(rec)).filter(([, l]) => l.role === 'committed' && (l.state === 'approved' || l.state === 'captured')).map(([id]) => id);
const orderOpen = (order) => isSdk(order) && !F.markerFault(order) && !!order.payment_placed && !isTerminalOrder(order) && order.status !== 'cancelled' && !order.payment_cancel && !order.payment_terminal;
// The order revision an adjustment commits WITH its payment decision (Codex r1 #10): canonical items + totals, validated against
// the new total. Returns the fields to write, or null (refused before any PSP call).
const BREAKDOWN_CENTS = Object.freeze(['delivery_cents', 'tip_cents', 'promo_discount_cents']);
function orderRevision(rv, total) {
  if (!rv || typeof rv !== 'object' || !Array.isArray(rv.items) || !rv.items.length || !rv.items.every((i) => i && typeof i === 'object' && !Array.isArray(i))) return null;
  if (!R.isCentsInt(total) || rv.total_cents !== total) return null;
  const out = { items: rv.items, total_cents: total, total: total / 100 };
  for (const f of BREAKDOWN_CENTS) if (rv[f] !== undefined) { if (!R.isCentsInt(rv[f])) return null; out[f] = rv[f]; }
  return out;
}
const recordOpen = (rec, order) => !!rec && rec.phase === 'open' && !rec.lock && !R.unansweredMoneyOps(rec).length && (rec.committed_revision || 0) === revOf(order);

async function persistProposal(deps, orderId, p) {
  let pid = null;
  const res = await R.casRecord(deps.db, orderId, (rec) => {
    if ((rec.committed_revision || 0) !== p.base_revision) return undefined;
    pid = `p${Object.keys(rec.proposals || {}).length + 1}`;
    rec.proposals = { ...(rec.proposals || {}), [pid]: { ...p, pid, state: 'proposed', created_at: deps.clock() } };
    return rec;
  });
  return res.applied ? pid : null;
}
// THE decision: the order must be live, not cancelled/terminal, and still at the proposal's base revision.
async function commitProposal(deps, orderId, pid, p) {
  const box = { won: false };
  return decision(await deps.db.ref(`orders/${orderId}`).transaction((cur) => {
    box.won = false;
    if (cur == null) return null;
    if (R.TERMINAL.includes(cur.status) || cur.status === 'cancelled' || cur.payment_cancel || cur.payment_terminal || F.markerFault(cur)) return undefined;
    if (revOf(cur) !== p.base_revision) return undefined;
    box.won = true;
    return { ...cur, ...p.order_revision, payment_commit: { revision: p.base_revision + 1, pid }, payment_total_cents: p.fulfillment_total_cents };
  }), box);
}

// Apply the order's committed proposal if the record lags (crash recovery included). At most one can be pending.
async function recoverProjection(deps, orderId, order) {
  const pc = order && order.payment_commit;
  if (!pc) return null;
  let rule4 = false; let missing = false;
  const res = await R.casRecord(deps.db, orderId, (rec) => {
    if ((rec.committed_revision || 0) >= pc.revision) return undefined;
    const p = rec.proposals && rec.proposals[pc.pid];
    if (!p) { missing = true; return undefined; }
    for (const [id, l] of Object.entries(R.legsOfRecord(rec))) {
      if ((p.committed_set || []).includes(id)) { if (l.state === 'approved' || l.state === 'captured') l.role = 'committed'; }
      else if (l.role === 'committed' || l.role === 'pending') l.role = 'surplus';
    }
    rec.fulfillment_total_cents = p.fulfillment_total_cents;
    rec.committed_revision = pc.revision;
    p.state = 'committed';
    if (p.kind === 'decrease_rule4') { rec.rule4 = { at: deps.clock(), revision: pc.revision }; rule4 = true; }
    return rec;
  });
  if (missing) {
    await R.casRecord(deps.db, orderId, (r) => { if (r.lock && r.lock.reason === 'manual_reconciliation') return undefined; lockFor(r, 'manual_reconciliation', null, deps.clock()); return r; });
    await alertOnce(deps, 'proposal_missing', orderId, { revision: pc.revision });
  }
  if (rule4) await alertOnce(deps, 'rule4', orderId, { revision: pc.revision }, `r${pc.revision}`);
  return res;
}

// A proposal whose order transaction LOST (the order moved on without it): its new legs are SURPLUS, never captured.
async function classifyLostProposals(deps, orderId, order) {
  const closedOrder = !order || R.TERMINAL.includes(order.status) || order.status === 'cancelled' || order.payment_cancel || order.payment_terminal;
  const pc = (order && order.payment_commit) || null;
  return R.casRecord(deps.db, orderId, (rec) => {
    let changed = false;
    for (const [pid, p] of Object.entries(rec.proposals || {})) {
      if (p.state !== 'proposed') continue;
      if (pc && pc.pid === pid) continue;
      const superseded = revOf(order) > p.base_revision;
      if (!closedOrder && !superseded) continue;
      p.state = 'lost'; changed = true;
      for (const id of p.new_leg_ids || []) { const l = R.legsOfRecord(rec)[id]; if (l && (l.role === 'pending' || l.role === 'none')) l.role = 'surplus'; }
    }
    return changed ? rec : undefined;
  });
}

// Void every surplus hold the caller's rule allows (adjustments, production: never; cancel: same HN day, before 21:50); a refused / unknown void leaves it SURPLUS.
async function voidSurplus(deps, orderId, voidRule = deps.voidEligible) {
  const rec = await readRecord(deps.db, orderId);
  for (const [legId, leg] of Object.entries(R.legsOfRecord(rec))) {
    if (leg.role !== 'surplus' || leg.state !== 'approved' || !leg.pp_uuid) continue;
    if (Object.values(R.opsOf(rec)).some((o) => o.leg_id === legId && o.action === 'void')) continue;   // one void per leg
    if (!voidRule(leg, deps.clock())) continue;
    await dispatch(deps, orderId, {
      legId, action: 'void',
      // the one-void rule and the eligibility are re-checked IN the journal transaction, right before the call (Codex r1 #1, #2)
      pre: (r) => {
        const l = R.legsOfRecord(r)[legId];
        if (!l || l.role !== 'surplus' || l.state !== 'approved') return undefined;
        if (Object.values(R.opsOf(r)).some((o) => o.leg_id === legId && o.action === 'void') || !voidRule(l, deps.clock())) return undefined;
        return r;
      },
      call: (opId) => deps.psp.pspVoid({ uuid: leg.pp_uuid, op_id: opId }),
      apply: (r, l, out, opId) => applyVoid(deps, r, l, out, opId),
    });
  }
}

// propose → commit → project; the caller's new legs become surplus if the order decided otherwise.
async function decideProposal(deps, orderId, p) {
  const pid = await persistProposal(deps, orderId, p);
  if (!pid) return { outcome: 'refused', reason: 'revision_moved' };
  const c = await commitProposal(deps, orderId, pid, p);
  if (!c.won) { await classifyLostProposals(deps, orderId, c.order || await readOrder(deps.db, orderId)); return { outcome: 'lost_to_order', pid }; }
  await recoverProjection(deps, orderId, c.order);
  return { outcome: 'committed', pid, revision: c.order.payment_commit.revision };
}

const expireConsent = (deps, orderId) => R.casRecord(deps.db, orderId, (r) => { if (!r.consent || r.consent.state !== 'pending') return undefined; r.consent.state = 'expired'; return r; });

async function requestDecrease(deps, { orderId, new_total_cents, revision }) {
  const now = deps.clock();
  const order = await readOrder(deps.db, orderId);
  const rec = await readRecord(deps.db, orderId);
  if (!orderOpen(order) || !recordOpen(rec, order)) return { outcome: 'refused', reason: 'not_adjustable' };
  if (!R.isCentsInt(new_total_cents) || new_total_cents <= 0 || new_total_cents >= rec.fulfillment_total_cents) return { outcome: 'refused', reason: 'not_a_decrease' };
  const ov = orderRevision(revision, new_total_cents);
  if (!ov) return { outcome: 'refused', reason: 'bad_revision' };
  await expireConsent(deps, orderId);                 // a later edit invalidates a pending consent
  const base = rec.committed_revision || 0;
  const S = committedLegIds(rec);
  if (S.length && S.every((id) => deps.voidEligible(R.legsOfRecord(rec)[id], now))) {
    let legId = null;
    const d = await dispatch(deps, orderId, {
      action: 'auth', legId: () => legId, amount_cents: new_total_cents,
      pre: (r) => { if (r.phase !== 'open' || (r.committed_revision || 0) !== base) return undefined; legId = newLeg(r, 'replacement', new_total_cents, now); r.legs[legId].state = 'sent'; return r; },
      call: (opId) => deps.psp.pspAuthorize({ token: rec.token, amount_cents: new_total_cents, op_id: opId, ref: orderId }),
      apply: (r, l, out, opId) => applyAuth(deps, r, l, out, opId),
    });
    if (!d.dispatched) return { outcome: 'refused', reason: 'locked_or_busy' };
    if (d.out.outcome === 'approved') {
      const res = await decideProposal(deps, orderId, { kind: 'decrease', base_revision: base, committed_set: [legId], fulfillment_total_cents: new_total_cents, new_leg_ids: [legId], order_revision: ov });
      if (res.outcome !== 'committed') { await R.casRecord(deps.db, orderId, (r) => { const l = R.legsOfRecord(r)[legId]; if (!l || l.role !== 'pending') return undefined; l.role = 'surplus'; return r; }); return res; }
      await voidSurplus(deps, orderId);
      return { outcome: 'replaced', leg_id: legId };
    }
    if (d.out.outcome === 'unknown' || d.out.outcome === 'requires_action') return { outcome: d.out.outcome };
    // a definitive decline of B → rule 4 (S stays committed)
  }
  const r4 = await decideProposal(deps, orderId, { kind: 'decrease_rule4', base_revision: base, committed_set: S, fulfillment_total_cents: new_total_cents, new_leg_ids: [], order_revision: ov });
  return r4.outcome === 'committed' ? { outcome: 'rule4' } : r4;
}

// owner 2026-11-10: a card order's total never goes up after ordering (more food = a new order). An increase is never offered
// and never applied: refused first, before any read, write or provider call. The code below each refusal is kept, unreachable,
// until the owner decides whether to delete it (NOTE-sdk-card-no-increase r0).
const increaseNotOffered = () => ({ outcome: 'refused', reason: 'increase_not_offered' });
async function recordConsent(deps, { orderId, adjustment_id, new_total_cents }) {
  return increaseNotOffered();
  const now = deps.clock();
  const order = await readOrder(deps.db, orderId);
  const rec = await readRecord(deps.db, orderId);
  if (!orderOpen(order) || !recordOpen(rec, order)) return { outcome: 'refused' };
  if (typeof adjustment_id !== 'string' || !adjustment_id || !R.isCentsInt(new_total_cents) || new_total_cents <= rec.fulfillment_total_cents) return { outcome: 'refused' };
  const res = await R.casRecord(deps.db, orderId, (r) => {
    if ((r.committed_revision || 0) !== revOf(order)) return undefined;
    r.consent = { adjustment_id, order_revision: r.committed_revision || 0, old_total: r.fulfillment_total_cents, new_total: new_total_cents, delta: new_total_cents - r.fulfillment_total_cents, expires_at: now + CONSENT_WINDOW_MS, state: 'pending' };
    return r;
  });
  return { outcome: res.applied ? 'pending' : 'refused' };
}

async function applyIncrease(deps, { orderId, adjustment_id, order_revision, new_total_cents, accept, revision }) {
  return increaseNotOffered();
  const now = deps.clock();
  const ov = orderRevision(revision, new_total_cents);
  if (!ov) return { outcome: 'rejected', reason: 'bad_revision' };
  const order = await readOrder(deps.db, orderId);
  let consent = null;
  const taken = await R.casRecord(deps.db, orderId, (r) => {
    const c = r.consent;
    if (!c || c.state !== 'pending' || c.adjustment_id !== adjustment_id) return undefined;
    const valid = c.order_revision === order_revision && c.new_total === new_total_cents && now <= c.expires_at && (r.committed_revision || 0) === c.order_revision;
    c.state = !valid ? (now > c.expires_at ? 'expired' : 'rejected') : accept === true ? 'accepted' : 'rejected';
    consent = { ...c };
    return r;
  });
  if (!taken.applied || !consent || consent.state !== 'accepted') return { outcome: 'rejected' };
  const rec = taken.record;
  if (!orderOpen(order) || !recordOpen(rec, order)) return { outcome: 'rejected', reason: 'not_adjustable' };
  const base = rec.committed_revision || 0;
  const S = committedLegIds(rec);
  const need = Math.max(0, new_total_cents - R.derive(rec).committed_auth_total);
  if (need === 0) {
    const res = await decideProposal(deps, orderId, { kind: 'increase', base_revision: base, committed_set: S, fulfillment_total_cents: new_total_cents, new_leg_ids: [], order_revision: ov });
    return res.outcome === 'committed' ? { outcome: 'committed' } : res;
  }
  let legId = null;
  const d = await dispatch(deps, orderId, {
    action: 'auth', legId: () => legId, amount_cents: need,
    pre: (r) => { if (r.phase !== 'open' || (r.committed_revision || 0) !== base) return undefined; legId = newLeg(r, 'delta', need, now); r.legs[legId].state = 'sent'; return r; },
    call: (opId) => deps.psp.pspAuthorize({ token: rec.token, amount_cents: need, op_id: opId, ref: orderId }),
    apply: (r, l, out, opId) => applyAuth(deps, r, l, out, opId),
  });
  if (!d.dispatched) return { outcome: 'refused', reason: 'locked_or_busy' };
  if (d.out.outcome !== 'approved') return { outcome: d.out.outcome === 'unknown' || d.out.outcome === 'requires_action' ? d.out.outcome : 'declined' };
  const res = await decideProposal(deps, orderId, { kind: 'increase', base_revision: base, committed_set: [...S, legId], fulfillment_total_cents: new_total_cents, new_leg_ids: [legId], order_revision: ov });
  if (res.outcome !== 'committed') {
    await R.casRecord(deps.db, orderId, (r) => { const l = R.legsOfRecord(r)[legId]; if (!l || l.role !== 'pending') return undefined; l.role = 'surplus'; return r; });
    await voidSurplus(deps, orderId);
    return res;
  }
  return { outcome: 'committed', leg_id: legId };
}

// ── cancellation / TTL expiry (§8) ───────────────────────────────────────────────────────────────────────────────────────
const CLEANUP_STALE_MS = 2 * 60 * 1000;
async function cancelSdkOrder(deps, { orderId, kind = 'cancel' }) {
  const now = deps.clock();
  let order = await readOrder(deps.db, orderId);
  if (!isSdk(order)) return { outcome: 'refused', reason: 'not_sdk' };
  if (await markerGuard(deps, orderId, order)) return { outcome: 'manual' };
  const rec0 = await readRecord(deps.db, orderId);
  // 0. ENROL before the decision and before the record (Codex r1 #7) — fresh or resumed; only a finished cleanup skips it
  if (!(rec0 && rec0.cleanup && rec0.cleanup.done_at)) await enrol(deps, orderId);
  if (!order.payment_cancel) {
    if (isTerminalOrder(order) || order.payment_terminal) { await settleTerminal(deps, { orderId }); return { outcome: 'lost_to_terminal' }; }
    // the shared go-live claim has committed and its materialization has not: the cancel waits for it (or for its park)
    if (F.goLiveInFlight(order)) return { outcome: 'refused', reason: 'going_live' };
    // 1. WIN the order-level decision first
    const box = { won: false };
    const d = decision(await deps.db.ref(`orders/${orderId}`).transaction((cur) => {
      box.won = false;
      if (cur == null) return null;
      if (R.TERMINAL.includes(cur.status) || cur.payment_terminal || cur.payment_cancel || F.markerFault(cur)) return undefined;
      if (F.goLiveInFlight(cur)) return undefined;
      if (kind === 'expire' && (cur.status !== 'pending_payment' || cur.payment_placed || !rec0 || now < rec0.ttl_at)) return undefined;
      box.won = true;
      return { ...cur, payment_cancel: { kind, at: now }, status: 'cancelled', cancelled_at: now };
    }), box);
    order = d.order || await readOrder(deps.db, orderId);
    if (!d.won) {
      if (order && (R.TERMINAL.includes(order.status) || order.payment_terminal) && !order.payment_cancel) { await settleTerminal(deps, { orderId }); return { outcome: 'lost_to_terminal' }; }
      if (!order || !order.payment_cancel) return { outcome: 'refused', reason: 'not_cancellable' };
    }
  }
  // the decision is committed (now or earlier): every step below is idempotent and resumable
  await R.createRecord(deps.db, orderId, { flow: 'sdk_auth_v1', phase: 'cancelled', committed_revision: 0, fulfillment_total_cents: 0, created_at: now, ttl_at: now });
  // 2. stop attempts (placement and adjustments require phase 'open')
  await R.casRecord(deps.db, orderId, (r) => {
    if (r.phase === 'cancelled') return undefined;
    r.phase = 'cancelled'; r.cancel_kind = order.payment_cancel.kind;
    if (r.consent && r.consent.state === 'pending') r.consent.state = 'expired';
    return r;
  });
  // 3. recover a pending projection, classify lost proposals, reconcile issued ops
  await recoverProjection(deps, orderId, order);
  await classifyLostProposals(deps, orderId, order);
  await reconcileSdkOps(deps, { orderId });
  // 4. every live hold (a late approval included) is SURPLUS — voided while the cancel rule allows it (same HN day, before 21:50);
  //    no cancel rule ⇒ never (fail closed)
  await R.casRecord(deps.db, orderId, (r) => {
    let changed = false;
    for (const l of Object.values(R.legsOfRecord(r))) if (l.state === 'approved' && l.role !== 'surplus') { l.role = 'surplus'; changed = true; }
    return changed ? r : undefined;
  });
  await voidSurplus(deps, orderId, typeof deps.cancelVoidEligible === 'function' ? deps.cancelVoidEligible : () => false);
  // 5. cleanup — claimed in the record so concurrent workers release once; a stale claim (a crash) is resumed
  const claim = await R.casRecord(deps.db, orderId, (r) => {
    const c = r.cleanup || {};
    if (c.done_at) return undefined;
    if (c.claimed_at && now - c.claimed_at < CLEANUP_STALE_MS) return undefined;
    r.cleanup = { ...c, claimed_at: now };
    return r;
  });
  if (claim.applied) {
    const releaseResources = deps.releaseResources || ((dp, id, o) => require('./release').releaseSdkOrder(dp, id, o));
    await releaseResources(deps, orderId, order);
    await R.casRecord(deps.db, orderId, (r) => { if (!r.cleanup || r.cleanup.done_at) return undefined; r.cleanup.done_at = deps.clock(); return r; });
  }
  return { outcome: 'cancelled' };
}
const expirePending = (deps, { orderId }) => cancelSdkOrder(deps, { orderId, kind: 'expire' });

// A replacement/delta leg approved but never committed (its flow crashed before deciding) is SURPLUS after the reconcile window.
async function sweepPendingRoles(deps, orderId) {
  const now = deps.clock();
  return R.casRecord(deps.db, orderId, (r) => {
    let changed = false;
    const proposed = new Set(Object.values(r.proposals || {}).filter((p) => p.state === 'proposed').flatMap((p) => p.new_leg_ids || []));
    for (const [id, l] of Object.entries(R.legsOfRecord(r))) {
      if (l.role === 'pending' && !proposed.has(id) && now - l.created_at >= RECONCILE_AFTER_MS) { l.role = 'surplus'; changed = true; }
    }
    return changed ? r : undefined;
  });
}

// A surplus hold past its 15-day expiry becomes `expired` (or `voided`) ONLY on bound status evidence — never by assumption.
async function trackExpiry(deps, orderId) {
  const now = deps.clock();
  const rec = await readRecord(deps.db, orderId);
  if (!rec) return;
  for (const [legId, leg] of Object.entries(R.legsOfRecord(rec))) {
    if (leg.state !== 'approved' || leg.role === 'committed' || now < leg.hold_expires_at || !leg.pp_uuid) continue;
    let sId = null;
    await R.casRecord(deps.db, orderId, (r) => { sId = `${orderId}:${legId}:status:${Object.keys(R.opsOf(r)).length + 1}`; r.ops = { ...R.opsOf(r), [sId]: { leg_id: legId, action: 'status', of: 'expiry', dispatched_at: now, result: null } }; return r; });
    const ev = await deps.psp.pspStatus({ uuid: leg.pp_uuid });
    await R.casRecord(deps.db, orderId, (r) => {
      const s = R.opsOf(r)[sId]; const l = R.legsOfRecord(r)[legId];
      if (!s || s.result) return undefined;
      s.result = { kind: ev.state, at: deps.clock() };
      if (l && l.state === 'approved' && boundStatus(ev, l) && (ev.state === 'expired' || ev.state === 'voided')) l.state = ev.state;
      return r;
    });
  }
}

module.exports = { decidePlacement, ppRef, consumeFulfilledRedemption, markerGuard, sweepPendingRoles, trackExpiry, cancelSdkOrder, expirePending, placeOriginal, reconcileSdkOps, settleTerminal, openObligations, completeObligation, requestDecrease, recordConsent, applyIncrease, recoverProjection, classifyLostProposals, voidSurplus, readOrder, readRecord, alertOnce, RECONCILE_AFTER_MS, CONSENT_WINDOW_MS };
