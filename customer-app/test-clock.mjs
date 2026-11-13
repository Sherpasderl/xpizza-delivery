// Test support for the customer-app suites (never loaded by the app; never packaged): the VIRTUAL clock (PLAN-capp-virtual-clock r0,
// advisor 11-13). The cells wait on virtual time, not on the machine — a 300 ms debounce fires at +300 whatever the load.
//   createClock(t0) → the timers the code under test is handed ({ setTimeout, clearTimeout, setInterval, clearInterval }) + now(),
//   drain()         settle until QUIET: microtasks / setImmediate turns, WebCrypto digests in flight (the threadpool is outside any
//                   clock), and the timers due at the CURRENT virtual time — never advancing it; bounded (a timer that re-arms
//                   itself at the same instant is a failure, never a hang)
//   jump(t)         a wall-clock jump, forward only (the passed timers fire at the next drain)
//   flush(ms = 30)  drain, advance to +ms firing each due timer in (due, arming) order with a drain after each, drain — the same
//                   virtual duration the real-sleep flush waited, now exact
import { trackDigests, digestsInFlight, digestsSettled } from './capp-test-digests.mjs';

trackDigests();
const TURNS = 25, ROUNDS = 200;
const turns = async () => { for (let i = 0; i < TURNS; i++) await new Promise((r) => setImmediate(r)); };

export function createClock(t0 = 0) {
  let now = Number(t0) || 0, seq = 0;
  const q = new Map();   // id → { due, seq, f, every }
  const arm = (f, ms, every) => { const id = ++seq; q.set(id, { due: now + Math.max(0, Number(ms) || 0), seq: id, f, every }); return id; };
  // the earliest timer due at or before `limit` (ties: the one armed first)
  const earliest = (limit) => { let best = null; for (const [id, t] of q) if (t.due <= limit && (!best || t.due < best[1].due || (t.due === best[1].due && t.seq < best[1].seq))) best = [id, t]; return best; };
  function fire([id, t]) {
    if (t.every != null) { t.due += Math.max(1, t.every); t.seq = ++seq; } else q.delete(id);
    t.f();
  }
  // the timers due NOW, one by one (each may arm more); the count fired
  function runDue() { let n = 0; for (let e = earliest(now); e; e = earliest(now)) { fire(e); n++; if (n > ROUNDS) break; } return n; }
  async function drain() {
    for (let r = 0; r < ROUNDS; r++) {
      await turns();
      if (digestsInFlight()) { await digestsSettled(); continue; }
      if (runDue() === 0) return;
    }
    throw new Error(`drain: not quiet after ${ROUNDS} rounds — a timer re-arms itself at the same instant`);
  }
  async function flush(ms = 30) {
    await drain();
    const target = now + Math.max(0, Number(ms) || 0);
    for (let e = earliest(target); e; e = earliest(target)) { now = e[1].due; fire(e); await drain(); }
    now = target;
    await drain();
  }
  return {
    setTimeout: (f, ms) => arm(f, ms, null), clearTimeout: (h) => { q.delete(h); },
    setInterval: (f, ms) => arm(f, ms, Math.max(1, Number(ms) || 0)), clearInterval: (h) => { q.delete(h); },
    now: () => now, drain, flush, get pending() { return q.size; },
    // a wall-clock JUMP (a cell moving the app's time): forward only; the timers it passed fire at the next drain, in due order
    jump(t) { const v = Number(t); if (!(v >= now)) throw new Error(`jump: the virtual clock only moves forward (${now} → ${t})`); now = v; },
  };
}
