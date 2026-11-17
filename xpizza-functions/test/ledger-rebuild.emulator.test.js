'use strict';
// LEDGER S5 (PLAN-5f-ledger-shadow-s1-r3 §2) — the nightly rebuild end to end on the emulator, over sources from the REAL writers:
//   LR-ORACLE   a cash app delivery (the REAL createOrder ⇒ orders + ledger_alloc), hosted card orders through the REAL webhook (paid; a
//               cancel ⇒ voided; a SECOND paid attempt on one order), a 14-day-old card order refunded today (a late event) and the
//               default rate through the REAL CLI core (appendRate): one run ⇒ every touched order's ledger/orders/{id} = projectOrder of
//               its sources (S3 is the oracle), the open set, a finished run record
//   LR-NOOP     a second run over unchanged sources leaves every projection byte-identical (computed_at included: no write)
//   LR-INDEXED  every window query runs on a declared index — no «Using an unspecified index» warning; the control (an undeclared child)
//               DOES warn, so the detector is live (this also closes S4's owed rules cell)
//   LR-ALARM    the create-once alarm on the real transaction: two calls ⇒ ONE dispatcher_alerts/ledger_run_<date>, counts only
// The SDK legs are projected by S3 over their real record (ledger/projector.test.js); this suite owns the job. Run: npm run test:ledger-rebuild
require('./_emulator-required')('database', 'firestore');
const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'lr-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'lr-quote-secret';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));   // a signed-in member
const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { handleHostedCallback } = require('../pixelpay-hosted-webhook');
const { buildMaterializeUpdates } = require('../materialize');
const { paymentHash } = require('../pixelpay');
const LA = require('../ledger/alloc-snapshot');
const PJ = require('../ledger/projector');
const RB = require('../ledger/rebuild');
const { appendRate } = require('../tools/set-commission-rate-core');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const DAY = 86400000;
const read = async (p) => (await rtdb.ref(p).get()).val();
const stored = (v) => { if (v === null || typeof v !== 'object') return v; const o = {}; for (const [k, x] of Object.entries(v)) { const y = stored(x); if (y !== null && !(typeof y === 'object' && !Object.keys(y).length)) o[k] = y; } return Object.keys(o).length ? o : null; };
function post(handler, body, hdr = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...hdr }, body: JSON.stringify(body) });
        const t = await r.text(); s.close(() => resolve({ status: r.status, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
async function wipe() {
  assert.match(rtdb.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, '🔴 refusing to wipe: not the RTDB emulator');
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe: Firestore is not the emulator');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
const HUB = { lat: 14.1, lng: -87.2 };
const RID = 'x_pizza';
const APP_HDR = { 'x-client-app': 'capp', 'x-client-deployment': 'orders-app', 'x-client-build': '1', 'x-client-compat': '1' };
const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
const RESTAURANT = { lat: 15.5, lng: -88.0, name: 'X Pizza', phone: '+50497952893' };
const CARD = { payment_method: 'online', order_type: 'delivery', total_cents: 29900, subtotal_cents: 25000, tax_cents: 0, delivery_cents: 5000, promo_discount_cents: 1000, delivery_discount_funder: 'sherpa', tip_cents: 900 };
const APPMODE = LA.modeOf({ body: { entry_mode: 'app' }, clientHdr: { app: 'capp', deployment: 'orders-app' } });

// a hosted card order: the order + the claimed attempt carrying the S1 snapshot (as the hosted claim stores it), then the REAL webhook
async function hostedOrder(id, at, { aid = `a_${id}`, cancel = false, voided = true, status = 'pending_payment' } = {}) {
  const order = { order_id: id, restaurant_id: RID, order_type: 'delivery', payment_method: 'online', payment_status: 'pending', status, total: 299, total_cents: 29900, customer_name: 'T', items_text: 'M', created_at: at, active_attempt_id: aid };
  await rtdb.ref(`orders/${id}`).set(order);
  await rtdb.ref(`payment_attempts/${aid}`).set({ order_id: id, hosted_state: 'created', hosted_order_id: `${id}-${aid}`, hosted_checkout_url: 'https://pay/x', ledger: stored(LA.snapshotOf({ ...CARD, created_at: at, restaurant_id: RID }, APPMODE)), ...(cancel ? { cancel_pending: true } : {}) });
  await handleHostedCallback({ db: rtdb, restaurant: RESTAURANT, buildMaterializeUpdates, alert: () => {}, genToken: () => `TOK${id}`, client: {}, voidOrRefund: async () => ({ voided }) },
    { order: `${id}-${aid}`, ref: 'R', status: 'paid', amount: 299, uuid: `P-${id}`, transaction_id: `T-${id}`, payment_hash: paymentHash(`${id}-${aid}`, KEY, SECRET) }, at + 60000);
}
async function oracle(id) {
  const src = await RB.readSources(rtdb, id);
  const settings = await read('ledger_settings/commission');
  const rate = require('../ledger/commission-rate').rateAt(settings, src.order.restaurant_id, src.order.created_at);
  const r = PJ.projectOrder(src, { rateBp: rate ? rate.bp : null });
  return stored({ status: r.status, reasons: r.reasons, journals: r.journals });
}
const proj = async (id) => { const v = await read(`ledger/orders/${id}`); return v && stored({ status: v.status ?? null, reasons: v.reasons ?? null, journals: v.journals ?? null }); };

(async () => {
  await wipe();
  const NOW = Date.now();
  await fs.collection('restaurants').doc(RID).set({ name: RID, pricing_key_mode: 'name', active: true, schema_version: 2 });
  const seed = buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'lr-seed' });
  await publishVersion(fs, RID, seed.input, { expected: { activeVersionId: null }, mirror: require('../catalog/mirror-rtdb').makeRtdbMirror(rtdb) });
  await rtdb.ref(`restaurants/${RID}/identity`).set({ name: RID, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, hours: HOURS });
  await rtdb.ref('platform_config/delivery_pricing').set({ policy_version: 1, bands: [{ max_km: 7, cents: 3000 }], restaurants: {} });
  // the rate through the REAL CLI core: effective 30 days ago is refused (never retro), so it is written while "now" is 30 days back
  const RATE_AT = NOW - 30 * DAY;
  await appendRate(rtdb, '_default', { bp: 1000, effective_from: RATE_AT }, () => rtdb.ref('ledger_settings/commission/_default').push().key, () => RATE_AT - 2 * 3600000);

  // sources from the real writers
  const cashId = `lr_cash_${NOW}`;
  const b = { restaurant_id: RID, order_id: cashId, customer_name: 'Ledger S5', customer_phone: '99550001', customer_email: 'lr@example.com', items_text: '1x Margherita', order_type: 'delivery', payment_method: 'cash',
    items: [{ name: 'Margherita', qty: 1, price: 0 }], lat: HUB.lat + 1 / 111.195, lng: HUB.lng, address_detected: 'Col. Prueba', address_details: 'Casa 1', pin_confirmed: true, entry_mode: 'app' };
  const r = await post(app.createOrder, b, { ...APP_HDR, 'x-firebase-id-token': 'lrmember' });   // a MEMBER: guests are card-only (guest_cash_not_allowed)
  assert.strictEqual(r.status, 200, `premise: the real createOrder (${r.text.slice(0, 200)})`);
  await rtdb.ref(`orders/${cashId}`).update({ status: 'delivered', delivered_at: NOW - 3600000 });   // the dispatcher's status write
  await hostedOrder('lr_paid', NOW - 2 * DAY);
  await hostedOrder('lr_void', NOW - 2 * DAY, { cancel: true });
  await hostedOrder('lr_twice', NOW - 3 * DAY, { aid: 'a_lr_twice_1' });
  await rtdb.ref('payment_attempts/a_lr_twice_2').set({ order_id: 'lr_twice', hosted_state: 'created', hosted_order_id: 'lr_twice-a_lr_twice_2', hosted_checkout_url: 'https://pay/y' });
  await handleHostedCallback({ db: rtdb, restaurant: RESTAURANT, buildMaterializeUpdates, alert: () => {}, genToken: () => 'TOK2', client: {}, voidOrRefund: async () => ({ voided: false }) },
    { order: 'lr_twice-a_lr_twice_2', ref: 'R2', status: 'paid', amount: 299, uuid: 'P-twice-2', transaction_id: 'T2', payment_hash: paymentHash('lr_twice-a_lr_twice_2', KEY, SECRET) }, NOW - 3 * DAY + 120000);
  await hostedOrder('lr_late', NOW - 14 * DAY);
  await rtdb.ref('payment_attempts/a_lr_late').update({ status: 'refunded', refunded_at: NOW - 600000 });   // refunded today (the late event)
  const IDS = [cashId, 'lr_paid', 'lr_void', 'lr_twice', 'lr_late'];

  // capture the SDK's index warnings for the whole run
  const warnings = []; const cap = (orig) => (...a) => { warnings.push(a.map(String).join(' ')); return orig(...a); };
  const ow = console.warn; const ol = console.log; console.warn = cap(ow); console.log = cap(ol);
  let res;
  try { res = await RB.runNightly({ db: rtdb, clock: () => NOW }, { slot: 'run' }); } finally { console.warn = ow; console.log = ol; }

  {   // LR-ORACLE
    assert.strictEqual(res.outcome, 'finished', JSON.stringify(res));
    for (const id of IDS) assert.deepStrictEqual(await proj(id), await oracle(id), `🔴 LR-ORACLE: ${id}`);
    const run = await read(`ledger/run/${RB.hnDate(NOW)}`);
    assert.ok(run && run.finished_at && run.counts.touched >= IDS.length && run.counts.written === run.counts.touched, `run ${JSON.stringify(run)}`);
    const open = (await read('ledger/open')) || {};
    for (const id of IDS) assert.strictEqual(!!open[id], ['open', 'unresolved'].includes((await read(`ledger/orders/${id}/status`))), `🔴 LR-ORACLE: open set ${id}`);
  }
  ok('LR-ORACLE: one run ⇒ every touched order = projectOrder of its real-writer sources, the open set, a finished run record');

  {   // LR-NOOP
    const before = await read('ledger/orders');
    await rtdb.ref(`ledger/run/${RB.hnDate(NOW)}`).remove();
    const r2 = await RB.runNightly({ db: rtdb, clock: () => NOW + 60000 }, { slot: 'run' });
    assert.deepStrictEqual(await read('ledger/orders'), before, '🔴 LR-NOOP: an unchanged re-run rewrote a projection');
    assert.strictEqual(r2.counts.written, 0, `🔴 LR-NOOP: ${JSON.stringify(r2.counts)}`);
  }
  ok('LR-NOOP: a re-run over unchanged sources writes nothing (every projection byte-identical, computed_at included)');

  {   // LR-INDEXED
    const unindexed = warnings.filter((w) => /unspecified index/i.test(w));
    assert.deepStrictEqual(unindexed, [], `🔴 LR-INDEXED: ${unindexed.join(' || ')}`);
    const ctl = []; const ow2 = console.warn; const ol2 = console.log; console.warn = (...a) => { ctl.push(a.join(' ')); }; console.log = (...a) => { ctl.push(a.join(' ')); };
    try { await rtdb.ref('orders').orderByChild('lr_not_indexed').startAt(1).once('value'); await new Promise((s) => setTimeout(s, 200)); } finally { console.warn = ow2; console.log = ol2; }
    assert.ok(ctl.some((w) => /unspecified index/i.test(w)), '🔴 LR-INDEXED control: an undeclared child must warn (the detector is live)');
  }
  ok('LR-INDEXED: every window query runs on a declared index (no unspecified-index warning); the undeclared control does warn');

  {   // LR-ALARM
    const date = RB.hnDate(NOW + 2 * DAY);
    await rtdb.ref(`ledger/run/${date}`).set({ started_at: NOW, attempt: 1, stopped: 'time_cap' });
    const failing = { ref: (p) => (p === 'ledger_settings/commission' ? { once: async () => { throw Object.assign(new Error('x'), { code: 'EFAIL' }); } } : rtdb.ref(p)) };
    await RB.runNightly({ db: failing, clock: () => NOW + 2 * DAY }, { slot: 'safety' });
    await rtdb.ref(`ledger/run/${date}`).set({ started_at: NOW, attempt: 2, stopped: 'EFAIL' });
    await RB.runNightly({ db: failing, clock: () => NOW + 2 * DAY }, { slot: 'safety' });
    const alerts = Object.entries((await read('dispatcher_alerts')) || {}).filter(([k]) => k.startsWith('ledger_run_'));
    assert.strictEqual(alerts.length, 1, `🔴 LR-ALARM: ${alerts.map(([k]) => k)}`);
    assert.deepStrictEqual([alerts[0][1].type, alerts[0][1].reasons], [RB.ALERT_TYPE, ['unfinished']]);
  }
  ok('LR-ALARM: the safety slot ending unfinished twice the same day ⇒ ONE create-once alert, type contabilidad_sombra, codes and counts only');
  console.log(`ledger-rebuild(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { process.stderr.write(`ledger-rebuild(emulator): FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
