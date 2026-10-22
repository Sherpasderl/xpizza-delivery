'use strict';
// S3b — PixelPay return routing as DATA, end to end on the emulator through the REAL chargeOnlineOrder: the complete / cancel
// URLs handed to the (stubbed) PixelPay create carry the brand's base from platform/sites.json pay_return — byte-identical to
// before for x_pizza (env || the netlify default) and la_musa (its env, fail-closed when unset) — and the cancel URL now
// carries the SAME poll token as complete (a paid order landing on cancel verifies with its stash cleared). entry_mode
// 'app' fails closed until an app deployment exists. (Branch-brand selection and the one precedence rule are unit-proven:
// pixelpay-return-url.test.js.)
// Run: npm run test:s3b-return
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 's3b-secret';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const HOSTED = [];
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { HOSTED.push({ complete: q.completeUrl, cancel: q.cancelUrl }); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s3b-return: FAILED — exited without completing'); process.exitCode = 1; } });

function post(handler, body) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}` }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
async function wipe() {
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: the RTDB handle resolves to ${url}`);
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe: Firestore is not the local emulator');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
const LINE = { x_pizza: { name: 'Margherita', qty: 1, price: 0 }, la_musa: { id: 'rice_02', name: 'rice_02', qty: 1, price: 0 } };
let PH = 0;
const body = (rid, extra = {}) => ({ restaurant_id: rid, order_id: `s3b_${rid}_${PH += 1}_${Date.now()}`, customer_name: 'S3b Return', customer_phone: `9977${String(PH).padStart(4, '0')}`,
  customer_email: 's3b@example.com', items_text: `1x ${LINE[rid].name}`, order_type: 'pickup', payment_method: 'online', items: [LINE[rid]], ...extra });
async function card(rid, extra) {
  await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); HOSTED.length = 0;
  const r = await post(app.chargeOnlineOrder, body(rid, extra));
  return { ...r, hosted: HOSTED.slice() };
}
const urlOf = (s) => { const u = new URL(s); return { base: u.origin + u.pathname.replace(/\/$/, ''), pay: u.searchParams.get('pay'), order: u.searchParams.get('order'), t: u.searchParams.get('t') }; };

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) {
    await fs.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
    const seed = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 's3b-seed' });
    await publishVersion(fs, rid, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: HOURS });
  }

  // 1. x_pizza — env unset → the netlify default; env set → that base (trailing slash stripped); cancel carries the poll token
  delete process.env.PIXELPAY_RETURN_URL;
  const a = await card('x_pizza');
  assert.ok(a.status === 200 && a.hosted.length === 1, `x_pizza checkout (${a.text.slice(0, 200)})`);
  const ac = urlOf(a.hosted[0].complete), ax = urlOf(a.hosted[0].cancel);
  assert.deepStrictEqual([ac.base, ac.pay, ax.base, ax.pay], ['https://xpizzaorders.netlify.app', 'complete', 'https://xpizzaorders.netlify.app', 'cancel'], 'x_pizza (env unset) → the netlify default, byte-identical');
  assert.ok(a.json.poll_token && ac.t === a.json.poll_token && ax.t === a.json.poll_token && ax.order === ac.order, '🔴 the cancel URL carries the SAME poll token as complete (and as the response)');
  process.env.PIXELPAY_RETURN_URL = 'https://xp.example/';
  const b = await card('x_pizza');
  assert.deepStrictEqual([urlOf(b.hosted[0].complete).base, urlOf(b.hosted[0].cancel).base], ['https://xp.example', 'https://xp.example'], 'x_pizza env set → that base');
  ok('x_pizza: env unset → https://xpizzaorders.netlify.app, env set → its base (as before); cancel now carries the poll token');

  // 2. la_musa — its own env; unset → fail-closed exactly as before (500 Payment not configured), no checkout
  process.env.PIXELPAY_RETURN_URL_LA_MUSA = 'https://lm.example';
  const c = await card('la_musa');
  assert.deepStrictEqual([c.status, urlOf(c.hosted[0].complete).base, urlOf(c.hosted[0].cancel).t === c.json.poll_token], [200, 'https://lm.example', true], `la_musa → its base (${c.text.slice(0, 160)})`);
  delete process.env.PIXELPAY_RETURN_URL_LA_MUSA;
  const d = await card('la_musa');
  assert.deepStrictEqual([d.status, d.json && d.json.error, d.hosted.length], [500, 'Payment not configured', 0], '🔴 la_musa unset → fail-closed (never the x_pizza base)');
  ok('la_musa: its env → its base; unset → 500 Payment not configured, no checkout (never X Pizza\'s site) — as before');

  // 3. entry_mode 'app' → fail-closed until an app deployment exists; an unknown mode → direct
  const e = await card('x_pizza', { entry_mode: 'app' });
  assert.deepStrictEqual([e.status, e.hosted.length], [500, 0], `entry_mode app → fail-closed (${e.text.slice(0, 160)})`);
  const f = await card('x_pizza', { entry_mode: 'kiosk' });
  assert.deepStrictEqual([f.status, urlOf(f.hosted[0].complete).base], [200, 'https://xp.example'], 'an unknown entry_mode → direct');
  ok('entry_mode: app → fail-closed (no app deployment yet); unknown → direct');

  FINISHED = true;
  console.log(`\ns3b-return: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('s3b-return FAILED:', e && (e.stack || e)); process.exit(1); });
