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
