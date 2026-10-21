/**
 * BRAND-AGNOSTIC SERVER (PLAN-brand-agnostic-server r3 §E) — MONEY-PATH PARITY for the one line this slice adds to
 * pixelpay-confirm.js#confirmAndMaterialize (`const restaurant = await materializeRestaurant(deps, order)`).
 * OLD = b5820e51:pixelpay-confirm.js, compiled IN MEMORY against this directory's modules (nothing written to the tree);
 * NEW = the live module. Both run the FULL confirm path (confirmOnlinePayment: status → capture → verify → attempt/order
 * stamps → materialize) with identical nested-RTDB mocks and PixelPay stubs, and every observable is compared:
 * the outcome, the ENTIRE database after the run, the PixelPay calls (capture / getStatus / void) and the alerts.
 *   • every STAMPED order (all orders since 3b — delivery and pickup, x_pizza and a third brand) and every non-materializing
 *     path (declined, not authorized, capture timeout → void) is BYTE-IDENTICAL, and hubFor is never called;
 *   • an UNSTAMPED x_pizza order is byte-identical too (its identity hub === index.js RESTAURANT, pinned by materialize-hub);
 *   • the ONLY difference anywhere: an UNSTAMPED non-x_pizza order's pickup task destination = its own identity hub
 *     (was the x_pizza constant) — the authorized §E change; money fields, statuses and stamps identical.
 * Run: node confirm-materialize-parity.test.js
 */
process.env.PIXELPAY_MODE = 'sandbox';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const { buildMaterializeUpdates } = require('./materialize');
const { voidOrRefund } = require('./pixelpay-cancel');
const realClient = require('./pixelpay-client');
const { paymentHash } = require('./pixelpay');
const { IDENTITIES } = require('./seed_identity');
const NEW = require('./pixelpay-confirm');

const loadBase = (file) => {
  const src = execFileSync('git', ['show', `b5820e51:xpizza-functions/${file}`], { cwd: __dirname, encoding: 'utf8' });
  const filename = path.join(__dirname, `${file}.b5820e51-in-memory.js`);
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(__dirname);
  m._compile(src, filename);
  return m.exports;
};
const OLD = loadBase('pixelpay-confirm.js');
assert.ok(!fs.existsSync(path.join(__dirname, 'pixelpay-confirm.js.b5820e51-in-memory.js')), 'nothing written to the tree');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const XP = { lat: IDENTITIES.x_pizza.hub_lat, lng: IDENTITIES.x_pizza.hub_lng };
const RESTAURANT = { lat: XP.lat, lng: XP.lng, name: 'X Pizza', phone: '+50497952893' };   // index.js RESTAURANT (pinned by materialize-hub)
const TB = { lat: 15.53, lng: -88.01 };
const SBOX_KEY = '1234567890', SBOX_SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
const goodHash = paymentHash('PZX-1-A', SBOX_KEY, SBOX_SECRET);

function makeDb(initial = {}) {
  const root = JSON.parse(JSON.stringify(initial));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const getAt = (p) => { if (!p) return root; let node = root; for (const k of p.split('/')) { if (node == null) return null; node = node[k]; } return node === undefined ? null : node; };
  const setAt = (p, val) => { const parts = p.split('/'); let node = root; for (let i = 0; i < parts.length - 1; i++) { if (node[parts[i]] == null || typeof node[parts[i]] !== 'object') node[parts[i]] = {}; node = node[parts[i]]; } const last = parts[parts.length - 1]; if (val === null) delete node[last]; else node[last] = val; };
  let pk = 0;
  const ref = (p = '') => ({
    async once() { const v = getAt(p); return { val: () => clone(v), exists: () => v != null }; },
    async transaction(fn) { const real = clone(getAt(p)); let next = fn(null); if (next === undefined) return { committed: false, snapshot: { val: () => real } }; if (real !== null) { next = fn(clone(real)); if (next === undefined) return { committed: false, snapshot: { val: () => real } }; } setAt(p, clone(next)); return { committed: true, snapshot: { val: () => clone(getAt(p)) } }; },
    async update(patch) { if (!p) { for (const [k, v] of Object.entries(patch)) setAt(k, clone(v)); return; } setAt(p, Object.assign({}, getAt(p) || {}, clone(patch))); },
    async set(val) { setAt(p, clone(val)); },
    async push(val) { const k = `k${++pk}`; setAt(p ? `${p}/${k}` : k, clone(val)); return { key: k }; },
    async remove() { setAt(p, null); },
  });
  return { root, ref, getAt };
}
function mkClient({ statusValue = 'authorized', capture, captureThrows = false } = {}) {
  const calls = { capture: 0, void: 0, status: 0 };
  return {
    calls, interpretStatus: realClient.interpretStatus, verifyCaptureResult: realClient.verifyCaptureResult,
    async getStatus() { calls.status++; return { data: { status: statusValue } }; },
    async capture() { calls.capture++; if (captureThrows) throw new Error('ETIMEDOUT'); return capture || { ok: true, httpStatus: 200, data: { response_approved: true, transaction_approved_amount: 385, payment_hash: goodHash, transaction_reference: 'REF123' } }; },
    async voidTransaction() { calls.void++; return { ok: true }; },
  };
}
const pending = ({ type = 'delivery', rid = 'x_pizza', hub = XP } = {}) => {
  const o = { order_id: 'PZX-1', customer_name: 'Ana', customer_phone: '50488887777', items_text: 'Margherita x1', total: 385, total_cents: 38500, subtotal_cents: 33478, tax_cents: 5022,
    notes: '', payment_method: 'online', payment_status: 'pending', order_type: type, status: 'pending_payment', active_attempt_id: 'A', payment_fingerprint: 'fp', created_at: 1, restaurant_id: rid };
  if (hub) { o.hub_lat = hub.lat; o.hub_lng = hub.lng; o.restaurant_name = 'Snapshot Name'; o.restaurant_phone = '+504'; }
  if (type === 'delivery') { o.lat = 15.51; o.lng = -88.03; o.address_detected = 'Calle 1, SPS'; o.address_details = 'casa azul'; } else o.pickup_time = 'standard';
  return { orders: { 'PZX-1': o }, payment_attempts: { A: { order_id: 'PZX-1', status: 'active', total_cents: 38500, pixelpay_order_id: 'PZX-1-A', created_at: 1 } } };
};

async function run(mod, init, clientOpts, { withHubFor }) {
  const db = makeDb(init); const client = mkClient(clientOpts); const alerts = []; const hubReads = [];
  const deps = { db, client, restaurant: RESTAURANT, buildMaterializeUpdates, voidOrRefund, staleMs: 90000, alert: async (k, d) => { alerts.push([k, d]); } };
  if (withHubFor) deps.hubFor = async (rid) => { hubReads.push(rid); return { x_pizza: XP, tb_norte: TB }[rid] || null; };
  let outcome; try { outcome = await mod.confirmOnlinePayment(deps, { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 1000, trackingToken: 'TOK1' }); } catch (e) { outcome = { threw: String(e && e.message) }; }
  return { outcome, root: db.root, calls: client.calls, alerts, hubReads };
}

(async () => {
  const SCEN = [
    ['stamped x_pizza delivery', pending(), {}],
    ['stamped x_pizza pickup', pending({ type: 'pickup' }), {}],
    ['stamped third-brand delivery', pending({ rid: 'tb_norte', hub: TB }), {}],
    ['declined capture', pending(), { capture: { ok: true, httpStatus: 200, data: { response_approved: false } } }],
    ['not authorized at status', pending(), { statusValue: 'declined' }],
    ['capture timeout', pending(), { captureThrows: true }],
  ];
  for (const [label, init, c] of SCEN) {
    const o = await run(OLD, init, c, { withHubFor: false });
    const v = await run(NEW, init, c, { withHubFor: true });
    assert.deepStrictEqual(v.outcome, o.outcome, `${label}: outcome`);
    assert.deepStrictEqual(v.root, o.root, `${label}: the ENTIRE database after the run is byte-identical`);
    assert.deepStrictEqual(v.calls, o.calls, `${label}: PixelPay calls (capture / status / void)`);
    assert.deepStrictEqual(v.alerts, o.alerts, `${label}: alerts`);
    assert.deepStrictEqual(v.hubReads, [], `${label}: no identity read`);
  }
  assert.strictEqual((await run(NEW, pending(), {}, { withHubFor: true })).root.orders['PZX-1'].payment_status, 'confirmed', 'premise: the happy path materialized');
  ok(`byte-identical OLD vs NEW on the full confirm path — outcome, entire database, PixelPay calls, alerts — for ${SCEN.length} scenarios (stamped delivery / pickup / third brand; declined; not authorized; capture timeout); hubFor never called`);

  {
    const init = pending({ hub: null });
    const o = await run(OLD, init, {}, { withHubFor: false });
    const v = await run(NEW, init, {}, { withHubFor: true });
    assert.deepStrictEqual(v.root, o.root, 'unstamped x_pizza: entire database byte-identical');
    assert.deepStrictEqual([v.outcome, v.calls, v.alerts], [o.outcome, o.calls, o.alerts]);
    assert.deepStrictEqual(v.hubReads, ['x_pizza'], 'one identity read');
    ok('an UNSTAMPED x_pizza order: byte-identical (its identity hub === RESTAURANT)');
  }
  {
    const init = pending({ rid: 'tb_norte', hub: null });
    const o = await run(OLD, init, {}, { withHubFor: false });
    const v = await run(NEW, init, {}, { withHubFor: true });
    const pk = (r) => r.tasks['PZX-1_pickup'];
    assert.deepStrictEqual([pk(o.root).destination_lat, pk(o.root).destination_lng], [XP.lat, XP.lng], 'OLD: the x_pizza constant');
    assert.deepStrictEqual([pk(v.root).destination_lat, pk(v.root).destination_lng], [TB.lat, TB.lng], 'NEW: its own identity hub');
    const strip = (r) => { const c = JSON.parse(JSON.stringify(r)); delete c.tasks['PZX-1_pickup'].destination_lat; delete c.tasks['PZX-1_pickup'].destination_lng; return c; };
    assert.deepStrictEqual(strip(v.root), strip(o.root), 'everything else — money fields, statuses, stamps, tracking — byte-identical');
    assert.deepStrictEqual([v.outcome, v.calls, v.alerts], [o.outcome, o.calls, o.alerts]);
    ok('an UNSTAMPED non-x_pizza order: the ONLY difference is the pickup destination = its own identity hub (authorized §E); money / status / stamps identical');
  }
  console.log(`\nconfirm-materialize-parity: OK (${n})`);
})().catch((e) => { console.error('confirm-materialize-parity FAILED:', e); process.exit(1); });
