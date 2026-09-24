// xpizza-dispatch/dispatch-recon-note.test.js
//
// Slice C-2 — reconciliation operator note: native prompt() → styled in-board field (MONEY-ADJACENT).
// Only the INPUT SURFACE changed; the fed value + resolve/outcome/finally logic stay byte-identical.
//
// These guards drive the REAL functions extracted from the shipped file — the real resolveReconciliationAction
// calling the real reconNotePrompt through a DOM shim (compose the real pieces, not two halves). They enforce
// the 4-part money contract, each red-when-reverted:
//   1. value byte-identical — XPD.resolveReconciliation(id, action, note.trim()) across all 3 actions;
//   2. cancel/dismiss → NO server call (reconNotePrompt(null) ⟶ early return);
//   3. abandon → required non-blank note: same 'Se requiere una nota para descartar' + no call; materialize/
//      refund keep the note optional (empty still resolves);
//   4. in-flight double-fire guard — buttons disabled during the await, re-enabled in finally; and a second
//      concurrent action while the dialog is open fires NO resolve (single-instance).
// Plus: reconNotePrompt returns the RAW value on confirm / null on dismiss; the outcome+finally block is
// byte-identical to the approved base b50a467; and native prompt() is gone from the resolver.
import assert from 'node:assert';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'index.html');
const BASE = 'b50a467';                       // approved Slice B tip C-2 stacks on (resolve/outcome logic frozen)
const html = fs.readFileSync(FILE, 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const tick = () => new Promise(r => setTimeout(r, 0));

// ---- extract the REAL source blocks ----
const reconSuccessLine = (html.match(/const RECON_SUCCESS_OUTCOMES = new Set\(\[[^\]]*\]\);/) || [])[0];
assert.ok(reconSuccessLine, 'RECON_SUCCESS_OUTCOMES located');
const promptStart = html.indexOf('let reconNoteSettle = null;');
const resolveStart = html.indexOf('async function resolveReconciliationAction(');
const resolveEnd = html.indexOf('function formatTime(');
assert.ok(promptStart > -1 && resolveStart > promptStart && resolveEnd > resolveStart, 'located recon-note + resolver blocks');
const promptBlock = html.slice(promptStart, resolveStart);
const resolveSrc = html.slice(resolveStart, resolveEnd);

// ---- harness: eval BOTH real functions in one scope so resolveReconciliationAction calls the REAL reconNotePrompt ----
function buildEnv() {
  const els = {};
  const getEl = (id) => (els[id] ||= { id, textContent: '', value: '', classList: { add() {}, remove() {}, contains: () => false }, addEventListener() {}, focus() {}, disabled: false });
  let queryButtons = [];
  let xpd = null;
  const toasts = [], resolveCalls = [];
  const doc = { getElementById: getEl, activeElement: null, contains: () => false, querySelectorAll: () => queryButtons, querySelector: () => null };
  const win = { matchMedia: () => ({ matches: false }), CSS: { escape: (s) => s } };
  const XPD = { resolveReconciliation: (...args) => { resolveCalls.push(args); return new Promise((res, rej) => { xpd = { res, rej }; }); } };
  const api = new Function('$', 'document', 'window', 'CSS', 'toast', 'XPD', 'displayOrderLabel', 'focusTrapTarget',
    `${reconSuccessLine}\n${promptBlock}\n${resolveSrc}\n; return { resolveReconciliationAction, reconNotePrompt, settleReconNote };`
  )(getEl, doc, win, win.CSS, (m, t) => toasts.push([m, t]), XPD, (x) => String(x), () => null);
  return {
    ...api, toasts, resolveCalls,
    // buttons track everDisabled so a removed cancel-guard (which would run the disable loop before returning)
    // is caught even though note.trim() on the dismissed value never reaches the resolve call.
    setButtons: (k) => (queryButtons = Array.from({ length: k }, () => { let d = false; return { get disabled() { return d; }, set disabled(v) { if (v) this.everDisabled = true; d = v; }, everDisabled: false }; })),
    buttons: () => queryButtons,
    settleXpd: (v) => xpd.res(v),
    rejectXpd: (e) => xpd.rej(e),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Value byte-identical — the string passed to resolveReconciliation is note.trim(), same value, all 3 actions.
// ─────────────────────────────────────────────────────────────────────────────
{
  for (const action of ['materialize', 'refund', 'abandon']) {
    const t = buildEnv(); t.setButtons(3);
    const p = t.resolveReconciliationAction('ord-1', action);
    await tick();
    t.settleReconNote('  nota con espacios  ');       // confirm with a padded note
    await tick();
    assert.strictEqual(t.resolveCalls.length, 1, `${action}: exactly one resolve`);
    assert.deepStrictEqual(t.resolveCalls[0], ['ord-1', action, 'nota con espacios'], `${action}: (id, action, note.trim()) byte-identical`);
    t.settleXpd({ outcome: 'materialized' }); await p;
  }
  ok('value byte-identical: resolveReconciliation(id, action, note.trim()) across materialize/refund/abandon');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Cancel / dismiss → NO server call (reconNotePrompt resolves null ⟶ early return, buttons never touched).
// ─────────────────────────────────────────────────────────────────────────────
{
  const t = buildEnv(); t.setButtons(3);
  const p = t.resolveReconciliationAction('ord-1', 'refund');
  await tick();
  t.settleReconNote(null);                            // Esc / Cancel / backdrop
  await p;
  assert.strictEqual(t.resolveCalls.length, 0, 'dismiss fired no resolve');
  assert.ok(t.buttons().every(b => !b.everDisabled), 'buttons never disabled on dismiss (guard returned before the disable loop)');
  ok('cancel/dismiss → no resolve call, no button disable');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Abandon requires a non-blank note (same error, no call); materialize/refund keep it optional.
// ─────────────────────────────────────────────────────────────────────────────
{
  const t = buildEnv(); t.setButtons(3);
  const p = t.resolveReconciliationAction('ord-1', 'abandon');
  await tick();
  t.settleReconNote('   ');                           // whitespace-only note on abandon
  await p;
  assert.strictEqual(t.resolveCalls.length, 0, 'abandon+blank fired no resolve');
  assert.ok(t.toasts.some(([m, tt]) => m === 'Se requiere una nota para descartar' && tt === 'error'), 'same required-note error toast');

  const t2 = buildEnv(); t2.setButtons(3);
  const p2 = t2.resolveReconciliationAction('ord-2', 'materialize');
  await tick();
  t2.settleReconNote('');                             // empty note on materialize → optional, still resolves
  await tick();
  assert.strictEqual(t2.resolveCalls.length, 1, 'materialize with empty note still resolves (optional)');
  assert.strictEqual(t2.resolveCalls[0][2], '', 'empty note passed through as ""');
  t2.settleXpd({ outcome: 'materialized' }); await p2;
  ok('abandon requires non-blank note (same error, no call); materialize/refund note optional');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Double-fire guard — a 2nd action while the dialog is open fires NO resolve; buttons disable during the
//    await and re-enable in finally.
// ─────────────────────────────────────────────────────────────────────────────
{
  const t = buildEnv(); const btns = t.setButtons(3);
  const p = t.resolveReconciliationAction('ord-1', 'materialize');
  await tick();
  const p2 = t.resolveReconciliationAction('ord-1', 'refund');   // second, while the dialog is open
  await p2;                                                      // single-instance ⟶ reconNotePrompt(null) ⟶ returns
  assert.strictEqual(t.resolveCalls.length, 0, 'second concurrent action fired no resolve');
  t.settleReconNote('nota');
  await tick();
  assert.ok(btns.every(b => b.disabled === true), 'buttons disabled while resolve awaits');
  assert.strictEqual(t.resolveCalls.length, 1, 'exactly one resolve after confirm');
  t.settleXpd({ outcome: 'materialized' });
  await p;
  assert.ok(btns.every(b => b.disabled === false), 'buttons re-enabled in finally');
  ok('double-fire guard: single-instance dialog + buttons disabled during await, re-enabled in finally');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. reconNotePrompt returns the RAW value on confirm (caller trims) / null on dismiss.
// ─────────────────────────────────────────────────────────────────────────────
{
  const t = buildEnv();
  const q = t.reconNotePrompt('materialize', 'o9');
  await tick();
  t.settleReconNote('  raw value  ');
  assert.strictEqual(await q, '  raw value  ', 'confirm resolves the RAW textarea value (untrimmed)');
  const q2 = t.reconNotePrompt('abandon', 'o9');
  await tick();
  t.settleReconNote(null);
  assert.strictEqual(await q2, null, 'dismiss resolves null');
  ok('reconNotePrompt → raw value on confirm, null on dismiss');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. The money-terminal outcome+finally block is byte-identical to the approved base b50a467 (only the input
//    surface changed). And native prompt() is gone from the resolver.
// ─────────────────────────────────────────────────────────────────────────────
{
  const outcomeOf = (src) => { const i = src.indexOf('const sel = (window.CSS'); return src.slice(i); };
  let baseHtml;
  try { baseHtml = execSync(`git show ${BASE}:xpizza-dispatch/index.html`, { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { console.error('  ! could not load base blob:', e.message); process.exit(1); }
  const baseResolve = baseHtml.slice(baseHtml.indexOf('async function resolveReconciliationAction('), baseHtml.indexOf('function formatTime('));
  assert.strictEqual(outcomeOf(resolveSrc), outcomeOf(baseResolve), 'outcome+finally block byte-identical to base b50a467');
  const resolveCode = resolveSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');   // strip comments (which mention prompt())
  assert.doesNotMatch(resolveCode, /(?<![\w.])prompt\(/, 'native prompt() removed from resolveReconciliationAction');
  assert.match(resolveSrc, /await reconNotePrompt\(action, orderId\)/, 'note now collected via the styled reconNotePrompt');
  // modal surface present + keyboard-operable
  assert.match(html, /id="recon-note-overlay"[^>]*role="dialog"[^>]*aria-modal="true"/, 'recon-note dialog present + aria-modal');
  assert.match(html, /<textarea id="recon-note-input"/, 'note textarea present');
  assert.match(html, /id="recon-note-confirm"/, 'confirm button present');
  assert.match(html, /id="recon-note-cancel"/, 'cancel button present');
  ok('outcome/finally byte-identical to base; native prompt() gone; styled dialog surface present');
}

console.log(`\ndispatch-recon-note: OK (${n} groups)`);
