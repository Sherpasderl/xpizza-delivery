// H1b T5 — the callable client (PLAN-H1b T5). Writes go ONLY through H1a callables.
//   act(accept | more | ready) → the T3 queue (persist → send → resolve); never a direct send.
//   direct(name, data) → online-only, a fresh op_id, classified by T3 (busy, pause, agotado, handed, heartbeat …).
//   reject(oid, …) → online-only; returns the server's outcome. BC2: a 'pending' result gets ONE replay of the SAME op_id at ~15 s
//     (H1a's receipt never re-runs the cancel core and returns the stored reject_outcome); the A-2 feed stays the primary resolver.
//   orderState(oid) → merchantOrderState (driver presence / name / at-restaurant / location, prep base), or null — fail closed.
import { classify } from './outcomes.js';
import { orderView } from './model.js';

export const QUEUED = Object.freeze({ accept: 'merchantAccept', more: 'merchantMoreTime', ready: 'merchantReady' });
export const REJECT_RETRY_MS = 15000;

export function createApi({ call, queue, isOnline, rid, newOpId = () => crypto.randomUUID(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const send = (it) => call(QUEUED[it.action], { rid, oid: it.order_id, op_id: it.op_id, ...(it.payload || {}) });
  const timers = new Set();
  return {
    act(action, orderId, payload = null) {
      if (!QUEUED[action]) throw new Error(`${action} is not a queued action`);
      const r = queue.enqueue({ action, order_id: orderId, payload });
      if (r.ok && isOnline()) void queue.flush(send);
      return r;
    },
    flush: () => queue.flush(send),
    async direct(name, data = {}) {
      if (!isOnline()) return { class: 'offline', code: 'offline', result: null };
      let res;
      try { res = await call(name, { rid, op_id: newOpId(), ...data }); } catch (e) { res = e; }
      const c = classify(res);
      return { ...c, result: c.class === 'ok' ? res : null };
    },
    async reject(orderId, { reason, note = null, gone_items = [] }, { onResolved = () => {} } = {}) {
      if (!isOnline()) return { class: 'offline', code: 'offline', state: null, op_id: null };
      const op_id = newOpId();
      const body = { rid, oid: orderId, op_id, reason, note, gone_items };
      const once = async () => { let res; try { res = await call('merchantReject', body); } catch (e) { res = e; } return res; };
      const res = await once();
      const c = classify(res);
      const state = c.class === 'ok' && typeof res.state === 'string' ? res.state : null;
      if (state === 'pending') {
        const h = setTimer(async () => {
          timers.delete(h);
          const again = await once();
          if (classify(again).class === 'ok' && typeof again.state === 'string' && again.state !== 'pending') onResolved(again.state);
        }, REJECT_RETRY_MS);
        timers.add(h);
      }
      return { class: c.class, code: c.code, state, op_id };
    },
    async orderState(orderId) {
      if (!isOnline()) return null;
      try { const r = await call('merchantOrderState', { rid, oid: orderId }); return r && typeof r === 'object' ? r : null; } catch (_) { return null; }
    },
    stop() { for (const h of timers) clearTimer(h); timers.clear(); },
  };
}

// The cancelled toast: ONLY from the rejecting device's own returned outcome (never from an order leaving the feed).
export function rejectToast(order, state) {
  if (state !== 'cancelled' && state !== 'refund_pending') return null;
  const base = `Pedido #${orderView(order).num} cancelado. Sherpa le avisa al cliente.`;
  return order && order.payment_method === 'online' ? `${base} Le devolvemos el dinero al cliente.` : base;
}
