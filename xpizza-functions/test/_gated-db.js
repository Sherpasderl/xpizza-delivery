'use strict';
// ORCHESTRATION O1a (Codex r1 on 203076e0) — test-only deterministic interleavings over ANY RTDB handle (the in-memory fake or the
// REAL emulator Admin db): gated(db).pause(method, path) arms a one-shot gate; the first matching ref call (once / transaction /
// update / remove / set on exactly that path, or a predicate(path)) waits at the gate. `reached` resolves when a caller arrives;
// release() lets it continue. Everything else passes straight through to the wrapped db, so the writers under test are the REAL ones.
function gated(db) {
  const gates = [];
  const hit = async (method, path) => {
    const g = gates.find((x) => !x.used && x.method === method && (typeof x.path === 'function' ? x.path(path) : x.path === path));
    if (!g) return;
    g.used = true; g.arrive(); await g.go;
  };
  const wrapRef = (path) => {
    const r = path ? db.ref(path) : db.ref();
    return {
      once: async (...a) => { await hit('once', path); return r.once(...a); },
      transaction: async (fn) => { await hit('transaction', path); return r.transaction(fn); },
      update: async (v) => { await hit('update', path); return r.update(v); },
      remove: async () => { await hit('remove', path); return r.remove(); },
      set: async (v) => { await hit('set', path); return r.set(v); },
      orderByChild: (c) => r.orderByChild(c),
    };
  };
  return {
    db: { ref: (p) => wrapRef(p || '') },
    pause(method, path) {
      const g = { method, path, used: false };
      g.reached = new Promise((res) => { g.arrive = res; });
      let release; g.go = new Promise((res) => { release = res; });
      gates.push(g);
      return { reached: g.reached, release };
    },
  };
}

module.exports = { gated };
