'use strict';
// SECURITY (NOTE-security-confirm-tracking-token, advisor RULED Option A 2026-11-12): the HTTP export `confirmOnlinePayment` is
// RETIRED. It was the retired SDK direct-charge flow's confirm (no live client: the forms and the capp poll paymentStatus with the
// per-attempt poll_token; the advisor's request-log read since 10-13 shows zero HTTP requests), and behind only the PUBLIC intake
// bearer it (a) returned any paid order's tracking_token for {order_id} alone and (b) could write manual_reconciliation / failed
// on an inactive restaurant's order — with a CALLER-supplied payment_uuid. The module core (pixelpay-confirm.js) stays for its
// importers (webhook, sweeps, recovery). Cells: the export is gone (static — index.js is not require-safe), and the core's two
// behaviours are DOCUMENTED (they are why no public route may reach it again). Run: node confirm-retired.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fakeRtdb } = require('./test/_fake-rtdb-sdk');
const { confirmOnlinePayment } = require('./pixelpay-confirm');

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

(async () => {
  await cell('RET-EXPORT-GONE', (L) => {
    const src = strip(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'));
    assert.ok(!/exports\.confirmOnlinePayment\s*=/.test(src), `${L}: index.js must not export confirmOnlinePayment (RETIRED)`);
    assert.ok(!/\bconfirmOnlineApp\b/.test(src), `${L}: the retired HTTP app is gone with it`);
    assert.ok(/exports\.paymentStatus\s*=/.test(src) && /exports\.pixelPayWebhook\s*=/.test(src), `${L}: premise — the hosted flow's customer read and money authority remain`);
  });

  // DOCUMENTED (the core, unchanged): an already-paid, materialized online order → its tracking token, for {orderId} alone
  await cell('SEC-CONFIRM-TOKEN (core, documented)', async (L) => {
    const db = fakeRtdb({ orders: { O1: { payment_method: 'online', payment_status: 'confirmed', status: 'new', materialized_at: 1, tracking_token: 'victim-token', active_attempt_id: 'A1' } } });
    const r = await confirmOnlinePayment({ db }, { orderId: 'O1', paymentUuid: null, now: 2, trackingToken: 'fresh' });
    assert.deepStrictEqual([r.outcome, r.tracking_token], ['already_confirmed', 'victim-token'], `${L}: the core answers with the stored token — so no unauthenticated route may call it`);
  });

  // DOCUMENTED (the core, unchanged): an inactive restaurant → a void with the CALLER's payment_uuid, then money-state writes
  await cell('SEC-CONFIRM-INACTIVE (core, documented)', async (L) => {
    const db = fakeRtdb({ orders: { O2: { payment_method: 'online', payment_status: 'pending', status: 'pending_payment', restaurant_id: 'tb_r1', active_attempt_id: 'A2' } },
      payment_attempts: { A2: { status: 'active', payment_uuid: 'REAL-UUID' } } });
    const voids = [];
    const deps = { db, getIdentity: async () => ({ active: false }), client: { voidTransaction: async (q) => { voids.push(q.payment_uuid); return { ok: true }; } }, alert: async () => {} };
    const r = await confirmOnlinePayment(deps, { orderId: 'O2', paymentUuid: 'CALLER-UUID', now: 3, trackingToken: 't' });
    assert.deepStrictEqual([r.outcome, voids, db.get('orders/O2/payment_status'), db.get('payment_attempts/A2/status')], ['voided_inactive', ['CALLER-UUID'], 'failed', 'voided_inactive'],
      `${L}: the core voids the CALLER's uuid and writes failed / voided_inactive — reachable before only through the retired public export`);
  });

  if (fails.length) { console.log(`confirm-retired FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`confirm-retired: OK (${n})`);
})();
