// xpizza-dispatch/dispatch-comms-thread.js
/**
 * Pure read-only comms-thread assembler (dispatch Phase 1). Orders existing
 * inbound WhatsApp messages + order automessage events into a single timeline
 * for a read-only Comms view. Display-only — no send (send is Phase 2).
 */
export function assembleThread({ inbound = [], autoEvents = [] } = {}) {
  const items = [];
  for (const m of inbound) {
    // chat → received_at (ms); non-chat/media → time (seconds). Never silently drop non-chat.
    const ts = Number.isFinite(m.received_at) ? m.received_at
             : Number.isFinite(m.time) ? m.time * 1000
             : null;
    if (ts == null) continue;
    items.push({ kind: 'in', text: m.body ?? '(media)', ts });
  }
  for (const e of autoEvents) {
    if (Number.isFinite(e.at)) items.push({ kind: 'auto', text: e.label, ts: e.at });
  }
  return items.sort((a, b) => a.ts - b.ts);
}
