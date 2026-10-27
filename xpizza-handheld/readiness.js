// H1c — the checks screen's readiness rows (OWNER APPROVED copy 2026-10-26, copy.js READINESS). PURE: status in, rows + the line
// under «Continuar» out. Only a statusEx() status (pushReady is a boolean) has the three new rows; the frozen status() keeps the
// approved H1b screen exactly as it was (ex:false, the template's own battery line).
//   channel / fullScreen: ok · todo (+ the repair button) · kiosk (the device is lock-task LOCKED: no button can open Settings, the
//     row asks for the owner instead)
//   push: ok · wait (registering; no button, the hourly / resume refresh turns it green) · repair (no native session at all:
//     «Vincular» → the existing sign-out → login path; in-app, so it stays under kiosk too)
//   line: 0 missing → none; 2+ → «Faltan N pasos…»; exactly 1 → that row's own line (battery: the board's line). A lone
//     notifications / volume gap has no approved line of its own → no line (the row itself shows the gap).
import { READINESS as R } from './copy.js';

const BATTERY_LINE = 'Falta apagar el ahorro de batería.';

function settingsRow(ok, kiosk, title, okText, todo, btn, missing) {
  if (ok) return { title, state: 'ok', text: okText, btn: null, missing: null };
  if (kiosk) return { title, state: 'kiosk', text: R.kiosk, btn: null, missing };
  return { title, state: 'todo', text: todo, btn, missing };
}

export function readiness(st) {
  const s = st || {};
  if (typeof s.pushReady !== 'boolean') return { ex: false };
  const kiosk = s.kiosk === true;
  const channel = settingsRow(s.channelOk === true, kiosk, R.channelTitle, R.channelOk, R.channelTodo, R.channelBtn, R.channelMissing);
  const fullScreen = settingsRow(s.fullScreen === true, kiosk, R.fullScreenTitle, R.fullScreenOk, R.fullScreenTodo, R.fullScreenBtn, R.fullScreenMissing);
  const push = s.pushReady === true ? { title: R.pushTitle, state: 'ok', text: R.pushOk, btn: null, missing: null }
    : s.pushSession === false ? { title: R.pushTitle, state: 'repair', text: R.pushTodo, btn: R.pushBtn, missing: R.pushMissing }
      : { title: R.pushTitle, state: 'wait', text: R.pushWait, btn: null, missing: R.pushWaitMissing };
  // every gap, in the approved row order
  const gaps = [
    s.notifications === true ? null : '',
    channel.missing,
    fullScreen.missing,
    s.alarmVolumeMax === true ? null : '',
    s.batteryExempt === true ? null : BATTERY_LINE,
    push.missing,
  ].filter((g) => g !== null);
  const line = gaps.length >= 2 ? R.steps(gaps.length) : gaps.length === 1 ? gaps[0] : '';
  return { ex: true, kiosk, channel, fullScreen, push, missingCount: gaps.length, line };
}

// The checks screen is waiting on push registration («Conectando…»).
export function connecting(phase, status) {
  if (phase !== 'checks') return false;
  const r = readiness(status);
  return r.ex === true && r.push.state === 'wait';
}

// codex b4 r1 P2: while «Conectando…» shows, re-read the status every `everyMs` so «Continuar» unblocks as soon as registration
// lands. sync(waiting) is idempotent (app.js calls it on every state change): it starts the loop, or stops and re-arms it once the
// screen is ready or left. Bounded: after `max` reads it rests until the waiting state ends (the resume / hourly refresh carry on).
export function createConnectPoll({ refresh, setTimer = setTimeout, clearTimer = clearTimeout, everyMs = 3000, max = 40 }) {
  let timer = null; let reads = 0; let inflight = false; let want = false; let exhausted = false;
  async function tick() {
    timer = null; inflight = true; reads++;
    try { await refresh(); } catch (_) { /* the next tick retries */ }
    inflight = false;
    if (reads >= max) { exhausted = true; return; }
    if (want && !timer) timer = setTimer(tick, everyMs);
  }
  return {
    sync(waiting) {
      if (!waiting) { want = false; if (timer) clearTimer(timer); timer = null; reads = 0; exhausted = false; return; }
      want = true;
      if (!timer && !inflight && !exhausted) timer = setTimer(tick, everyMs);
    },
    reads: () => reads,
  };
}

// The repair buttons → the native screen for that check. Never throws into the click handler.
export function repairAction(bridge) {
  return (kind) => {
    try { const p = bridge.openSettings(kind); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_) { /* the resume refresh re-reads */ }
  };
}
