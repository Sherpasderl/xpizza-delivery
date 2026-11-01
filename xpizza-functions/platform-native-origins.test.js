'use strict';
// PLAN-capp-native-shell §1.1 (Codex #1, P1) — the native shell's WebView origins, SERVER CODE: the manifest's `native` block
// admits EXACTLY capacitor://localhost and https://localhost, only on the platform orders deployment, and feeds ONLY the derived
// CORS lists (never `origins`: the pay-return allowlist, the stamp and the domain swap keep https sites only).
// The proof uses ACTUAL request headers: each list is handed to firebase-functions' own v2 onRequest({ cors }) — the production
// wrapper — served over a real socket; a preflight and a credentialed POST from each native origin are admitted with the exact
// echo, an unlisted origin is not. Run: node platform-native-origins.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const { onRequest } = require('firebase-functions/v2/https');
const M = require('./platform-manifest');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = () => JSON.parse(JSON.stringify(M.PLATFORM.sites));
const appOf = (m) => m.deployments.find((d) => d.app === 'orders' && d.context === M.PLATFORM_CONTEXT);
const formOf = (m) => m.deployments.find((d) => d.app === 'orders' && d.context !== M.PLATFORM_CONTEXT);

(async () => {
  // 1. the live manifest: both native origins, in the CORS lists AFTER every site origin, never in any deployment's `origins`
  assert.deepStrictEqual(M.NATIVE_ORIGINS, ['capacitor://localhost', 'https://localhost']);
  assert.deepStrictEqual(appOf(M.PLATFORM.sites).native, { origins: [...M.NATIVE_ORIGINS] }, 'premise: the app deployment declares both');
  for (const L of [M.PLATFORM.ACCOUNT_ORIGINS, M.PLATFORM.PUBLIC_MENU_ORIGINS]) assert.deepStrictEqual(L.slice(-2), [...M.NATIVE_ORIGINS], 'the native origins come last');
  const siteOrigins = M.PLATFORM.sites.deployments.flatMap((d) => d.origins);
  assert.ok(M.NATIVE_ORIGINS.every((o) => !siteOrigins.includes(o)), '🔴 a native origin is in a deployment\'s `origins` (pay-return / stamp / domain swap)');
  ok('the live manifest: both native origins, last in ACCOUNT_ORIGINS and PUBLIC_MENU_ORIGINS, in no deployment\'s origins');

  // 2. the native block is NARROW: exact members, the app deployment only, nothing else accepted
  const bad = (mut, re, why) => { const c = clone(); mut(c); assert.throws(() => M.loadPlatform(c, M.PLATFORM.compat), re, why); };
  for (const o of ['capacitor://evil', 'capacitor://localhost:8080', 'capacitor://localhost/', 'http://localhost', 'https://localhost:8443', 'ionic://localhost', '*', 'https://*.localhost', 'CAPACITOR://localhost'])
    bad((c) => { appOf(c).native = { origins: [o] }; }, /is not one of/, o);
  bad((c) => { appOf(c).native = { origins: ['capacitor://localhost', 'capacitor://localhost'] }; }, /unique/);
  bad((c) => { appOf(c).native = { origins: [] }; }, /non-empty/);
  bad((c) => { appOf(c).native = { origins: 'capacitor://localhost' }; }, /non-empty array/);
  bad((c) => { appOf(c).native = { origins: ['capacitor://localhost'], extra: 1 }; }, /native must be \{ origins \}/);
  bad((c) => { formOf(c).native = { origins: ['capacitor://localhost'] }; }, /only for the platform orders deployment/);
  bad((c) => { c.deployments.find((d) => d.app === 'portal').native = { origins: ['capacitor://localhost'] }; }, /only for the platform orders deployment/);
  bad((c) => { appOf(c).origins = [...appOf(c).origins, 'capacitor://localhost']; }, /not an exact https origin/, 'the HTTPS-only rule still holds for `origins`');
  ok('refused: a non-member / port / path / http / wildcard / other-scheme native origin, duplicates, empty, extra keys, a native block off the app deployment, capacitor:// in `origins`');

  // 3. absent block ⇒ the lists are exactly the site origins (today's shape before §1.1)
  const none = clone(); delete appOf(none).native;
  const P0 = M.loadPlatform(none, M.PLATFORM.compat);
  assert.deepStrictEqual(P0.ACCOUNT_ORIGINS, M.PLATFORM.ACCOUNT_ORIGINS.slice(0, -2));
  ok('no native block ⇒ ACCOUNT_ORIGINS / PUBLIC_MENU_ORIGINS are the site origins only');

  // 4. ACTUAL headers through the production wrapper (onRequest({ cors }) → the cors middleware), over a real socket
  const serve = (cors) => new Promise((resolve) => {
    const fn = onRequest({ cors }, (req, res) => res.status(200).json({ ok: true }));
    const app = express(); app.all('*', (req, res) => fn(req, res));
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  const call = (port, method, origin, extra = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/requestOtp', method, headers: { Origin: origin, ...extra } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, h: res.headers })); });
    r.on('error', reject); if (method === 'POST') r.write('{}'); r.end();
  });
  for (const [name, list] of [['ACCOUNT_ORIGINS', M.PLATFORM.ACCOUNT_ORIGINS], ['PUBLIC_MENU_ORIGINS', M.PLATFORM.PUBLIC_MENU_ORIGINS]]) {
    const s = await serve(list); const port = s.address().port;
    try {
      for (const origin of M.NATIVE_ORIGINS) {
        const pre = await call(port, 'OPTIONS', origin, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' });
        assert.strictEqual(pre.h['access-control-allow-origin'], origin, `🔴 ${name}: the preflight from ${origin} is not admitted`);
        assert.match(String(pre.h['access-control-allow-methods'] || ''), /POST/, `${name}: POST allowed`);
        assert.match(String(pre.h['access-control-allow-headers'] || ''), /authorization/i, `${name}: the Authorization header is allowed`);
        const post = await call(port, 'POST', origin, { 'Content-Type': 'application/json', Authorization: 'Bearer t' });
        assert.strictEqual(post.status, 200); assert.strictEqual(post.h['access-control-allow-origin'], origin, `🔴 ${name}: the credentialed POST from ${origin} is not readable`);
        assert.match(String(post.h.vary || ''), /Origin/, `${name}: the echo varies by Origin`);
      }
      for (const origin of ['capacitor://evil', 'https://localhost:8443', 'https://evil.example']) {
        const pre = await call(port, 'OPTIONS', origin, { 'Access-Control-Request-Method': 'POST' });
        assert.strictEqual(pre.h['access-control-allow-origin'], undefined, `🔴 ${name}: ${origin} must not be admitted`);
      }
      const site = M.PLATFORM.sites.deployments.find((d) => d.app === 'orders' && d.origins.length).origins[0];
      assert.strictEqual((await call(port, 'OPTIONS', site, { 'Access-Control-Request-Method': 'POST' })).h['access-control-allow-origin'], site, `${name}: the site origins still work`);
    } finally { s.close(); }
    ok(`${name} through onRequest({ cors }): preflight + credentialed POST from both native origins echo exactly; unlisted origins get no grant; a site origin still does`);
  }
  console.log(`platform-native-origins: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
