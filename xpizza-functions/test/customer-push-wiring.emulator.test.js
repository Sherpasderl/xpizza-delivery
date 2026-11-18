'use strict';
/**
 * PLAN-3a-capp-push-tokens r0 §2 — the 4 customer-push endpoints AS DEPLOYED: the exports of index.js (its makeCustomerPush call
 * with index.js's own getDatabase / getAuth / checkRateLimit) over REAL HTTP through Express (what onRequest hands a function),
 * against the REAL RTDB emulator. The capp's api (customer-app/capp-signup-api.js) calls exactly these names with
 * ?context=platform and the ID token in the x-firebase-id-token header. Run: npm run test:push-wiring
 *   Token verification is stubbed at the Admin boundary (Auth.prototype.verifyIdToken): only the tokens this test minted verify,
 *   anything else throws — as production rejects an unsigned token. Synthetic ids only; no token or hash is printed.
 *   PW-REGISTER · PW-GETPREFS · PW-SETPREFS · PW-UNREGISTER — one cell per export, FIRST (each export's mutant dies at its own cell);
 *   then PW-AUTH — no token / an unminted / a handheld one ⇒ 401 on all 4, nothing written; PW-CORS — the account origins, never a stranger.
 */
require('./_emulator-required')('database');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

const assert = require('assert');
const http = require('http');
require('../lib/admin');
const { getDatabase } = require('firebase-admin/database');
const { Auth } = require('firebase-admin/auth');
const CP = require('../customer-push');
const PP = require('../marketing/push-policy');

const MINTED = new Map();
Auth.prototype.verifyIdToken = async function (t) {
  if (!MINTED.has(t)) throw Object.assign(new Error('unminted'), { code: 'auth/argument-error' });
  return MINTED.get(t);
};
const mint = (uid, claims = { customer: true }) => { const t = `idt.${uid}.${MINTED.size}`; MINTED.set(t, { uid, ...claims }); return t; };

const fns = require('../index');
const NAMES = ['registerCustomerPushToken', 'unregisterCustomerPushToken', 'setCustomerPushPrefs', 'getCustomerPushPrefs'];

const db = getDatabase();
const U = 'u_' + 'w'.repeat(24);
const TOKEN = 'fcm_wiring_device_' + 'k'.repeat(40);
const INSTALL = 'inst_wiring_' + 'm'.repeat(16);
let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const cell = async (name, fn) => { try { await fn(); } catch (e) { console.log(`  ✗ ${name}`); throw new Error(`🔴 ${name}: ${e && e.message}`); } ok(name); };
const val = async (p) => (await db.ref(p).once('value')).val();
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ push-wiring: exited without completing (a hang)\n'); process.exitCode = 1; } });

(async () => {
  await db.ref('/').set(null);
  // Express, as the deploy: onRequest hands each function an Express req/res with the JSON body already parsed
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.all('/:fn', (req, res) => {
    const f = fns[req.params.fn];
    if (typeof f !== 'function') return res.status(404).json({ wiring: 'absent' });
    return f(req, res);
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (fn, { method = 'POST', body, tok, origin } = {}) => {
    const headers = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(tok ? { 'x-firebase-id-token': tok } : {}), ...(origin ? { origin } : {}) };
    const r = await fetch(`${base}/${fn}?context=platform`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let json = null; try { json = await r.json(); } catch (_) { json = null; }
    return { status: r.status, json, headers: r.headers };
  };
  const leaks = (j) => { const s = JSON.stringify(j); return s.includes(TOKEN) || s.includes(CP.hashOf(TOKEN)); };
  try {
    const tok = mint(U);
    const hash = CP.hashOf(TOKEN);

    await cell('PW-REGISTER: registerCustomerPushToken registers THIS device for the verified uid and initializes prefs (rev 1, push offers OFF)', async () => {
      const r = await call('registerCustomerPushToken', { tok, body: { token: TOKEN, platform: 'android', app_build: '2.4.1', install_id: INSTALL, pedidos: true, promociones: false } });
      assert.strictEqual(r.status, 200, `status ${r.status} ${JSON.stringify(r.json && r.json.reason)}`);
      assert.deepStrictEqual(r.json, { ok: true, prefs: { pedidos: true, promociones: false, rev: 1 } });
      assert.strictEqual(r.headers.get('cache-control'), 'no-store');
      const rec = await val(`customer_push_tokens/${hash}`);
      assert.ok(rec && rec.uid === U && rec.token === TOKEN && rec.platform === 'android' && rec.install_id === INSTALL, 'the token record is this uid\'s');
      const p = await val(`customer_push_prefs/${U}`);
      assert.deepStrictEqual([p && p.rev, p && p.pedidos, p && p.promociones], [1, true, false]);
      assert.ok(!leaks(r.json), 'no token or hash in the reply');
    });

    await cell('PW-GETPREFS: getCustomerPushPrefs (GET) returns the stored prefs + the push policy limits (the DEFAULTS when never configured)', async () => {
      const r = await call('getCustomerPushPrefs', { method: 'GET', tok });
      assert.strictEqual(r.status, 200, `status ${r.status}`);
      assert.deepStrictEqual(r.json, { ok: true, prefs: { pedidos: true, promociones: false, rev: 1 }, limits: { ...PP.DEFAULTS } });
      assert.ok(!leaks(r.json), 'no token or hash in the reply');
    });

    await cell('PW-SETPREFS: setCustomerPushPrefs is the rev-CAS write — expected_rev 1 ⇒ rev 2 stored; a stale rev ⇒ 409 stale_prefs with the current prefs', async () => {
      const r = await call('setCustomerPushPrefs', { tok, body: { pedidos: false, promociones: false, expected_rev: 1 } });
      assert.strictEqual(r.status, 200, `status ${r.status}`);
      assert.deepStrictEqual(r.json, { ok: true, prefs: { pedidos: false, promociones: false, rev: 2 } });
      const p = await val(`customer_push_prefs/${U}`);
      assert.deepStrictEqual([p.rev, p.pedidos, p.promociones], [2, false, false]);
      const s = await call('setCustomerPushPrefs', { tok, body: { pedidos: true, promociones: false, expected_rev: 1 } });
      assert.deepStrictEqual([s.status, s.json && s.json.reason, s.json && s.json.prefs], [409, 'stale_prefs', { pedidos: false, promociones: false, rev: 2 }]);
      assert.strictEqual((await val(`customer_push_prefs/${U}`)).rev, 2, 'the stale write changed nothing');
    });

    await cell('PW-UNREGISTER: unregisterCustomerPushToken clears the caller\'s own registration (idempotent); the prefs stay', async () => {
      const r = await call('unregisterCustomerPushToken', { tok, body: { token: TOKEN } });
      assert.deepStrictEqual([r.status, r.json], [200, { ok: true }]);
      assert.strictEqual(await val(`customer_push_tokens/${hash}`), null, 'the registration is gone');
      assert.strictEqual((await val(`customer_push_prefs/${U}`)).rev, 2, 'prefs untouched');
      const again = await call('unregisterCustomerPushToken', { tok, body: { token: TOKEN } });
      assert.deepStrictEqual([again.status, again.json], [200, { ok: true }], 'idempotent');
    });

    await cell('PW-AUTH: no token / an unminted token / a handheld token ⇒ 401 on all 4 exports, nothing written', async () => {
      const before = [await val('customer_push_tokens'), await val('customer_push_prefs')];
      const handheld = mint('u_' + 'h'.repeat(24), { customer: true, handheld: true });
      for (const fn of NAMES) {
        const method = fn === 'getCustomerPushPrefs' ? 'GET' : 'POST';
        const body = { registerCustomerPushToken: { token: TOKEN, platform: 'ios', app_build: '1.0.0', install_id: INSTALL, pedidos: true, promociones: false },
          unregisterCustomerPushToken: { token: TOKEN }, setCustomerPushPrefs: { pedidos: true, promociones: false, expected_rev: 0 } }[fn];
        for (const t of [null, 'idt.forged', handheld]) {
          const r = await call(fn, { method, body, tok: t });
          assert.notStrictEqual(r.status, 404, `${fn} is not exported by index.js`);
          assert.deepStrictEqual([r.status, r.json && r.json.reason], [401, 'unauthenticated'], `${fn} with ${t ? 'a bad' : 'no'} token`);
        }
      }
      assert.deepStrictEqual([await val('customer_push_tokens'), await val('customer_push_prefs')], before, 'nothing written by a refused call');
    });

    await cell('PW-CORS: the 4 exports answer the account origins (the capp\'s signup family) and never a stranger origin', async () => {
      for (const fn of NAMES) {
        const pre = async (origin) => fetch(`${base}/${fn}?context=platform`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-firebase-id-token' } });
        const good = await pre('https://orders.xpizza.hn');
        assert.strictEqual(good.headers.get('access-control-allow-origin'), 'https://orders.xpizza.hn', `${fn}: an account origin is allowed`);
        const bad = await pre('https://evil.example');
        assert.notStrictEqual(bad.headers.get('access-control-allow-origin'), 'https://evil.example', `${fn}: a stranger origin is refused`);
        assert.notStrictEqual(bad.headers.get('access-control-allow-origin'), '*', `${fn}: never a wildcard`);
      }
    });

    FINISHED = true;
    console.log(`\npush-wiring: OK (${n})`);
  } finally {
    server.close();
  }
  process.exit(0);
})().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
