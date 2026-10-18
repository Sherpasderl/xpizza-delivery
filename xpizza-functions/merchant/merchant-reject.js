'use strict';
// H1a amendment A-R1 (r3, approved with BC1–BC4) — an explicit handheld reject CANCELS the order through the EXISTING
// cancelOrderCore → voidOrRefund. This module holds NO money code: the core arrives injected as deps.cancelCore (index.js's
// h1 block binds it to cancelOrderCore(cancelDeps(db), …)); merchant-no-money.guard allows exactly that one call, here.
//
// runReject (merchantReject):
//   1. the order transaction (merchant-transitions 'reject'): receipt + handheld_answered{kind:'rejected'} + reject_intent;
//      status stays 'new'. A replay of the op never reaches step 2 — it returns the stored reject_outcome, or pending.
//   2. the core, in the same request, with a fresh random claim id.
//   3. ONLY a known core result is persisted: the dispatch notice FIRST (when one applies), then reject_outcome, op-matched.
//      A 503 / 404 / unknown status / throw writes nothing — the repair sweep (merchant-reject-repair) covers it.
//   The callable AWAITS the core and the settle to completion inside its invocation (codex r1 P1-1: no response deadline —
//   a detached cancel could lose execution mid-refund). timeoutSeconds:120 bounds it; the device shows "Cancelando…" meanwhile.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// detail.action copy (advisor, identical to the dispatch mockup). N = display_number, else the short order id.
const ACTION = Object.freeze({
  stranded: () => 'Rechazado por la sucursal — cancelar o reasignar',
  manual_review: () => 'La cancelación necesita revisión: confirmá el estado del pago antes de cancelar o reasignar.',
  refund_pending: (n) => `Pedido #${n} cancelado por la sucursal. El reembolso no se completó: revisá el pago y terminá la devolución al cliente.`,
  claim_held: () => 'Cancelación trabada — no reasignar; se libera sola en unas horas. Si el cliente reclama, revisar el pago en PixelPay.',
  // codex r1 P2-4: the core's own two terminal refusals, with the EXISTING dispatch copy of cancel-order.js's gate
  not_cancelable: () => 'El pedido ya fue entregado — no se puede cancelar',
  referred_recon: () => 'Resuélvelo en "Reconciliación de pagos"',
});
const NOTICE_KINDS = Object.freeze(Object.keys(ACTION));
const shortId = (oid) => String(oid).slice(-6);

// The core's {status, body:{outcome}} → {state, notice, code?}, or null for anything not known to be truthful.
function classify(res) {
  if (!isObj(res) || !isObj(res.body)) return null;
  const { status } = res; const outcome = res.body.outcome;
  if (status === 200 && (outcome === 'cancelled' || outcome === 'already_cancelled')) return { state: 'cancelled', notice: null };
  if (status === 409 && outcome === 'refund_pending') return { state: 'refund_pending', notice: 'refund_pending' };
  if (status === 409 && (outcome === 'manual_review' || outcome === 'resolving_in_progress' || outcome === 'claim_lost')) {
    return { state: 'manual_review', notice: 'manual_review', code: outcome };
  }
  if (status === 409 && outcome === 'not_cancelable') return { state: 'not_cancelable', notice: 'not_cancelable', code: outcome };
  if (status === 409 && outcome === 'in_recon_surface') return { state: 'referred_recon', notice: 'referred_recon', code: outcome };
  return null;
}

const noticeKey = (kind, oid) => `handheld_reject_${kind}_${oid}`;

// One atomic multi-path write: the keyed alert (set semantics — a repeat overwrites the same key) + the repair marker that
// the sweep reads to know this notice already exists (an alert pruned later must not be re-raised).
async function writeNotice(db, kind, oid, order, extra, nowMs) {
  if (!NOTICE_KINDS.includes(kind)) throw new Error(`bad notice kind ${kind}`);
  const it = isObj(order && order.reject_intent) ? order.reject_intent : {};
  const detail = {
    orderId: oid,
    rid: (order && order.restaurant_id) || null,
    display_number: (order && order.display_number) || null,
    reason: it.reason || null,
    outcome: (extra && extra.outcome) || null,
    action: ACTION[kind]((order && order.display_number) || shortId(oid)),
  };
  await db.ref().update({
    [`dispatcher_alerts/${noticeKey(kind, oid)}`]: { type: `payment_handheld_reject_${kind}`, detail, created_at: nowMs },
    [`merchant_reject_notices/${oid}/${kind}`]: nowMs,
  });
}

// The reject_outcome updater on orders/{oid} (a delegating call so the R3 census resolves its one field). Null-first safe;
// writes only while the order still carries THIS op's reject_intent.
function outcomeUpdate(node, opId, outcome) {
  if (node === null) return null;
  if (!isObj(node) || !isObj(node.reject_intent) || node.reject_intent.op_id !== opId) return undefined;
  return { ...node, reject_outcome: outcome };
}

async function writeOutcome(db, oid, opId, outcome) {
  const tx = await db.ref(`orders/${oid}`).transaction((node) => outcomeUpdate(node, opId, outcome));
  return !!tx.committed;
}

// Persist a settled core result: notice first, then the outcome. Unknown results write nothing.
async function settle(deps, oid, opId, res) {
  const { db, now } = deps;
  const c = classify(res);
  if (!c) return null;
  const t = now();
  if (c.notice) {
    const order = (await db.ref(`orders/${oid}`).once('value')).val();
    await writeNotice(db, c.notice, oid, order, { outcome: c.state }, t);
  }
  const outcome = { state: c.state, at: t, op_id: opId, by: 'handler', ...(c.code ? { code: c.code } : {}) };
  await writeOutcome(db, oid, opId, outcome);
  return c.state;
}

async function storedState(db, oid, opId) {
  const o = (await db.ref(`orders/${oid}/reject_outcome`).once('value')).val();
  return isObj(o) && o.op_id === opId && typeof o.state === 'string' ? o.state : 'pending';
}

// deps: the merchant deps + cancelCore(args) (injected), newClaimId().
async function runReject(deps, auth, data, orderAction) {
  const { db, now, cancelCore, newClaimId } = deps;
  const r = await orderAction(deps, auth, 'reject', data);
  const res = r.outcome;
  if (!res || res.ok !== true) return res;
  const oid = data.oid; const opId = data.op_id;
  if (!r.fresh) return { ...res, state: await storedState(db, oid, opId) };      // replay: never runs the core

  const reason = res.reason || (data && data.reason) || 'otro';
  let state = null;
  try {
    const coreRes = await cancelCore({ orderId: oid, actor: `handheld:${auth.uid}`, reason: `rechazado en sucursal: ${reason}`, now: now(), claimId: newClaimId() });
    state = await settle(deps, oid, opId, coreRes);
  } catch (e) { console.error(`merchantReject: ${oid} core/settle failed`, e && e.message); }
  return { ...res, state: state || 'pending' };                                    // null = unknown / failed → pending (repair sweep)
}

module.exports = { classify, noticeKey, writeNotice, outcomeUpdate, writeOutcome, settle, runReject, ACTION, NOTICE_KINDS };
