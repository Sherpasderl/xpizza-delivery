import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isPostPickup, assignedDriverId } from './board-model.js';

// Executed UI tests (mobile): the REAL openPicker guard and the REAL deactivation-remedy render,
// extracted from index.html and run over stubs. Proves (P2-2) a post-pickup reassign refuses AND
// closes any open sheet, and (P2-1) the remedy no longer crashes and picks a PRE-pickup order.

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');
const sliceFn = (sig, end = '\n}') => { const s = html.indexOf(sig); assert.ok(s > -1, `${sig} present`); return html.slice(s, html.indexOf(end, s) + end.length); };
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));

// ── openPicker guard (P2-2) ──────────────────────────────────────────────────
function runOpenPicker(STORE) {
  const calls = { toast: [], closeSheet: 0, openSheet: 0 };
  const deps = {
    STORE, isPostPickup, assignedDriverId, escapeHtml, IC_BACK: '',
    toast: (m) => calls.toast.push(m), closeSheet: () => { calls.closeSheet++; }, openSheet: () => { calls.openSheet++; },
    HUBS: { x_pizza: {} }, driverPickList: () => [], fmtDist: () => '', driverColorVar: () => '#000',
    DRIVER_STATUS_ES: {}, XPD: { isStalePing: () => false, DRIVER_STATUS: { OFF_SHIFT: 'off_shift' } },
  };
  const names = Object.keys(deps);
  const body = `let pickerFromDriver=null, pickerIsReassign=false;\n${sliceFn('function openPicker(orderId){')}\n; return openPicker;`;
  // eslint-disable-next-line no-new-func
  const openPicker = new Function(...names, body)(...names.map((n) => deps[n]));
  return { openPicker, calls };
}

test('openPicker: a post-pickup reassign refuses, closes the sheet, and opens no picker', () => {
  const STORE = {
    drivers: { d1: { name: 'Uno' } }, scheduled: {},
    orders: { oPost: { order_id: 'oPost', order_type: 'delivery', status: 'out_for_delivery', picked_up_at: 1, customer_name: 'M' } },
    tasks: { oPost_delivery: { assigned_driver_id: 'd1', status: 'accepted' }, oPost_pickup: { assigned_driver_id: 'd1', status: 'completed' } },
  };
  const { openPicker, calls } = runOpenPicker(STORE);
  openPicker('oPost');
  assert.ok(calls.toast.some((m) => /recogió/.test(m)), 'shows the picked_up copy');
  assert.equal(calls.closeSheet, 1, 'closes any open sheet (the «Elegir otro» stale-confirm case)');
  assert.equal(calls.openSheet, 0, 'no picker opened');
});

test('openPicker: a pre-pickup reassign opens the picker (unchanged)', () => {
  const STORE = {
    drivers: { d1: { name: 'Uno' } }, scheduled: {},
    orders: { oPre: { order_id: 'oPre', order_type: 'delivery', status: 'preparing', customer_name: 'R' } },
    tasks: { oPre_delivery: { assigned_driver_id: 'd1', status: 'accepted' }, oPre_pickup: { assigned_driver_id: 'd1', status: 'accepted' } },
  };
  const { openPicker, calls } = runOpenPicker(STORE);
  openPicker('oPre');
  assert.equal(calls.openSheet, 1, 'picker opened for a pre-pickup order');
  assert.equal(calls.closeSheet, 0, 'no premature close');
});

// ── deactivation remedy (P2-1 crash fix + pre-pickup selection) ───────────────
function runRemedy(orders, tasks) {
  const el = () => ({ addEventListener() {} });
  const bodyEl = { innerHTML: '' };
  const deps = {
    MDRA: { sel: 'u1', recs: { u1: { status: 'suspended' } }, cash: null, cashErr: null, attested: false, view: 'deactivate' },
    mdraDeriveState: () => 'suspended', isPostPickup, escapeHtml, STORE: { orders, scheduled: {} },
    fbGet: async (r) => ({ val: () => (r._p === 'tasks' ? tasks : { active: false }) }),
    ref: (_db, p) => ({ _p: p }), XPD: { getDb: () => ({}) },
    mdraLatestCuadre: () => null, mdraCashDisplay: () => ({ available: false, text: '—' }),
    mdraBlockers: () => [], mdraName: () => 'Uno', mdraRender: () => {}, mdraClose: () => {},
    openPicker: () => {}, $: () => el(),
  };
  const names = Object.keys(deps);
  const src = sliceFn('async function mdraDeactivate(body) {');
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `${src}\n; return mdraDeactivate;`)(...names.map((n) => deps[n]));
  return fn(bodyEl).then(() => bodyEl.innerHTML);
}

test('deactivation remedy: no crash, and «Reasignar» targets a PRE-pickup order', async () => {
  const tasks = { oPre_delivery: { assigned_driver_id: 'u1', status: 'accepted', order_id: 'oPre' }, oPost_delivery: { assigned_driver_id: 'u1', status: 'accepted', order_id: 'oPost' }, oPost_pickup: { assigned_driver_id: 'u1', status: 'completed', order_id: 'oPost' } };
  const orders = { oPre: { order_id: 'oPre', status: 'preparing', order_type: 'delivery' }, oPost: { order_id: 'oPost', status: 'out_for_delivery', order_type: 'delivery' } };
  const out = await runRemedy(orders, tasks);   // must not throw (tasks hoisted to function scope)
  assert.match(out, /id="mdra-reasignar" data-oid="oPre"/, 'the remedy link targets the PRE-pickup order');
  assert.doesNotMatch(out, /data-oid="oPost"/, 'never the post-pickup order');
});

test('deactivation remedy: all open orders post-pickup → no «Reasignar» link', async () => {
  const tasks = { oPost_delivery: { assigned_driver_id: 'u1', status: 'accepted', order_id: 'oPost' }, oPost_pickup: { assigned_driver_id: 'u1', status: 'completed', order_id: 'oPost' } };
  const orders = { oPost: { order_id: 'oPost', status: 'out_for_delivery', order_type: 'delivery' } };
  const out = await runRemedy(orders, tasks);
  assert.doesNotMatch(out, /mdra-reasignar/, 'no reassign remedy when nothing is pre-pickup (driver has the food)');
});
