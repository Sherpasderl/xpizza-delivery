'use strict';
// P-SELFUPDATE — CORS PREFLIGHT per endpoint per origin, through the REAL exported handlers (the v2 `cors` option runs
// before any handler code), with a manifest that carries a SYNTHETIC THIRD order deployment. Also asserts the
// X-Client-* headers the shared module sends are allowed on every order-site endpoint.
// Run: node cors-preflight.test.js        (no emulator: a preflight never reaches the database)
const assert = require('assert');
const http = require('http');
const path = require('path');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'cors-secret';

// inject the manifest BEFORE index.js loads: today's deployments + a synthetic third merchant
const sitesPath = require.resolve('./platform/sites.json');
const real = require('./platform/sites.json');
const synth = JSON.parse(JSON.stringify(real));
synth.deployments.push({ id: 'orders-synth', app: 'orders', folder: 'synth-orders', entrypoints: ['index.html'], context: 'synthetic_3', origins: ['https://orders.synthetic.test'] });
require.cache[sitesPath] = { id: sitesPath, filename: sitesPath, loaded: true, children: [], paths: [], exports: synth };
const app = require('./index.js');

const XPIZZA = 'https://orders.xpizza.hn', LAMUSA = 'https://orders.lamusa.hn', SYNTH = 'https://orders.synthetic.test', EVIL = 'https://evil.example';
// S2-srv-app: the customer APP's origin(s), read from the manifest (never a host literal; PLAN-capp-S2-r4 §2.1a)
const APP_ORIGINS = real.deployments.filter((d) => d.app === 'orders' && d.context === 'platform').flatMap((d) => d.origins);
const CLIENT_HEADERS = 'content-type,x-client-app,x-client-deployment,x-client-build,x-client-compat';

function preflight(handler, origin) {
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => handler(req, res)).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': CLIENT_HEADERS } });
        const out = { status: r.status, allowOrigin: r.headers.get('access-control-allow-origin'), allowHeaders: (r.headers.get('access-control-allow-headers') || '').toLowerCase() };
        await r.text().catch(() => {});
        s.close(() => resolve(out));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ORDER_SITE_LISTED = ['quoteOrder', 'quoteRedemption', 'requestOtp', 'verifyOtp', 'deleteAccount', 'getPublicMenu'];
const ORDER_SITE_OPEN = ['createOrder', 'chargeOnlineOrder', 'reportClientVersion'];   // reportClientVersion: every deployment's pages report → cors: true
const EXTRA = (process.env.CORS_EXTRA_ENDPOINTS || '').split(',').filter(Boolean);   // later sub-commits add endpoints here

(async () => {
  for (const ep of [...ORDER_SITE_LISTED, ...ORDER_SITE_OPEN, ...EXTRA]) assert.strictEqual(typeof app[ep], 'function', `export ${ep} exists`);
  assert.ok(APP_ORIGINS.length >= 1, 'premise: the manifest declares the app origin(s)');
  for (const ep of ORDER_SITE_LISTED) {
    for (const o of [XPIZZA, LAMUSA, ...APP_ORIGINS, SYNTH]) {
      const r = await preflight(app[ep], o);
      assert.strictEqual(r.allowOrigin, o, `🔴 ${ep}: preflight from configured origin ${o} must be allowed (got ${JSON.stringify(r)})`);
      for (const h of CLIENT_HEADERS.split(',')) assert.ok(r.allowHeaders.includes(h), `${ep} ${o}: request header ${h} allowed`);
    }
    const e = await preflight(app[ep], EVIL);
    assert.ok(e.allowOrigin !== EVIL && e.allowOrigin !== '*', `🔴 ${ep}: an UNCONFIGURED origin must not be allowed (${JSON.stringify(e)})`);
    ok(`${ep}: preflight allowed for x_pizza, la_musa, the customer app AND the synthetic third origin (with the X-Client-* headers); an unconfigured origin is not`);
  }
  // S2-srv-app: widening the customer lists never reaches the PORTAL — its write endpoints refuse the app origin
  for (const ep of ['editCatalog', 'publishEdited']) {
    assert.strictEqual(typeof app[ep], 'function', `export ${ep} exists`);
    for (const o of APP_ORIGINS) {
      const r = await preflight(app[ep], o);
      assert.ok(r.allowOrigin !== o && r.allowOrigin !== '*', `🔴 ${ep}: the customer app origin ${o} must NOT be allowed on a portal write endpoint (${JSON.stringify(r)})`);
    }
    const PORTAL = require('./portal/origins').PORTAL_ORIGINS.find((o) => typeof o === 'string');
    const p = await preflight(app[ep], PORTAL);
    assert.strictEqual(p.allowOrigin, PORTAL, `non-vacuity: ${ep} does allow the portal origin`);
  }
  ok('portal write endpoints (editCatalog, publishEdited) refuse the customer app origin and still allow the portal');
  for (const ep of [...ORDER_SITE_OPEN, ...EXTRA]) {
    for (const o of [XPIZZA, LAMUSA, SYNTH]) {
      const r = await preflight(app[ep], o);
      assert.ok(r.allowOrigin === o || r.allowOrigin === '*', `🔴 ${ep}: preflight from ${o} allowed (cors: true) (${JSON.stringify(r)})`);
      for (const h of CLIENT_HEADERS.split(',')) assert.ok(r.allowHeaders.includes(h), `${ep} ${o}: request header ${h} allowed`);
    }
    ok(`${ep}: cors:true reflects every order origin incl. the synthetic third, X-Client-* headers allowed`);
  }
  console.log(`cors-preflight: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('cors-preflight FAILED:', e); process.exit(1); });
