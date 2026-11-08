'use strict';
// SDK payment coordinator — the ONE writer of payment_sdk/{orderId} (PLAN-capp-native-shell-and-payments §2.11;
// BRIEF-sdk-payment-coordinator r5). Every PSP call is journaled by a record CAS BEFORE it is made and answered by another CAS
// after; an unknown outcome LOCKS the record (no new money op until a bound status answer resolves it). Decisions that race
// the order's own life (going live, adjusting, cancelling, settling) are won by a transaction on orders/{id} (§4, §4a, §8).
// deps: { db, psp (makeAdapter), now(), voidEligible(leg, now), release(orderId) }.
const R = require('./record');
const { boundStatus } = require('./psp-adapter');

const RECONCILE_AFTER_MS = 2 * 60 * 1000;   // an unanswered op older than this is reconciled (> the PSP call timeout)
const UNKNOWN_ALERT_MS = 10 * 60 * 1000;
const OBLIGATION_DUE_MS = 3 * 24 * 3600 * 1000;

const readOrder = async (db, orderId) => (await db.ref(`orders/${orderId}`).once('value')).val();
const readRecord = async (db, orderId) => (await db.ref(`payment_sdk/${orderId}`).once('value')).val();
const enrol = (deps, orderId) => deps.db.ref(`payment_sdk_due/${orderId}`).set(deps.now());
const isSdk = (order) => !!order && order.payment_flow === 'sdk_auth_v1';
const isTerminal = (order) => !!order && R.TERMINAL.includes(order.status);

// A deterministic, create-once alert (never duplicated by retries or sweeps).
async function alertOnce(deps, kind, orderId, detail, suffix) {
  const key = `sdkpay_${kind}_${orderId}${suffix ? `_${suffix}` : ''}`;
  try {
    await deps.db.ref(`dispatcher_alerts/${key}`).transaction((cur) => (cur == null ? { type: `payment_sdk_${kind}`, detail: { orderId, ...(detail || {}) }, created_at: deps.now() } : undefined));
  } catch (_) { /* best-effort: the record still carries the condition and the sweeper re-raises it */ }
}

// One transaction on orders/{id}: mutate(cur) returns the next order or undefined (refuse). Null-first safe.
async function orderTxn(db, orderId, mutate) {
  let won = false;
  const res = await db.ref(`orders/${orderId}`).transaction((cur) => {
    won = false;
    if (cur == null) return null;
    const next = mutate(JSON.parse(JSON.stringify(cur)));
    if (next === undefined) return undefined;
    won = true;
    return next;
  });
  return { won: !!(res && res.committed && won), order: res && res.snapshot ? res.snapshot.val() : null };
}

// ── journal → call → answer ───────────────────────────────────────────────────────────────────────────────────────────
// pre(rec) mutates the record for this op (or returns undefined to refuse); call(opId, rec) talks to the PSP; apply(rec, leg,
// out, opId) records the answer. A money op is refused while the record is locked or any money op is unanswered.
async function dispatch(deps, orderId, { legId, action, amount_cents, pre, call, apply }) {
  const now = deps.now();
  const lid = () => (typeof legId === 'function' ? legId() : legId);   // a new leg's id is known only after pre()
  await enrol(deps, orderId);                         // enrol BEFORE work (§5): a crash after this leaves only a due entry
  let opId = null;
  const j = await R.casRecord(deps.db, orderId, (rec) => {
    if (rec.lock || R.unansweredMoneyOps(rec).length) return undefined;
    const r2 = pre(rec);
    if (!r2) return undefined;
    const n = Object.keys(R.opsOf(r2)).length + 1;
    opId = `${orderId}:${lid()}:${action}:${n}`;
    r2.ops = { ...R.opsOf(r2), [opId]: { leg_id: lid(), action, amount_cents: amount_cents || null, binding: { order_id: orderId, revision: r2.committed_revision || 0, leg_id: lid() }, dispatched_at: now, result: null } };
    return r2;
  });
  if (!j.applied) return { dispatched: false, record: j.record };
  const out = await call(opId, j.record);
  const done = await R.casRecord(deps.db, orderId, (rec) => {
    const op = R.opsOf(rec)[opId];
    if (!op || op.result) return undefined;           // already answered (reconciled) — a stale result is ignored
    op.result = { kind: out.outcome, code: out.code || null, at: deps.now() };
    apply(rec, R.legsOf(rec)[lid()], out, opId);
    return rec;
  });
  return { dispatched: true, out, opId, record: done.record };
}

const lockFor = (rec, reason, opId, now) => { rec.lock = { reason, op_id: opId || null, at: now }; };

function applyAuth(deps, rec, leg, out, opId) {
  if (!leg) return;
  if (out.uuid) leg.pp_uuid = out.uuid;
  if (out.outcome === 'approved') { leg.state = 'approved'; leg.role = leg.kind === 'original' ? 'committed' : 'pending'; }
  else if (out.outcome === 'definitive_decline' || out.outcome === 'token_expired_confirmed') { leg.state = 'declined'; leg.role = 'none'; }
  else if (out.outcome === 'requires_action') { leg.state = 'requires_action'; lockFor(rec, 'requires_action', opId, deps.now()); }
  else { leg.state = 'unknown'; lockFor(rec, 'unknown_op', opId, deps.now()); }
}
function applyCapture(deps, rec, leg, out, opId) {
  if (!leg) return;
  if (out.outcome === 'captured') { leg.state = 'captured'; leg.captured_at = deps.now(); }
  else if (out.outcome === 'declined') lockFor(rec, 'manual_reconciliation', opId, deps.now());   // capture failure ⇒ a person
  else lockFor(rec, 'unknown_op', opId, deps.now());
}
function applyVoid(deps, rec, leg, out, opId) {
  if (!leg) return;
  if (out.outcome === 'voided') leg.state = 'voided';
  else if (out.outcome === 'unknown') lockFor(rec, 'unknown_op', opId, deps.now());
  // refused: the leg stays approved (surplus), tracked to its expiry
}

function newLeg(rec, kind, amount_cents, now) {
  const id = `L${Object.keys(R.legsOf(rec)).length + 1}`;
  rec.legs = { ...R.legsOf(rec), [id]: { kind, amount_cents, role: 'none', state: 'journaled', created_at: now, hold_expires_at: now + R.HOLD_MS } };
  return id;
}

// ── placement (§2.11: the order goes live on an APPROVED original leg; the go-live decision is an order transaction) ─────
async function placeOriginal(deps, { orderId, token, amount_cents }) {
  const now = deps.now();
  if (!R.isInt(amount_cents) || amount_cents <= 0 || typeof token !== 'string' || !token) return { outcome: 'refused', reason: 'bad_input' };
  const order = await readOrder(deps.db, orderId);
  if (!isSdk(order) || order.status !== 'pending_payment' || order.payment_cancel || order.payment_placed) return { outcome: 'refused', reason: 'order_state' };
  await enrol(deps, orderId);
  await R.createRecord(deps.db, orderId, { flow: 'sdk_auth_v1', phase: 'open', committed_revision: 0, fulfillment_total_cents: amount_cents, created_at: now, ttl_at: now + R.TTL_MS });
  let legId = null;
  const d = await dispatch(deps, orderId, {
    action: 'auth',
    legId: () => legId,
    amount_cents,
    pre: (rec) => {
      if (rec.phase !== 'open') return undefined;
      if (Object.values(R.legsOf(rec)).some((l) => l.kind === 'original' && l.state !== 'declined')) return undefined;
      legId = newLeg(rec, 'original', amount_cents, now);
      rec.legs[legId].state = 'sent';
      rec.token = token;
      rec.fulfillment_total_cents = amount_cents;
      return rec;
    },
    call: (opId) => deps.psp.authorize({ token, amount_cents, op_id: opId, ref: orderId }),
    apply: (rec, leg, out, opId) => applyAuth(deps, rec, leg, out, opId),
  });
  if (!d.dispatched) return { outcome: 'refused', reason: 'locked_or_busy' };
  if (d.out.outcome !== 'approved') return { outcome: d.out.outcome === 'requires_action' ? 'requires_action' : d.out.outcome === 'unknown' ? 'unknown' : 'declined' };
  const decided = await orderTxn(deps.db, orderId, (cur) => {
    if (cur.status !== 'pending_payment' || cur.payment_cancel || cur.payment_placed) return undefined;
    cur.payment_placed = { leg_id: legId, at: deps.now() };
    return cur;
  });
  if (decided.won) return { outcome: 'placed', leg_id: legId };
  // the order lost the race (expired / cancelled first): the approved hold is SURPLUS, never captured
  await R.casRecord(deps.db, orderId, (rec) => { const l = R.legsOf(rec)[legId]; if (!l || l.state !== 'approved') return undefined; l.role = 'surplus'; return rec; });
  return { outcome: 'late_surplus', leg_id: legId };
}

// ── reconciliation: status queries never resolve an op implicitly; a separate CAS does, on BOUND definitive evidence ─────
async function reconcile(deps, { orderId }) {
  const now = deps.now();
  const rec = await readRecord(deps.db, orderId);
  if (!rec) return { reconciled: 0 };
  let reconciled = 0;
  for (const [opId, op] of Object.entries(R.opsOf(rec))) {
    if (!R.MONEY_ACTIONS.includes(op.action)) continue;
    const unanswered = !op.result && now - op.dispatched_at >= RECONCILE_AFTER_MS;
    const unknown = op.result && op.result.kind === 'unknown';
    if (!unanswered && !unknown) continue;
    const leg = R.legsOf(rec)[op.leg_id];
    if (!leg || !leg.pp_uuid) {
      // no uuid: the lost-UUID lookup (§7.V) is out of scope → a person; the lock stays
      await R.casRecord(deps.db, orderId, (r) => { if (r.lock && r.lock.reason === 'manual_reconciliation' && r.lock.op_id === opId) return undefined; lockFor(r, 'manual_reconciliation', opId, now); return r; });
      await alertOnce(deps, 'manual_reconciliation', orderId, { op_id: opId, why: 'no_uuid' }, opId.replace(/[^A-Za-z0-9_-]/g, '_'));
      continue;
    }
    // journal the status query (allowed while locked), ask, record its answer
    let sId = null;
    await R.casRecord(deps.db, orderId, (r) => { sId = `${orderId}:${op.leg_id}:status:${Object.keys(R.opsOf(r)).length + 1}`; r.ops = { ...R.opsOf(r), [sId]: { leg_id: op.leg_id, action: 'status', of: opId, dispatched_at: now, result: null } }; return r; });
    const ev = await deps.psp.status({ uuid: leg.pp_uuid });
    await R.casRecord(deps.db, orderId, (r) => { const s = R.opsOf(r)[sId]; if (!s || s.result) return undefined; s.result = { kind: ev.state, at: deps.now() }; return r; });
    if (!boundStatus(ev, leg)) {
      if (now - op.dispatched_at >= UNKNOWN_ALERT_MS) await alertOnce(deps, 'unknown_op', orderId, { op_id: opId }, opId.replace(/[^A-Za-z0-9_-]/g, '_'));
      continue;                                        // inconclusive / unbound → the lock stays, no retry
    }
    const res = await R.casRecord(deps.db, orderId, (r) => {
      const o = R.opsOf(r)[opId]; const l = R.legsOf(r)[op.leg_id];
      if (!o || !l || (o.result && o.result.kind !== 'unknown')) return undefined;
      const st = ev.state;
      let kind = null;
      if (o.action === 'auth') {
        if (st === 'authorized') { l.state = 'approved'; l.role = l.kind === 'original' ? 'committed' : 'surplus'; kind = 'approved'; }   // a B / delta found live after its flow returned is SURPLUS
        else if (st === 'declined') { l.state = 'declined'; l.role = 'none'; kind = 'definitive_decline'; }
        else if (st === 'voided' || st === 'expired') { l.state = st; kind = st; }
      } else if (o.action === 'capture') {
        if (st === 'captured') { l.state = 'captured'; l.captured_at = now; kind = 'captured'; }
        else if (st === 'authorized') kind = 'not_captured';
      } else if (o.action === 'void') {
        if (st === 'voided') { l.state = 'voided'; kind = 'voided'; }
        else if (st === 'authorized') kind = 'refused';
        else if (st === 'expired') { l.state = 'expired'; kind = 'expired'; }
      }
      if (!kind) return undefined;                     // evidence that does not fit this op → stays locked for a person
      o.result = { kind, code: null, at: now, via: sId };
      if (r.lock && r.lock.op_id === opId && r.lock.reason !== 'manual_reconciliation') r.lock = null;
      return r;
    });
    if (res.applied) reconciled += 1;
  }
  return { reconciled };
}

// ── terminal settlement (§4, §4a, §6): payment_terminal → recover → freeze → capture the frozen set → obligations ───────
async function settleTerminal(deps, { orderId }) {
  const now = deps.now();
  let order = await readOrder(deps.db, orderId);
  let rec = await readRecord(deps.db, orderId);
  if (!rec || !isSdk(order)) return { outcome: 'none' };
  if (!isTerminal(order) && !order.payment_terminal) return { outcome: 'not_terminal' };
  if (order.payment_cancel && !order.payment_terminal) {
    // a terminal status written after a committed cancel decision (an override): never captured automatically
    await R.casRecord(deps.db, orderId, (r) => { if (r.lock && r.lock.reason === 'manual_reconciliation') return undefined; lockFor(r, 'manual_reconciliation', null, now); return r; });
    await alertOnce(deps, 'terminal_after_cancel', orderId, {});
    return { outcome: 'manual' };
  }
  if (!order.payment_terminal) {
    const t = await orderTxn(deps.db, orderId, (cur) => {
      if (cur.payment_terminal) return undefined;
      if (!R.TERMINAL.includes(cur.status) || cur.payment_cancel) return undefined;
      cur.payment_terminal = { revision: (cur.payment_commit && cur.payment_commit.revision) || 0, at: deps.now() };
      return cur;
    });
    order = t.order || await readOrder(deps.db, orderId);
    if (!order || !order.payment_terminal) return { outcome: 'not_terminal' };
  }
  if (!isTerminal(order)) await alertOnce(deps, 'status_reversal_after_terminal', orderId, { status: order.status || null });
  await recoverProjection(deps, orderId, order);
  await classifyLostProposals(deps, orderId, order);
  const fr = await R.casRecord(deps.db, orderId, (r) => {
    if (r.phase !== 'open' && r.phase !== 'adjusting') return undefined;
    const set = Object.entries(R.legsOf(r)).filter(([, l]) => l.role === 'committed' && (l.state === 'approved' || l.state === 'captured')).map(([id]) => id);
    for (const l of Object.values(R.legsOf(r))) if (l.role === 'pending') l.role = 'surplus';   // a late approval outside the set
    r.phase = 'frozen';
    r.frozen = { revision: r.committed_revision || 0, fulfillment_total_cents: r.fulfillment_total_cents, capture_set: set, at: now };
    if (r.consent && r.consent.state === 'pending') r.consent.state = 'expired';
    return r;
  });
  rec = fr.record || await readRecord(deps.db, orderId);
  if (!rec || !rec.frozen) return { outcome: 'not_frozen' };
  for (const legId of rec.frozen.capture_set || []) {
    const leg = R.legsOf(rec)[legId];
    if (!leg || leg.state !== 'approved') continue;
    const d = await dispatch(deps, orderId, {
      legId, action: 'capture', amount_cents: leg.amount_cents,
      pre: (r) => { const l = R.legsOf(r)[legId]; if (r.phase !== 'frozen' || !l || l.state !== 'approved' || !(r.frozen.capture_set || []).includes(legId)) return undefined; return r; },
      call: (opId) => deps.psp.capture({ uuid: leg.pp_uuid, amount_cents: leg.amount_cents, op_id: opId }),
      apply: (r, l, out, opId) => applyCapture(deps, r, l, out, opId),
    });
    if (d.record) rec = d.record;
  }
  await openObligations(deps, orderId);
  return { outcome: 'settled' };
}

// Obligations open in the step that follows the LAST confirmed capture; deterministic id ⇒ created once.
async function openObligations(deps, orderId) {
  const now = deps.now();
  let opened = null;
  await R.casRecord(deps.db, orderId, (r) => {
    if (!r.frozen) return undefined;
    const set = r.frozen.capture_set || [];
    if (set.some((id) => !R.legsOf(r)[id] || R.legsOf(r)[id].state !== 'captured')) return undefined;
    const liability = R.derive(r).refund_liability;
    if (liability <= 0) return undefined;
    const id = `refund_${r.frozen.revision}`;
    if (r.obligations && r.obligations[id]) return undefined;
    r.obligations = { ...(r.obligations || {}), [id]: { kind: 'refund', amount_cents: liability, reason: r.rule4 ? 'rule4_no_void' : 'liability', owner: 'operator', due_at: now + OBLIGATION_DUE_MS, state: 'open' } };
    opened = { id, amount_cents: liability };
    return r;
  });
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
const committedLegIds = (rec) => Object.entries(R.legsOf(rec)).filter(([, l]) => l.role === 'committed' && (l.state === 'approved' || l.state === 'captured')).map(([id]) => id);
const orderOpen = (order) => isSdk(order) && !!order.payment_placed && !isTerminal(order) && order.status !== 'cancelled' && !order.payment_cancel && !order.payment_terminal;
const recordOpen = (rec, order) => !!rec && rec.phase === 'open' && !rec.lock && !R.unansweredMoneyOps(rec).length && (rec.committed_revision || 0) === revOf(order);

async function persistProposal(deps, orderId, p) {
  let pid = null;
  const res = await R.casRecord(deps.db, orderId, (rec) => {
    if ((rec.committed_revision || 0) !== p.base_revision) return undefined;
    pid = `p${Object.keys(rec.proposals || {}).length + 1}`;
    rec.proposals = { ...(rec.proposals || {}), [pid]: { ...p, pid, state: 'proposed', created_at: deps.now() } };
    return rec;
  });
  return res.applied ? pid : null;
}
// THE decision: the order must be live, not cancelled/terminal, and still at the proposal's base revision.
const commitProposal = (deps, orderId, pid, p) => orderTxn(deps.db, orderId, (cur) => {
  if (R.TERMINAL.includes(cur.status) || cur.status === 'cancelled' || cur.payment_cancel || cur.payment_terminal) return undefined;
  if (revOf(cur) !== p.base_revision) return undefined;
  cur.payment_commit = { revision: p.base_revision + 1, pid };
  cur.payment_total_cents = p.fulfillment_total_cents;
  return cur;
});

// Apply the order's committed proposal if the record lags (crash recovery included). At most one can be pending.
async function recoverProjection(deps, orderId, order) {
  const pc = order && order.payment_commit;
  if (!pc) return null;
  let rule4 = false; let missing = false;
  const res = await R.casRecord(deps.db, orderId, (rec) => {
    if ((rec.committed_revision || 0) >= pc.revision) return undefined;
    const p = rec.proposals && rec.proposals[pc.pid];
    if (!p) { missing = true; return undefined; }
    for (const [id, l] of Object.entries(R.legsOf(rec))) {
      if ((p.committed_set || []).includes(id)) { if (l.state === 'approved' || l.state === 'captured') l.role = 'committed'; }
      else if (l.role === 'committed' || l.role === 'pending') l.role = 'surplus';
    }
    rec.fulfillment_total_cents = p.fulfillment_total_cents;
    rec.committed_revision = pc.revision;
    p.state = 'committed';
    if (p.kind === 'decrease_rule4') { rec.rule4 = { at: deps.now(), revision: pc.revision }; rule4 = true; }
    return rec;
  });
  if (missing) {
    await R.casRecord(deps.db, orderId, (r) => { if (r.lock && r.lock.reason === 'manual_reconciliation') return undefined; lockFor(r, 'manual_reconciliation', null, deps.now()); return r; });
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
      for (const id of p.new_leg_ids || []) { const l = R.legsOf(rec)[id]; if (l && (l.role === 'pending' || l.role === 'none')) l.role = 'surplus'; }
    }
    return changed ? rec : undefined;
  });
}

// Void every surplus hold that is still void-eligible (production: never); a refused / unknown void leaves it SURPLUS.
async function voidSurplus(deps, orderId) {
  const rec = await readRecord(deps.db, orderId);
  for (const [legId, leg] of Object.entries(R.legsOf(rec))) {
    if (leg.role !== 'surplus' || leg.state !== 'approved' || !leg.pp_uuid) continue;
    if (Object.values(R.opsOf(rec)).some((o) => o.leg_id === legId && o.action === 'void')) continue;   // one void per leg
    if (!deps.voidEligible(leg, deps.now())) continue;
    await dispatch(deps, orderId, {
      legId, action: 'void',
      pre: (r) => { const l = R.legsOf(r)[legId]; if (!l || l.role !== 'surplus' || l.state !== 'approved') return undefined; return r; },
      call: (opId) => deps.psp.void({ uuid: leg.pp_uuid, op_id: opId }),
      apply: (r, l, out, opId) => applyVoid(deps, r, l, out, opId),
    });
  }
}

// propose → commit → project; the caller's new legs become surplus if the order decided otherwise.
async function decide(deps, orderId, p) {
  const pid = await persistProposal(deps, orderId, p);
  if (!pid) return { outcome: 'refused', reason: 'revision_moved' };
  const c = await commitProposal(deps, orderId, pid, p);
  if (!c.won) { await classifyLostProposals(deps, orderId, c.order || await readOrder(deps.db, orderId)); return { outcome: 'lost_to_order', pid }; }
  await recoverProjection(deps, orderId, c.order);
  return { outcome: 'committed', pid, revision: c.order.payment_commit.revision };
}

const expireConsent = (deps, orderId) => R.casRecord(deps.db, orderId, (r) => { if (!r.consent || r.consent.state !== 'pending') return undefined; r.consent.state = 'expired'; return r; });

async function requestDecrease(deps, { orderId, new_total_cents }) {
  const now = deps.now();
  const order = await readOrder(deps.db, orderId);
  const rec = await readRecord(deps.db, orderId);
  if (!orderOpen(order) || !recordOpen(rec, order)) return { outcome: 'refused', reason: 'not_adjustable' };
  if (!R.isInt(new_total_cents) || new_total_cents <= 0 || new_total_cents >= rec.fulfillment_total_cents) return { outcome: 'refused', reason: 'not_a_decrease' };
  await expireConsent(deps, orderId);                 // a later edit invalidates a pending consent
  const base = rec.committed_revision || 0;
  const S = committedLegIds(rec);
  if (S.length && S.every((id) => deps.voidEligible(R.legsOf(rec)[id], now))) {
    let legId = null;
    const d = await dispatch(deps, orderId, {
      action: 'auth', legId: () => legId, amount_cents: new_total_cents,
      pre: (r) => { if (r.phase !== 'open' || (r.committed_revision || 0) !== base) return undefined; legId = newLeg(r, 'replacement', new_total_cents, now); r.legs[legId].state = 'sent'; return r; },
      call: (opId) => deps.psp.authorize({ token: rec.token, amount_cents: new_total_cents, op_id: opId, ref: orderId }),
      apply: (r, l, out, opId) => applyAuth(deps, r, l, out, opId),
    });
    if (!d.dispatched) return { outcome: 'refused', reason: 'locked_or_busy' };
    if (d.out.outcome === 'approved') {
      const res = await decide(deps, orderId, { kind: 'decrease', base_revision: base, committed_set: [legId], fulfillment_total_cents: new_total_cents, new_leg_ids: [legId] });
      if (res.outcome !== 'committed') { await R.casRecord(deps.db, orderId, (r) => { const l = R.legsOf(r)[legId]; if (!l || l.role !== 'pending') return undefined; l.role = 'surplus'; return r; }); return res; }
      await voidSurplus(deps, orderId);
      return { outcome: 'replaced', leg_id: legId };
    }
    if (d.out.outcome === 'unknown' || d.out.outcome === 'requires_action') return { outcome: d.out.outcome };
    // a definitive decline of B → rule 4 (S stays committed)
  }
  const r4 = await decide(deps, orderId, { kind: 'decrease_rule4', base_revision: base, committed_set: S, fulfillment_total_cents: new_total_cents, new_leg_ids: [] });
  return r4.outcome === 'committed' ? { outcome: 'rule4' } : r4;
}

async function recordConsent(deps, { orderId, adjustment_id, new_total_cents }) {
  const now = deps.now();
  const order = await readOrder(deps.db, orderId);
  const rec = await readRecord(deps.db, orderId);
  if (!orderOpen(order) || !recordOpen(rec, order)) return { outcome: 'refused' };
  if (typeof adjustment_id !== 'string' || !adjustment_id || !R.isInt(new_total_cents) || new_total_cents <= rec.fulfillment_total_cents) return { outcome: 'refused' };
  const res = await R.casRecord(deps.db, orderId, (r) => {
    if ((r.committed_revision || 0) !== revOf(order)) return undefined;
    r.consent = { adjustment_id, order_revision: r.committed_revision || 0, old_total: r.fulfillment_total_cents, new_total: new_total_cents, delta: new_total_cents - r.fulfillment_total_cents, expires_at: now + CONSENT_WINDOW_MS, state: 'pending' };
    return r;
  });
  return { outcome: res.applied ? 'pending' : 'refused' };
}

async function applyIncrease(deps, { orderId, adjustment_id, order_revision, new_total_cents, accept }) {
  const now = deps.now();
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
    const res = await decide(deps, orderId, { kind: 'increase', base_revision: base, committed_set: S, fulfillment_total_cents: new_total_cents, new_leg_ids: [] });
    return res.outcome === 'committed' ? { outcome: 'committed' } : res;
  }
  let legId = null;
  const d = await dispatch(deps, orderId, {
    action: 'auth', legId: () => legId, amount_cents: need,
    pre: (r) => { if (r.phase !== 'open' || (r.committed_revision || 0) !== base) return undefined; legId = newLeg(r, 'delta', need, now); r.legs[legId].state = 'sent'; return r; },
    call: (opId) => deps.psp.authorize({ token: rec.token, amount_cents: need, op_id: opId, ref: orderId }),
    apply: (r, l, out, opId) => applyAuth(deps, r, l, out, opId),
  });
  if (!d.dispatched) return { outcome: 'refused', reason: 'locked_or_busy' };
  if (d.out.outcome !== 'approved') return { outcome: d.out.outcome === 'unknown' || d.out.outcome === 'requires_action' ? d.out.outcome : 'declined' };
  const res = await decide(deps, orderId, { kind: 'increase', base_revision: base, committed_set: [...S, legId], fulfillment_total_cents: new_total_cents, new_leg_ids: [legId] });
  if (res.outcome !== 'committed') {
    await R.casRecord(deps.db, orderId, (r) => { const l = R.legsOf(r)[legId]; if (!l || l.role !== 'pending') return undefined; l.role = 'surplus'; return r; });
    await voidSurplus(deps, orderId);
    return res;
  }
  return { outcome: 'committed', leg_id: legId };
}

module.exports = { placeOriginal, reconcile, settleTerminal, openObligations, completeObligation, requestDecrease, recordConsent, applyIncrease, recoverProjection, classifyLostProposals, voidSurplus, readOrder, readRecord, orderTxn, alertOnce, RECONCILE_AFTER_MS, CONSENT_WINDOW_MS };
