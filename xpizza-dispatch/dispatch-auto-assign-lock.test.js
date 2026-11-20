// xpizza-dispatch/dispatch-auto-assign-lock.test.js
//
// CTA audit #1 — the «Auto-asignar» toggle changes order routing for every incoming order.
//   #1a in-flight lock: a rapid double-click used to double-write before the subscription echo re-synced the
//        class. Fix: an in-flight latch + a disabled button until the write settles.
//   #1b confirm on PAUSE: pausing goes through the generic styledConfirm («Pausar»/«Cancelar»); a decline
//        writes nothing; resume is one tap.
//   P2-1 / Codex #228 P2: focus returns to the toggle after dismissing the confirm — but ONLY when the
//        confirm was shown AND the user hasn't moved focus elsewhere meanwhile (a slow write + an open
//        picker must not get focus stolen). Resume shows no confirm and never moves focus.
// Asserts BEHAVIOUR, not the confirm copy.
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const start = html.indexOf('let autoAssignInFlight');
assert.ok(start > -1, 'the #1a fix is present (in-flight latch)');
const anchor = html.indexOf("$('auto-assign-toggle').addEventListener('click'", start);
const regSrc = html.slice(start, html.indexOf('\n  });', anchor) + '\n  });'.length);
assert.ok(regSrc.includes('autoAssignInFlight') && regSrc.includes('styledConfirm') && regSrc.includes('document.activeElement'),
  'sliced the handler (latch + styled-confirm + focus restore)');

function harness({ setEnabled, confirmResult = true, isOn = true } = {}) {
  const calls = { setEnabled: [], toasts: [], confirms: 0, disabled: [], confirmOpts: null, focused: 0, focusedWhileDisabled: null };
  const doc = { body: {} };
  doc.activeElement = doc.body;                                   // focus lands on body when a disabled control loses it
  const btn = {
    classList: { contains: () => isOn },
    _d: false,
    set disabled(v) { this._d = v; calls.disabled.push(v); },
    get disabled() { return this._d; },
    focus() { calls.focused++; calls.focusedWhileDisabled = this._d; doc.activeElement = this; },
    addEventListener: (ev, fn) => { btn._handler = fn; },
    querySelector: () => null,
  };
  const $ = () => btn;
  const XPD = { setAutoAssignEnabled: (v) => { calls.setEnabled.push(v); return setEnabled ? setEnabled(doc) : Promise.resolve(); } };
  const toast = (m) => calls.toasts.push(m);
  const styledConfirm = (opts) => { calls.confirms++; calls.confirmOpts = opts; return Promise.resolve(confirmResult); };
  new Function('$', 'XPD', 'toast', 'styledConfirm', 'document', regSrc)($, XPD, toast, styledConfirm, doc);
  return { handler: btn._handler, btn, calls, doc };
}

// (#1a) latch: two concurrent clicks write once; disabled during flight, re-enabled after. RESUME path.
{
  let release;
  const pending = () => new Promise((r) => { release = r; });
  const { handler, calls } = harness({ setEnabled: pending, isOn: false });
  const p1 = handler();
  const p2 = handler();
  assert.equal(calls.setEnabled.length, 1, 'a double-click writes exactly once while the first is in flight');
  assert.equal(calls.disabled[0], true, 'the button is disabled during the write');
  release();
  await Promise.all([p1, p2]);
  assert.equal(calls.disabled[calls.disabled.length - 1], false, 're-enabled after the write settles');
  assert.equal(calls.focused, 0, 'resume (no confirm) never moves focus');
  ok('in-flight latch: concurrent clicks write once; disabled during flight, re-enabled after; resume moves no focus');
}

// (#1a) latch releases even if the write throws (finally).
{
  const { handler, calls } = harness({ setEnabled: () => Promise.reject(new Error('net')), isOn: false });
  await handler();
  assert.equal(calls.disabled[calls.disabled.length - 1], false, 're-enabled after a failed write');
  assert.equal(calls.toasts.length, 1, 'an error toast is shown');
  await handler();
  assert.equal(calls.setEnabled.length, 2, 'the latch cleared — a later click writes again');
  ok('latch clears on a failed write (finally); a later click still works');
}

// (#1b) confirm on PAUSE; decline blocks the write + restores focus; resume one tap, no focus move.
{
  const declined = harness({ isOn: true, confirmResult: false });   // ON → pause
  await declined.handler();
  assert.equal(declined.calls.confirms, 1, 'pausing opens the styled confirm');
  assert.equal(declined.calls.setEnabled.length, 0, 'declining the pause confirm writes nothing');
  assert.equal(declined.calls.confirmOpts.confirmLabel, 'Pausar', 'the confirm action is labelled «Pausar»');
  assert.equal(declined.calls.confirmOpts.opener, declined.btn, 'the toggle is passed as the opener (captured before disable)');
  assert.equal(declined.calls.focused, 1, 'focus returns to the toggle after a decline (activeElement was body)');
  assert.equal(declined.calls.focusedWhileDisabled, false, 'focus runs after the toggle is re-enabled, not while disabled');

  const accepted = harness({ isOn: true, confirmResult: true });
  await accepted.handler();
  assert.equal(accepted.calls.setEnabled[0], false, 'accepting pauses (writes false)');

  const resume = harness({ isOn: false });
  await resume.handler();
  assert.equal(resume.calls.confirms, 0, 'resuming is one tap — no confirm');
  assert.equal(resume.calls.setEnabled[0], true, 'resuming writes true');
  assert.equal(resume.calls.focused, 0, 'resuming never moves focus');
  ok('confirm on pause only (decline blocks write + restores focus); resume one tap, no focus move');
}

// (Codex #228 P2) a delayed write must NOT steal focus from a picker the user opened meanwhile.
{
  const picker = { tag: 'picker-row' };
  // accept the pause, then the slow write moves focus into the picker before it settles.
  const { handler, calls, doc } = harness({
    isOn: true, confirmResult: true,
    setEnabled: (d) => { d.activeElement = picker; return Promise.resolve(); },
  });
  await handler();
  assert.equal(calls.setEnabled.length, 1, 'the pause was confirmed and written');
  assert.equal(calls.focused, 0, 'focus was NOT stolen back to the toggle');
  assert.equal(doc.activeElement, picker, 'focus stays in the picker the user opened');
  ok('a delayed write does not steal focus from an open picker');
}

console.log(`dispatch-auto-assign-lock: OK (${n})`);
