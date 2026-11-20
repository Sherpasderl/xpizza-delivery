// xpizza-dispatch/dispatch-auto-assign-lock.test.js
//
// CTA audit #1a — the «Auto-asignar» toggle changes order routing for every incoming order, but the
// handler read the DOM `.on` class and wrote setAutoAssignEnabled(!isOn) with no guard, so a rapid
// double-click double-wrote before the subscription echo re-synced the class — the toggle could land
// opposite to what the dispatcher saw. Fix: an in-flight latch + a disabled button until the write settles.
// (The pause confirm is #1b, wired through the generic styled confirm.)
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// slice the registration block: the in-flight latch + the click handler.
const start = html.indexOf('let autoAssignInFlight');
assert.ok(start > -1, 'the #1a fix is present (in-flight latch)');
const anchor = html.indexOf("$('auto-assign-toggle').addEventListener('click'", start);
const regSrc = html.slice(start, html.indexOf('\n  });', anchor) + '\n  });'.length);
assert.ok(regSrc.includes('autoAssignInFlight') && regSrc.includes('.addEventListener'), 'sliced the handler registration');

function harness({ setEnabled, isOn = true } = {}) {
  const calls = { setEnabled: [], toasts: [], confirms: 0, disabled: [] };
  const btn = {
    classList: { contains: () => isOn },
    _d: false,
    set disabled(v) { this._d = v; calls.disabled.push(v); },
    get disabled() { return this._d; },
    addEventListener: (ev, fn) => { btn._handler = fn; },
    querySelector: () => null,
  };
  const $ = () => btn;
  const XPD = { setAutoAssignEnabled: (v) => { calls.setEnabled.push(v); return setEnabled ? setEnabled() : Promise.resolve(); } };
  const toast = (m) => calls.toasts.push(m);
  const confirm = () => { calls.confirms++; return confirmResult; };
  new Function('$', 'XPD', 'toast', 'confirm', regSrc)($, XPD, toast, confirm);
  return { handler: btn._handler, btn, calls };
}

// (a) in-flight latch: two concurrent clicks write exactly once; disabled during flight, re-enabled after.
{
  let release;
  const pending = () => new Promise((r) => { release = r; });
  const { handler, calls } = harness({ setEnabled: pending, isOn: true, confirmResult: true });
  const p1 = handler();           // first click — setAutoAssignEnabled pends
  const p2 = handler();           // second click WHILE in flight — must be ignored
  assert.equal(calls.setEnabled.length, 1, 'a double-click writes exactly once while the first is in flight');
  assert.equal(calls.disabled[0], true, 'the button is disabled during the write');
  release();
  await Promise.all([p1, p2]);
  assert.equal(calls.disabled[calls.disabled.length - 1], false, 're-enabled after the write settles');
  ok('in-flight latch: concurrent clicks write once; button disabled during flight, re-enabled after');
}

// (a') the latch releases even if the server write throws (finally re-enables + clears the latch).
{
  const { handler, calls } = harness({ setEnabled: () => Promise.reject(new Error('net')), isOn: true, confirmResult: true });
  await handler();
  assert.equal(calls.disabled[calls.disabled.length - 1], false, 're-enabled after a failed write');
  assert.equal(calls.toasts.length, 1, 'an error toast is shown');
  // a subsequent click still works (latch cleared)
  await handler();
  assert.equal(calls.setEnabled.length, 2, 'the latch cleared — a later click writes again');
  ok('latch clears on a failed write (finally); a later click still works');
}

// the write direction follows the current state (pause when ON, resume when OFF)
{
  const pause = harness({ isOn: true });
  await pause.handler();
  assert.equal(pause.calls.setEnabled[0], false, 'clicking while ON writes setAutoAssignEnabled(false) — pause');
  const resume = harness({ isOn: false });
  await resume.handler();
  assert.equal(resume.calls.setEnabled[0], true, 'clicking while OFF writes setAutoAssignEnabled(true) — resume');
  ok('toggle writes the opposite of the current state');
}

console.log(`dispatch-auto-assign-lock: OK (${n})`);
