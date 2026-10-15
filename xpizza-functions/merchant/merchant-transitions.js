'use strict';
// H1a C-2/C-5/C-6 — the PURE body of every handheld order action. It runs INSIDE runTransaction(orders/{oid}) on the live
// node, so the status CAS, the prep change, the answer marker, the reject intent and the operation receipt commit together
// or not at all. No I/O, no clock (nowMs is injected), never mutates its input.
//
// Check order (codex r2 #3): receipt (same caller + action + payload hash → the stored result) → served order (stored
// location + on-brand provenance) → cancel claim / terminal status → action preconditions → stored-prep validation → effect.
// Result: { commit: newNode, result } or { abort: result }. An abort writes nothing.
const { vStoredPrep } = require('./merchant-validate');

const TERMINAL = new Set(['cancelled', 'delivered', 'completed']);
const fail = (code, extra) => ({ abort: { ok: false, code, ...(extra || {}) } });

function applyAction(node, req, ctx) {
  if (!node || typeof node !== 'object') return fail('not_found');
  const ops = (node.handheld_ops && typeof node.handheld_ops === 'object') ? node.handheld_ops : {};
  const prior = ops[req.op_id];
  if (prior) {
    return (prior.by === ctx.uid && prior.action === req.action && prior.payload_hash === ctx.payloadHash)
      ? { abort: prior.result }
      : fail('op_conflict');
  }
  if (node.restaurant_id !== req.rid || typeof node.routing_reason !== 'string') return fail('not_served');
  const stale = () => fail('stale_state', { status: node.status === undefined ? null : node.status });
  if (node.cancel_claim_id || TERMINAL.has(node.status)) return stale();

  const t = ctx.nowMs, by = ctx.uid, op = req.op_id, p = req.payload || {};
  let next;
  switch (req.action) {
    case 'accept': {
      if (node.status !== 'new' || node.handheld_answered) return stale();
      const n = p.prep_min;
      next = { ...node, status: 'preparing',
        prep: { committed_min: n, extra_min: 0, accepted_at: t, ready_at: t + n * 60000 },
        handheld_answered: { kind: 'accepted', at: t, by, op_id: op } };
      break;
    }
    case 'more': {
      if (node.status !== 'preparing' || vStoredPrep(node.prep) !== 'full') return stale();
      const cur = node.prep, extra = cur.extra_min + p.add_min;
      if (extra > 30) return fail('cap_reached');
      next = { ...node, prep: { ...cur, extra_min: extra, ready_at: cur.accepted_at + (cur.committed_min + extra) * 60000 } };
      break;
    }
    case 'ready': {
      if (node.status !== 'preparing') return stale();
      const kind = node.prep == null ? 'none' : vStoredPrep(node.prep);
      if (kind === null) return fail('bad_stored_state');
      next = { ...node, status: 'ready', prep: kind === 'full' ? { ...node.prep, ready_marked_at: t } : { ready_marked_at: t } };
      break;
    }
    case 'handed':
      if (node.status !== 'ready' || node.order_type !== 'pickup') return stale();
      next = { ...node, status: 'completed' };
      break;
    case 'reject':
      if (node.status !== 'new') return stale();
      if (node.handheld_answered) return fail('already_requested');
      next = { ...node,
        handheld_answered: { kind: 'reject_requested', at: t, by, op_id: op },
        reject_intent: { type: 'reject', reason: p.reason, note: p.note == null ? null : p.note, gone_items: Array.isArray(p.gone_items) ? p.gone_items.slice() : [], op_id: op, by, at: t } };
      break;
    default:
      return fail('bad_input');
  }
  const result = { ok: true, action: req.action, status: next.status, prep: next.prep || null };
  next.handheld_ops = { ...ops, [op]: { action: req.action, payload_hash: ctx.payloadHash, by, at: t, result } };
  return { commit: next, result };
}

module.exports = { applyAction };
