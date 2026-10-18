// H1b T4 — the Listo undo window (PLAN-H1b T4; advisor 2; codex P1-2; BC1). IN MEMORY ONLY:
//   startReady(orderId) holds {order_id, op_id, uid, rid, gen} + a 5 s LOCAL timer (T2: max of monotonic and wall, so neither a
//   backgrounded app nor a server offset change moves it). On expiry — seen by tick() or onResume() — the record is enqueued in
//   the T3 queue EXACTLY once, with its own op_id, and dropped from memory.
//   cancel(orderId) is Deshacer. A session gen change drops every pending record (never enqueued under another identity).
//   BC1: when the queue drops a refused ACCEPT, a pending Listo of the same order is dropped too and reported (onDropped).
//   Accepted residual (advisor): a crash inside the window loses that Listo; the order visibly stays in En preparación.
export const UNDO_MS = 5000;

export function createUndo({ queue, session, makeTimer, newOpId = () => crypto.randomUUID(), windowMs = UNDO_MS }) {
  const pending = new Map();                          // order_id → {record, timer}
  const listeners = new Set();
  const emit = (d) => { for (const cb of [...listeners]) cb(d); };

  queue.onDrop((d) => {
    if (d.action !== 'accept' || !pending.has(d.order_id)) return;
    pending.delete(d.order_id);
    emit({ order_id: d.order_id, code: d.code, reason: 'accept_refused' });
  });

  function sweep() {
    const cur = session.current();
    for (const [oid, p] of [...pending]) {
      if (p.record.gen !== cur.gen || p.record.uid !== cur.uid || p.record.rid !== cur.rid) { pending.delete(oid); continue; }
      if (!p.timer.expired()) continue;
      pending.delete(oid);                           // before the enqueue: exactly once, even if enqueue throws
      const { order_id, op_id } = p.record;
      const r = queue.enqueue({ action: 'ready', order_id, op_id });
      if (!r.ok) emit({ order_id, code: null, reason: r.reason });
    }
  }

  return {
    startReady(orderId) {
      if (pending.has(orderId)) return pending.get(orderId).record.op_id;
      const cur = session.current();
      const timer = makeTimer(); timer.start(windowMs);
      const record = Object.freeze({ order_id: orderId, op_id: newOpId(), uid: cur.uid, rid: cur.rid, gen: cur.gen });
      pending.set(orderId, { record, timer });
      return record.op_id;
    },
    cancel(orderId) { return pending.delete(orderId); },
    tick: sweep,
    onResume: sweep,
    pending(orderId) {
      const p = pending.get(orderId);
      return p ? { op_id: p.record.op_id, remaining: p.timer.remaining() } : null;
    },
    onDropped(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
