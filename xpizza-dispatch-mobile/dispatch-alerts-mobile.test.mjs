import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyAlert, sortAlertEntries, driverProblemContent, driverProblemReasonLabel } from './dispatch-alerts.js';
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
  const deps = { label: (ord) => 'Pedido #' + ((ord && typeof ord === 'object') ? ord.display_number : ord), resolveDriverName: (a) => a.driver_name || 'Un repartidor', escapeHtml };
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
// The real displayLabel (the order-number fallback alLabel leans on), lifted from source so the P2-3 test
// exercises the ACTUAL short-ID fallback, not a re-implementation.
const displayLabelSrc = html.slice(html.indexOf('function displayLabel('), html.indexOf('\n}', html.indexOf('function displayLabel(')) + 2);
const displayLabel = new Function(`${displayLabelSrc}; return displayLabel;`)();
// The REAL openSheet + closeSheet source (used by the sheet-lifecycle integration test so their own
// ownership/token invalidation is exercised, not a stub).
const sheetFnsSrc = html.slice(html.indexOf('function openSheet(html){'), html.indexOf("\n$('scrim').addEventListener('click', closeSheet);"));
function harness(opts = {}) {
  const calls = { openDetail: [], toast: [], dismiss: [] };
  const slotClasses = new Set();
  const sheetBody = { innerHTML: '' };
  const slot = { innerHTML: '', classList: { toggle: (c, on) => { on ? slotClasses.add(c) : slotClasses.delete(c); }, add: (c) => slotClasses.add(c), remove: (c) => slotClasses.delete(c), contains: (c) => slotClasses.has(c) } };
  const $ = (id) => (id === 'sheet-body' ? sheetBody : id === 'alerts-slot' ? slot : { innerHTML: '' });
  const STORE = opts.STORE || { orders: {}, scheduled: {}, drivers: {} };
  const openSheet = (h) => { sheetBody.innerHTML = h; };
  const openDetail = (id, fetched) => calls.openDetail.push({ id, fetched });
  const toast = (m, bad) => calls.toast.push({ m, bad });
  const XPD = { fetchOrderById: opts.fetchOrderById || (async () => ({ ok: true, order: { order_id: 'o' } })), dismissDispatcherAlert: async (id, rec) => { calls.dismiss.push({ id, rec }); } };
  const api = new Function('classifyAlert', 'sortAlertEntries', 'driverProblemContent', 'escapeHtml', 'displayLabel', 'STORE', '$', 'openSheet', 'openDetail', 'toast', 'XPD',
    `let alertsList=[], alertsSheetOwner=false, alertNavToken=0;\n${blockSrc}\n; return { set:(l)=>{alertsList=l;}, owner:(v)=>{alertsSheetOwner=v;}, bumpNav:()=>{alertNavToken+=1;}, buildAlerts, alertRow, alertsSheetHtml, renderAlertsPill, renderAlertsSheet, openOrderFromAlert };`)(
    classifyAlert, sortAlertEntries, driverProblemContent, escapeHtml, displayLabel, STORE, $, openSheet, openDetail, toast, XPD);
  return { api, calls, sheetBody, slot, STORE, slotHidden: () => slotClasses.has('hidden') };
}

test('buildAlerts filters to driver_problem ONLY, then orders via the shared classify/sort path', () => {
  const { api } = harness();
  const raw = {
    a: { type: 'driver_problem', order_id: 'o1' },
    b: { type: 'no_drivers_available', order_id: 'o2' },   // excluded
    c: { type: 'driver_problem', order_id: 'o3' },
    d: { kind: 'factura_x' },                              // type-less, excluded
    e: { type: 'payment_reconcile_breaches' },            // excluded
  };
  const out = api.buildAlerts(raw);
  assert.deepEqual(out.map((r) => r.id), ['a', 'c'], 'only driver_problem, in the shared sort order (stable within severity)');
  assert.ok(out.every((r) => r.alert && r.category === 'driver-problem' && r.severity === 'amber'), 'rows carry the shared classification (proves the shared path, not a local sorter)');
  assert.deepEqual(api.buildAlerts({ x: { type: 'no_drivers_available' } }).map((r) => r.id), [], 'unsupported-only → empty');
  assert.deepEqual(api.buildAlerts({}).map((r) => r.id), [], 'empty → empty');
});

test('alertRow: violet order number, shared reason label, driver, note, and dismiss id', () => {
  const { api } = harness({ STORE: { orders: {}, scheduled: {}, drivers: { d9: { name: 'Daniela Castro' } } } });
  const row = api.alertRow({ id: 'driver_problem_o1187_p', alert: { type: 'driver_problem', order_id: 'o1187', display_number: 1187, reason: 'not_ready_incomplete', driver_uid: 'd9', note: 'La cocina dice 15 min' } });
  assert.match(row, /<b>Problema con el pedido<\/b>/);
  assert.match(row, /<em class="num">Pedido #1187<\/em>/, 'violet FULL «Pedido #N» order label');
  assert.ok(row.includes('El pedido no está listo o está incompleto'), 'shared reason label');
  assert.ok(row.includes('Daniela Castro') && row.includes('— La cocina dice 15 min'), 'driver + note');
  assert.match(row, /data-alert-order="o1187"/);
  assert.match(row, /data-alert-dismiss="driver_problem_o1187_p"/);
});

test('alLabel (P2-3): alert display_number first, else the live/scheduled order label, NEVER the raw id', () => {
  const emOf = (row) => (row.match(/<em class="num">([^<]*)<\/em>/) || [])[1];
  // (a) no display_number on the alert, but the live order carries one → use the order's number
  const h1 = harness({ STORE: { orders: { long_order_1234: { order_id: 'long_order_1234', display_number: 42 } }, scheduled: {}, drivers: {} } });
  const r1 = h1.api.alertRow({ id: 'dp_1', alert: { type: 'driver_problem', order_id: 'long_order_1234', reason: 'other' } });
  assert.equal(emOf(r1), 'Pedido #42', 'falls back to the live order number');
  assert.ok(!/Pedido #long_order_1234/.test(r1), 'never renders the raw order id as the label');
  // (b) the order is a scheduled one → still resolved
  const h2 = harness({ STORE: { orders: {}, scheduled: { sch_9: { order_id: 'sch_9', display_number: 77 } }, drivers: {} } });
  assert.equal(emOf(h2.api.alertRow({ id: 'dp_2', alert: { type: 'driver_problem', order_id: 'sch_9', reason: 'other' } })), 'Pedido #77', 'scheduled order resolves too');
  // (c) the order is pruned (not in either store) → the short-ID fallback (last 4, upper), never the raw id
  const h3 = harness({ STORE: { orders: {}, scheduled: {}, drivers: {} } });
  assert.equal(emOf(h3.api.alertRow({ id: 'dp_3', alert: { type: 'driver_problem', order_id: 'abcdEFGH', reason: 'other' } })), 'Pedido #EFGH', 'short-ID fallback, not the raw id');
  // (d) a finite display_number on the alert wins directly
  assert.equal(emOf(h3.api.alertRow({ id: 'dp_4', alert: { type: 'driver_problem', order_id: 'o', display_number: 1187, reason: 'other' } })), 'Pedido #1187', 'the alert number wins when present');
});

test('renderAlertsPill: shows the count when ≥1 and collapses the slot out of the header at zero', () => {
  const h = harness();
  h.api.set([{ id: 'a', alert: { type: 'driver_problem' } }, { id: 'b', alert: { type: 'driver_problem' } }]);
  h.api.renderAlertsPill();
  assert.match(h.slot.innerHTML, /data-alerts="1"[^>]*aria-label="Alertas: 2"/);
  assert.match(h.slot.innerHTML, />2\s*<\/button>/);
  assert.equal(h.slotHidden(), false, 'the slot is visible when there are alerts');
  h.api.set([]); h.api.renderAlertsPill();
  assert.equal(h.slot.innerHTML, '', 'no pill markup at zero');
  assert.equal(h.slotHidden(), true, 'the empty slot is collapsed out of the flex header (baseline spacing)');
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

// ── INTEGRATION: the wired paths themselves (fail-on-revert). These run the ACTUAL source statements —
// the __startApp subscription, the onAuth logout branch, and the delegated-click alert branches — so that
// removing any of them (or dropping the dismiss record, or widening the dismiss) turns a test RED. ──

// Extract the inner body of a brace-delimited block whose opener ends with `{` (brace-safe regions only).
function innerBlock(src, marker) {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `source marker present: ${marker}`);
  let i = at + marker.length - 1, depth = 0; const start = i;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) break; } }
  return src.slice(start + 1, i);
}

test('INTEGRATION startup: __startApp wires exactly one driver_problem subscription → buildAlerts + pill + sheet', () => {
  const stmt = (html.match(/alertsUnsub = XPD\.subscribeToDispatcherAlerts\(\(raw\) => \{[^}]*\}\);/) || [])[0];
  assert.ok(stmt, 'the one alert subscription statement is present in __startApp (removing it fails here)');
  const REC = { sub: 0, pill: 0, sheet: 0, built: null };
  const run = new Function('XPD', 'buildAlerts', 'renderAlertsPill', 'renderAlertsSheet', 'REC', `
    let alertsUnsub = null, alertsList = [];
    ${stmt}
    return { unsubFn: alertsUnsub, cb: XPD.__cb };
  `);
  const XPD = { subscribeToDispatcherAlerts: (cb) => { REC.sub++; XPD.__cb = cb; return () => 'torn-down'; } };
  const out = run(XPD, (raw) => { REC.built = raw; return [{ id: 'x', alert: { type: 'driver_problem' } }]; }, () => REC.pill++, () => REC.sheet++, REC);
  assert.equal(REC.sub, 1, 'subscribed exactly once');
  assert.equal(typeof out.unsubFn, 'function', 'the unsubscribe handle is retained for logout teardown');
  out.cb({ a: { type: 'driver_problem' }, b: { type: 'no_drivers_available' } });
  assert.deepEqual(REC.built, { a: { type: 'driver_problem' }, b: { type: 'no_drivers_available' } }, 'the raw snapshot is routed through buildAlerts (the filter)');
  assert.ok(REC.pill >= 1 && REC.sheet >= 1, 'an alert update refreshes the pill and the owned sheet');
});

test('INTEGRATION logout: the onAuth !user branch unsubscribes and resets pill/sheet/nav state', () => {
  const body = innerBlock(html, 'if (!user) {');
  assert.ok(body.includes('alertsUnsub') && body.includes('alertNavToken'), 'extracted the logout branch');
  const REC = { unsubCalls: 0, pill: 0, pillSawLen: -1, shown: null };
  const run = new Function('REC', `
    let started = true;
    let alertsUnsub = () => { REC.unsubCalls++; };
    let alertsList = [{ id: 'a', alert: { type: 'driver_problem' } }];
    let alertsSheetOwner = true;
    let alertNavToken = 0;
    const show = (s) => { REC.shown = s; };
    const renderAlertsPill = () => { REC.pill++; REC.pillSawLen = alertsList.length; };
    (() => {
${body}
    })();
    return { listLen: alertsList.length, owner: alertsSheetOwner, nav: alertNavToken, unsubNulled: alertsUnsub === null, started };
  `);
  const out = run(REC);
  assert.equal(REC.unsubCalls, 1, 'the live subscription is unsubscribed on logout');
  assert.equal(out.unsubNulled, true, 'the handle is nulled so the next sign-in re-subscribes');
  assert.equal(out.listLen, 0, 'the rendered list is cleared');
  assert.equal(out.owner, false, 'sheet ownership is released');
  assert.equal(out.nav, 1, 'the nav token is invalidated so a pending alert fetch is dropped');
  assert.equal(REC.pill, 1, 'the pill is re-rendered (cleared) on logout');
  assert.equal(REC.pillSawLen, 0, 'the pill clears AFTER the list is emptied (no stale count on next sign-in)');
  assert.equal(REC.shown, 'login', 'routed to the login screen');
});

test('INTEGRATION delegated click: the alert selectors route, and dismiss is guarded + passes the record', () => {
  // (1) structural: the delegation selector still lists all three alert hooks (removing any fails here).
  const sel = (html.match(/closest\?\.\('([^']*data-alert[^']*)'\)/) || [])[1];
  assert.ok(sel, 'the delegated click selector is present');
  for (const attr of ['[data-alerts]', '[data-alert-order]', '[data-alert-dismiss]']) assert.ok(sel.includes(attr), `the selector lists ${attr}`);
  // (2) behavioural: run the ACTUAL alert branch lines (order preserved) against a fake dataset.
  const branchLine = (needle) => { const l = html.split('\n').map((s) => s.trim()).find((s) => s.startsWith('if (') && s.includes(needle)); assert.ok(l, `branch present: ${needle}`); return l; };
  const mini = [branchLine('ds.alerts)'), branchLine("'alertOrder' in ds"), branchLine('ds.alertDismiss')].join('\n');
  const run = (ds, s = {}) => new Function('ds', 'openAlertsSheet', 'openOrderFromAlert', 'alertsList', 'XPD', `(() => {\n${mini}\n})();`)(
    ds, s.openAlertsSheet || (() => {}), s.openOrderFromAlert || (() => {}), s.alertsList || [], s.XPD || { dismissDispatcherAlert: () => ({ catch() {} }) });
  // data-alerts → open the sheet
  let opened = 0; run({ alerts: '1' }, { openAlertsSheet: () => { opened++; } });
  assert.equal(opened, 1, 'data-alerts opens the Alertas sheet');
  // data-alert-order → open that order
  let navTo = null; run({ alertOrder: 'o5' }, { openOrderFromAlert: (id) => { navTo = id; } });
  assert.equal(navTo, 'o5', 'data-alert-order opens the tapped order');
  // data-alert-dismiss on a CURRENT row → dismiss(id, RECORD)
  const calls = []; const rec = { type: 'driver_problem', order_id: 'o1' };
  run({ alertDismiss: 'dp_o1_p1' }, { alertsList: [{ id: 'dp_o1_p1', alert: rec }], XPD: { dismissDispatcherAlert: (id, r) => { calls.push({ id, r }); return { catch() {} }; } } });
  assert.equal(calls.length, 1, 'a current row is dismissed');
  assert.equal(calls[0].id, 'dp_o1_p1');
  assert.equal(calls[0].r, rec, 'dismiss passes the alert RECORD, never null (driver_problem → remove() path)');
  // data-alert-dismiss for an id ABSENT from the filtered list → NO write (P2-1 guard)
  const calls2 = [];
  run({ alertDismiss: 'ghost' }, { alertsList: [], XPD: { dismissDispatcherAlert: (id, r) => { calls2.push({ id, r }); return { catch() {} }; } } });
  assert.equal(calls2.length, 0, 'an id absent from the current driver_problem list writes nothing');
});

// INTEGRATION: the REAL openSheet/closeSheet (not a stub) — so their own `alertsSheetOwner = false;
// alertNavToken += 1;` is exercised. Removing either from openSheet or closeSheet must turn this red.
function sheetHarness(opts = {}) {
  const calls = { openDetail: [], toast: [] };
  const mkEl = () => { const cls = new Set(); return { innerHTML: '', scrollTop: 0, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => { on ? cls.add(c) : cls.delete(c); } }, querySelector: () => null, setAttribute: () => {} }; };
  const els = { sheet: mkEl(), 'sheet-body': mkEl(), scrim: mkEl(), 'screen-main': mkEl(), 'alerts-slot': mkEl() };
  const $ = (id) => els[id] || mkEl();
  const STORE = opts.STORE || { orders: {}, scheduled: {}, drivers: {} };
  const openDetail = (id, fetched) => calls.openDetail.push({ id, fetched });
  const toast = (m, bad) => calls.toast.push({ m, bad });
  const XPD = { fetchOrderById: opts.fetchOrderById || (async () => ({ ok: true, order: { order_id: 'o' } })) };
  const documentStub = { activeElement: null, contains: () => false };
  const replay = () => {};
  const api = new Function('classifyAlert', 'sortAlertEntries', 'driverProblemContent', 'escapeHtml', 'displayLabel', 'STORE', '$', 'openDetail', 'toast', 'XPD', 'document', 'replay',
    `let alertsList=[], alertsSheetOwner=false, alertNavToken=0, unassignToken=0, lastFocus=null, sheetDir=null, pickerFromDriver=null, pickerIsReassign=false;
${blockSrc}
${sheetFnsSrc}
; return { setList:(l)=>{alertsList=l;}, openAlertsSheet, renderAlertsSheet, openOrderFromAlert, openSheet, closeSheet, bodyHtml:()=>$('sheet-body').innerHTML, owner:()=>alertsSheetOwner, nav:()=>alertNavToken };`)(
    classifyAlert, sortAlertEntries, driverProblemContent, escapeHtml, displayLabel, STORE, $, openDetail, toast, XPD, documentStub, replay);
  return { api, calls };
}
const tick = () => new Promise((r) => setTimeout(r));

test('INTEGRATION sheet lifecycle: real openSheet/closeSheet release Alertas ownership and invalidate a pending alert fetch', async () => {
  // (1) opening ANOTHER sheet mid-fetch drops the stale alert order result (openSheet bumps alertNavToken)
  let release; let h = sheetHarness({ fetchOrderById: () => new Promise((r) => { release = () => r({ ok: true, order: { order_id: 'oPruned' } }); }) });
  h.api.setList([{ id: 'dp', alert: { type: 'driver_problem', order_id: 'oPruned' } }]);
  h.api.openAlertsSheet();
  h.api.openOrderFromAlert('oPruned');     // pruned → pending fetch, captures the token
  h.api.openSheet('<other-sheet>');        // REAL openSheet → must invalidate the pending fetch's token
  release(); await tick();
  assert.equal(h.calls.openDetail.length, 0, 'openSheet invalidated the in-flight alert fetch (token bump)');

  // (2) closing the sheet mid-fetch also drops the stale result (closeSheet bumps alertNavToken)
  h = sheetHarness({ fetchOrderById: () => new Promise((r) => { release = () => r({ ok: true, order: { order_id: 'oPruned' } }); }) });
  h.api.setList([{ id: 'dp', alert: { type: 'driver_problem', order_id: 'oPruned' } }]);
  h.api.openAlertsSheet();
  h.api.openOrderFromAlert('oPruned');
  h.api.closeSheet();                      // REAL closeSheet → must invalidate the pending fetch's token
  release(); await tick();
  assert.equal(h.calls.openDetail.length, 0, 'closeSheet invalidated the in-flight alert fetch (token bump)');

  // (3) after openSheet takes over, an alert update must NOT overwrite the other sheet (ownership released)
  h = sheetHarness();
  h.api.setList([{ id: 'dp', alert: { type: 'driver_problem', order_id: 'o', display_number: 1, reason: 'other' } }]);
  h.api.openAlertsSheet();
  assert.equal(h.api.owner(), true, 'Alertas owns the sheet after openAlertsSheet');
  h.api.openSheet('<other-sheet>');        // REAL openSheet → must release ownership
  assert.equal(h.api.owner(), false, 'openSheet released Alertas ownership');
  h.api.renderAlertsSheet();               // a concurrent alert update
  assert.equal(h.api.bodyHtml(), '<other-sheet>', 'an alert update does not overwrite another sheet after openSheet');

  // (4) after closeSheet, an alert update must NOT repopulate the closed sheet (ownership released)
  h = sheetHarness();
  h.api.setList([{ id: 'dp', alert: { type: 'driver_problem', order_id: 'o', display_number: 1, reason: 'other' } }]);
  h.api.openAlertsSheet();
  h.api.closeSheet();                      // REAL closeSheet → must release ownership + clear the body
  h.api.renderAlertsSheet();
  assert.equal(h.api.bodyHtml(), '', 'an alert update does not repopulate a closed sheet after closeSheet');
});
