'use strict';
// ORCHESTRATION O1a (Codex r1/r2 on the lifecycle writers) — test-only deterministic interleavings over ANY RTDB handle (the in-memory
// fake or the REAL emulator Admin db): gated(db).pause(method, path) arms a one-shot gate; the first matching ref call (once /
// transaction / update / remove / set — `method` a name or a predicate(method, path); `path` exact or a predicate(path)) waits at
// the gate (`nth`: the n-th matching call, default 1st). `reached` resolves when a caller arrives and REJECTS loudly (GATE-TIMEOUT) if none does within `ms` — its timer also keeps
// the process alive, so an unreached gate can never end a run silently (Codex r2 P3). release() lets the caller continue.
// Everything else passes straight through to the wrapped db, so the writers under test are the REAL ones.
function gated(db) {
  const gates = [];
  const matches = (g, method, path) => (typeof g.method === 'function' ? g.method(method, path) : g.method === method)
    && (typeof g.path === 'function' ? g.path(path) : g.path === path);
  const hit = async (method, path) => {
    const g = gates.find((x) => !x.used && matches(x, method, path) && (x.seen += 1) >= x.nth);
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
    pause(method, path, { ms = 10000, nth = 1 } = {}) {
      const g = { method, path, used: false, nth, seen: 0 };
      const name = `${typeof method === 'function' ? '<pred>' : method} ${typeof path === 'function' ? '<pred>' : path}`;
      g.reached = new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`GATE-TIMEOUT no caller reached the gate ${name} within ${ms} ms`)), ms);
        g.arrive = () => { clearTimeout(t); res(); };
      });
      let release; g.go = new Promise((res) => { release = res; });
      gates.push(g);
      return { reached: g.reached, release };
    },
  };
}

module.exports = { gated };
