// H1b T2 — the two clocks (PLAN-H1b Global Constraints, codex P2-10). PURE: the time sources are injected.
//   makeClock  DISPLAY time = local wall + the RTDB `.info/serverTimeOffset` — countdowns only. Unknown offset → null (shown "--").
//   makeTimer  DURATIONS (the Listo undo window, the PIN lockout within a session) on LOCAL time: elapsed = max(monotonic, wall),
//              so neither a suspended monotonic clock (app backgrounded) nor a wall-clock change stretches a window. Never
//              server-corrected. A duration that must survive a restart (the PIN lockout) is persisted by T6 as a wall deadline.
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const MIN = 60000;

export function makeClock({ wall = () => Date.now() } = {}) {
  let offset = null;
  const listeners = new Set();
  return {
    setOffset(ms) {
      const next = ms === null ? null : (isNum(ms) ? ms : undefined);
      if (next === undefined || next === offset) return;
      offset = next;
      for (const cb of [...listeners]) cb(offset);
    },
    now: () => (offset === null ? null : wall() + offset),
    minutesLeft(targetMs) {
      if (offset === null || !isNum(targetMs)) return null;
      const v = Math.ceil((targetMs - (wall() + offset)) / MIN);
      return v === 0 ? 0 : v;
    },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}

export function makeTimer({ mono = () => performance.now(), wall = () => Date.now() } = {}) {
  let started = null; let duration = 0;
  const elapsed = () => Math.max(0, mono() - started.mono, wall() - started.wall);
  return {
    start(ms) { started = { mono: mono(), wall: wall() }; duration = ms; },
    remaining: () => (started === null ? null : Math.max(0, duration - elapsed())),
    expired: () => started !== null && elapsed() >= duration,
  };
}
