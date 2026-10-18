// H1b T3 — the persisted action queue (PLAN-H1b T3; advisor 1 + 3; codex P1-1, P1-3, P2-8).
//   ONE path: accept | more | ready ALWAYS go persist → send → resolve, online or offline. A failed persist sends nothing.
//   Items are immutable {op_id, action, order_id, payload, uid, rid, enqueued_at}; the original op_id is kept forever, so a
//   resend after a crash is deduped by H1a's receipt.
//   Single-flight flush, FIFO (which preserves each order's order). A tap during a flush is appended and sent after.
//   Dependencies: a TERMINAL accept drops the later items of the same order; a terminal more / ready drops nothing else.
//   Session guard: each flush captures {uid, rid, gen}; before every send and on every result, a different gen (bumped BEFORE any
//   Auth switch) or a partition mismatch stops the flush and VOIDS the late result (no state touched). An already-sent request
//   may still commit server-side — accepted; its receipt makes a later resend harmless.
//   auth → paused (no sends) until re-pair; the partition is discarded at sign-out, with a note.
import { classify } from './outcomes.js';

export const keyOf = ({ uid, rid }) => `hh_queue:${uid}:${rid}`;

// storage adapter: { get(key) → string|null, set(key, string), remove(key) } — localStorage in the app (wrapped: it can throw).
export function memoryStorage({ failWrites = false } = {}) {
  const m = new Map();
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { if (failWrites) throw new Error('quota'); m.set(k, v); },
    remove: (k) => { m.delete(k); },
    raw: (k) => (m.has(k) ? m.get(k) : null),
    setRaw: (k, v) => m.set(k, v),
  };
}
export function browserStorage(ls) {
  return {
    get: (k) => { try { return ls.getItem(k); } catch (_) { return null; } },
    set: (k, v) => ls.setItem(k, v),                  // a throw here is the "persist failed" signal
    remove: (k) => { try { ls.removeItem(k); } catch (_) { /* nothing to do */ } },
  };
}

const freeze = (it) => Object.freeze({ ...it, payload: it.payload ? Object.freeze({ ...it.payload }) : null });

export function createQueue({ storage, partition, session, newOpId = () => crypto.randomUUID(), now = () => Date.now() }) {
  const key = keyOf(partition);
  let items = load();
  let flight = null;
  let paused = false;
  const dropListeners = new Set();

  function load() {
    try {
      const raw = storage.get(key);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x) => x && typeof x.op_id === 'string' && x.uid === partition.uid && x.rid === partition.rid).map(freeze) : [];
    } catch (_) { return []; }
  }
  function persist(next) {
    if (next.length) storage.set(key, JSON.stringify(next)); else storage.remove(key);
    items = next;
  }
  const sameSession = (snap) => {
    const c = session.current();
    return c.gen === snap.gen && c.uid === partition.uid && c.rid === partition.rid && snap.uid === partition.uid && snap.rid === partition.rid;
  };
  const emitDrop = (d) => { for (const cb of [...dropListeners]) cb(d); };

  async function run(send) {
    const snap = { ...session.current() };
    const out = { sent: 0, dropped: [], stopped: null };
    if (paused) { out.stopped = 'paused'; return out; }
    while (items.length) {
      if (!sameSession(snap)) { out.stopped = 'session'; return out; }
      const it = items[0];
      let res;
      try { res = await send(it); } catch (e) { res = e; }
      if (!sameSession(snap)) { out.stopped = 'session'; return out; }   // void the late result: nothing touched
      const c = classify(res);
      if (c.class === 'ok') { persist(items.slice(1)); out.sent++; continue; }
      if (c.class === 'retry') { out.stopped = 'retry'; return out; }
      if (c.class === 'auth') { paused = true; out.stopped = 'auth'; return out; }
      // terminal: drop it (+ the same order's later items if it was an accept)
      const drops = [{ action: it.action, order_id: it.order_id, op_id: it.op_id, code: c.code, reason: 'refused' }];
      let rest = items.slice(1);
      if (it.action === 'accept') {
        for (const x of rest.filter((y) => y.order_id === it.order_id)) drops.push({ action: x.action, order_id: x.order_id, op_id: x.op_id, code: c.code, reason: 'depends_on_refused_accept' });
        rest = rest.filter((y) => y.order_id !== it.order_id);
      }
      persist(rest);
      for (const d of drops) { out.dropped.push(d); emitDrop(d); }
    }
    return out;
  }

  return {
    enqueue({ action, order_id, payload = null, op_id = null }) {
      const id = typeof op_id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(op_id) ? op_id : newOpId();   // H1a vOpId
      const it = freeze({ op_id: id, action, order_id, payload, uid: partition.uid, rid: partition.rid, enqueued_at: now() });
      try { persist([...items, it]); } catch (_) { return { ok: false, reason: 'storage' }; }
      return { ok: true, item: it };
    },
    flush(send) {
      if (!flight) flight = run(send).finally(() => { flight = null; });
      return flight;
    },
    discard(reason) {
      const n = items.length;
      try { storage.remove(key); } catch (_) { /* best effort */ }
      items = [];
      return { discarded: n, reason };
    },
    items: () => items.slice(),
    paused: () => paused,
    resume() { paused = false; },
    onDrop(cb) { dropListeners.add(cb); return () => dropListeners.delete(cb); },
  };
}
