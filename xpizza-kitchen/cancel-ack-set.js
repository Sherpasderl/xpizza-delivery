// PLATFORM F2 Q2 (PLAN-F2-query-rules §2) — the KDS's per-order cancel-ack set. Dependency-free and pure (the listener is
// injected), so it is node-testable; xpizza-delivery.js wires `listen` to onValue(kds_cancel_acks/{orderId}).
// Replaces the whole-collection kds_cancel_acks listener (narrowed away at Q4): one listener per ELIGIBLE cancelled order.
// Readiness is PER ID (codex F2q plan r1 P1-9): state 'unread' → 'present' | 'absent'. A missing ack may be treated as a recall
// ONLY when that id is confirmed 'absent' — never while 'unread', and never after a listener error. A callback that arrives
// for a detached id (eligibility change, teardown) is ignored.
export function createCancelAckSet({ listen, onChange }) {
  const subs = new Map();   // orderId → { state, val, unsub }
  function setIds(ids) {
    const want = new Set(ids);
    for (const [id, e] of subs) if (!want.has(id)) { e.unsub(); subs.delete(id); }
    for (const id of want) {
      if (subs.has(id)) continue;
      const entry = { state: 'unread', val: null, unsub: () => {} };
      subs.set(id, entry);
      entry.unsub = listen(id, (v) => {
        if (subs.get(id) !== entry) return;                    // stale: detached or replaced
        entry.val = v || null; entry.state = v ? 'present' : 'absent';
        onChange();
      }, () => {
        if (subs.get(id) !== entry) return;
        entry.val = null; entry.state = 'unread';              // unknown — never "absent"
        onChange();
      });
    }
  }
  function acks() { const out = {}; for (const [id, e] of subs) if (e.state === 'present') out[id] = e.val; return out; }
  const isReady = (id) => { const e = subs.get(id); return !!e && e.state !== 'unread'; };
  const isAbsent = (id) => { const e = subs.get(id); return !!e && e.state === 'absent'; };
  function teardown() { for (const e of subs.values()) e.unsub(); subs.clear(); }
  return { setIds, acks, isReady, isAbsent, teardown };
}
