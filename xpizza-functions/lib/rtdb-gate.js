'use strict';
// RTDB in-flight-get gate (PLAN-rtdb-get-once-race r6 → r9, Codex #403 APPROVE). firebase-js-sdk #10653 (@firebase/database 1.0.8,
// pinned by tools/rtdb-sdk-pin.guard.test.js): in ONE process, a get(P) in flight and THEN a listener registered on P or a descendant
// of P orphans the listener's connection listen; the next subscription asserts «listen() called twice». No read changes here:
//   gatedGet(ref)               — ref.get() called NOW, exactly as today (same promise, value, error, timing); its PATH is marked
//                                 «in flight» until that promise settles (never at a caller's deadline: a raced get keeps its mark).
//   afterGets(ref, register)    — register() (the listener's existing call, e.g. () => ref.once('value')) runs NOW unless a marked get
//                                 is in flight on the ref's path or an ANCESTOR; then it waits and is admitted in the same synchronous
//                                 turn the last such get settles (one forward pass, FIFO). No deadline, no synthesized error: the
//                                 promise returned is register()'s own. A listener never blocks a get (listener-first is clean), a
//                                 child get never blocks an ancestor listener (clean), get + get never wait.
// Process-local by design: the two parties of every audited pair live in the same deployed function (one function per instance).
const inFlight = new Map();   // path → count of marked gets in flight
const waiters = [];           // FIFO { path, register, resolve, reject }
let maxConcurrent = 0;

// the path of a Reference or a Query ('' = the root), from the SDK's public toString()
function pathOf(refOrQuery) {
  const ref = refOrQuery && refOrQuery.ref ? refOrQuery.ref : refOrQuery;
  return decodeURIComponent(String(ref.toString()).slice(String(ref.root.toString()).length)).replace(/^\/+|\/+$/g, '');
}
const covers = (getPath, listenPath) => getPath === '' || listenPath === getPath || listenPath.startsWith(`${getPath}/`);
function blocked(path) {
  for (const p of inFlight.keys()) if (covers(p, path)) return true;
  return false;
}
const WAIT_LOG_MS = 250;
function admit(w) {
  const waited = Date.now() - w.at;
  if (waited > WAIT_LOG_MS) { try { console.warn('rtdb_gate_wait', JSON.stringify({ ms: waited })); } catch (_) { /* logging never blocks admission */ } }
  let out;
  try { out = w.register(); } catch (e) { w.reject(e); return; }
  w.resolve(out);
}
function settle(path) {
  const n = inFlight.get(path) - 1;
  if (n > 0) inFlight.set(path, n); else inFlight.delete(path);
  // one FORWARD pass: every waiter no longer blocked registers now, in arrival order, synchronously
  for (let i = 0; i < waiters.length;) {
    if (blocked(waiters[i].path)) { i += 1; continue; }
    const [w] = waiters.splice(i, 1);
    admit(w);
  }
}

function gatedGet(ref) {
  const path = pathOf(ref);
  const p = ref.get();   // issued first, exactly as today; the mark below can never delay it
  inFlight.set(path, (inFlight.get(path) || 0) + 1);
  if (inFlight.get(path) > maxConcurrent) maxConcurrent = inFlight.get(path);
  const done = () => settle(path);
  p.then(done, done);
  return p;
}

function afterGets(refOrQuery, register) {
  const path = pathOf(refOrQuery);
  if (!blocked(path)) return register();
  return new Promise((resolve, reject) => { waiters.push({ path, register, resolve, reject, at: Date.now() }); });
}

// observability / tests: pending marked gets, queued waiters, the oldest waiter's age, the max concurrent marked gets on one path
function gateState(now = Date.now()) {
  let pending = 0; for (const n of inFlight.values()) pending += n;
  return { pending_gets: pending, waiters: waiters.length, oldest_waiter_ms: waiters.length ? now - Math.min(...waiters.map((w) => w.at)) : 0, max_concurrent_per_path: maxConcurrent };
}

module.exports = { gatedGet, afterGets, gateState, pathOf };
