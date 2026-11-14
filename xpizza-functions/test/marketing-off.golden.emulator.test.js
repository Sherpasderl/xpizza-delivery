'use strict';
// PLAN-5f-marketing-price r0 — the OFF GOLDENS (advisor 11-14): with offers OFF — and an ACTIVE offer in the mirror — the core money
// surfaces are BYTE-EQUAL to the base (ae7ec7e35, before the price path): the quote response, the SIGNED quote payload and the stored
// order, for a platform-factura cash cart, the same restaurant's card (pending record + the PixelPay amount) and a non-factura cash cart.
//   MKT_GOLDEN_CAPTURE=1 in a checkout of the BASE writes test/marketing-off.base.golden.json; the candidate compares. The SAME file runs
//   on both (3a's offer cores exist on the base; the price path does not). Volatile values (clock, nonces, tokens) are normalized.
// Run: npm run test:marketing-off-golden
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const fsys = require('fs');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'mkt-off-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'mkt-off-quote-secret';
process.env.OTP_SALT = process.env.OTP_SALT || 'c'.repeat(40);
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push(Number(q.amountLempiras)); return { ok: true, url: 'https://pay.test/x' }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const ROOT = path.join(__dirname, '..', '..');
const { adaptMenu } = require(path.join(ROOT, 'customer-app/capp-menu.js'));
const { createCart } = require(path.join(ROOT, 'customer-app/capp-cart.js'));
const { serialize } = require(path.join(ROOT, 'customer-app/capp-serialize.js'));
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { makeRtdbMirrorReader } = require('../catalog/snapshot-fallback');
const { buildPublicMenu } = require('../catalog/public-menu');
const { publishThirdBrand, THIRD } = require('../contract/third-brand');
const { verifyQuoteToken } = require('../quote-token');
const R = require('../access/roster');
const CFG = require('../marketing/config');
const C = require('../marketing/offers-core');

const GOLDEN = path.join(__dirname, 'marketing-off.base.golden.json');
const CAPTURE = process.env.MKT_GOLDEN_CAPTURE === '1';
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('marketing-off-golden: FAILED — exited without completing'); process.exitCode = 1; } });

function post(handler, body) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}` }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
async function wipe() {
  assert.match(rtdb.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, '🔴 refusing to wipe a non-emulator RTDB');
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe a non-emulator Firestore');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
}
// volatile values: the clock, nonces, attempt ids, tokens — replaced by a marker so the comparison is about money and shape
const VOLATILE = /(_at$|_ms$|^ts$|time|token|attempt_id|quote_id|nonce|uuid|^at$|version_id$)/i;   // version_id: each publish mints its own (v-<ms>-<random>)
function norm(v, k = '') {
  if (VOLATILE.test(k) && v != null) return '<v>';
  if (typeof v === 'number' && v > 1e12) return '<ms>';
  if (Array.isArray(v)) return v.map((x) => norm(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((kk) => [kk, norm(v[kk], kk)]));
  return v;
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
const HUB = { lat: 14.1, lng: -87.2 }; const PIN = { lat: HUB.lat + 1 / 111.195, lng: HUB.lng };
const OWNER = 'ownerMko1'; const MENU = {}; const BRAND = { x_pizza: 'bxp', [THIRD]: 'bth' };
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
const bodyOf = (rid, method, s, n, extra = {}) => ({ restaurant_id: rid, order_id: `mko_${rid}_${method}_${n}`, customer_name: 'Mko', customer_phone: `99770${n}00`, customer_email: 'm@example.com',
  order_type: 'delivery', payment_method: method, lat: PIN.lat, lng: PIN.lng, pin_confirmed: true, address_detected: 'Calle', address_details: 'portón', items: s.items, items_text: s.items_text, entry_mode: 'app', ...extra });
const quote = (rid, items) => post(app.quoteOrder, { restaurant_id: rid, items, mode: 'delivery', pin: { ...PIN, confirmed: true }, entry_mode: 'app' });
const cartOf = (rid, qty) => { const m = MENU[rid]; const d = m.dishes.find((x) => !x.launcher && !(m.weekendOnlyCats.has(String(x.cat)) || m.pickupOnlyCats.has(String(x.cat)))); const c = createCart(m); c.add(d.key, [], qty); return serialize(c, m); };
const offerDeps = () => ({ db: rtdb, verifyIdToken: async (t) => { if (t !== `t-${OWNER}`) throw new Error('bad'); return { uid: OWNER }; }, now: () => Date.now(), readMirror: makeRtdbMirrorReader(rtdb), readCategoryMenu: async () => { throw new Error('none'); } });
const oreq = (rid, body) => ({ method: 'POST', body: { rid, ...body }, get: (h) => (h === 'authorization' ? `Bearer t-${OWNER}` : undefined) });
const writeCfg = async (on) => { const cur = (await rtdb.ref('platform_config/marketing').get()).val();
  await rtdb.ref('platform_config/pending_sweep_exit').set({ at: 1, by: 'test' });   // the owner's go-live marker (PLAN-5f-pending-sweep r1 §4)
  assert.strictEqual((await CFG.writeMarketingConfig(rtdb, { expected: cur ? cur.policy_version : 0, config: { offers_enabled: on, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: Date.now() })).ok, true, 'premise: config'); };

(async () => {
  await wipe();
  await fs.collection('restaurants').doc('x_pizza').set({ name: 'x_pizza', pricing_key_mode: 'name', active: true, schema_version: 2 });
  const seed = buildPublishCandidate('x_pizza', { activeVersionId: null }, { source_sha: 'mkt-off-seed' });
  await publishVersion(fs, 'x_pizza', seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await publishThirdBrand(fs, { mirror: makeRtdbMirror(rtdb) });
  for (const rid of ['x_pizza', THIRD]) {
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, hours: HOURS, brand_id: BRAND[rid] });
    await rtdb.ref(`brands/${BRAND[rid]}`).set({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'on', since: 1 } });
    assert.strictEqual((await R.mutateRoster({ db: rtdb, now: () => 1 }, BRAND[rid], { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'Dueña', email: 'd@m.hn' } })).ok, true, 'premise: owner');
    const m = await buildPublicMenu(fs, rid, { known: new Set([rid]), isActive: async () => true });
    MENU[rid] = adaptMenu({ rid: m.rid, representation_version: m.representation_version, menu: m.body });
  }
  await rtdb.ref('platform_config/delivery_pricing').set({ policy_version: 1, bands: [{ max_km: 2, cents: 3000 }], restaurants: { x_pizza: { active: true, free_delivery: false }, [THIRD]: { active: true, free_delivery: false } } });
  // an ACTIVE offer on both restaurants (written while ON), then the switch OFF
  await writeCfg(true);
  for (const rid of ['x_pizza', THIRD]) {
    const s = await C.marketingOfferSaveCore(offerDeps(), oreq(rid, { expected_rev: 0, offer: { name: 'Oferta', type: 'pct', params: { pct: 20, max_cents: 100000 }, audience: 'all', branches: [rid],
      schedule: { start: Date.now(), end: Date.now() + 30 * 86400000, days: [0, 1, 2, 3, 4, 5, 6] }, caps: { redemptions: null, spend_cents: null, weekly: false } } }));
    assert.strictEqual(s.status, 200, 'premise: offer saved');
    assert.strictEqual((await C.marketingOfferSetStateCore(offerDeps(), oreq(rid, { offer_id: s.body.offer.id, to: 'active', expected_rev: 1 }))).status, 200, 'premise: offer active');
  }
  await writeCfg(false);

  const got = {};
  const scenario = async (name, rid, method, qty, n) => {
    const s = cartOf(rid, qty);
    await clean(); CHARGED.length = 0;
    const q = await quote(rid, s.items);
    assert.ok(q.json && q.json.ok, `${name}: quote`);
    const v = verifyQuoteToken(q.json.quote_token, process.env.QUOTE_TOKEN_SECRET, Date.now());
    assert.ok(v.ok, `${name}: the token verifies`);
    const b = bodyOf(rid, method, s, n, { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents });
    await clean();
    const r = await post(method === 'cash' ? app.createOrder : app.chargeOnlineOrder, b);
    assert.strictEqual(r.status, 200, `${name}: placed`);
    const qj = { ...q.json }; delete qj.quote_token; got[name] = norm({ quote: qj, signed: v.payload, order: (await rtdb.ref(`orders/${b.order_id}`).get()).val(), charged: CHARGED.slice() });
  };
  await scenario('x_pizza cash (platform factura)', 'x_pizza', 'cash', 2, 1);
  await scenario('x_pizza card (pending record)', 'x_pizza', 'online', 3, 2);
  await scenario('third-brand cash (non-factura)', THIRD, 'cash', 2, 3);

  if (CAPTURE) {
    fsys.writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + '\n');
    console.log(`marketing-off-golden: CAPTURED ${Object.keys(got).length} scenarios → ${path.basename(GOLDEN)}`);
  } else {
    const g = JSON.parse(fsys.readFileSync(GOLDEN, 'utf8'));
    assert.deepStrictEqual(Object.keys(got), Object.keys(g), 'the scenarios');
    for (const k of Object.keys(g)) {
      for (const part of ['quote', 'signed', 'order', 'charged']) assert.deepStrictEqual(got[k][part], g[k][part], `🔴 OFF golden — ${k}: ${part} differs from the base capture`);
      console.log(`  ✓ ${k}: quote, signed payload, stored order${k.includes('card') ? ', PixelPay amount' : ''} byte-equal to the base`);
    }
    console.log(`marketing-off-golden: OK (${Object.keys(g).length})`);
  }
  FINISHED = true;
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
