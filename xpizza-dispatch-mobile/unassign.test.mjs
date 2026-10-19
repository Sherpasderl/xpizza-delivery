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

test('mobile delegated events: the REAL document click handler routes unassign + preserves assign/reassign', () => {
  const start = html.indexOf("document.addEventListener('click', (e) => {");
  const end = html.indexOf('\n});\n', start) + 3;
  const stmt = html.slice(start, end);
  assert.ok(start > -1 && stmt.includes('ds.unassign') && stmt.includes('ds.commit'), 'extracted the real click delegation statement');
  const rec = [];
  const stub = (name) => (...a) => rec.push([name, ...a]);
  const deps = {
    openPass: null, layoutDecks: () => {}, collapsedDone: false, renderBoard: () => {}, activeChip: null, animateBoard: false,
    showTab: stub('showTab'), openDetail: stub('openDetail'), openPicker: stub('openPicker'), openConfirm: stub('openConfirm'),
    commitAssign: stub('commitAssign'), openUnassignConfirm: stub('openUnassignConfirm'), commitUnassign: stub('commitUnassign'),
    closeSheet: stub('closeSheet'), theme: '', localStorage: { setItem() {} }, applyTheme: () => {}, openSettings: () => {},
    enableStaffPush: () => {}, XPD: { signOutUser: () => Promise.resolve() }, toast: () => {}, sheetDir: null,
    $: () => ({ querySelector: () => ({ dataset: { detail: 'o1' } }) }), window: {},
  };
  const handlers = [];
  const documentShim = { addEventListener: (t, fn) => { if (t === 'click') handlers.push(fn); }, querySelectorAll: () => [] };
  new Function('document', ...Object.keys(deps), stmt)(documentShim, ...Object.values(deps));
  const handler = handlers[0];
  assert.ok(handler, 'the delegation handler registered on document click');
  const click = (dataset) => { rec.length = 0; handler({ target: { closest: () => ({ dataset }) } }); };
  click({ unassign: 'o1' });        assert.deepEqual(rec, [['openUnassignConfirm', 'o1']], 'data-unassign → openUnassignConfirm');
  click({ unassignCommit: 'o1' });  assert.deepEqual(rec, [['commitUnassign', 'o1']], 'data-unassign-commit → commitUnassign');
  click({ choose: 'd1' });          assert.deepEqual(rec, [['openConfirm', 'o1', 'd1']], 'data-choose → openConfirm (assign/reassign pick) UNCHANGED');
  click({ commit: 'd1', order: 'o1' }); assert.deepEqual(rec, [['commitAssign', 'o1', 'd1']], 'data-commit → commitAssign (the existing mutation) UNCHANGED');
  click({ pick: 'o1' });            assert.deepEqual(rec, [['openPicker', 'o1']], 'data-pick → openPicker UNCHANGED');
});

test('mobile stale completion: a request resolving after a newer confirm opened does not close it', async () => {
  let releaseA; const t = buildEnv(() => new Promise((r) => { releaseA = () => r({ ok: true }); }));
  t.openUnassignConfirm('o1');          // dialog A (token 1)
  t.commitUnassign('o1'); await tick(); // A in flight
  const closesBefore = t.closeSheetCount(), toastsBefore = t.toasts.length;
  t.openUnassignConfirm('o1');          // newer confirm (token 2)
  releaseA(); await tick(); await tick();
  assert.equal(t.closeSheetCount(), closesBefore, 'stale A resolution did not closeSheet the newer confirm');
  assert.equal(t.toasts.length, toastsBefore, 'stale A resolution produced no toast');
});

test('mobile confirm a11y lifecycle is wired (focus Cancelar, Esc→picker, Tab wrap, restore-if-connected)', () => {
  // the confirm's Cancelar carries data-sheet-focus (initial focus, not the Atrás nav button), and both Atrás and
  // Cancelar return to the picker (data-pick + data-back).
  const confirm = html.slice(html.indexOf('function openUnassignConfirm(orderId){'), html.indexOf('\n\nlet unassignOpId'));
  assert.match(confirm, /data-pick="\$\{escapeHtml\(orderId\)\}" data-back="1" data-sheet-focus>Cancelar</, 'Cancelar has data-sheet-focus + returns to the picker');
  assert.match(confirm, /class="back"[^>]*data-pick="\$\{escapeHtml\(orderId\)\}" data-back="1"/, 'Atrás returns to the picker');
  // openSheet honors [data-sheet-focus] as the initial focus.
  assert.match(html, /querySelector\('\[data-sheet-focus\]:not\(\[disabled\]\)'\)\s*\|\|/, 'openSheet focuses [data-sheet-focus] first');
  // Esc on the confirm returns to the picker (openPicker), not closeSheet.
  const esc = html.slice(html.indexOf("if (e.key !== 'Escape') return;"), html.indexOf("// Keep Tab inside the sheet"));
  assert.match(esc, /\$\('unassign-yes'\)\s*&&\s*\$\('sheet'\)\.querySelector\('\.sh-nav \[data-pick\]\[data-back\]'\)/, 'Esc detects the confirm');
  assert.match(esc, /openPicker\(back\.dataset\.pick\);\s*return;/, 'Esc → openPicker (back to the picker), not closeSheet');
  // a confirm-scoped Tab handler wraps both directions.
  const tab = html.slice(html.indexOf("if (e.key !== 'Tab' || !$('unassign-yes')"), html.indexOf("if (e.key !== 'Tab' || !$('unassign-yes')") + 520);
  assert.match(tab, /e\.shiftKey && i <= 0.*f\[f\.length - 1\]\.focus\(\)/s, 'Shift-Tab from the first wraps to the last');
  assert.match(tab, /i === f\.length - 1.*f\[0\]\.focus\(\)/s, 'Tab from the last wraps to the first');
  // closeSheet restores the opener only if still connected.
  assert.match(html, /lastFocus\.focus && document\.contains\(lastFocus\)/, 'closeSheet restores opener only if connected');
});

test('mobile render gate: shown only for reassign + same-owner both legs + pickup∈{assigned,accepted,in_progress} + non-terminal (parity with desktop)', () => {
  const gStart = html.indexOf('  const pickupTask = STORE.tasks[');
  const gEnd = html.indexOf('\n\n  openSheet(', gStart);
  const gSrc = html.slice(gStart, gEnd);
  assert.ok(gStart > -1 && gEnd > gStart && gSrc.includes('removeBlock'), 'located mobile gating block');
  const base = { pickerIsReassign: true, pickerFromDriver: 'd1', pickupStatus: 'assigned', pickupOwner: 'd1', deliveryOwner: 'd1', orderStatus: 'preparing' };
  const run = (over) => {
    const c = { ...base, ...over };
    const tasks = {};
    if (c.pickupStatus !== null) tasks['o1_pickup'] = { status: c.pickupStatus, assigned_driver_id: c.pickupOwner };
    if (c.deliveryOwner !== null) tasks['o1_delivery'] = { assigned_driver_id: c.deliveryOwner };
    const STORE = { tasks, orders: { o1: { status: c.orderStatus } }, scheduled: {} };
    return new Function('STORE','orderId','pickerIsReassign','pickerFromDriver','escapeHtml', gSrc + '\n; return removeBlock;')(
      STORE, 'o1', c.pickerIsReassign, c.pickerFromDriver, (s) => String(s));
  };
  const shown = (over, why) => assert.match(run(over), /Quitar repartidor/, 'PRESENT: ' + why);
  const hidden = (over, why) => assert.equal(run(over), '', 'ABSENT: ' + why);
  shown({}, 'assigned');
  shown({ pickupStatus: 'accepted' }, 'accepted');
  shown({ pickupStatus: 'in_progress' }, 'in_progress');
  hidden({ pickerIsReassign: false }, 'initial-assign');
  hidden({ pickerFromDriver: null }, 'no captured driver');
  hidden({ pickupStatus: 'completed' }, 'completed pickup');
  hidden({ pickupStatus: 'pending' }, 'pending pickup');
  hidden({ pickupStatus: null }, 'no pickup task');
  hidden({ deliveryOwner: null }, 'no delivery task');
  hidden({ pickupOwner: 'dX' }, 'split owners (pickup)');
  hidden({ deliveryOwner: 'dX' }, 'split owners (delivery ≠ captured)');
  hidden({ orderStatus: 'delivered' }, 'terminal: delivered');
  hidden({ orderStatus: 'cancelled' }, 'terminal: cancelled');
});
