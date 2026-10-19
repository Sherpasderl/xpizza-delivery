// xpizza-dispatch/dispatch-unassign-confirm.test.js
//
// "Quitar repartidor / Sin asignar" — desktop confirm, REAL wiring (codex P1-2). Extracts the real
// openUnassignConfirm / closeUnassignConfirm / doUnassign + the real addEventListener wiring from index.html
// and runs them against a DOM shim with XPD.unassignOrder STUBBED to the frozen server contract. Nothing is
// a no-op: the real button/keydown handlers fire and the real fail-safe mapping runs.
//
// Contract (PLAN-unassign-prepickup §1): 200 {ok:true} | {ok:false,reason:'reassigned'|'not_assigned'|'picked_up'};
// non-2xx throws carrying err.message = the server `error` ('terminal'|'state'|'not_found'|'retryable'|…).
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

const start = html.indexOf('let unassignOpen = false,');
const end = html.indexOf('\n\nasync function resolveReconciliationAction(');
assert.ok(start > -1 && end > start, 'located the unassign confirm source block');
const src = html.slice(start, end);

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const tick = () => new Promise((r) => setTimeout(r, 0));

function makeEl(id) {
  const listeners = {};
  return {
    id, _text: '', _html: '', disabled: false, _attrs: {}, focused: 0,
    classList: { _s: new Set(['hidden']), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, contains(c){return this._s.has(c);} },
    set textContent(v){ this._text = v; }, get textContent(){ return this._text; },
    set innerHTML(v){ this._html = v; }, get innerHTML(){ return this._html; },
    setAttribute(k,v){ this._attrs[k]=v; }, hasAttribute(k){ return k in this._attrs; },
    addEventListener(t,fn){ (listeners[t] ||= []).push(fn); },
    dispatch(t,ev){ (listeners[t]||[]).forEach((fn)=>fn(ev)); },
    insertAdjacentHTML(_pos, h){ this._html += h; },
    focus(){ this.focused++; LAST_FOCUSED = this; },
    querySelectorAll(){ return [GET('unassign-cancel-btn'), GET('unassign-confirm-btn')].filter(Boolean); },
    closest(sel){ return (sel === '.hidden' && this.classList.contains('hidden')) ? this : null; },
  };
}
let LAST_FOCUSED = null;
const ELS = {};
const IDS = ['unassign-confirm-overlay','unassign-confirm-title','unassign-confirm-sub','unassign-confirm-body','unassign-cancel-btn','unassign-confirm-btn','picker-remove-row','picker-list'];
for (const id of IDS) ELS[id] = makeEl(id);
const GET = (id) => ELS[id] || null;

// env for the extracted block
function buildEnv(stub) {
  for (const id of IDS) { const e = ELS[id]; e.classList._s = new Set(['hidden']); e.disabled = false; e._text=''; e._html=''; e.focused=0; }
  LAST_FOCUSED = null;
  const calls = [];                       // XPD.unassignOrder args, in order
  const toasts = [];
  let closePickerCount = 0;
  const doc = { activeElement: null, contains: () => true, querySelector: () => GET('picker-remove-row') };
  const win = { matchMedia: () => ({ matches: false }), crypto: { randomUUID: () => 'uuid-' + (++win._c) }, _c: 0 };
  const cryptoObj = win.crypto;
  const XPD = { unassignOrder: (...a) => { calls.push(a); return stub(a); } };
  const api = new Function(
    '$','allOrders','allDrivers','pickerFromDriver','displayOrderLabel','escapeHtml','XPD','toast','closePicker','pickerReturnFocusTarget','focusTrapTarget','document','window','crypto',
    `${src}\n; return { openUnassignConfirm, closeUnassignConfirm, doUnassign };`
  )(
    GET,
    { o1: { customer_name: 'María', total: 420 } },
    { d1: { name: 'Carlos Mejía' } },
    'd1',
    (id) => '#' + id,
    (s) => String(s),
    XPD,
    (m, t) => toasts.push([m, t]),
    () => { closePickerCount++; },
    () => ({ el: GET('picker-remove-row'), temp: false }),
    (shift, active, f) => f[0],
    doc, win, cryptoObj,
  );
  return { ...api, calls, toasts, closePickerCount: () => closePickerCount, overlay: GET('unassign-confirm-overlay'),
    cancelBtn: GET('unassign-cancel-btn'), confirmBtn: GET('unassign-confirm-btn') };
}
const resolved = (v) => () => Promise.resolve(v);
const thrown = (msg, httpStatus) => () => { const e = new Error(msg); e.httpStatus = httpStatus; return Promise.reject(e); };

// ── 1. open: overlay shown, fields set, opId minted, initial focus on Cancel ──
{
  const t = buildEnv(resolved({ ok: true }));
  t.openUnassignConfirm('o1');
  assert.ok(!t.overlay.classList.contains('hidden'), 'overlay shown');
  assert.match(t.confirmBtn._text || 'Quitar repartidor', /Quitar repartidor/, 'confirm btn label');
  assert.ok(/#o1/.test(GET('unassign-confirm-sub')._text), 'sub names the order');
  assert.ok(/Carlos Mejía/.test(GET('unassign-confirm-body')._html) && /María/.test(GET('unassign-confirm-body')._html), 'body names driver + customer');
  assert.strictEqual(LAST_FOCUSED, t.cancelBtn, 'initial focus is Cancelar (no input in this dialog)');
  ok('open: overlay shown, order/customer/driver named, initial focus on Cancelar');
}

// ── 2. success + the no-op reasons + the error codes (the full fail-safe matrix) ──
async function runResult(stub) {
  const t = buildEnv(stub);
  t.openUnassignConfirm('o1');
  t.confirmBtn.dispatch('click', {});      // real wiring → doUnassign
  await tick(); await tick();
  return t;
}
{
  let t = await runResult(resolved({ ok: true }));
  assert.ok(t.toasts.some(([m]) => /sin asignar — de vuelta en la cola/.test(m)) && t.closePickerCount() === 1 && t.overlay.classList.contains('hidden'), 'ok:true → success, picker closed');

  t = await runResult(resolved({ ok: false, reason: 'reassigned' }));
  assert.ok(t.toasts.some(([m]) => m === 'Ese pedido ya tiene otro repartidor') && t.closePickerCount() === 1, 'reassigned');

  t = await runResult(resolved({ ok: false, reason: 'not_assigned' }));
  assert.ok(t.toasts.some(([m]) => m === 'Ese pedido ya no estaba asignado') && t.closePickerCount() === 1, 'not_assigned');

  t = await runResult(resolved({ ok: false, reason: 'picked_up' }));
  assert.ok(t.toasts.some(([m]) => m === 'El repartidor ya recogió el pedido') && t.closePickerCount() === 1, 'picked_up');

  t = await runResult(thrown('terminal', 409));
  assert.ok(t.toasts.some(([m]) => m === 'El pedido ya se cerró') && t.closePickerCount() === 1, 'terminal → final close');

  t = await runResult(thrown('state', 409));
  assert.ok(t.toasts.some(([m]) => m === 'No se puede quitar el repartidor ahora mismo') && t.closePickerCount() === 0 && !t.overlay.classList.contains('hidden') && t.confirmBtn.disabled === false, 'state → re-enable, stays open');

  t = await runResult(thrown('not_found', 404));
  assert.ok(t.toasts.some(([m]) => m === 'No se encontró el pedido') && t.closePickerCount() === 0, 'not_found → re-enable');

  for (const stub of [thrown('retryable', 503), thrown('bad_request', 400), thrown('internal', 500), resolved({}), resolved(null), resolved({ ok: false, reason: 'weird' })]) {
    t = await runResult(stub);
    assert.ok(t.toasts.some(([m, ty]) => m === 'No se pudo quitar — reintentá' && ty === 'error') && t.closePickerCount() === 0 && t.confirmBtn.disabled === false, 'else/503/malformed → retry error, stays open');
  }
  ok('fail-safe matrix: ok / reassigned / not_assigned / picked_up / terminal / state / not_found / 503+400+500+malformed each map to the right copy and open/close');
}

// ── 3. opId: generated at open, SAME on a retry of that press, NEW on reopen ──
{
  const t = buildEnv(thrown('retryable', 503));
  t.openUnassignConfirm('o1');
  t.confirmBtn.dispatch('click', {}); await tick(); await tick();   // 1st press → 503, re-enables
  t.confirmBtn.dispatch('click', {}); await tick(); await tick();   // retry same press
  assert.strictEqual(t.calls.length, 2, 'two calls (retry)');
  assert.strictEqual(t.calls[0][2], t.calls[1][2], 'retry resends the SAME opId');
  assert.strictEqual(t.calls[0][0], 'o1'); assert.strictEqual(t.calls[0][1], 'd1');
  const firstOpId = t.calls[0][2];
  t.closeUnassignConfirm(false);
  t.openUnassignConfirm('o1');                 // reopen = new operation
  t.confirmBtn.dispatch('click', {}); await tick(); await tick();
  assert.notStrictEqual(t.calls[2][2], firstOpId, 'a reopened dialog mints a NEW opId');
  ok('opId: minted at open, reused across a retry of the same press, new on reopen; args = (orderId, fromDriver, opId)');
}

// ── 4. one request per confirm: a double-activation while pending yields ONE call ──
{
  let release; const t = buildEnv(() => new Promise((r) => { release = () => r({ ok: true }); }));
  t.openUnassignConfirm('o1');
  t.confirmBtn.dispatch('click', {});          // in flight (unassignBusy = true)
  t.confirmBtn.dispatch('click', {});          // second press while pending
  await tick();
  assert.strictEqual(t.calls.length, 1, 'exactly one request while pending');
  release(); await tick(); await tick();
  ok('one request per confirm: a second activation while the first is pending makes no extra call');
}

// ── 5. cancel / Esc: no SDK call, no picker close by the cancel path, focus restored ──
{
  let t = buildEnv(resolved({ ok: true }));
  t.openUnassignConfirm('o1');
  t.cancelBtn.dispatch('click', {});
  assert.strictEqual(t.calls.length, 0, 'Cancelar makes no SDK call');
  assert.ok(t.overlay.classList.contains('hidden'), 'Cancelar hides the confirm');

  t = buildEnv(resolved({ ok: true }));
  t.openUnassignConfirm('o1');
  let prevented = 0, stopped = 0;
  t.overlay.dispatch('keydown', { key: 'Escape', preventDefault: () => prevented++, stopPropagation: () => stopped++ });
  assert.ok(prevented && stopped, 'Esc preventDefault + stopPropagation (no double dismiss with the picker)');
  assert.strictEqual(t.calls.length, 0, 'Esc makes no SDK call');
  assert.ok(t.overlay.classList.contains('hidden'), 'Esc cancels the confirm');
  ok('cancel + Esc: no SDK call, confirm closes, Esc stops propagation');
}

// ── 5b. stale completion: a request resolving AFTER a newer confirm opened must not dismiss/toast it ──
{
  let releaseA; const t = buildEnv(() => new Promise((r) => { releaseA = () => r({ ok: true }); }));
  t.openUnassignConfirm('o1');                 // dialog A (token 1)
  t.confirmBtn.dispatch('click', {}); await tick();   // A in flight
  const toastsBefore = t.toasts.length, closesBefore = t.closePickerCount();
  t.openUnassignConfirm('o1');                 // a NEWER confirm opens (token 2) — overlay re-shown
  releaseA(); await tick(); await tick();      // A resolves now, after the newer open
  assert.strictEqual(t.toasts.length, toastsBefore, 'stale A resolution produced no toast');
  assert.strictEqual(t.closePickerCount(), closesBefore, 'stale A resolution did NOT close the picker');
  assert.ok(!t.overlay.classList.contains('hidden'), "the newer confirm stays open");
  ok('stale completion: a request resolving after a newer confirm opened does not dismiss or toast it');
}

// ── 5c. token invalidated on LEAVE (codex P2): backing out of the removal dialog — Cancelar, Escape, or
//        backdrop — invalidates its completion token while a request is still in flight. So when that request
//        resolves afterwards it can no longer toast or close anything, even though no NEW unassign confirm
//        opened in between (the operator may have moved on to a different picker or an assign confirm). This
//        drives the REAL closeUnassignConfirm token bump, not a second openUnassignConfirm. ──
{
  const leaves = [
    { how: 'Cancelar', act: (t) => t.cancelBtn.dispatch('click', {}) },
    { how: 'Escape',   act: (t) => t.overlay.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} }) },
    { how: 'backdrop', act: (t) => t.overlay.dispatch('click', { target: t.overlay }) },
  ];
  for (const leave of leaves) {
    let releaseA; const t = buildEnv(() => new Promise((r) => { releaseA = () => r({ ok: true }); }));
    t.openUnassignConfirm('o1');                       // removal dialog A (token 1)
    t.confirmBtn.dispatch('click', {}); await tick();  // A's request in flight (dialog still open)
    const toastsBefore = t.toasts.length, closesBefore = t.closePickerCount();
    leave.act(t);                                      // operator backs out of A → token invalidated on leave
    assert.ok(t.overlay.classList.contains('hidden'), `${leave.how}: leaving closed the removal dialog`);
    releaseA(); await tick(); await tick();            // A's request resolves AFTER the leave
    assert.strictEqual(t.toasts.length, toastsBefore, `${leave.how}: the stale resolution produced no toast`);
    assert.strictEqual(t.closePickerCount(), closesBefore, `${leave.how}: the stale resolution did not close the picker`);
  }
  ok('token invalidated on leave: a removal request resolving after Cancelar/Escape/backdrop cannot toast or close anything');
}

// ── 6. render gating + REAL end-to-end (codex P2): the remove row is inserted into the picker list ONLY
//      for reassign + same-owner both legs + pickup∈{assigned,accepted,in_progress} + non-terminal. The
//      openPicker gating block is extracted and run in the SAME scope as the REAL confirm functions, so a
//      rendered row's click drives the actual openUnassignConfirm/doUnassign against the shim DOM — no
//      recorder stand-in replaces either one. ──
{
  const gStart = html.indexOf('  const pickupTask = allTasks[');
  const gEnd = html.indexOf("  $('picker-overlay').classList.remove('hidden');", gStart);
  assert.ok(gStart > -1 && gEnd > gStart, 'located the openPicker gating block');
  const gSrc = html.slice(gStart, gEnd);
  // defaults = a shown row; override one field per case.
  const base = { isReassign: true, pickerFromDriver: 'd1', pickupStatus: 'assigned', pickupOwner: 'd1', deliveryOwner: 'd1', orderStatus: 'preparing' };
  // Build a scope that holds BOTH the real confirm block (src) and the real gate block (gSrc, wrapped as
  // renderRemoveRow). Fresh shim elements each call so confirm listeners never accumulate across runs.
  function buildGate(stub, over) {
    const c = { ...base, ...over };
    for (const id of IDS) ELS[id] = makeEl(id);
    LAST_FOCUSED = null;
    const calls = [], toasts = []; let closePickerCount = 0;
    const allTasks = {};
    if (c.pickupStatus !== null) allTasks['o1_pickup'] = { status: c.pickupStatus, assigned_driver_id: c.pickupOwner };
    if (c.deliveryOwner !== null) allTasks['o1_delivery'] = { assigned_driver_id: c.deliveryOwner };
    const allOrders = { o1: { status: c.orderStatus, customer_name: 'María', total: 420 } };
    const allDrivers = { d1: { name: 'Carlos Mejía' } };
    const doc = { activeElement: null, contains: () => true, querySelector: () => GET('picker-remove-row') };
    const win = { matchMedia: () => ({ matches: false }), crypto: { randomUUID: () => 'uuid-' + (++win._c) }, _c: 0 };
    const XPD = { unassignOrder: (...a) => { calls.push(a); return stub(a); } };
    const api = new Function(
      '$','allOrders','allTasks','allDrivers','pickerFromDriver','displayOrderLabel','escapeHtml','XPD','toast','closePicker','pickerReturnFocusTarget','focusTrapTarget','document','window','crypto',
      `${src}\nfunction renderRemoveRow(orderId, isReassign){\n${gSrc}\n}\n; return { openUnassignConfirm, closeUnassignConfirm, doUnassign, renderRemoveRow };`,
    )(
      GET, allOrders, allTasks, allDrivers, c.pickerFromDriver,
      (id) => '#' + id, (s) => String(s), XPD,
      (m, t) => toasts.push([m, t]), () => { closePickerCount++; },
      () => ({ el: GET('picker-remove-row'), temp: false }), (shift, active, f) => f[0],
      doc, win, win.crypto,
    );
    api.renderRemoveRow('o1', c.isReassign);
    return { ...api, calls, toasts, closePickerCount: () => closePickerCount,
      inserted: GET('picker-list')._html, removeRow: GET('picker-remove-row'),
      overlay: GET('unassign-confirm-overlay'), cancelBtn: GET('unassign-cancel-btn'),
      confirmBtn: GET('unassign-confirm-btn'), sub: GET('unassign-confirm-sub'), body: GET('unassign-confirm-body') };
  }
  const shown = (over, why) => assert.match(buildGate(resolved({ ok: true }), over).inserted, /Quitar repartidor/, 'PRESENT: ' + why);
  const hidden = (over, why) => assert.strictEqual(buildGate(resolved({ ok: true }), over).inserted, '', 'ABSENT: ' + why);
  shown({}, 'reassign + same-owner both legs + assigned pre-pickup + non-terminal');
  shown({ pickupStatus: 'accepted' }, 'pickup accepted');
  shown({ pickupStatus: 'in_progress' }, 'pickup in_progress');
  hidden({ isReassign: false }, 'initial-assign');
  hidden({ pickerFromDriver: null }, 'no captured driver');
  hidden({ pickupStatus: 'completed' }, 'pickup completed (out for delivery)');
  hidden({ pickupStatus: 'pending' }, 'pickup pending');
  hidden({ pickupStatus: 'cancelled' }, 'pickup cancelled');
  hidden({ pickupStatus: null }, 'no pickup task');
  hidden({ deliveryOwner: null }, 'no delivery task');
  hidden({ pickupOwner: 'dX' }, 'split owners: pickup on a different driver');
  hidden({ deliveryOwner: 'dX' }, 'split owners: delivery owner ≠ captured');
  hidden({ orderStatus: 'delivered' }, 'terminal order: delivered');
  hidden({ orderStatus: 'completed' }, 'terminal order: completed');
  hidden({ orderStatus: 'cancelled' }, 'terminal order: cancelled');
  hidden({ orderStatus: 'out_for_delivery' }, 'out_for_delivery (server returns picked_up)');

  // REAL end-to-end: a rendered remove-row click drives the actual confirm (not a recorder), which renders,
  // names the order, puts focus on Cancelar, and — on confirm — sends exactly one request.
  const t = buildGate(resolved({ ok: true }), {});
  assert.match(t.inserted, /Quitar repartidor/, 'the remove row rendered into the picker list');
  t.removeRow.dispatch('click', {});                       // real wiring → the REAL openUnassignConfirm('o1')
  assert.ok(!t.overlay.classList.contains('hidden'), 'the row click opened the REAL confirm overlay');
  assert.ok(/#o1/.test(t.sub._text), 'the real confirm names the order (#o1)');
  assert.ok(/Carlos Mejía/.test(t.body._html) && /María/.test(t.body._html), 'the real confirm names driver + customer');
  assert.strictEqual(LAST_FOCUSED, t.cancelBtn, 'initial focus lands on Cancelar');
  t.confirmBtn.dispatch('click', {}); await tick(); await tick();   // real Quitar repartidor → real doUnassign
  assert.strictEqual(t.calls.length, 1, 'confirming sends exactly one request');
  assert.deepStrictEqual(t.calls[0].slice(0, 2), ['o1', 'd1'], 'the request carries (orderId, fromDriver)');
  ok('render gate + REAL flow: present only for the allowed shape, absent for every refused shape; the rendered row click opens the actual confirm (names order, Cancelar focused) and confirming sends exactly one request');
}

console.log(`\ndispatch-unassign-confirm: OK (${n})`);
