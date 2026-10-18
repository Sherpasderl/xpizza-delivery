// H1b T5 — the callable client (PLAN-H1b T5). Writes go ONLY through H1a callables.
//   act(accept | more | ready) → the T3 queue (persist → send → resolve); never a direct send.
//   direct(name, data) → online-only, a fresh op_id, classified by T3 (busy, pause, agotado, handed, heartbeat …).
//   reject(oid, …) → online-only; returns the server's outcome. BC2: a 'pending' result gets ONE replay of the SAME op_id at ~15 s
//     (H1a's receipt never re-runs the cancel core and returns the stored reject_outcome); the A-2 feed stays the primary resolver.
//   orderState(oid) → merchantOrderState (driver presence / name / at-restaurant / location, prep base), or null — fail closed.
//   stop() (sign-out / branch change, codex H1b r1 P1-1): every later continuation — a direct call, a reject, the BC2 retry, an
//   orderState — resolves as 'stopped' and touches nothing; onResolved never fires. onAuthLost() (P1-3): ANY auth-class result, from
//   a flush (automatic or explicit) or a call, is reported once per occurrence so the app tears the session down.
import { classify } from './outcomes.js';
import { orderView } from './model.js';

export const QUEUED = Object.freeze({ accept: 'merchantAccept', more: 'merchantMoreTime', ready: 'merchantReady' });
export const REJECT_RETRY_MS = 15000;

const STOPPED = Object.freeze({ class: 'stopped', code: 'stopped' });

export function createApi({ call, queue, isOnline, rid, newOpId = () => crypto.randomUUID(), setTimer = setTimeout, clearTimer = clearTimeout, onAuthLost = () => {} }) {
  const send = (it) => call(QUEUED[it.action], { rid, oid: it.order_id, op_id: it.op_id, ...(it.payload || {}) });
  const timers = new Set();
  let stopped = false;
  const authLost = () => { if (!stopped) onAuthLost(); };
  const flush = () => queue.flush(send).then((r) => { if (r && r.stopped === 'auth') authLost(); return r; });
  return {
    act(action, orderId, payload = null) {
      if (!QUEUED[action]) throw new Error(`${action} is not a queued action`);
      if (stopped) return { ok: false, reason: 'stopped' };
      const r = queue.enqueue({ action, order_id: orderId, payload });
      if (r.ok && isOnline()) void flush();
      return r;
    },
    flush,
    async direct(name, data = {}) {
      if (stopped) return { ...STOPPED, result: null };
      if (!isOnline()) return { class: 'offline', code: 'offline', result: null };
      let res;
      try { res = await call(name, { rid, op_id: newOpId(), ...data }); } catch (e) { res = e; }
      if (stopped) return { ...STOPPED, result: null };
      const c = classify(res);
      if (c.class === 'auth') authLost();
      return { ...c, result: c.class === 'ok' ? res : null };
    },
    async reject(orderId, { reason, note = null, gone_items = [] }, { onResolved = () => {} } = {}) {
      if (stopped) return { ...STOPPED, state: null, op_id: null };
      if (!isOnline()) return { class: 'offline', code: 'offline', state: null, op_id: null };
      const op_id = newOpId();
      const body = { rid, oid: orderId, op_id, reason, note, gone_items };
      const once = async () => { let res; try { res = await call('merchantReject', body); } catch (e) { res = e; } return res; };
      const res = await once();
      if (stopped) return { ...STOPPED, state: null, op_id };
      const c = classify(res);
      if (c.class === 'auth') authLost();
      const state = c.class === 'ok' && typeof res.state === 'string' ? res.state : null;
      if (state === 'pending') {
        const h = setTimer(async () => {
          timers.delete(h);
          if (stopped) return;
          const again = await once();
          if (stopped) return;
          if (classify(again).class === 'ok' && typeof again.state === 'string' && again.state !== 'pending') onResolved(again.state);
        }, REJECT_RETRY_MS);
        timers.add(h);
      }
      return { class: c.class, code: c.code, state, op_id };
    },
    async orderState(orderId) {
      if (stopped || !isOnline()) return null;
      let r = null;
      try { r = await call('merchantOrderState', { rid, oid: orderId }); } catch (e) { if (classify(e).class === 'auth') authLost(); return null; }
      return !stopped && r && typeof r === 'object' ? r : null;
    },
    stop() { stopped = true; for (const h of timers) clearTimer(h); timers.clear(); },
    stopped: () => stopped,
  };
}

// The cancelled toast: ONLY from the rejecting device's own returned outcome (never from an order leaving the feed).
export function rejectToast(order, state) {
  if (state !== 'cancelled' && state !== 'refund_pending') return null;
  const base = `Pedido #${orderView(order).num} cancelado. Sherpa le avisa al cliente.`;
  return order && order.payment_method === 'online' ? `${base} Le devolvemos el dinero al cliente.` : base;
}
