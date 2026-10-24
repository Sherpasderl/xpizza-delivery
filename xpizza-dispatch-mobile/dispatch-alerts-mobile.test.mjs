import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyAlert, driverProblemContent, driverProblemReasonLabel } from './dispatch-alerts.js';
import { h0DismissUpdate } from './dispatch-h0-dismiss.js';

// Mobile driver «Problema» alerts surface: the driver_problem-ONLY filter, the row render (violet order
// cue + shared content), tap→fetch navigation, sheet-ownership discipline, the scoped dismiss, and a
// byte-identical proof that extracting the shared builder left the DESKTOP alertContent output unchanged
// vs c8b08cf1 (F's approved base).

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));

// ── pure shared builder (import) ─────────────────────────────────────────────
test('classifyAlert({type:"driver_problem"}) → amber + known', () => {
  const c = classifyAlert({ type: 'driver_problem' });
  assert.equal(c.severity, 'amber');
  assert.equal(c.known, true);
  assert.equal(c.category, 'driver-problem');
});

test('driverProblemContent: all 6 reasons, note/no-note, unknown→Otro, driver fallback, XSS', () => {
  const deps = { label: (ord) => '#' + ((ord && typeof ord === 'object') ? ord.display_number : ord), resolveDriverName: (a) => a.driver_name || 'Un repartidor', escapeHtml };
  for (const reason of ['waiting_restaurant', 'not_ready_incomplete', 'customer_no_answer', 'address_not_found', 'restaurant_closed', 'other']) {
    const out = driverProblemContent({ type: 'driver_problem', order_id: 'o', display_number: 7, reason, driver_name: 'Ana', note: 'x' }, deps);
    assert.equal(out.title, 'Problema con el pedido');
    assert.ok(out.detail.includes(driverProblemReasonLabel(reason)), `reason ${reason} label present`);
    assert.ok(out.detail.endsWith(' — x'), 'note tail present');
  }
  assert.ok(driverProblemContent({ reason: 'bogus', note: '' }, deps).detail.includes('Otro'), 'unknown reason → Otro');
  assert.ok(!driverProblemContent({ reason: 'other' }, deps).detail.includes(' — '), 'no note → no tail');
  assert.ok(driverProblemContent({ reason: 'other', driver_name: '<b>x</b>', note: '<i>n</i>' }, deps).detail.includes('&lt;b&gt;x&lt;/b&gt;'), 'driver name escaped');
  assert.ok(driverProblemContent({ reason: 'other', note: '<i>n</i>' }, deps).detail.includes('&lt;i&gt;n&lt;/i&gt;'), 'note escaped');
});

// ── byte-identical desktop proof vs c8b08cf1 ─────────────────────────────────
test('desktop alertContent(driver_problem) is byte-identical to c8b08cf1 after the extraction', () => {
  const cur = readFileSync(join(here, '..', 'xpizza-dispatch', 'index.html'), 'utf8');
  const base = execSync('git show c8b08cf1:xpizza-dispatch/index.html', { cwd: here, maxBuffer: 64 * 1024 * 1024 }).toString();
  const lift = (src, name) => { const at = src.indexOf(`function ${name}(`); let i = src.indexOf('{', at), d = 0, e = i; for (; e < src.length; e++) { if (src[e] === '{') d++; else if (src[e] === '}') { d--; if (!d) break; } } return src.slice(at, e + 1); };
  const mk = (src, withBuilder) => new Function('escapeHtml', 'allOrders', 'allDrivers', 'driverProblemReasonLabel', 'driverProblemContent',
    `${lift(src, 'displayOrderLabel')}; ${lift(src, 'alertContent')}; return alertContent;`)(escapeHtml, {}, { d1: { name: 'DrvFallback' } }, driverProblemReasonLabel, withBuilder ? driverProblemContent : undefined);
  const curFn = mk(cur, true), baseFn = mk(base, false);
  let n = 0;
  for (const reason of ['waiting_restaurant', 'not_ready_incomplete', 'customer_no_answer', 'address_not_found', 'restaurant_closed', 'other', 'bogus']) {
    for (const note of [undefined, '', 'nota con <xss>', 'ñ']) {
      for (const name of [{ driver_name: 'Carlos' }, { driver_uid: 'd1' }, {}]) {
        for (const dn of [{ display_number: 42 }, {}]) {
          const a = { type: 'driver_problem', order_id: 'o_1', reason, note, ...name, ...dn };
          assert.deepEqual(curFn(a), baseFn(a), `mismatch for ${JSON.stringify(a)}`);
          n++;
        }
      }
    }
  }
  assert.ok(n >= 150, `ran a real matrix (${n})`);
});

// ── the mobile alert block (extracted + run) ─────────────────────────────────
const blockSrc = html.slice(html.indexOf('const AL_BELL ='), html.indexOf('\nfunction openSheet(html){'));
function harness(opts = {}) {
  const calls = { openDetail: [], toast: [], dismiss: [] };
  const sheetBody = { innerHTML: '' }, slot = { innerHTML: '' };
  const $ = (id) => (id === 'sheet-body' ? sheetBody : id === 'alerts-slot' ? slot : { innerHTML: '' });
  const STORE = opts.STORE || { orders: {}, scheduled: {}, drivers: {} };
  const openSheet = (h) => { sheetBody.innerHTML = h; };
  const openDetail = (id, fetched) => calls.openDetail.push({ id, fetched });
  const toast = (m, bad) => calls.toast.push({ m, bad });
  const XPD = { fetchOrderById: opts.fetchOrderById || (async () => ({ ok: true, order: { order_id: 'o' } })), dismissDispatcherAlert: async (id, rec) => { calls.dismiss.push({ id, rec }); } };
  const api = new Function('driverProblemContent', 'escapeHtml', 'STORE', '$', 'openSheet', 'openDetail', 'toast', 'XPD',
    `let alertsList=[], alertsSheetOwner=false, alertNavToken=0;\n${blockSrc}\n; return { set:(l)=>{alertsList=l;}, owner:(v)=>{alertsSheetOwner=v;}, bumpNav:()=>{alertNavToken+=1;}, buildAlerts, alertRow, alertsSheetHtml, renderAlertsPill, renderAlertsSheet, openOrderFromAlert };`)(
    driverProblemContent, escapeHtml, STORE, $, openSheet, openDetail, toast, XPD);
  return { api, calls, sheetBody, slot, STORE };
}

test('buildAlerts filters to driver_problem ONLY, newest first', () => {
  const { api } = harness();
  const raw = {
    a: { type: 'driver_problem', order_id: 'o1', created_at: 100 },
    b: { type: 'no_drivers_available', order_id: 'o2', created_at: 999 },   // excluded
    c: { type: 'driver_problem', order_id: 'o3', created_at: 300 },
    d: { kind: 'factura_x' },                                               // type-less, excluded
    e: { type: 'payment_reconcile_breaches' },                             // excluded
  };
  const out = api.buildAlerts(raw);
  assert.deepEqual(out.map((r) => r.id), ['c', 'a'], 'only driver_problem, newest first');
  assert.deepEqual(api.buildAlerts({ x: { type: 'no_drivers_available' } }), [], 'unsupported-only → empty');
  assert.deepEqual(api.buildAlerts({}), [], 'empty → empty');
});

test('alertRow: violet order number, shared reason label, driver, note, and dismiss id', () => {
  const { api } = harness({ STORE: { orders: {}, scheduled: {}, drivers: { d9: { name: 'Daniela Castro' } } } });
  const row = api.alertRow({ id: 'driver_problem_o1187_p', alert: { type: 'driver_problem', order_id: 'o1187', display_number: 1187, reason: 'not_ready_incomplete', driver_uid: 'd9', note: 'La cocina dice 15 min' } });
  assert.match(row, /<b>Problema con el pedido<\/b>/);
  assert.match(row, /<em class="num">#1187<\/em>/, 'violet order number');
  assert.ok(row.includes('El pedido no está listo o está incompleto'), 'shared reason label');
  assert.ok(row.includes('Daniela Castro') && row.includes('— La cocina dice 15 min'), 'driver + note');
  assert.match(row, /data-alert-order="o1187"/);
  assert.match(row, /data-alert-dismiss="driver_problem_o1187_p"/);
});

test('renderAlertsPill: shows the count only when ≥1; empty at zero', () => {
  const h = harness();
  h.api.set([{ id: 'a', alert: { type: 'driver_problem' } }, { id: 'b', alert: { type: 'driver_problem' } }]);
  h.api.renderAlertsPill();
  assert.match(h.slot.innerHTML, /data-alerts="1"[^>]*aria-label="Alertas: 2"/);
  assert.match(h.slot.innerHTML, />2\s*<\/button>/);
  h.api.set([]); h.api.renderAlertsPill();
  assert.equal(h.slot.innerHTML, '', 'hidden at zero (element absent)');
});

test('renderAlertsSheet refreshes ONLY while Alertas owns the sheet', () => {
  const h = harness();
  h.api.set([{ id: 'a', alert: { type: 'driver_problem', order_id: 'o', display_number: 1, reason: 'other' } }]);
  h.sheetBody.innerHTML = '<other-sheet>';
  h.api.owner(false); h.api.renderAlertsSheet();
  assert.equal(h.sheetBody.innerHTML, '<other-sheet>', 'another sheet is NOT replaced by an alert update');
  h.api.owner(true); h.api.renderAlertsSheet();
  assert.match(h.sheetBody.innerHTML, /Alertas/, 'refreshed in place when Alertas owns it');
});

test('openOrderFromAlert: present→openDetail; pruned→fetch→openDetail(fetched); not-found & read-fail toast; late result dropped', async () => {
  // present
  let h = harness({ STORE: { orders: { o1: { order_id: 'o1' } }, scheduled: {}, drivers: {} } });
  h.api.openOrderFromAlert('o1');
  assert.deepEqual(h.calls.openDetail, [{ id: 'o1', fetched: undefined }], 'present order opens directly');
  // pruned → fetch → openDetail(fetched)
  h = harness({ fetchOrderById: async () => ({ ok: true, order: { order_id: 'oX', total: 9 } }) });
  await h.api.openOrderFromAlert('oX'); await new Promise((r) => setTimeout(r));
  assert.equal(h.calls.openDetail.length, 1); assert.equal(h.calls.openDetail[0].fetched.total, 9, 'opened with the fetched order');
  // not found
  h = harness({ fetchOrderById: async () => ({ ok: true, order: null }) });
  h.api.openOrderFromAlert('oY'); await new Promise((r) => setTimeout(r));
  assert.ok(h.calls.toast.some((t) => /no encontrado/i.test(t.m)) && h.calls.openDetail.length === 0, 'not-found toast, no open');
  // read fail
  h = harness({ fetchOrderById: async () => ({ ok: false }) });
  h.api.openOrderFromAlert('oZ'); await new Promise((r) => setTimeout(r));
  assert.ok(h.calls.toast.some((t) => /reintentá/i.test(t.m)) && h.calls.openDetail.length === 0, 'read-fail toast, no open');
  // late result: a newer sheet action bumps the token during the fetch → the stale result does not open
  let release; h = harness({ fetchOrderById: () => new Promise((r) => { release = () => r({ ok: true, order: { order_id: 'oL' } }); }) });
  h.api.openOrderFromAlert('oL');
  h.api.bumpNav();                 // a newer sheet opened/closed while the fetch was pending
  release(); await new Promise((r) => setTimeout(r));
  assert.equal(h.calls.openDetail.length, 0, 'a late fetch result does not replace the newer sheet');
});

// ── dismiss removes ONLY that alert (real dismissDispatcherAlert over a stub db) ─
test('dismissDispatcherAlert(driver_problem) removes only that alert; orders/tasks/report untouched', async () => {
  const sdk = readFileSync(join(here, 'xpizza-delivery.js'), 'utf8');
  const src = sdk.slice(sdk.indexOf('export async function dismissDispatcherAlert('), sdk.indexOf('\n}', sdk.indexOf('export async function dismissDispatcherAlert(')) + 2).replace('export ', '');
  const root = { dispatcher_alerts: { A: { type: 'driver_problem' }, B: { type: 'no_drivers_available' } }, orders: { o1: { x: 1 } }, tasks: { t1: {} }, driver_problems: { o1: { p1: { reason: 'other' } } } };
  const getP = (p) => p.split('/').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), root);
  const delP = (p) => { const ks = p.split('/').filter(Boolean); let o = root; for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]]; delete o[ks[ks.length - 1]]; };
  const db = {};
  const ref = (_db, p = '') => ({ _p: p });
  const remove = async (r) => delP(r._p);
  const fbUpdate = async () => { throw new Error('driver_problem must take the remove() path, not h0 durable update'); };
  const dismiss = new Function('db', 'ref', 'remove', 'fbUpdate', 'h0DismissUpdate', `${src}; return dismissDispatcherAlert;`)(db, ref, remove, fbUpdate, h0DismissUpdate);
  await dismiss('A', { type: 'driver_problem' });
  assert.deepEqual(Object.keys(root.dispatcher_alerts), ['B'], 'only alert A removed');
  assert.deepEqual(root.orders, { o1: { x: 1 } }, 'orders untouched');
  assert.deepEqual(root.tasks, { t1: {} }, 'tasks untouched');
  assert.deepEqual(root.driver_problems, { o1: { p1: { reason: 'other' } } }, 'the original report untouched');
});
