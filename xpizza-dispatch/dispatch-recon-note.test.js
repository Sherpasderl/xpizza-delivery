// xpizza-dispatch/dispatch-recon-note.test.js
//
// Slice C-2 — reconciliation operator note: native prompt() → styled in-board field (MONEY-ADJACENT).
// Only the INPUT SURFACE changed; the fed value + resolve/outcome/finally logic stay byte-identical.
//
// These guards drive the REAL WIRING — the real event handlers ($('recon-note-confirm').onclick, the overlay
// keydown/backdrop, etc.) fire against a DOM shim that actually registers and dispatches events; nothing is
// stubbed to a no-op and settleReconNote is NEVER called directly. So the whole textarea → handler →
// settlement → resolveReconciliationAction chain is exercised (compose the real pieces, not two halves), and
// the money-critical mutations that a direct-settle test let survive now go RED:
//   • Confirm dropping the value (→ '')            → the value assertion fails
//   • Cancel / Esc settling '' instead of null     → a DISMISSED dialog fires a refund/materialize
// 4-part money contract, each red-when-reverted:
//   1. value byte-identical — resolveReconciliation(id, action, note.trim()) across all 3 actions;
//   2. cancel/Esc/backdrop → NO server call (dialog settles null; note===null returns);
//   3. abandon → required non-blank note (same toast, no call); materialize & refund keep it optional;
//   4. double-fire — buttons disabled during await + re-enabled in finally; a 2nd concurrent action fires no
//      resolve; and a late Esc after Confirm can't double-settle.
// Plus: ⌘Enter confirms; focus-restore survives a render tick (no black-hole, defect-2); the outcome+finally
// block is byte-identical to base b50a467; native prompt() is gone from the resolver.
import assert from 'node:assert';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'index.html');
const BASE = 'b50a467';
const html = fs.readFileSync(FILE, 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const tick = () => new Promise(r => setTimeout(r, 0));

// ---- extract the REAL source blocks ----
const reconSuccessLine = (html.match(/const RECON_SUCCESS_OUTCOMES = new Set\(\[[^\]]*\]\);/) || [])[0];
const pickerFocusSrc = html.slice(html.indexOf('function pickerReturnFocusTarget('), html.indexOf('function focusTrapTarget('));
const promptStart = html.indexOf('let reconNoteSettle = null;');
const resolveStart = html.indexOf('async function resolveReconciliationAction(');
const resolveEnd = html.indexOf('function formatTime(');
assert.ok(reconSuccessLine && pickerFocusSrc && promptStart > -1 && resolveStart > promptStart && resolveEnd > resolveStart, 'located source blocks');
const promptBlock = html.slice(promptStart, resolveStart);
const resolveSrc = html.slice(resolveStart, resolveEnd);

// ---- DOM shim with REAL event registration + dispatch (no stubbed addEventListener) ----
function buildEnv() {
  let lastFocused = null;
  const mkEl = (id) => ({
    id, textContent: '', value: '', _l: {}, offsetParent: {}, isConnected: true,
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener(t, fn) { (this._l[t] ||= []).push(fn); },
    dispatch(t, evt) { (this._l[t] || []).forEach(fn => fn(evt)); },
    focus() { lastFocused = this; },
    hasAttribute: () => false, setAttribute() {}, querySelectorAll: () => [],
  });
  const els = {};
  const getEl = (id) => (els[id] ||= mkEl(id));
  const opener = mkEl('__opener');                 // stands in for the recon button that had focus
  let queryButtons = [], xpd = null;
  const toasts = [], resolveCalls = [];
  const doc = {
    getElementById: getEl,
    get activeElement() { return opener; },
    querySelector: () => null,                     // no recon card in the shim → focus cascade falls back
    querySelectorAll: () => queryButtons,
  };
  const win = { matchMedia: () => ({ matches: false }), CSS: { escape: (s) => s } };
  const XPD = { resolveReconciliation: (...a) => { resolveCalls.push(a); return new Promise((res, rej) => { xpd = { res, rej }; }); } };
  const api = new Function('$', 'document', 'window', 'CSS', 'toast', 'XPD', 'displayOrderLabel', 'focusTrapTarget',
    `${reconSuccessLine}\n${pickerFocusSrc}\n${promptBlock}\n${resolveSrc}\n; return { resolveReconciliationAction, reconNotePrompt };`
  )(getEl, doc, win, win.CSS, (m, t) => toasts.push([m, t]), XPD, (x) => String(x), () => null);
  const ov = getEl('recon-note-overlay'), input = getEl('recon-note-input');
  return {
    ...api, toasts, resolveCalls, opener,
    setButtons: (k) => (queryButtons = Array.from({ length: k }, () => { let d = false; return { get disabled() { return d; }, set disabled(v) { if (v) this.everDisabled = true; d = v; }, everDisabled: false }; })),
    buttons: () => queryButtons,
    setNote: (v) => { input.value = v; },
    clickConfirm: () => getEl('recon-note-confirm').dispatch('click', {}),
    clickCancel: () => getEl('recon-note-cancel').dispatch('click', {}),
    clickBackdrop: () => ov.dispatch('click', { target: ov }),
    pressEsc: () => ov.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} }),
    cmdEnter: () => ov.dispatch('keydown', { key: 'Enter', metaKey: true, preventDefault() {}, stopPropagation() {} }),
    ctrlEnter: () => ov.dispatch('keydown', { key: 'Enter', ctrlKey: true, preventDefault() {}, stopPropagation() {} }),
    settleXpd: (v) => xpd.res(v),
    lastFocused: () => lastFocused,
    resetFocus: () => { lastFocused = null; },     // clear the dialog-open focus so a dismiss's restore is measured alone
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Value byte-identical — a REAL Confirm click reads the REAL textarea value; note.trim() is what's passed.
// ─────────────────────────────────────────────────────────────────────────────
{
  for (const action of ['materialize', 'refund', 'abandon']) {
    const t = buildEnv(); t.setButtons(3);
    const p = t.resolveReconciliationAction('ord-1', action);
    await tick();
    t.setNote('  nota con espacios  ');
    t.clickConfirm();
    await tick();
    assert.strictEqual(t.resolveCalls.length, 1, `${action}: exactly one resolve`);
    assert.deepStrictEqual(t.resolveCalls[0], ['ord-1', action, 'nota con espacios'], `${action}: (id, action, note.trim())`);
    t.settleXpd({ outcome: 'materialized' }); await p;
  }
  ok('value byte-identical via REAL confirm click: resolveReconciliation(id, action, note.trim()) × 3 actions');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Cancel / Esc / backdrop → settles null → NO server call, no button disable. Dismiss is synchronous
//    (settleReconNote(null) → resolveReconciliationAction returns at `if(note===null)return` with NO await),
//    so the money-safety fact is asserted DIRECTLY (call-count 0 + buttons untouched) — never via a crash. A
//    mutation settling '' would run a refund on a DISMISSED dialog and hang the pending XPD mock; racing p
//    against a tick keeps that a clean assertion failure, not an exit-13 unsettled-await crash.
// ─────────────────────────────────────────────────────────────────────────────
{
  for (const [name, dismiss] of [['cancel', 'clickCancel'], ['Esc', 'pressEsc'], ['backdrop', 'clickBackdrop']]) {
    const t = buildEnv(); t.setButtons(3);
    const p = t.resolveReconciliationAction('ord-1', 'refund');
    await tick();
    t.setNote('algo');                              // a non-empty textarea must NOT matter on dismiss
    t[dismiss]();
    await Promise.race([p, tick()]);                // dismiss returns immediately; a '' mutation would hang XPD — don't await it
    assert.strictEqual(t.resolveCalls.length, 0, `${name}: fired no resolve (dismiss reached no XPD call)`);
    assert.ok(t.buttons().every(b => !b.everDisabled), `${name}: buttons never disabled (returned before the disable loop)`);
  }
  ok('cancel / Esc / backdrop → settle null → no resolve, no button disable (asserted directly, not via crash)');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Abandon requires a non-blank note (same error, no call); materialize AND refund keep it optional.
// ─────────────────────────────────────────────────────────────────────────────
{
  const t = buildEnv(); t.setButtons(3);
  const p = t.resolveReconciliationAction('ord-1', 'abandon');
  await tick();
  t.setNote('   ');                                 // whitespace-only on abandon
  t.clickConfirm();
  await p;
  assert.strictEqual(t.resolveCalls.length, 0, 'abandon+blank fired no resolve');
  assert.ok(t.toasts.some(([m, tt]) => m === 'Se requiere una nota para descartar' && tt === 'error'), 'same required-note error toast');

  for (const action of ['materialize', 'refund']) {
    const t2 = buildEnv(); t2.setButtons(3);
    const p2 = t2.resolveReconciliationAction('ord-2', action);
    await tick();
    t2.setNote('');                                 // empty note → optional for materialize/refund
    t2.clickConfirm();
    await tick();
    assert.strictEqual(t2.resolveCalls.length, 1, `${action}: empty note still resolves`);
    assert.strictEqual(t2.resolveCalls[0][2], '', `${action}: empty note passed as ""`);
    t2.settleXpd({ outcome: 'materialized' }); await p2;
  }
  ok('abandon requires non-blank note (same error, no call); materialize & refund note optional');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Double-fire — buttons disabled during await + re-enabled in finally; 2nd concurrent action fires no
//    resolve; a late Esc after Confirm cannot double-settle.
// ─────────────────────────────────────────────────────────────────────────────
{
  const t = buildEnv(); const btns = t.setButtons(3);
  const p = t.resolveReconciliationAction('ord-1', 'materialize');
  await tick();
  const p2 = t.resolveReconciliationAction('ord-1', 'refund');   // second while the dialog is open
  await p2;
  assert.strictEqual(t.resolveCalls.length, 0, '2nd concurrent action fired no resolve (single-instance)');
  t.setNote('nota'); t.clickConfirm();
  await tick();
  assert.ok(btns.every(b => b.disabled === true), 'buttons disabled while resolve awaits');
  assert.strictEqual(t.resolveCalls.length, 1, 'exactly one resolve after confirm');
  t.pressEsc();                                     // late Esc — dialog already settled
  await tick();
  assert.strictEqual(t.resolveCalls.length, 1, 'late Esc after confirm does not double-settle');
  t.settleXpd({ outcome: 'materialized' }); await p;
  assert.ok(btns.every(b => b.disabled === false), 'buttons re-enabled in finally');
  ok('double-fire: single-instance + disabled during await + re-enabled in finally + no late double-settle');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. ⌘Enter (macOS) AND Ctrl-Enter (Windows/Linux) confirm with the real textarea value — both modifiers, so
//    dropping either e.metaKey or e.ctrlKey from the handler goes red.
// ─────────────────────────────────────────────────────────────────────────────
{
  for (const [name, key] of [['⌘Enter', 'cmdEnter'], ['Ctrl-Enter', 'ctrlEnter']]) {
    const t = buildEnv(); t.setButtons(3);
    const p = t.resolveReconciliationAction('ord-9', 'materialize');
    await tick();
    t.setNote('  via teclado  ');
    t[key]();
    await tick();
    assert.deepStrictEqual(t.resolveCalls[0], ['ord-9', 'materialize', 'via teclado'], `${name} confirms with the real value`);
    t.settleXpd({ outcome: 'materialized' }); await p;
  }
  ok('⌘Enter and Ctrl-Enter both confirm with the real textarea value');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Focus-restore survives a render tick (defect-2): a detached opener at dismiss must not black-hole focus —
//    the shared cascade lands on a fallback. (Reverting to opener-only restore → nothing focused → red.)
// ─────────────────────────────────────────────────────────────────────────────
{
  const t = buildEnv(); t.setButtons(3);
  const p = t.resolveReconciliationAction('ord-1', 'refund');
  await tick();
  t.opener.offsetParent = null; t.opener.isConnected = false;    // the ~5s tick replaced the recon buttons
  t.resetFocus();                                                // measure ONLY the dismiss's focus restore
  t.pressEsc();
  await p;
  assert.ok(t.lastFocused() && t.lastFocused() !== t.opener, 'focus restored to a live fallback, not black-holed to the detached opener');
  ok('focus-restore survives a render tick — dismiss after detach lands on a fallback (no black-hole)');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Contract: reconNotePrompt returns the RAW (untrimmed) textarea value on confirm — the caller owns the
//    .trim(). Locks the dialog directly (a `.value.trim()` in the confirm handler would go red here even
//    though the downstream server value is identical). Dismiss resolves null.
// ─────────────────────────────────────────────────────────────────────────────
{
  const t = buildEnv();
  const q = t.reconNotePrompt('materialize', 'o9');
  await tick();
  t.setNote('  raw value  ');
  t.clickConfirm();
  assert.strictEqual(await q, '  raw value  ', 'confirm resolves the RAW, untrimmed textarea value (caller trims)');
  const q2 = t.reconNotePrompt('abandon', 'o9');
  await tick();
  t.pressEsc();
  assert.strictEqual(await q2, null, 'dismiss resolves null');
  ok('reconNotePrompt returns RAW value on confirm / null on dismiss (caller owns .trim())');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. The money-terminal outcome+finally block is byte-identical to base b50a467; native prompt() is gone; the
//    styled dialog surface is present + aria-modal.
// ─────────────────────────────────────────────────────────────────────────────
{
  const outcomeOf = (src) => src.slice(src.indexOf('const sel = (window.CSS'));
  let baseHtml;
  try { baseHtml = execSync(`git show ${BASE}:xpizza-dispatch/index.html`, { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { console.error('  ! could not load base blob:', e.message); process.exit(1); }
  const baseResolve = baseHtml.slice(baseHtml.indexOf('async function resolveReconciliationAction('), baseHtml.indexOf('function formatTime('));
  assert.strictEqual(outcomeOf(resolveSrc), outcomeOf(baseResolve), 'outcome+finally block byte-identical to base b50a467');
  const resolveCode = resolveSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');   // strip comments (which mention prompt())
  assert.doesNotMatch(resolveCode, /(?<![\w.])prompt\(/, 'native prompt() removed from resolveReconciliationAction');
  assert.match(resolveSrc, /await reconNotePrompt\(action, orderId\)/, 'note collected via the styled reconNotePrompt');
  assert.match(promptBlock, /pickerReturnFocusTarget\(trigger \|\| opener, orderId, document\)/, 'focus-restore reuses the shared cascade (defect-2 fix)');
  assert.match(html, /id="recon-note-overlay"[^>]*role="dialog"[^>]*aria-modal="true"/, 'recon-note dialog present + aria-modal');
  assert.match(html, /<textarea id="recon-note-input"/, 'note textarea present');
  assert.match(html, /id="recon-note-confirm"/, 'confirm button present');
  assert.match(html, /id="recon-note-cancel"/, 'cancel button present');
  ok('outcome/finally byte-identical to base; native prompt() gone; focus cascade reused; dialog surface present');
}

console.log(`\ndispatch-recon-note: OK (${n} groups)`);
