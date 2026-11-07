import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// "Quitar repartidor" — MOBILE Torre, REAL wiring (codex P1-2). Extracts the real openSheet / closeSheet,
// the real Esc + Tab keydown handlers, the real openUnassignConfirm + commitUnassign, the real document
// click DELEGATION, and the real openPicker gating block from index.html, and runs them together in one
// scope against a DOM shim. Nothing load-bearing is stubbed: the token bump lives in the real openSheet /
// closeSheet, the delegation's closest() honors its selector, and a rendered remove-row click drives the
// actual confirm. XPD.unassignOrder is stubbed to the frozen server contract; assign/reassign routing is
// recorded so the real handler's branch selection stays genuine. No jsdom, no new external harness —
// buttons are parsed out of the rendered innerHTML so every assertion originates from real rendered markup.
const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

// ── extract the real source spans ───────────────────────────────────────────
const sheetSpan = html.slice(html.indexOf('function openSheet(html){'), html.indexOf('\nlet _toastT;'));
assert.ok(sheetSpan.includes('function closeSheet(){') && sheetSpan.includes("e.key !== 'Tab'"), 'sheet span has openSheet/closeSheet + keydown handlers');

const cStart = html.indexOf('function openUnassignConfirm(orderId){');
const cEnd = html.indexOf('\n\n// ── settings ──', cStart) > -1 ? html.indexOf('\n\n// ── settings ──', cStart)
          : html.indexOf('\nfunction openSettings(', cStart);
const confirmSrc = html.slice(cStart, cEnd);
assert.ok(cStart > -1 && confirmSrc.includes('async function commitUnassign'), 'located mobile confirm block');

const dStart = html.indexOf("document.addEventListener('click', (e) => {");
const dEnd = html.indexOf('\n});\n', dStart) + 3;
const delegationStmt = html.slice(dStart, dEnd);
assert.ok(dStart > -1 && delegationStmt.includes('ds.unassign') && delegationStmt.includes('ds.unassignCommit'), 'located the real click delegation');

const gStart = html.indexOf('  const pickupTask = STORE.tasks[');
const gEnd = html.indexOf('\n\n  openSheet(', gStart);
const gateSrc = html.slice(gStart, gEnd);
assert.ok(gStart > -1 && gEnd > gStart && gateSrc.includes('removeBlock'), 'located mobile gating block');

const cfStart = html.indexOf('function openConfirm(orderId, driverId){');
const cfEnd = html.indexOf('\n}', cfStart) + 2;
const openConfirmSrc = html.slice(cfStart, cfEnd);
assert.ok(cfStart > -1 && openConfirmSrc.includes('data-commit=') && openConfirmSrc.includes('openSheet('), 'located the real openConfirm (reassign confirm renderer)');

// ── the app harness: real code over a parsed-button DOM shim ─────────────────
const DEFAULT_STORE = () => ({
  orders: { o1: { customer_name: 'María', status: 'preparing' } },
  scheduled: {},
  drivers: { d1: { name: 'Carlos Mejía' } },
  tasks: { o1_pickup: { status: 'assigned', assigned_driver_id: 'd1' }, o1_delivery: { assigned_driver_id: 'd1' } },
});

function buildApp(stub, opts = {}) {
  const calls = [], toasts = [], picks = [], chooses = [], commits = [];
  const CONNECTED = new Set();
  let ACTIVE = opts.opener || null;
  if (opts.opener) CONNECTED.add(opts.opener);

  // Parse <button> tags out of rendered innerHTML into stable, focusable element stubs. Identity is stable
  // across lookups (cached on the host element) so disabled/focus mutations by the real code are observable.
  function parseButtons(src) {
    const out = [];
    const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
    let m;
    while ((m = re.exec(src))) {
      const raw = {}, dataset = {};
      const ar = /([a-zA-Z][a-zA-Z0-9-]*)(?:="([^"]*)")?/g;
      let a;
      while ((a = ar.exec(m[1]))) {
        const name = a[1], val = a[2] === undefined ? '' : a[2];
        raw[name] = val;
        if (name.startsWith('data-')) dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
      }
      const inner = m[2].replace(/<[^>]*>/g, '').trim();
      const b = {
        tagName: 'BUTTON', dataset, id: raw.id, disabled: 'disabled' in raw, _class: raw.class || '',
        textContent: inner, getAttribute: (k) => raw[k], hasAttribute: (k) => k in raw,
        focus() { ACTIVE = b; },
      };
      out.push(b);
    }
    return out;
  }
  const btns = () => sheetBody._btns;
  function qsel(sel) {
    const list = btns();
    if (sel.includes('[data-detail]')) return list.find((b) => 'detail' in b.dataset) || null;
    if (sel.includes('[data-sheet-focus]')) return list.find((b) => 'sheetFocus' in b.dataset && !b.disabled) || null;
    if (sel.includes('.sh-nav') && sel.includes('[data-pick]') && sel.includes('[data-back]'))
      return list.find((b) => 'pick' in b.dataset && 'back' in b.dataset && b._class.split(' ').includes('back')) || null;
    return list.find((b) => !b.disabled) || null;   // generic "button:not([disabled]), a[href]"
  }
  const qall = () => btns().filter((b) => !b.disabled);

  const mkEl = (id) => {
    const listeners = {};
    const el = {
      id, scrollTop: 0, _html: '', _btns: [], _attrs: {},
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      set innerHTML(v) { this._html = v; this._btns = parseButtons(v); },
      get innerHTML() { return this._html; },
      setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; }, hasAttribute(k) { return k in this._attrs; },
      addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
      dispatch(t, ev) { (listeners[t] || []).forEach((fn) => fn(ev)); },
      contains(node) { return node === el || el._btns.includes(node); },
      querySelector(sel) { return qsel(sel); },
      querySelectorAll() { return qall(); },
    };
    return el;
  };
  const sheet = mkEl('sheet'), sheetBody = mkEl('sheet-body'), scrim = mkEl('scrim'), screen = mkEl('screen-main'), toastEl = mkEl('toast');
  const byId = { sheet, 'sheet-body': sheetBody, scrim, 'screen-main': screen, toast: toastEl };
  const $ = (id) => (id in byId ? byId[id] : (sheetBody._btns.find((b) => b.id === id) || null));

  const docListeners = {};
  const documentShim = {
    addEventListener(t, fn) { (docListeners[t] ||= []).push(fn); },
    querySelector: () => null, querySelectorAll: () => [],
    contains: (node) => CONNECTED.has(node),
    get activeElement() { return ACTIVE; },
    dispatch(t, ev) { (docListeners[t] || []).forEach((fn) => fn(ev)); },
  };

  const STORE = opts.store || DEFAULT_STORE();
  const win = { crypto: { randomUUID: () => 'uuid-' + (++win._c) }, _c: 0 };
  const XPD = {
    unassignOrder: (...a) => { calls.push(a); return stub(a); },
    isStalePing: () => false, DRIVER_STATUS: { OFF_SHIFT: 'off_shift' },
  };
  const setTimeoutStub = opts.immediateFocus ? (fn) => { fn(); } : () => {};
  // deps the REAL openConfirm (reassign confirm renderer) reads — kept minimal; the production navigation it
  // performs (openSheet → token bump) is what the stale-reassign test exercises, not these values.
  const HUBS = { x_pizza: {} };
  const driverPickList = () => [{ id: 'd1', load: 0, distanceM: 900 }, { id: 'd2', load: 0, distanceM: 1200 }];
  const fmtDist = (m) => Math.round(m) + ' m';
  const minutesOf = () => 5;

  // late-bound so openPicker (the real Esc/Cancelar leave target) re-renders a sheet → real openSheet token bump
  let api = null;
  const openPicker = (oid) => { picks.push(oid); if (api) api.openSheet('<div class="sh-nav"><button class="back" data-detail="' + oid + '" data-back="1" aria-label="Atras">x</button></div>'); };
  const commitAssign = (...a) => commits.push(a);

  api = new Function(
    '$', 'STORE', 'escapeHtml', 'driverColorVar', 'IC_BACK', 'IC_PLUS', 'displayLabel', 'XPD', 'toast',
    'document', 'window', 'crypto', 'setTimeout', 'replay', 'openPicker', 'commitAssign',
    'HUBS', 'driverPickList', 'fmtDist', 'minutesOf',
    `let lastFocus = null, sheetDir = null, pickerFromDriver = 'd1', pickerIsReassign = true, alertsSheetOwner = false, alertNavToken = 0;\n`
    + `${sheetSpan}\n${confirmSrc}\n${openConfirmSrc}\n${delegationStmt}\n`
    + `function renderGate(orderId, pickerIsReassign){\n${gateSrc}\n; return removeBlock; }\n`
    + `; return { openUnassignConfirm, commitUnassign, openConfirm, openSheet, closeSheet, renderGate };`,
  )(
    $, STORE, (s) => String(s), () => '#000', '<back/>', '<plus/>', (id) => '#' + id, XPD,
    (m, bad) => toasts.push([m, !!bad]), documentShim, win, win.crypto, setTimeoutStub, () => {},
    openPicker, commitAssign, HUBS, driverPickList, fmtDist, minutesOf,
  );

  const makeTarget = (dataset) => ({
    closest(sel) {
      const keys = sel.split(',').map((s) => s.trim().replace(/^\[data-/, '').replace(/\]$/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
      return keys.some((k) => k in dataset) ? { dataset } : null;
    },
  });
  return {
    ...api, $, sheet, sheetBody, scrim, calls, toasts, picks, chooses, commits,
    get active() { return ACTIVE; }, setActive(el) { ACTIVE = el; }, connect(el) { CONNECTED.add(el); },
    sheetOn: () => sheet.classList.contains('on'),
    fireClick: (dataset) => documentShim.dispatch('click', { target: makeTarget(dataset) }),
    keydown: (ev) => documentShim.dispatch('keydown', ev),
    scrimClick: () => scrim.dispatch('click', {}),
    clearRecorders() { picks.length = chooses.length = commits.length = calls.length = toasts.length = 0; },
  };
}
const resolved = (v) => () => Promise.resolve(v);
const thrown = (msg) => () => { const e = new Error(msg); return Promise.reject(e); };
const tick = () => new Promise((r) => setTimeout(r, 0));

test('mobile confirm fail-safe matrix: each response maps to the right copy + open/close (REAL openSheet/closeSheet)', async () => {
  const run = async (stub) => { const t = buildApp(stub); t.openUnassignConfirm('o1'); await t.commitUnassign('o1'); await tick(); return t; };
  let t = await run(resolved({ ok: true }));
  assert.ok(t.toasts.some(([m]) => /sin asignar — de vuelta en la cola/.test(m)) && !t.sheetOn(), 'ok:true → success + sheet closed');
  t = await run(resolved({ ok: false, reason: 'reassigned' }));
  assert.ok(t.toasts.some(([m]) => m === 'Ese pedido ya tiene otro repartidor') && !t.sheetOn(), 'reassigned → close');
  t = await run(resolved({ ok: false, reason: 'not_assigned' }));
  assert.ok(t.toasts.some(([m]) => m === 'Ese pedido ya no estaba asignado') && !t.sheetOn(), 'not_assigned → close');
  t = await run(resolved({ ok: false, reason: 'picked_up' }));
  assert.ok(t.toasts.some(([m]) => m === 'El repartidor ya recogió el pedido') && !t.sheetOn(), 'picked_up → close');
  t = await run(thrown('terminal'));
  assert.ok(t.toasts.some(([m]) => m === 'El pedido ya se cerró') && !t.sheetOn(), 'terminal → final close');
  t = await run(thrown('state'));
  assert.ok(t.toasts.some(([m]) => m === 'No se puede quitar el repartidor ahora mismo') && t.sheetOn() && t.$('unassign-yes').disabled === false, 'state → re-enable, stays open');
  t = await run(thrown('not_found'));
  assert.ok(t.toasts.some(([m]) => m === 'No se encontró el pedido') && t.sheetOn() && t.$('unassign-yes').disabled === false, 'not_found → re-enable, stays open');
  for (const stub of [thrown('retryable'), thrown('internal'), resolved({}), resolved(null), resolved({ ok: false, reason: 'weird' })]) {
    t = await run(stub);
    assert.ok(t.toasts.some(([m, bad]) => m === 'No se pudo quitar — reintentá' && bad === true) && t.sheetOn() && t.$('unassign-yes').disabled === false, 'else/503/malformed → retry error, stays open');
  }
});

test('mobile opId: minted at open, reused on retry, new on reopen; args (orderId, fromDriver, opId)', async () => {
  const t = buildApp(thrown('retryable'));
  t.openUnassignConfirm('o1');
  await t.commitUnassign('o1'); await tick();
  await t.commitUnassign('o1'); await tick();            // retry same press
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[0][2], t.calls[1][2], 'retry resends the SAME opId');
  assert.deepEqual([t.calls[0][0], t.calls[0][1]], ['o1', 'd1'], 'args orderId, fromDriver');
  const first = t.calls[0][2];
  t.openUnassignConfirm('o1');                            // reopen (real openSheet) mints a new operation
  await t.commitUnassign('o1'); await tick();
  assert.notEqual(t.calls[2][2], first, 'reopen mints a NEW opId');
});

test('mobile one request per confirm: a second activation while pending makes no extra call', async () => {
  let release; const t = buildApp(() => new Promise((r) => { release = () => r({ ok: true }); }));
  t.openUnassignConfirm('o1');
  t.commitUnassign('o1');          // in flight
  t.commitUnassign('o1');          // second while pending
  await tick();
  assert.equal(t.calls.length, 1, 'exactly one request');
  release(); await tick();
});

test('mobile delegation: the REAL document click handler routes every case with a selector-honoring closest()', () => {
  const t = buildApp(resolved({ ok: true }));
  // closest() honors its selector: a dataset key NOT in the delegation selector list matches nothing → no route.
  t.fireClick({ bogus: 'x' });
  assert.deepEqual([t.picks.length, t.chooses.length, t.commits.length, t.calls.length], [0, 0, 0, 0], 'unrelated dataset → closest returns null → no route fires');

  t.fireClick({ pick: 'o1' });
  assert.deepEqual(t.picks, ['o1'], 'data-pick → openPicker (UNCHANGED)');
  t.clearRecorders();

  t.sheetBody.innerHTML = '<button data-detail="o1"></button>';   // the open detail sheet the choose reads its order from
  t.fireClick({ choose: 'd1' });
  assert.match(t.sheetBody.innerHTML, /data-commit="d1"/, 'data-choose → the REAL openConfirm renders the reassign confirm for that driver (assign/reassign path real, not a recorder)');
  t.clearRecorders();

  t.fireClick({ commit: 'd1', order: 'o1' });
  assert.deepEqual(t.commits, [['o1', 'd1']], 'data-commit → commitAssign (the existing mutation UNCHANGED)');
  t.clearRecorders();

  // data-unassign routes to the REAL openUnassignConfirm → the real confirm renders.
  t.fireClick({ unassign: 'o1' });
  assert.ok(t.sheetOn() && /data-unassign-commit="o1"/.test(t.sheetBody.innerHTML) && /Quitar repartidor/.test(t.sheetBody.innerHTML), 'data-unassign → REAL openUnassignConfirm renders the confirm');
  // data-unassign-commit routes to the REAL commitUnassign → exactly one request.
  t.clearRecorders();
  t.fireClick({ unassignCommit: 'o1' });
  assert.equal(t.calls.length, 1, 'data-unassign-commit → REAL commitUnassign sends exactly one request');
});

test('mobile end-to-end: a rendered remove row click drives the actual confirm, then confirming sends one request', async () => {
  const t = buildApp(resolved({ ok: true }), { immediateFocus: true });
  const removeBlock = t.renderGate('o1', true);
  assert.match(removeBlock, /data-unassign="o1"/, 'the gate rendered a remove row for o1');
  const oid = removeBlock.match(/data-unassign="([^"]+)"/)[1];   // originate the click from the REAL rendered markup
  t.fireClick({ unassign: oid });
  assert.ok(t.sheetOn(), 'the row click opened the confirm sheet');
  assert.match(t.sheetBody.innerHTML, /#o1/, 'the real confirm names the order');
  assert.match(t.sheetBody.innerHTML, /Carlos Mejía|Carlos/, 'the real confirm names the current driver');
  assert.match(t.sheetBody.innerHTML, /data-unassign-commit="o1"/, 'the confirm carries the commit CTA');
  assert.ok(t.active && 'sheetFocus' in t.active.dataset && /Cancelar/.test(t.active.textContent), 'initial focus lands on Cancelar (data-sheet-focus)');
  const commitId = t.sheetBody.innerHTML.match(/data-unassign-commit="([^"]+)"/)[1];
  t.fireClick({ unassignCommit: commitId });
  await tick();
  assert.equal(t.calls.length, 1, 'confirming sends exactly one request');
  assert.deepEqual([t.calls[0][0], t.calls[0][1]], ['o1', 'd1'], 'the request carries (orderId, fromDriver)');
});

test('mobile stale completion: a request resolving after a newer confirm opened does not close/toast it (REAL token bump via openSheet)', async () => {
  let releaseA; const t = buildApp(() => new Promise((r) => { releaseA = () => r({ ok: true }); }));
  t.openUnassignConfirm('o1');          // dialog A
  t.commitUnassign('o1'); await tick(); // A in flight
  const closesBefore = t.toasts.length;
  t.openUnassignConfirm('o1');          // a NEWER confirm opens → real openSheet bumps the token
  releaseA(); await tick(); await tick();
  assert.equal(t.toasts.length, closesBefore, 'stale A resolution produced no toast');
  assert.ok(t.sheetOn(), 'the newer confirm stays open');
});

test('mobile stale completion into a REAL reassign confirm: openConfirm navigates (real openSheet bump), the stale removal no-ops', async () => {
  let releaseRemoval; const t = buildApp(() => new Promise((r) => { releaseRemoval = () => r({ ok: true }); }));
  t.openUnassignConfirm('o1');                      // removal confirm (dialog A)
  t.commitUnassign('o1'); await tick();             // A's removal request pending
  const toastsBefore = t.toasts.length;
  t.openConfirm('o1', 'd2');                         // leave → REAL reassign confirm via the REAL openSheet (production navigation, no picker stub)
  assert.match(t.sheetBody.innerHTML, /data-commit="d2"/, 'the reassign confirm rendered (its commit CTA is present)');
  assert.match(t.sheetBody.innerHTML, /Reasignar/, 'the reassign confirm is titled Reasignar');
  releaseRemoval(); await tick(); await tick();      // the stale removal resolves AFTER the reassign confirm opened
  assert.ok(t.sheetOn() && /data-commit="d2"/.test(t.sheetBody.innerHTML), 'the reassign confirm is still open and intact');
  assert.equal(t.toasts.length, toastsBefore, 'no stale toast appeared over the reassign confirm');
});

test('mobile token invalidated on LEAVE: backing out (scrim/Esc) invalidates an in-flight removal (REAL openSheet/closeSheet bump)', async () => {
  // leave via the scrim → the REAL closeSheet (token bump at close)
  {
    let releaseA; const t = buildApp(() => new Promise((r) => { releaseA = () => r({ ok: true }); }));
    t.openUnassignConfirm('o1');
    t.commitUnassign('o1'); await tick();            // in flight
    const toastsBefore = t.toasts.length;
    t.scrimClick();                                  // real closeSheet → token invalidated
    assert.ok(!t.sheetOn(), 'scrim closed the sheet');
    releaseA(); await tick(); await tick();
    assert.equal(t.toasts.length, toastsBefore, 'scrim: the stale resolution produced no toast');
  }
  // leave via Esc → the REAL Esc handler routes back to the picker (openPicker → real openSheet bump), not closeSheet
  {
    let releaseA; const t = buildApp(() => new Promise((r) => { releaseA = () => r({ ok: true }); }));
    t.openUnassignConfirm('o1');
    t.commitUnassign('o1'); await tick();            // in flight
    const toastsBefore = t.toasts.length;
    t.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(t.picks, ['o1'], 'Esc on the confirm returns to the picker (not a whole-sheet close)');
    releaseA(); await tick(); await tick();
    assert.equal(t.toasts.length, toastsBefore, 'Esc: the stale resolution produced no toast');
  }
});

test('mobile a11y (shim-exercised): Cancelar initial focus, Esc→picker, Tab two-way wrap, restore-if-connected', async () => {
  // Cancelar is the initial focus (data-sheet-focus wins over the Atrás nav button) — the REAL openSheet focus pick.
  const opener = { focus() {} };
  const t = buildApp(resolved({ ok: true }), { immediateFocus: true, opener });
  t.setActive(opener);
  t.openUnassignConfirm('o1');
  assert.ok(t.active && 'sheetFocus' in t.active.dataset, 'initial focus is the Cancelar (data-sheet-focus), not Atrás');

  // Esc → openPicker (back to the picker), proven by routing in the leave test above; here assert it is NOT a closeSheet.
  t.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(t.picks, ['o1'], 'Esc returns to the picker via openPicker');

  // Tab two-way wrap, run against the real Tab handler over the real rendered button order [Atrás, Quitar, Cancelar].
  const t2 = buildApp(resolved({ ok: true }), { immediateFocus: true });
  t2.openUnassignConfirm('o1');                       // ACTIVE = Cancelar (last focusable)
  t2.keydown({ key: 'Tab', shiftKey: false, preventDefault() {} });
  assert.equal(t2.active._class.split(' ').includes('back'), true, 'Tab from the last focusable wraps to the first (Atrás)');
  t2.keydown({ key: 'Tab', shiftKey: true, preventDefault() {} });
  assert.ok('sheetFocus' in t2.active.dataset, 'Shift-Tab from the first wraps to the last (Cancelar)');

  // closeSheet restores the opener ONLY if it is still connected — exercise the real document.contains guard.
  const opener2 = { focused: 0, focus() { this.focused++; } };
  const t3 = buildApp(resolved({ ok: true }), { immediateFocus: true, opener: opener2 });
  t3.setActive(opener2);
  t3.openUnassignConfirm('o1');                       // lastFocus = opener2 (connected at open)
  t3.scrimClick();                                    // real closeSheet
  assert.ok(opener2.focused > 0, 'connected opener is refocused on close');

  const opener3 = { focused: 0, focus() { this.focused++; } };
  const t4 = buildApp(resolved({ ok: true }), { immediateFocus: true });
  t4.setActive(opener3);                              // active, but NOT in the connected set
  t4.openUnassignConfirm('o1');
  t4.scrimClick();
  assert.equal(opener3.focused, 0, 'a disconnected opener is NOT refocused (document.contains guard honored)');
});

test('mobile render gate: shown only for reassign + same-owner both legs + pickup∈{assigned,accepted,in_progress} + non-terminal (parity with desktop)', () => {
  const base = { pickerIsReassign: true, pickerFromDriver: 'd1', pickupStatus: 'assigned', pickupOwner: 'd1', deliveryOwner: 'd1', orderStatus: 'preparing' };
  const run = (over) => {
    const c = { ...base, ...over };
    const tasks = {};
    if (c.pickupStatus !== null) tasks['o1_pickup'] = { status: c.pickupStatus, assigned_driver_id: c.pickupOwner };
    if (c.deliveryOwner !== null) tasks['o1_delivery'] = { assigned_driver_id: c.deliveryOwner };
    const STORE = { tasks, orders: { o1: { status: c.orderStatus } }, scheduled: {} };
    return new Function('STORE', 'orderId', 'pickerIsReassign', 'pickerFromDriver', 'escapeHtml', gateSrc + '\n; return removeBlock;')(
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
  hidden({ orderStatus: 'out_for_delivery' }, 'out_for_delivery (server returns picked_up)');
});
