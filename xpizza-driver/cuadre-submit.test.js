// Cuadre SLIDE-to-confirm money submit — HANDLER test. run: `node cuadre-submit.test.js` (invoked from
// xpizza-functions in the npm chain). EXECUTES the REAL shipped index.html handlers (onCuadreConfirm + the
// #cuadre-screen click listener + cuadreSubmitting, lifted from source via new Function — the endshift-confirm.test.js
// idiom) against a REAL jsdom DOM, with XPD.recordCuadre stubbed as a controllable deferred. No source-grep asserts.
// Proves the money contract of the slide conversion (prototype S.cuadre):
//   - a completed slide submits EXACTLY ONE recordCuadre; on ack it finalizes the shift (overlay closed);
//   - a SECOND slide while a close is in flight is a no-op → still ONE recordCuadre (the closeInFlight double-submit
//     guard — mutant: drop the guard ⇒ TWO);
//   - a server REJECTION shows cierreRechazado and does NOT finalize;
//   - the hdr/foot BUTTONS never submit: «Volver al turno» (.cuadre-volver) supersedes + closes with NO recordCuadre,
//     and «Reintentar cierre» (.cuadre-reintentar) re-opens the receipt (showCuadre) with NO recordCuadre
//     (mutant: wire the back chevron to submit ⇒ a recordCuadre).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = require('jsdom');

const SCRIPT = readFileSync(join(__dir, 'index.html'), 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1];

function liftFn(name) {
  let start = SCRIPT.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  if (SCRIPT.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0, seen = false;
  for (let i = start; i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '{') { depth++; seen = true; }
    else if (SCRIPT[i] === '}') { depth--; if (seen && depth === 0) return SCRIPT.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
// The delegated #cuadre-screen click listener (back/retry buttons) — from the addEventListener call to its `});`.
function liftClickListener() {
  const start = SCRIPT.indexOf("$('cuadre-screen').addEventListener('click'");
  assert.notEqual(start, -1, 'cuadre-screen click listener not found');
  const end = SCRIPT.indexOf('\n});', start);
  assert.notEqual(end, -1, 'click listener end not found');
  return SCRIPT.slice(start, end + 3);
}

function deferred() { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

// Build the REAL handlers in a sandbox with a real jsdom document + externals injected.
function build() {
  const dom = new JSDOM('<!doctype html><html><body><div id="cuadre-screen"></div></body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  const screen = $('cuadre-screen');
  screen._ident = { valid: true, shiftId: 's1', start: 1000 };

  const calls = { recordCuadre: 0, finalize: 0, showCierreRechazado: 0, showCuadre: 0, toasts: [] };
  let pendingRecord = null;
  const XPD = { recordCuadre: () => { calls.recordCuadre++; pendingRecord = deferred(); return pendingRecord.promise; } };

  const deps = {
    document, window, $,
    toast: (m) => calls.toasts.push(m),
    shiftIdentity: () => ({ valid: true, shiftId: 's1', start: 1000 }),
    identityMatches: () => true,
    currentUser: { uid: 'drv' },
    pendingCompletions: new Set(),
    COMPLETION_SETTLE_TIMEOUT_MS: 100000,
    CUADRE_ACK_TIMEOUT_MS: 100000,
    BLOCKED_CLOSE_TEXT: 'No se pudo registrar el cierre.',
    refreshOpenCashSurfaces: () => {},
    renderCuadreReceipt: (bound) => { const c = { cashOwed: 1430 }; screen._cash = c; return c; },
    makeOpId: () => 'op_test',
    XPD,
    finalizeEndShift: async () => { calls.finalize++; },
    render: () => {},
    showCierreRechazado: () => { calls.showCierreRechazado++; },
    showCuadre: () => { calls.showCuadre++; },
  };

  const body = 'let closeGen = 0; let closeInFlight = false; let shiftBusy = false; let optimisticShift = null;\n'
    + 'let feedReady = true; let driverState = {}; let driverFeed = null;\n'
    + liftFn('cuadreSubmitting') + '\n'
    + liftFn('onCuadreConfirm') + '\n'
    + liftClickListener() + '\n'
    + 'return { onCuadreConfirm, getGen: () => closeGen, getInFlight: () => closeInFlight };';
  const names = Object.keys(deps);
  const fn = new Function(...names, body);
  const api = fn(...names.map((n) => deps[n]));
  return { api, calls, screen, document, resolveRecord: (v) => pendingRecord.resolve(v), rejectRecord: (e) => pendingRecord.reject(e) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ok -', name); }

await t('a completed slide submits EXACTLY ONE recordCuadre and finalizes the shift on ack', async () => {
  const h = build();
  const p = h.api.onCuadreConfirm();
  await tick();
  assert.equal(h.calls.recordCuadre, 1, 'one recordCuadre');
  h.resolveRecord();                      // server ack
  await p; await tick();
  assert.equal(h.calls.finalize, 1, 'the shift finalized on ack');
  assert.ok(!h.screen.classList.contains('open'), 'overlay closed');
});

await t('a SECOND slide while a close is in flight is a no-op → still ONE recordCuadre (closeInFlight guard)', async () => {
  const h = build();
  const p1 = h.api.onCuadreConfirm();      // in flight (recordCuadre pending)
  await tick();
  assert.equal(h.calls.recordCuadre, 1, 'first slide submitted');
  assert.equal(h.api.getInFlight(), true, 'closeInFlight latched during the in-flight window');
  h.api.onCuadreConfirm();                 // the double-submit the advisor worries about (fire-and-forget)
  await tick();
  assert.equal(h.calls.recordCuadre, 1, 'the second slide did NOT fire a second recordCuadre');
  h.resolveRecord(); await p1;
});

await t('a server REJECTION shows cierreRechazado and does NOT finalize', async () => {
  const h = build();
  const p = h.api.onCuadreConfirm();
  await tick();
  h.rejectRecord(new Error('permission denied'));
  await p; await tick();
  assert.equal(h.calls.showCierreRechazado, 1, 'cierreRechazado shown on rejection');
  assert.equal(h.calls.finalize, 0, 'never clock out on a rejection');
});

await t('«Volver al turno» (.cuadre-volver) supersedes + closes with NO recordCuadre', async () => {
  const h = build();
  h.screen.classList.add('open');
  const genBefore = h.api.getGen();
  const btn = h.document.createElement('button'); btn.className = 'rc-volver cuadre-volver'; h.screen.appendChild(btn);
  btn.click();
  await tick();
  assert.equal(h.calls.recordCuadre, 0, 'back never submits');
  assert.ok(h.api.getGen() > genBefore, 'closeGen++ supersedes any in-flight close');
  assert.ok(!h.screen.classList.contains('open'), 'overlay closed');
});

await t('«Reintentar cierre» (.cuadre-reintentar) re-opens the receipt (showCuadre) with NO recordCuadre', async () => {
  const h = build();
  const btn = h.document.createElement('button'); btn.className = 'rc-retry cuadre-reintentar'; h.screen.appendChild(btn);
  btn.click();
  await tick();
  assert.equal(h.calls.recordCuadre, 0, 'retry never submits directly');
  assert.equal(h.calls.showCuadre, 1, 'retry re-opens the normal receipt');
});

console.log(`✓ cuadre-submit: ${passed} checks passed`);
process.exit(passed === 5 ? 0 : 1);   // force-exit past the lifted handler's lingering ack-timeout timers
