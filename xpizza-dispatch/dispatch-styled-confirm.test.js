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
    id, _cls: new Set(['hidden']), textContent: '', _ls: {},
    classList: { add(c) { el(id)._cls.add(c); }, remove(c) { el(id)._cls.delete(c); }, contains(c) { return el(id)._cls.has(c); } },
    focus() {}, querySelectorAll() { return []; },
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

// cancel → false
{
  const { styledConfirm, fire } = build();
  const p = styledConfirm({ title: 'T', body: 'B' });
  fire('styled-confirm-cancel', 'click');
  assert.equal(await p, false, 'cancel resolves false');
  ok('cancel button resolves false');
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

console.log(`dispatch-styled-confirm: OK (${n})`);
