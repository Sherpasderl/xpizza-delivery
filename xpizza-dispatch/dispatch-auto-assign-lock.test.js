// xpizza-dispatch/dispatch-auto-assign-lock.test.js
//
// CTA audit #1 — the «Auto-asignar» toggle changes order routing for every incoming order.
//   #1a in-flight lock: the handler read the DOM `.on` class and wrote setAutoAssignEnabled(!isOn) with no
//        guard, so a rapid double-click double-wrote before the subscription echo re-synced the class. Fix:
//        an in-flight latch + a disabled button until the write settles.
//   #1b confirm on PAUSE: pausing (which can strand orders) now goes through the generic styledConfirm with
//        «Pausar»/«Cancelar»; a decline writes nothing. Resuming stays one tap.
// Asserts BEHAVIOUR, not the confirm copy (owner wording can change freely).
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
assert.ok(regSrc.includes('autoAssignInFlight') && regSrc.includes('.addEventListener') && regSrc.includes('styledConfirm'),
  'sliced the handler registration (latch + styled-confirm pause)');

function harness({ setEnabled, confirmResult = true, isOn = true } = {}) {
  const calls = { setEnabled: [], toasts: [], confirms: 0, disabled: [], confirmOpts: null, focusedWhileDisabled: null, focused: 0 };
  const btn = {
    classList: { contains: () => isOn },
    _d: false,
    set disabled(v) { this._d = v; calls.disabled.push(v); },
    get disabled() { return this._d; },
    focus() { calls.focused++; calls.focusedWhileDisabled = this._d; },   // record whether focus() ran while still disabled
    addEventListener: (ev, fn) => { btn._handler = fn; },
    querySelector: () => null,
  };
  const $ = () => btn;
  const XPD = { setAutoAssignEnabled: (v) => { calls.setEnabled.push(v); return setEnabled ? setEnabled() : Promise.resolve(); } };
  const toast = (m) => calls.toasts.push(m);
  const styledConfirm = (opts) => { calls.confirms++; calls.confirmOpts = opts; return Promise.resolve(confirmResult); };
  new Function('$', 'XPD', 'toast', 'styledConfirm', regSrc)($, XPD, toast, styledConfirm);
  return { handler: btn._handler, btn, calls };
}

// (#1a) in-flight latch: two concurrent clicks write exactly once; disabled during flight, re-enabled after.
// Uses the RESUME path (isOn:false) so no confirm step sits between the click and the write.
{
  let release;
  const pending = () => new Promise((r) => { release = r; });
  const { handler, calls } = harness({ setEnabled: pending, isOn: false });
  const p1 = handler();           // first click — setAutoAssignEnabled pends
  const p2 = handler();           // second click WHILE in flight — must be ignored
  assert.equal(calls.setEnabled.length, 1, 'a double-click writes exactly once while the first is in flight');
  assert.equal(calls.disabled[0], true, 'the button is disabled during the write');
  release();
  await Promise.all([p1, p2]);
  assert.equal(calls.disabled[calls.disabled.length - 1], false, 're-enabled after the write settles');
  ok('in-flight latch: concurrent clicks write once; button disabled during flight, re-enabled after');
}

// (#1a) the latch releases even if the server write throws (finally re-enables + clears the latch).
{
  const { handler, calls } = harness({ setEnabled: () => Promise.reject(new Error('net')), isOn: false });
  await handler();
  assert.equal(calls.disabled[calls.disabled.length - 1], false, 're-enabled after a failed write');
  assert.equal(calls.toasts.length, 1, 'an error toast is shown');
  await handler();
  assert.equal(calls.setEnabled.length, 2, 'the latch cleared — a later click writes again');
  ok('latch clears on a failed write (finally); a later click still works');
}

// (#1b) confirm only when PAUSING; a decline blocks the write; resume is one tap.
{
  const declined = harness({ isOn: true, confirmResult: false });   // ON → click = pause
  await declined.handler();
  assert.equal(declined.calls.confirms, 1, 'pausing opens the styled confirm');
  assert.equal(declined.calls.setEnabled.length, 0, 'declining the pause confirm writes nothing');
  assert.equal(declined.calls.disabled[declined.calls.disabled.length - 1], false, 're-enabled after a decline');
  assert.equal(declined.calls.confirmOpts.confirmLabel, 'Pausar', 'the confirm action is labelled «Pausar»');
  assert.equal(declined.calls.confirmOpts.opener, declined.btn, 'the toggle is passed to styledConfirm as the opener (captured before disable)');
  // P2-1: focus returns to the toggle on Esc/Cancelar, and only AFTER it is re-enabled (never while disabled).
  assert.equal(declined.calls.focused, 1, 'focus returns to the toggle after a decline');
  assert.equal(declined.calls.focusedWhileDisabled, false, 'focus() runs after the toggle is re-enabled, not while disabled');

  const accepted = harness({ isOn: true, confirmResult: true });
  await accepted.handler();
  assert.equal(accepted.calls.setEnabled[0], false, 'accepting the pause confirm writes setAutoAssignEnabled(false)');

  const resume = harness({ isOn: false });   // OFF → click = resume
  await resume.handler();
  assert.equal(resume.calls.confirms, 0, 'resuming is one tap — no confirm');
  assert.equal(resume.calls.setEnabled[0], true, 'resuming writes setAutoAssignEnabled(true)');
  ok('confirm on pause only via styledConfirm (decline blocks the write); resume is one tap');
}

console.log(`dispatch-auto-assign-lock: OK (${n})`);
