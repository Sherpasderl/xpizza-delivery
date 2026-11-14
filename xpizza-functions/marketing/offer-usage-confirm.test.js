'use strict';
// PLAN-5f-marketing-price step 2 (A, advisor 11-14) — the offer usage on the REAL hosted money writers:
//   UC-DECLINE: a definitive decline through the REAL confirmOnlinePayment (PixelPay status stubbed «declined»; the real interpretStatus)
//               ⇒ order.offer.usage 'released_failed' and the counters given back — beside the reward's own release;
//   UC-RETRY:   that order retried ⇒ re-held exactly once (the normal cap check);
//   UC-ABANDON: the REAL resolve-manual abandon (a stale hosted order a person abandons) writes status 'cancelled' — the transition the
//               onOrderCancelled hook releases on (its wiring: test:marketing-price E10) — ⇒ 'released', terminal.
// The offer by 3a's REAL writers (the seed), the hold by offer-usage. Run: node marketing/offer-usage-confirm.test.js
const assert = require('assert');
const { world, NOW } = require('../test/_marketing-price-seed');
const OP = require('./offer-price');
const CFG = require('./config');
const OU = require('./offer-usage');
const { confirmOnlinePayment } = require('../pixelpay-confirm');
const { resolveManualReconciliationCore } = require('../resolve-manual');
const { buildMaterializeUpdates } = require('../materialize');
const { voidOrRefund } = require('../pixelpay-cancel');
const realClient = require('../pixelpay-client');

let n = 0; let FINISHED = false; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ offer-usage-confirm: exited without completing\n'); process.exitCode = 1; } });

const RID = 'tb_centro'; const MENU = { i_aaaaaaaaaaaa: 200 };
const items = [{ name: 'i_aaaaaaaaaaaa', qty: 2, extras: [] }];
const T = NOW + 3600000; const SALES = 35000;
const client = (status) => ({ interpretStatus: realClient.interpretStatus, verifyCaptureResult: realClient.verifyCaptureResult,
  async getStatus() { return { data: { status } }; }, async capture() { throw new Error('no capture expected'); }, async voidTransaction() { return { ok: true }; } });

async function heldOrder(extra = {}) {
  const w = await world({ rid: RID, menu: MENU });
  const id = await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
  const offer = OP.offerFor({ cfg: await CFG.readMarketingConfig(w.db), live: w.fake.get(`marketing_live/${RID}`), nowMs: T, items, rid: RID, tables: { restaurantId: RID, menu: MENU, extras: {} }, baseTotalL: 400 });
  assert.ok(offer, 'premise: the REAL offer');
  w.fake.put('orders/PZ-1', { order_id: 'PZ-1', restaurant_id: RID, customer_name: 'Ana', customer_phone: '50488887777', items_text: 'x2', total: 350, total_cents: 35000, subtotal_cents: 35000, tax_cents: 0,
    payment_method: 'online', payment_status: 'pending', order_type: 'pickup', pickup_time: 'standard', status: 'pending_payment', active_attempt_id: 'A', payment_fingerprint: 'fp', created_at: 1, offer: OP.frozenOf(offer), ...extra });
  w.fake.put('payment_attempts/A', { order_id: 'PZ-1', status: 'active', total_cents: 35000, pixelpay_order_id: 'PZ-1-A', payment_uuid: 'U-1', created_at: 1 });
  assert.deepStrictEqual(await OU.holdForOrder(w.db, 'PZ-1', offer, { salesCents: SALES, nowMs: T }), { ok: true }, 'premise: held at the gate');
  return { w, id, offer };
}
const confirmDeps = (db, st) => ({ db, client: client(st), restaurant: { lat: 15.5, lng: -88, name: 'R', phone: '+504' }, buildMaterializeUpdates, voidOrRefund, staleMs: 90000, alert: () => {} });

(async () => {
  await cell('UC-DECLINE: a definitive decline through the REAL confirmOnlinePayment ⇒ «released_failed», the counters given back', async (L) => {
    const { w, id } = await heldOrder();
    const r = await confirmOnlinePayment(confirmDeps(w.db, 'declined'), { orderId: 'PZ-1', paymentUuid: 'U-1', now: T + 1000, trackingToken: 'TK' });
    assert.strictEqual(r.outcome, 'failed', `${L}: premise — the real decline path (${JSON.stringify(r)})`);
    assert.deepStrictEqual([w.fake.get('orders/PZ-1/payment_status'), w.fake.get('orders/PZ-1/status')], ['failed', 'pending_payment'], `${L}: premise — the order stays open (the leak's shape)`);
    assert.strictEqual(w.fake.get('orders/PZ-1/offer/usage'), 'released_failed', L);
    assert.deepStrictEqual([w.fake.get(`marketing_usage/${id}/redemptions`), w.fake.get(`marketing_usage/${id}/spend_cents`), w.fake.get(`marketing_usage/${id}/orders`)], [0, 0, 0], `${L}: counters back`);
  });
  await cell('UC-RETRY: the declined order retried ⇒ re-held exactly once (a retried gate counts nothing more)', async (L) => {
    const { w, id, offer } = await heldOrder();
    await confirmOnlinePayment(confirmDeps(w.db, 'declined'), { orderId: 'PZ-1', paymentUuid: 'U-1', now: T + 1000, trackingToken: 'TK' });
    for (let i = 0; i < 2; i += 1) assert.deepStrictEqual(await OU.holdForOrder(w.db, 'PZ-1', offer, { salesCents: SALES, nowMs: T + 2000 }), { ok: true }, `${L}: gate ${i + 1}`);
    assert.deepStrictEqual([w.fake.get('orders/PZ-1/offer/usage'), w.fake.get(`marketing_usage/${id}/redemptions`)], ['held', 1], L);
  });
  await cell('UC-ABANDON: the REAL resolve-manual abandon of a stale hosted order writes status «cancelled» ⇒ the hook\'s release ⇒ «released», terminal', async (L) => {
    const { w, id, offer } = await heldOrder({ payment_status: 'manual_reconciliation' });
    w.fake.put('payment_attempts/A/hosted_state', 'manual_reconciliation'); w.fake.put('payment_attempts/A/payment_uuid', null);   // a stale NO-callback checkout: no payment id (with one, the real abandon refuses: «usá Reembolsar»)
    const deps = { db: w.db, client: client('declined'), alert: async () => {}, sanitizeText: (x) => String(x || ''), serverTimestamp: 1, voidOrRefund, buildMaterializeUpdates, restaurant: { lat: 15.5, lng: -88, name: 'R', phone: '+504' } };
    const r = await resolveManualReconciliationCore(deps, { orderId: 'PZ-1', action: 'abandon', actor: 'disp', note: '', now: T + 5000, claimId: 'C1' });
    assert.strictEqual(w.fake.get('orders/PZ-1/status'), 'cancelled', `${L}: premise — the real abandon cancels (${JSON.stringify(r)})`);
    assert.strictEqual(await OU.releaseForOrder(w.db, 'PZ-1'), true, `${L}: what onOrderCancelled runs`);
    assert.deepStrictEqual([w.fake.get('orders/PZ-1/offer/usage'), w.fake.get(`marketing_usage/${id}/redemptions`)], ['released', 0], L);
    assert.strictEqual((await OU.holdForOrder(w.db, 'PZ-1', offer, { salesCents: SALES, nowMs: T + 6000 })).ok, false, `${L}: terminal`);
  });

  FINISHED = true;
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`offer-usage-confirm: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
