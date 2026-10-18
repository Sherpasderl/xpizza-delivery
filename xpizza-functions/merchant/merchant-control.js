'use strict';
// H1a T6 — Ocupado (busy) and Pausa (pause) writers for a location, plus the no-answer undo.
//   writePause: EXACTLY the owner CLI's transaction (tools/order-control.js) on order_control/{rid}: planChange → checkAtApply →
//     txnCallback, explicit-null args, version + no-op semantics kept, and success only if OUR op_id is the committed current.
//     txnCallback spreads the whole node, so `busy` is preserved. Returns {ok, op_id, version} | {ok, noop} | {ok:false, code}.
//   resumeIfOwn: the no-answer worker's undo (C-8) — resumes only if current.op_id is still the op it wrote.
//   writeBusy: a transaction on the same node that sets/clears ONLY `busy` = {add_min ∈ {10,15,20}, until, since, by};
//     `current` and `events` are carried through untouched.
//   effectiveBusy: the pure reader shared with C2 (ETA/dispatch) and the handheld UI.
// Deps are injected: {db, now, timestamp, newOpId}. In production `timestamp` returns ServerValue.TIMESTAMP (as the CLI does).
const OCC = require('../tools/order-control-core');

const BUSY_ADD = new Set([10, 15, 20]);
const BUSY_DUR = new Set([30, 60, 90]);

async function writePause(deps, rid, { op, forMs, reason, actor, principal }) {
  const { db, now, timestamp, newOpId } = deps;
  const ref = db.ref(`order_control/${rid}`);
  const node = (await ref.once('value')).val();
  const serverNow = now();
  const args = { op, rid, forMs: forMs === undefined ? null : forMs, untilMs: null, expectVersion: null };
  const plan = OCC.planChange({ node, args, serverNow });
  if (!plan.ok) return { ok: false, code: plan.conflict ? 'superseded' : 'refused', error: plan.error };
  if (plan.noop) return { ok: true, noop: true };
  const late = OCC.checkAtApply(plan, now());
  if (!late.ok) return { ok: false, code: 'refused', error: late.error };
  const opId = newOpId();
  const tx = await ref.transaction(OCC.txnCallback({ expectedVersion: plan.expectedVersion, to: plan.to, opId, actor, principal, reason, timestamp: timestamp() }));
  const after = tx.snapshot.val();
  if (!(tx.committed && after && after.current && after.current.op_id === opId)) return { ok: false, code: 'superseded' };
  return { ok: true, op_id: opId, version: after.current.version };
}

async function resumeIfOwn(deps, rid, opId) {
  // codex r1 P1-3: the checked version AND op ownership are enforced INSIDE the transaction — a newer pause written between
  // this read and the commit (staff, dispatch, the CLI) is never resumed.
  const { db, timestamp, newOpId } = deps;
  const ref = db.ref(`order_control/${rid}`);
  const node = (await ref.once('value')).val();
  if (!node || !node.current || node.current.op_id !== opId || node.current.paused !== true) return { ok: true, resumed: false };
  const checked = OCC.versionOf(node);
  const resumeOp = newOpId();
  const apply = OCC.txnCallback({ expectedVersion: checked, to: { paused: false }, opId: resumeOp, actor: 'sistema', principal: 'sistema',
    reason: 'sin respuesta · respondido a tiempo', timestamp: timestamp() });
  const tx = await ref.transaction((cur) => {
    if (cur === null) return null;                                                        // null-first safe
    if (!cur || !cur.current || cur.current.op_id !== opId || cur.current.paused !== true || OCC.versionOf(cur) !== checked) return undefined;
    return apply(cur);
  });
  const after = tx.snapshot.val();
  return { ok: true, resumed: !!(tx.committed && after && after.current && after.current.op_id === resumeOp) };
}

async function writeBusy(deps, rid, spec) {
  const { db, now } = deps;
  const ref = db.ref(`order_control/${rid}`);
  if (spec && spec.clear === true) {
    await ref.transaction((cur) => {
      if (cur === null) return null;                       // null-first safe: an existing node makes the server re-run us
      if (!cur.busy) return undefined;
      const { busy, ...rest } = cur; void busy;
      return rest;
    });
    return { ok: true, cleared: true };
  }
  if (!spec || !BUSY_ADD.has(spec.add_min) || !BUSY_DUR.has(spec.dur_min) || typeof spec.actor !== 'string') throw new Error('bad busy spec');
  const t = now();
  const busy = { add_min: spec.add_min, until: t + spec.dur_min * 60000, since: t, by: spec.actor };
  await ref.transaction((cur) => ({ ...(cur || {}), busy }));
  return { ok: true, busy };
}

function effectiveBusy(busy, nowMs) {
  if (!busy || typeof busy !== 'object') return 0;
  if (!BUSY_ADD.has(busy.add_min) || typeof busy.until !== 'number' || !Number.isFinite(busy.until)) return 0;
  return nowMs < busy.until ? busy.add_min : 0;
}

module.exports = { BUSY_ADD, BUSY_DUR, writePause, resumeIfOwn, writeBusy, effectiveBusy };
