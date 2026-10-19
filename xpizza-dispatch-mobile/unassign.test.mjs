import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// "Quitar repartidor" — MOBILE Torre, REAL wiring (codex P1-2). Extracts the real openUnassignConfirm +
// commitUnassign (+ the openPicker gating block) from index.html and runs them with XPD.unassignOrder stubbed
// to the frozen contract. Mirrors the desktop suite so both Torres are covered in parity.
const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

const cStart = html.indexOf('function openUnassignConfirm(orderId){');
const cEnd = html.indexOf('\n\n// ── settings ──', cStart) > -1 ? html.indexOf('\n\n// ── settings ──', cStart)
          : html.indexOf('\nfunction openSettings(', cStart);
// commitUnassign ends just before the settings section; slice to there.
const confirmSrc = html.slice(cStart, cEnd);
assert.ok(cStart > -1 && confirmSrc.includes('async function commitUnassign'), 'located mobile confirm block');

function buildEnv(stub) {
  const calls = [], toasts = []; let closeSheetCount = 0, sheetHtml = '';
  const btn = { disabled: false, textContent: 'Quitar repartidor' };
  const $m = (id) => id === 'unassign-yes' ? btn : null;
  const win = { crypto: { randomUUID: () => 'uuid-' + (++win._c) }, _c: 0 };
  const STORE = { orders: { o1: { customer_name: 'María' } }, scheduled: {}, drivers: { d1: { name: 'Carlos Mejía' } }, tasks: {} };
  const XPD = { unassignOrder: (...a) => { calls.push(a); return stub(a); } };
  const api = new Function(
    'STORE','pickerFromDriver','escapeHtml','driverColorVar','IC_BACK','IC_PLUS','openSheet','displayLabel','$','XPD','toast','closeSheet','window','crypto',
    `${confirmSrc}\n; return { openUnassignConfirm, commitUnassign };`
  )(
    STORE, 'd1', (s) => String(s), () => '#000', '<back/>', '<plus/>',
    (h) => { sheetHtml = h; }, (id) => '#' + id, $m, XPD,
    (m, isErr) => toasts.push([m, isErr]), () => { closeSheetCount++; }, win, win.crypto,
  );
  return { ...api, calls, toasts, btn, closeSheetCount: () => closeSheetCount, sheetHtml: () => sheetHtml };
}
const resolved = (v) => () => Promise.resolve(v);
const thrown = (msg) => () => { const e = new Error(msg); return Promise.reject(e); };
const tick = () => new Promise((r) => setTimeout(r, 0));

test('mobile confirm fail-safe matrix: each response maps to the right copy + open/close', async () => {
  const run = async (stub) => { const t = buildEnv(stub); t.openUnassignConfirm('o1'); await t.commitUnassign('o1'); await tick(); return t; };
  let t = await run(resolved({ ok: true }));
  assert.ok(t.toasts.some(([m]) => /sin asignar — de vuelta en la cola/.test(m)) && t.closeSheetCount() === 1, 'ok:true → success + closeSheet');
  t = await run(resolved({ ok: false, reason: 'reassigned' }));
  assert.ok(t.toasts.some(([m]) => m === 'Ese pedido ya tiene otro repartidor') && t.closeSheetCount() === 1, 'reassigned');
  t = await run(resolved({ ok: false, reason: 'not_assigned' }));
  assert.ok(t.toasts.some(([m]) => m === 'Ese pedido ya no estaba asignado') && t.closeSheetCount() === 1, 'not_assigned');
  t = await run(resolved({ ok: false, reason: 'picked_up' }));
  assert.ok(t.toasts.some(([m]) => m === 'El repartidor ya recogió el pedido') && t.closeSheetCount() === 1, 'picked_up');
  t = await run(thrown('terminal'));
  assert.ok(t.toasts.some(([m]) => m === 'El pedido ya se cerró') && t.closeSheetCount() === 1, 'terminal → final close');
  t = await run(thrown('state'));
  assert.ok(t.toasts.some(([m]) => m === 'No se puede quitar el repartidor ahora mismo') && t.closeSheetCount() === 0 && t.btn.disabled === false, 'state → re-enable');
  t = await run(thrown('not_found'));
  assert.ok(t.toasts.some(([m]) => m === 'No se encontró el pedido') && t.closeSheetCount() === 0, 'not_found → re-enable');
  for (const stub of [thrown('retryable'), thrown('internal'), resolved({}), resolved(null)]) {
    t = await run(stub);
    assert.ok(t.toasts.some(([m, e]) => m === 'No se pudo quitar — reintentá' && e === true) && t.closeSheetCount() === 0 && t.btn.disabled === false, 'else/503/malformed → retry error, re-enable');
  }
});

test('mobile opId: minted at open, reused on retry, new on reopen; args (orderId, fromDriver, opId)', async () => {
  const t = buildEnv(thrown('retryable'));
  t.openUnassignConfirm('o1');
  await t.commitUnassign('o1'); await tick();
  await t.commitUnassign('o1'); await tick();            // retry same press
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[0][2], t.calls[1][2], 'retry resends the SAME opId');
  assert.deepEqual([t.calls[0][0], t.calls[0][1]], ['o1', 'd1'], 'args orderId, fromDriver');
  const first = t.calls[0][2];
  t.openUnassignConfirm('o1');                            // reopen
  await t.commitUnassign('o1'); await tick();
  assert.notEqual(t.calls[2][2], first, 'reopen mints a NEW opId');
});

test('mobile one request per confirm: a second activation while pending makes no extra call', async () => {
  let release; const t = buildEnv(() => new Promise((r) => { release = () => r({ ok: true }); }));
  t.openUnassignConfirm('o1');
  t.commitUnassign('o1');          // in flight
  t.commitUnassign('o1');          // second while pending
  await tick();
  assert.equal(t.calls.length, 1, 'exactly one request');
  release(); await tick();
});

test('mobile render gate: the remove row shows only for reassign + PRE-PICKUP', () => {
  const gStart = html.indexOf('  const pickupTask = STORE.tasks[');
  const gEnd = html.indexOf('\n\n  openSheet(', gStart);
  const gSrc = html.slice(gStart, gEnd);
  assert.ok(gStart > -1 && gEnd > gStart && gSrc.includes('removeBlock'), 'located mobile gating block');
  const run = ({ pickerIsReassign, pickupStatus }) => {
    const STORE = { tasks: pickupStatus === null ? {} : { 'o1_pickup': { status: pickupStatus } } };
    return new Function('STORE','orderId','pickerIsReassign','escapeHtml', gSrc + '\n; return removeBlock;')(
      STORE, 'o1', pickerIsReassign, (s) => String(s));
  };
  assert.match(run({ pickerIsReassign: true, pickupStatus: 'assigned' }), /Quitar repartidor/, 'reassign + pre-pickup → PRESENT');
  assert.equal(run({ pickerIsReassign: false, pickupStatus: 'assigned' }), '', 'not reassign → ABSENT');
  assert.equal(run({ pickerIsReassign: true, pickupStatus: 'completed' }), '', 'pickup completed → ABSENT');
  assert.equal(run({ pickerIsReassign: true, pickupStatus: null }), '', 'no pickup task → ABSENT (parity with desktop: requires the pickup task present)');
});
