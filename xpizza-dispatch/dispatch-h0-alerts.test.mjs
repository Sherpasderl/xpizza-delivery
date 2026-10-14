// xpizza-dispatch/dispatch-h0-alerts.test.mjs — PLAN-H0: the two payment alerts render, classify and navigate, from the
// REAL emitter's record shape (xpizza-functions/superseded-capture.js alertRecord), and an order outside the live lists
// opens by id. Run: node xpizza-dispatch/dispatch-h0-alerts.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { classifyAlert } from './dispatch-alerts.js';
import { alertNavTarget } from './dispatch-alert-nav.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { alertRecord } = require('../xpizza-functions/superseded-capture.js');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const fnSrc = (src, name) => { const s = src.indexOf(`function ${name}(`); const e = src.indexOf('\n}\n', s); return s < 0 || e < 0 ? null : src.slice(s, e + 2); };

// the real emitter shape (as recordEvidence writes it; an evidence child read back from RTDB lacks its null fields)
const ev = (kind, over = {}) => ({ kind, version: 'v', amount_cents: 29950, first_seen_at: 1700000000000, alert_state: 'pending', ...over });
const sup = alertRecord('PZX-251014-120000-ABCDEFGH', 'a1a1a1a1a1a1a1a1', ev('paid_superseded'), { restaurant_id: 'x_pizza' });
const unc = alertRecord('PZX-251014-120000-ABCDEFGH', 'b2b2b2b2b2b2b2b2', ev('reversal_uncertain', { amount_cents: 33700 }), { restaurant_id: 'la_musa' });
const noAmt = alertRecord('PZX-1', 'c3', { kind: 'reversal_uncertain', version: 'v', first_seen_at: 1 }, null);

// ── 1. alertContent executed on the real record ──
{
  const alertContent = new Function('escapeHtml', 'displayOrderLabel', 'allDrivers', `${fnSrc(html, 'alertContent')}\nreturn alertContent;`)((s) => String(s), (x) => `#${x}`, {});
  const a = alertContent(sup);
  assert.strictEqual(a.title, 'Pago recibido en un intento anterior');
  assert.strictEqual(a.detail, 'Pedido #PZX-251014-120000-ABCDEFGH · L299.50 — revisar en PixelPay y reembolsar.');
  const b = alertContent(unc);
  assert.strictEqual(b.title, 'Reembolso sin confirmar');
  assert.strictEqual(b.detail, 'Pedido #PZX-251014-120000-ABCDEFGH · L337 — el reembolso automático no se pudo confirmar. Revisar en PixelPay.');
  assert.strictEqual(alertContent(noAmt).detail, 'Pedido #PZX-1 — el reembolso automático no se pudo confirmar. Revisar en PixelPay.', 'no amount → no amount segment');
  assert.notStrictEqual(a.title, 'Alerta', 'not the untyped fallback');
  ok('alertContent: Spanish title + order label + amount (decimals only when present) + the action, from the real record shape');
}
// ── 2. registry (severity red, an existing value) + navigation (opens the order) + not cola-owned ──
{
  for (const r of [sup, unc]) {
    const c = classifyAlert(r);
    assert.strictEqual(c.known, true, `${r.type} is registered`);
    assert.strictEqual(c.severity, 'red'); assert.strictEqual(c.category, 'payment'); assert.strictEqual(c.iconId, 'i-card');
    assert.deepStrictEqual(alertNavTarget(r), { kind: 'order', orderId: r.order_id }, `${r.type} opens the order`);
  }
  const cola = (html.match(/COLA_OWNED_ALERT_TYPES = new Set\(\[([^\]]*)\]\)/) || [])[1] || '';
  assert.ok(!/paid_superseded|reversal_uncertain/.test(cola), 'not cola-owned → renders in the Torre');
  assert.strictEqual(sup.detail, undefined, 'no detail.* → alert-prune never removes it');
  ok('registry: severity red / payment / i-card; navigation opens the order; not cola-owned; no detail.* (prune-proof)');
}
// ── 3. openOrderDetailModal: in the lists → render; not loaded → fetch once; absent / read failure → distinct toasts ──
{
  const src = fnSrc(html, 'openOrderDetailModal');
  const run = async (lists, fetchResult) => {
    const calls = { toast: [], show: [], fetch: 0 };
    const XPD = { fetchOrderById: async (id) => { calls.fetch += 1; return fetchResult(id); } };
    // the rest of the real function renders the drawer; stub its collaborators and record what it rendered
    const el = { removeAttribute() {}, classList: { add() {} }, focus() {} };
    const f = new Function('allOrders', 'allScheduled', 'XPD', 'toast', 'renderOrderDetailModal', '$', 'document', 'window',
      `let detailOpener, currentDetailOrderId;\n${src}\nreturn openOrderDetailModal;`)(
      lists.orders, lists.scheduled, XPD, (m, k) => calls.toast.push([m, k]), (o) => calls.show.push([o.order_id, o]), () => el, { activeElement: null }, {});
    f('O1');
    await new Promise((r) => setTimeout(r, 0));
    return calls;
  };
  const loaded = await run({ orders: { O1: { order_id: 'O1' } }, scheduled: {} }, () => { throw new Error('no fetch'); });
  assert.deepStrictEqual(loaded, { toast: [], show: [['O1', { order_id: 'O1' }]], fetch: 0 }, 'a loaded order renders without a fetch');
  const fetched = await run({ orders: {}, scheduled: {} }, () => ({ ok: true, order: { status: 'cancelled' } }));
  assert.strictEqual(fetched.fetch, 1);
  assert.deepStrictEqual(fetched.show, [['O1', { status: 'cancelled', order_id: 'O1' }]], 'a cancelled order outside the lists is fetched and rendered, with its id');
  const absent = await run({ orders: {}, scheduled: {} }, () => ({ ok: true, order: null }));
  assert.deepStrictEqual(absent.toast, [['Pedido no encontrado', 'error']]);
  const failed = await run({ orders: {}, scheduled: {} }, () => ({ ok: false }));
  assert.deepStrictEqual(failed.toast, [['No se pudo cargar el pedido — reintentá', 'error']], 'a read failure is not reported as absence');
  ok('openOrderDetailModal: loaded → render; not loaded → one fetch then render with its id; absent → "Pedido no encontrado"; read failure → retry message');
}
// ── 4. the × on a payment alert = durable dismissal on its evidence (ONE multi-path update); other alerts unchanged ──
{
  const { h0DismissUpdate } = await import('./dispatch-h0-dismiss.js');
  const sup2 = alertRecord('PZX-1', 'a1a1', { kind: 'paid_superseded', version: 'v9', first_seen_at: 1 }, null, 7);
  assert.deepStrictEqual(h0DismissUpdate('K1', sup2), { 'dispatcher_alerts/K1': null, 'orders/PZX-1/paid_evidence/a1a1/dismissed_kind': 'paid_superseded', 'orders/PZX-1/paid_evidence/a1a1/dismissed_version': 'v9' });
  assert.strictEqual(h0DismissUpdate('K2', { type: 'no_drivers_available', order_id: 'X' }), null, 'any other alert → plain removal');
  assert.strictEqual(h0DismissUpdate('K3', { ...sup2, version: null }), null, 'no version → plain removal (never a dismissal of an unknown version)');
  const del = fs.readFileSync(path.join(__dirname, 'xpizza-delivery.js'), 'utf8');
  assert.ok(/const u = h0DismissUpdate\(alertId, rec\);\n  if \(u\) \{ await fbUpdate\(ref\(db\), u\); return; \}/.test(del), 'dismissDispatcherAlert sends the H0 update atomically');
  assert.ok(html.includes('XPD.dismissDispatcherAlert(id, latestAlerts[id])'), 'the × passes the alert record');
  ok('the × on a payment alert writes {dismissed_kind, dismissed_version} on its evidence in ONE update with the removal; other alerts are removed as before');
}
console.log(`\ndispatch-h0-alerts: OK (${n})`);
