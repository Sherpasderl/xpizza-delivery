'use strict';
// TRACKER FIXES (codex build r1 P1-2; BUILD r1.5 §0 flag-transition protocol) — tracking/reconcile-core.js (tools/tracker-reconcile.js)
// on the RTDB emulator, with the REAL recompute / ingest of index.js. Run: npm run test:tracker-reconcile
//  (1) ON: a dry run READS only (zero writes) and reports the window (out_for_delivery + terminal ≤ 24 h; older terminal and
//      non-window orders excluded); --apply converges every window node (mx present, mixed legacy/new shapes erased); a SECOND
//      apply reports 0 customer-visible changes
//  (2) OFF: a dry run writes nothing; --apply deletes mx from every window node and leaves the legacy fields byte-equal; a second
//      run reports 0 nodes carrying mx
//  (3) held operations admitted BEFORE the ON → OFF flip: a recompute held at its node transaction and an ingest held at commit;
//      the tool runs (mx deleted), the held operations land afterwards; the post-window run converges (0 nodes with mx)
require('./_emulator-required')('database');
const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'reconcile-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const app = require('../index.js');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const { recomputeOrderTracker } = require('../tracking/recompute');
const { runReconcile } = require('../tracking/reconcile-core');
const flag = require('../tracking/flag');
Object.getPrototypeOf(getAuth()).getUser = async (uid) => ({ uid, disabled: false, tokensValidAfterTime: null });
const db = getDatabase();
assert.match(db.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost)/);
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const v = async (p) => (await db.ref(p).once('value')).val();
const NOW = Date.now(), H = 3600 * 1000;
const DA = 'u_recon_a000000000000000';
const holds = [];
globalThis.__trackerHold = async (name, ctx) => { for (const h of holds) if (!h.used && h.name === name && h.match(ctx || {})) { h.used = true; h.reached(); await h.gate; return; } };
const hold = (name, match) => { let open, reached; const gate = new Promise((r) => { open = r; }); const r = new Promise((x) => { reached = x; }); holds.push({ name, match, gate, reached, used: false }); return { reached: r, release: () => open() }; };

async function loadRules() {
  const ns = new URL(db.app.options.databaseURL).hostname.split('.')[0];
  const rules = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
  const r = await fetch(`http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/.settings/rules.json?ns=${ns}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
  assert.ok(r.ok);
}
const order = (oid, status, extra = {}) => ({ order_id: oid, status, tracking_token: `TOK_${oid}`, restaurant_id: 'tb_centro', hub_lat: 15.5, hub_lng: -88.03, lat: 15.52, lng: -88.01, created_at: NOW - 2 * H, ...extra });
async function seed({ flagOn }) {
  await db.ref('/').set(null);
  holds.length = 0;
  const legacy = { is_active_drop: true, driver_name: 'Ana', driver_location: { lat: 1, lng: 2, at: NOW - 1000 }, dest_lat: 15.52, dest_lng: -88.01 };
  await db.ref().update({
    'config/tracker_fixes_enabled': flagOn,
    [`drivers/${DA}`]: { name: 'ana', status: 'available', active: false },
    // window: out_for_delivery (live for DA), delivered 2 h ago, cancelled 3 h ago
    'orders/W1': order('W1', 'out_for_delivery'), 'order_tracking/TOK_W1': { order_id: 'W1', status: 'out_for_delivery', ...legacy },
    'tasks/W1_pickup': { order_id: 'W1', type: 'pickup', status: 'completed', assigned_driver_id: DA, created_at: 1 },
    'tasks/W1_delivery': { order_id: 'W1', type: 'delivery', status: 'in_progress', assigned_driver_id: DA, created_at: 1 },
    'orders/W2': order('W2', 'delivered', { delivered_at: NOW - 2 * H }), 'order_tracking/TOK_W2': { order_id: 'W2', status: 'out_for_delivery', ...legacy },   // a stale OFF-path shape after terminal
    'orders/W3': order('W3', 'cancelled', { cancelled_at: NOW - 3 * H }), 'order_tracking/TOK_W3': { order_id: 'W3', status: 'cancelled' },
    // codex build r2 P2-1: CREATED 8 days ago, DELIVERED 1 h ago — inside the approved 'terminal within 24 h' window
    'orders/W4': order('W4', 'delivered', { created_at: NOW - 8 * 24 * H, delivered_at: NOW - 1 * H }), 'order_tracking/TOK_W4': { order_id: 'W4', status: 'out_for_delivery' },
    // outside the window: delivered 30 h ago; a 'ready' order
    'orders/X1': order('X1', 'delivered', { delivered_at: NOW - 30 * H, created_at: NOW - 31 * H }), 'order_tracking/TOK_X1': { order_id: 'X1', status: 'delivered' },
    'orders/X2': order('X2', 'ready'), 'order_tracking/TOK_X2': { order_id: 'X2', status: 'ready' },
  });
  flag._resetForTest();
}
const tracking = async () => JSON.stringify(await v('order_tracking'));
function ingest(token) {
  const w = express(); w.use(express.json()); w.use(app.ingestDriverLocation);
  return new Promise((resolve, reject) => {
    const server = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try { const r = await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-driver-token': token }, body: JSON.stringify({ locations: [{ ts: Date.now() - 500, lat: 15.51, lng: -88.02, accuracy: 10 }] }) }); await r.text(); server.close(() => resolve(r.status)); }
      catch (e) { server.close(() => reject(e)); }
    });
  });
}

(async () => {
  const watchdog = setTimeout(() => { console.error('tracker-reconcile: FAIL — timed out'); process.exit(1); }, 300000);
  await loadRules();
  const run = (mode, apply) => runReconcile({ db, mode, apply, now: NOW, recompute: recomputeOrderTracker });

  // (1) ON
  await seed({ flagOn: true });
  const t0 = await tracking();
  const dry = await run('on', false);
  assert.strictEqual(await tracking(), t0, 'a dry run writes NOTHING');
  assert.deepStrictEqual([dry.window, dry.outForDelivery, dry.terminal24h], [4, 1, 3], `the window is W1 + W2 + W3 + W4 (created 8 days ago, delivered 1 h ago) (${JSON.stringify(dry)})`);
  const a1 = await run('on', true);
  assert.ok(a1.visibleChanges >= 2, `apply converges the window (${a1.visibleChanges} visible changes)`);
  for (const t of ['W1', 'W2', 'W3', 'W4']) assert.ok((await v(`order_tracking/TOK_${t}/mx`)), `${t} now carries mx`);
  assert.strictEqual((await v('order_tracking/TOK_W2/mx')).mode, 'terminal'); assert.strictEqual(await v('order_tracking/TOK_W2/is_active_drop'), null, 'the stale legacy shape on the delivered order is erased');
  assert.strictEqual(await v('order_tracking/TOK_X1/mx'), null, 'an order delivered 30 h ago is outside the window'); assert.strictEqual(await v('order_tracking/TOK_X2/mx'), null, 'a ready order is outside the window');
  const a2 = await run('on', true);
  assert.strictEqual(a2.visibleChanges, 0, `a SECOND apply reports 0 customer-visible changes (${a2.changed})`);
  ok(`--mode on: dry run writes nothing (window ${dry.window}: 1 out_for_delivery + 3 terminal ≤ 24 h incl. one CREATED 8 days ago; 30 h-old and ready excluded); apply converges (${a1.visibleChanges} visible changes, stale legacy shape erased); second apply → 0 visible changes`);

  // (2) OFF
  const legacyBefore = Object.fromEntries(await Promise.all(['W1', 'W2', 'W3', 'W4'].map(async (t) => { const x = await v(`order_tracking/TOK_${t}`); delete x.mx; return [t, JSON.stringify(x)]; })));
  await db.ref('config/tracker_fixes_enabled').set(false); flag._resetForTest();
  const t1 = await tracking();
  const dOff = await run('off', false);
  assert.strictEqual(await tracking(), t1, 'an OFF dry run writes nothing'); assert.strictEqual(dOff.mxPresent, 4);
  const o1 = await run('off', true);
  assert.strictEqual(o1.mxRemoved, 4);
  for (const t of ['W1', 'W2', 'W3', 'W4']) {
    const x = await v(`order_tracking/TOK_${t}`);
    assert.strictEqual(x.mx, undefined, `${t}: mx deleted`);
    assert.strictEqual(JSON.stringify(x), legacyBefore[t], `${t}: the legacy fields are untouched`);
  }
  const o2 = await run('off', false);
  assert.strictEqual(o2.mxPresent, 0, 'a second run reports 0 nodes carrying mx');
  ok('--mode off: dry run writes nothing (4 nodes carry mx, incl. the order created 8 days ago); apply deletes mx only (legacy fields byte-equal); second run → 0 nodes with mx');

  // (3) held operations admitted before the ON → OFF flip
  await seed({ flagOn: true });
  const reg = await app.startDriverShift.run({ auth: { uid: DA, token: { uid: DA } }, data: { platform: 'native' }, rawRequest: { headers: {} } });
  await db.ref().update({ [`drivers/${DA}/current_task_id`]: 'W1_delivery' });
  await run('on', true);
  assert.strictEqual((await v('order_tracking/TOK_W1/mx')).mode, 'live', 'premise: W1 live for DA');
  const hr = hold('node-tx', (c) => c.orderId === 'W1');
  const heldRecompute = recomputeOrderTracker(db, 'W1');
  await hr.reached;
  const hi = hold('ingest:commit', (c) => c.orderId === 'W1');
  const heldIngest = ingest(reg.ingest_token);
  await hi.reached;
  // the flip: flag OFF, (the 10-minute wait), the tool
  await db.ref('config/tracker_fixes_enabled').set(false); flag._resetForTest();
  const off1 = await run('off', true);
  assert.ok(off1.mxRemoved >= 1);
  hr.release(); await heldRecompute;
  hi.release(); await heldIngest;
  const afterHeld = await v('order_tracking/TOK_W1');
  const reAdded = !!afterHeld.mx;   // the held recompute, admitted before the flip, may re-add mx after the tool ran
  const off2 = await run('off', true);
  const off3 = await run('off', false);
  assert.strictEqual(off3.mxPresent, 0, 'the post-window run converges: 0 nodes carrying mx');
  const fin = await v('order_tracking/TOK_W1');
  assert.strictEqual(fin.mx, undefined);
  // (a held ingest may legitimately land the driver's real location on its own live order — the legacy field today's OFF code
  // writes too; convergence is about mx)
  ok(`held operations admitted before the ON → OFF flip: a recompute held at its node txn (re-added mx after the tool: ${reAdded}) and an ingest held at commit land after the tool; the post-window run converges (removed ${off2.mxRemoved}; then 0 nodes with mx)`);

  clearTimeout(watchdog);
  delete globalThis.__trackerHold;
  console.log(`tracker-reconcile: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('tracker-reconcile: FAIL\n', e); process.exit(1); });
