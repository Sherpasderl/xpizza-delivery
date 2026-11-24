// xpizza-dispatch/dispatch-styled-confirm.test.js
//
// CTA audit #1b — the generic styled confirm (the «Quitar repartidor» look; title/body/two labels,
// resolving a Promise<boolean>, nothing operation-specific). Extracts the REAL styledConfirm +
// settleStyledConfirm + their event wiring from index.html and drives them over a DOM shim: confirm →
// true, cancel / backdrop / Esc → false, and Esc self-handles (stopPropagation) so the document arbiter
// never double-fires. Plus source guards that it is registered in the canonical OVERLAYS registry.
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── source: registered in OVERLAYS, close:null, self-handles Esc with stopPropagation ──
{
  const reg = html.slice(html.indexOf('const OVERLAYS = ['), html.indexOf('const anyModalOpen ='));
  assert.match(reg, /name: 'styled-confirm',[^\n]*close: null/, 'styled-confirm is in OVERLAYS as a self-handled (close:null) modal');
  assert.match(html, /\$\('styled-confirm-overlay'\)\.addEventListener\('keydown'[\s\S]*?e\.key === 'Escape'[\s\S]*?e\.stopPropagation\(\); settleStyledConfirm\(false\)/,
    'styled-confirm self-handles Esc element-level with stopPropagation (cancel = settle false)');
  ok('styled-confirm registered in the canonical OVERLAYS + self-handles Esc (stopPropagation)');
}

// ── behaviour: extract the real code and run it over a DOM shim ──
const block = html.slice(html.indexOf('let styledConfirmSettle'), html.indexOf('// ── "Quitar repartidor'));
assert.ok(block.includes('function styledConfirm(') && block.includes('function settleStyledConfirm('), 'sliced the real styledConfirm block');

function build() {
  const els = {};
  const el = (id) => (els[id] ||= {
    id, _cls: new Set(['hidden']), textContent: '', _ls: {}, _focused: 0,
    classList: { add(c) { el(id)._cls.add(c); }, remove(c) { el(id)._cls.delete(c); }, contains(c) { return el(id)._cls.has(c); } },
    focus() { this._focused++; }, querySelectorAll() { return []; },
    querySelector() { return el('panel'); },   // the overlay's .picker-panel (focus target while busy)
    addEventListener(ev, fn) { (el(id)._ls[ev] ||= []).push(fn); },
  });
  const $ = (id) => el(id);
  const document = { activeElement: el('opener'), contains: () => true };
  const window = { matchMedia: () => ({ matches: false }) };
  const focusTrapTarget = () => null;
  const make = new Function('$', 'document', 'window', 'focusTrapTarget',
    block + '\n; return { styledConfirm, settleStyledConfirm };');
  const api = make($, document, window, focusTrapTarget);
  const fire = (id, ev, obj = {}) => (el(id)._ls[ev] || []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() { obj.stopped = true; }, ...obj }));
  return { ...api, el, fire };
}

// confirm → true
{
  const { styledConfirm, el, fire } = build();
  const p = styledConfirm({ title: 'T', body: 'B', confirmLabel: 'Pausar', cancelLabel: 'Cancelar' });
  assert.equal(el('styled-confirm-overlay').classList.contains('hidden'), false, 'overlay shown');
  assert.equal(el('styled-confirm-ok').textContent, 'Pausar', 'ok label applied');
  assert.equal(el('styled-confirm-body').textContent, 'B', 'body set as text');
  fire('styled-confirm-ok', 'click');
  assert.equal(await p, true, 'confirm resolves true');
  assert.equal(el('styled-confirm-overlay').classList.contains('hidden'), true, 'overlay hidden after settle');
  ok('confirm button resolves true and hides the overlay');
}

// cancel → false, and focus returns to the opener
{
  const { styledConfirm, el, fire } = build();
  const p = styledConfirm({ title: 'T', body: 'B' });   // no opener → captures document.activeElement (el('opener'))
  fire('styled-confirm-cancel', 'click');
  assert.equal(await p, false, 'cancel resolves false');
  assert.ok(el('opener')._focused >= 1, 'focus restored to the opener on cancel');
  ok('cancel button resolves false and restores focus to the opener');
}

// an explicit opener is honoured on dismiss
{
  const { styledConfirm, el, fire } = build();
  const trigger = el('my-trigger');
  const p = styledConfirm({ title: 'T', body: 'B', opener: trigger });
  fire('styled-confirm-cancel', 'click');
  await p;
  assert.ok(trigger._focused >= 1, 'focus restored to the explicitly-passed opener');
  ok('an explicit opener is restored on dismiss');
}

// backdrop → false
{
  const { styledConfirm, el, fire } = build();
  const p = styledConfirm({ title: 'T', body: 'B' });
  fire('styled-confirm-overlay', 'click', { target: el('styled-confirm-overlay') });
  assert.equal(await p, false, 'backdrop click resolves false');
  ok('backdrop click resolves false');
}

// Esc → false + stopPropagation
{
  const { styledConfirm, fire } = build();
  const p = styledConfirm({ title: 'T', body: 'B' });
  const ev = { key: 'Escape' };
  fire('styled-confirm-overlay', 'keydown', ev);
  assert.equal(await p, false, 'Esc resolves false');
  assert.equal(ev.stopped, true, 'Esc stops propagation so the document arbiter never double-fires');
  ok('Esc resolves false and stops propagation');
}

// async onConfirm flow (§3/§6): the «do» button shows the busy label + disabled while the action runs,
// closes + resolves true on success.
{
  const { styledConfirm, el, fire } = build();
  let release; const action = () => new Promise((r) => { release = r; });
  const p = styledConfirm({ title: 'T', body: 'B', confirmLabel: 'Cerrar sesión', busyLabel: 'Cerrando sesión…', onConfirm: action });
  fire('styled-confirm-ok', 'click');   // starts the async flow — does not resolve yet
  assert.equal(el('styled-confirm-ok').textContent, 'Cerrando sesión…', 'busy label shown while the action runs');
  assert.equal(el('styled-confirm-ok').disabled, true, 'the do button is disabled while busy');
  assert.equal(el('styled-confirm-cancel').disabled, true, 'cancel is disabled while busy');
  assert.equal(el('styled-confirm-overlay').classList.contains('hidden'), false, 'stays open while busy');
  release();
  assert.equal(await p, true, 'resolves true after the action succeeds');
  assert.equal(el('styled-confirm-overlay').classList.contains('hidden'), true, 'closes after success');
  ok('async onConfirm: busy label + disabled while running; closes + resolves true on success');
}

// an onConfirm failure keeps the dialog OPEN and re-enables it (the action surfaces its own error).
{
  const { styledConfirm, el, fire } = build();
  styledConfirm({ title: 'T', body: 'B', confirmLabel: 'Cerrar sesión', onConfirm: () => Promise.reject(new Error('net')) });
  fire('styled-confirm-ok', 'click');
  await new Promise((r) => setTimeout(r, 0));   // let the rejection settle
  assert.equal(el('styled-confirm-overlay').classList.contains('hidden'), false, 'stays open on failure');
  assert.equal(el('styled-confirm-ok').disabled, false, 're-enabled on failure');
  assert.equal(el('styled-confirm-ok').textContent, 'Cerrar sesión', 'label restored on failure');
  ok('async onConfirm: a failed action keeps the dialog open and re-enabled');
}

// Codex #241 P1: a busy completion settles ONLY its own dialog; a new confirm is refused while busy; a
// stale-token completion is ignored.
{
  const { styledConfirm, el, fire } = build();
  let release; const slow = () => new Promise((r) => { release = r; });
  const pA = styledConfirm({ title: 'A', body: 'cancel', confirmLabel: 'Cancelar pedido', busyLabel: 'Cancelando…', onConfirm: slow });
  fire('styled-confirm-ok', 'click');   // A is now busy
  const pB = styledConfirm({ title: 'B', body: 'override', confirmLabel: 'Asignar igual' });
  assert.equal(await pB, false, 'a second styledConfirm is REFUSED while the first is busy (resolves false, does not open)');
  assert.equal(el('styled-confirm-title').textContent, 'A', 'the busy dialog A is still the one shown (B never opened)');
  release();
  assert.equal(await pA, true, 'A’s own completion settles A');
  ok('P1: a new confirm is blocked while busy; a busy completion settles only its own dialog');
}
{
  const { styledConfirm, settleStyledConfirm, el } = build();
  styledConfirm({ title: 'X', body: 'b', confirmLabel: 'OK' });   // opens → token = 1
  settleStyledConfirm(true, 999);                                 // a stale-token completion
  assert.equal(el('styled-confirm-overlay').classList.contains('hidden'), false, 'a stale-token completion does NOT settle the open dialog');
  ok('P1: settleStyledConfirm ignores a completion whose token is not the current dialog’s');
}

// Codex #242 Part A: on entering busy, focus moves to the dialog panel BEFORE the buttons disable — so
// disabling the focused button (which blurs it in Chromium) can't drop focus out of the trap.
{
  const { styledConfirm, el, fire } = build();
  styledConfirm({ title: 'T', body: 'B', confirmLabel: 'Cerrar sesión', busyLabel: '…', onConfirm: () => new Promise(() => {}) });
  fire('styled-confirm-ok', 'click');   // enter busy (the action never resolves)
  assert.ok(el('panel')._focused >= 1, 'busy moves focus to the dialog panel');
  assert.equal(el('styled-confirm-ok').disabled, true, 'and the button is disabled (focus already parked on the panel)');
  ok('Part A: busy parks focus on the panel before disabling, so the trap never loses focus');
}

console.log(`dispatch-styled-confirm: OK (${n})`);
