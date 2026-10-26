'use strict';
// Customer app S2a — the two MANDATORY carry-overs from S2-srv-app (D4c-grill/CARRYOVER-capp-S2a-acceptance.md), in a REAL
// headless Chrome over the DevTools protocol, on the emulator (demo-xpizza):
//
//   T  PLAN-capp-S2-r4 §2.1a — the domain transition. Two local HTTPS origins stand in for the hosts (https://old.capp.test:P and
//      https://new.capp.test:P — separate localStorage by origin), served by a local https server with a throwaway self-signed
//      certificate generated at test time, mapped by --host-resolver-rules, declared in the test manifest as they are (the
//      validator accepts an explicit port; no relaxation). The REAL customer-app/ page (a stamped copy) runs the REAL S2a
//      modules against the REAL chargeOnlineOrder; the PixelPay stub confirms through the REAL writer and redirects to the
//      issued return URL. Cells: pre-switch checkout (env old → switched to new → lands OLD, stash found, polls to placed);
//      an old-host submission after the switch (lands OLD); an old-host submission LONG after (env unset, default = new:
//      still OLD); the control (new host lands NEW).
//   F  PLAN-capp-S2-r4 §2.4 — the client floor ENABLED (platform_config/client_floor/orders): the page's quote / create carry the
//      X-Client-* headers and are admitted; below the floor ⇒ 426 ⇒ the update path, but the reload is REFUSED while a payment is
//      unresolved (the app adapter), and allowed once it is resolved; a header-less request ⇒ 426.
// Run: npm run test:capp-s2a-browser          (CHROME_BIN overrides the browser binary; needs openssl for the throwaway cert)
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const https = require('https');
const os = require('os');
const fsys = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'capp-tr-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'capp-tr-quote-secret';
process.env.PIXELPAY_MERCHANT_EMAIL = process.env.PIXELPAY_MERCHANT_EMAIL || 'pagos@example.com';
const ROOT = path.join(__dirname, '..', '..');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('capp-domain-transition: FAILED — exited without completing'); process.exitCode = 1; } });

// ── a throwaway certificate + one https server for every host (routes by Host) ──
const TMP = fsys.mkdtempSync(path.join(os.tmpdir(), 'capp-tr-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(TMP, 'k.pem'), '-out', path.join(TMP, 'c.pem'), '-days', '1', '-subj', '/CN=capp.test',
  '-addext', 'subjectAltName=DNS:old.capp.test,DNS:new.capp.test,DNS:fn.capp.test'], { stdio: 'pipe' });
const web = express();
const server = https.createServer({ key: fsys.readFileSync(path.join(TMP, 'k.pem')), cert: fsys.readFileSync(path.join(TMP, 'c.pem')) }, web);

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const P = server.address().port;
  const OLD = `https://old.capp.test:${P}`, NEW = `https://new.capp.test:${P}`, FN = `https://fn.capp.test:${P}`;

  // the test manifest: the app deployment declares BOTH hosts (the post-switch state — origins are only ever added), default = NEW,
  // injected BEFORE index.js loads (CORS lists are derived at load)
  const sitesPath = require.resolve('../platform/sites.json');
  const sites = JSON.parse(JSON.stringify(require('../platform/sites.json')));
  const appDep = sites.deployments.find((d) => d.app === 'orders' && d.context === 'platform');
  appDep.origins = [OLD, NEW]; appDep.pay_return = { env: appDep.pay_return.env, default: NEW };
  require.cache[sitesPath] = { id: sitesPath, filename: sitesPath, loaded: true, children: [], paths: [], exports: sites };
  const ENV_KEY = appDep.pay_return.env;

  const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
  stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
  // the PixelPay stub: the hosted page is /pay on the functions host, which confirms through the REAL writer and redirects
  stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => ({ ok: true, url: `${FN}/pay?o=${encodeURIComponent(new URL(q.completeUrl).searchParams.get('order'))}&ret=${encodeURIComponent(q.completeUrl)}` }) }));
  const app = require('../index.js');
  const admin = require('firebase-admin');
  const rtdb = admin.database();
  const fs = admin.firestore();
  const { PLATFORM } = require('../platform-manifest');
  assert.deepStrictEqual(PLATFORM.ACCOUNT_ORIGINS.slice(-2), [OLD, NEW], 'premise: the test hosts are declared app origins (CORS)');
  const { publishVersion } = require('../catalog/catalog-publish');
  const { buildPublishCandidate } = require('../tools/publish-version');
  const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
  const { buildPublicMenu } = require('../catalog/public-menu');
  const { confirmAndMaterialize } = require('../pixelpay-confirm');
  const { buildMaterializeUpdates } = require('../materialize');
  const { adaptMenu } = require(path.join(ROOT, 'customer-app/capp-menu.js'));

  // the stamped REAL page (orders-app identity, a preview stamp: no heartbeat) — copied, so the repo folder is untouched
  const SITE = path.join(TMP, 'customer-app');
  fsys.mkdirSync(SITE);
  for (const f of fsys.readdirSync(path.join(ROOT, 'customer-app'))) if (!/\.test\.mjs$/.test(f)) fsys.copyFileSync(path.join(ROOT, 'customer-app', f), path.join(SITE, f));
  const stamp = require(path.join(ROOT, 'platform/stamp-version.js')).stamp(SITE, { siteName: appDep.netlify_site, commit: 'tr', env: 'preview' });
  assert.ok(stamp.ok, `premise: the page is stamped (${stamp.error})`);
  const VERSION = JSON.parse(fsys.readFileSync(path.join(SITE, 'version.json'), 'utf8'));
  let SERVE_STALE = false;

  // ── routes ──
  const HDRS = [];
  web.use((req, res, next) => {
    const host = (req.headers.host || '').split(':')[0];
    if (host === 'fn.capp.test') return next();
    if (req.path === '/version.json') return res.json(SERVE_STALE ? { ...VERSION, build: `${VERSION.build}x` } : VERSION);
    const rel = req.path === '/' ? 'index.html' : req.path.replace(/^\/+/, '');
    const file = path.join(SITE, rel);
    if (!file.startsWith(SITE) || !fsys.existsSync(file)) return res.status(404).end();
    res.set('cache-control', 'no-store'); return res.sendFile(file);
  });
  web.use(express.json());
  web.use((req, res, next) => { if (/^\/(createOrder|chargeOnlineOrder|quoteOrder)/.test(req.path)) HDRS.push({ ep: req.path.split('/')[1], app: req.headers['x-client-app'] || null, dep: req.headers['x-client-deployment'] || null, compat: req.headers['x-client-compat'] || null }); next(); });
  for (const k of ['quoteOrder', 'createOrder', 'chargeOnlineOrder', 'paymentStatus']) web.use(`/${k}`, app[k]);
  const OPENH = { open: true, start: '00:00', end: '24:00' };
  const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
  const HUB = { lat: 14.1, lng: -87.2 };
  const edgeDeps = { db: rtdb, restaurant: { lat: HUB.lat, lng: HUB.lng, name: 'x_pizza', phone: '+504' }, buildMaterializeUpdates, genToken: () => 'TOK', alert: async () => {},
    client: { voidTransaction: async () => ({ ok: true }) }, getIdentity: async () => ({ active: true, hours: HOURS }), sanitizeText: (x) => String(x || ''), serverTimestamp: 1, voidOrRefund: async () => ({ ok: true }) };
  web.get('/pay', async (req, res) => {   // the "hosted page": the payment succeeds (the real confirm writer), then the redirect
    const id = String(req.query.o); const o = (await rtdb.ref(`orders/${id}`).get()).val();
    await confirmAndMaterialize(edgeDeps, { orderId: id, attemptId: o.active_attempt_id, now: Date.now(), trackingToken: `TT${id.slice(-4)}` });
    res.redirect(302, String(req.query.ret));
  });

  // ── data ──
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: ${url}`);
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
  await fs.collection('restaurants').doc('x_pizza').set({ name: 'x_pizza', pricing_key_mode: 'name', active: true, schema_version: 2 });
  const seed = buildPublishCandidate('x_pizza', { activeVersionId: null }, { source_sha: 'capp-tr-seed' });
  await publishVersion(fs, 'x_pizza', seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await rtdb.ref('restaurants/x_pizza/identity').set({ name: 'x_pizza', phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, hours: HOURS });
  const pm = await buildPublicMenu(fs, 'x_pizza', { known: new Set(['x_pizza']), isActive: async () => true });
  const ENVELOPE = { rid: pm.rid, representation_version: pm.representation_version, menu: pm.body };
  const menu = adaptMenu(ENVELOPE);
  const DISH = menu.dishes.find((d) => !d.launcher && !(menu.weekendOnlyCats.has(String(d.cat)) || menu.pickupOnlyCats.has(String(d.cat)))).key;
  const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };

  // ── Chrome ──
  const chromeBin = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const profile = fsys.mkdtempSync(path.join(os.tmpdir(), 'capp-tr-chrome-'));
  const chrome = spawn(chromeBin, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--ignore-certificate-errors',
    '--host-resolver-rules=MAP *.capp.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => { let buf = ''; const t = setTimeout(() => reject(new Error('Chrome did not start')), 20000); chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } }); });
  const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let mid = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++mid; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  async function tab() {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setTimezoneOverride', { timezoneId: 'America/Tegucigalpa' }, sessionId);
    const ev = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      return r.result.value;
    };
    const loaded = async (pred = 'true') => { for (let i = 0; i < 200; i++) { try { if (await ev(`document.readyState === 'complete' && !!window.CappApi && (${pred})`)) return; } catch (_) {} await new Promise((x) => setTimeout(x, 50)); } throw new Error('page not ready'); };
    const go = async (u) => { await send('Page.navigate', { url: u }, sessionId); await loaded(`location.href.startsWith(${JSON.stringify(u.split('?')[0])})`); };
    return { ev, go, loaded, close: () => send('Target.closeTarget', { targetId }) };
  }
  // the page-side app: the REAL modules, the REAL SherpaClient.fetch (stamped ⇒ X-Client headers)
  const API = (pay) => `CappApi.createApi({ config: { restaurantId: 'x_pizza', orderIdPrefix: 'TR', pendingPayKey: 'tr_pending_pay', hours: Array.from({ length: 7 }, () => [0, 0, 23, 59]),
    endpoints: { quoteOrder: '${FN}/quoteOrder', createOrder: '${FN}/createOrder', chargeOnlineOrder: '${FN}/chargeOnlineOrder', paymentStatus: '${FN}/paymentStatus' } } })`;
  let PH = 0;
  const startCheckout = (pay) => `(async () => {
    const menu = CappMenu.adaptMenu(${JSON.stringify(ENVELOPE)}); const cart = CappCart.createCart(menu); cart.inc(${JSON.stringify(DISH)});
    const s = CappSerialize.serialize(cart, menu);
    window.__api = ${API(pay)};
    const f = CappCheckout.freshFlow(null); CappCheckout.setPin(f, ${HUB.lat + 1 / 111.195}, ${HUB.lng}, true);
    Object.assign(f, { details: 'Portón negro', name: 'Ana TR', phone: '9977${String(PH += 1).padStart(4, '0')}', pay: '${pay}' }); CappCheckout.chooseTip(f, 0);
    const ctx = { restaurantId: 'x_pizza', items: s.items, itemsText: s.items_text, member: null, headers: { Authorization: 'Bearer ${process.env.MAKE_SECRET}' } };
    const q = await window.__api.quote(f, ctx);
    if (q.kind !== 'ok') return { q };
    const out = await window.__api.place({ flow: f, ctx, sig: q.record.sig, expectedNetCents: q.record.resp.net_total_cents });
    return { out, origin: location.origin };
  })()`;
  const finishReturn = `(async () => ({ origin: location.origin, stash: localStorage.getItem('tr_pending_pay'), out: await ${API('online')}.handleReturn(location.search) }))()`;
  const run = async (host, before) => {
    await clean();
    const t = await tab();
    try {
      await t.go(`${host}/`);
      const s = await t.ev(startCheckout('online'));
      assert.strictEqual(s.out && s.out.kind, 'redirect', `premise: the checkout (${JSON.stringify(s)})`);
      if (before) before();
      await t.ev(`(location.href = ${JSON.stringify(s.out.url)}, true)`).catch(() => {});   // the app's redirect to the hosted page
      await t.loaded("new URLSearchParams(location.search).get('pay') === 'complete'");
      return { checkout: s, landed: await t.ev(finishReturn) };
    } finally { await t.close(); }
  };

  let code = 1;
  try {
    // ── T: the domain transition ──
    process.env[ENV_KEY] = OLD;
    const pre = await run(OLD, () => { process.env[ENV_KEY] = NEW; });   // the env switches to NEW while the checkout is open
    assert.deepStrictEqual([pre.landed.origin, !!pre.landed.stash, pre.landed.out.kind], [OLD, true, 'placed'], `🔴 pre-switch checkout: lands on the OLD origin, finds the stash, polls to placed (${JSON.stringify(pre.landed)})`);
    ok('T1 pre-switch: an old-host checkout (env old → switched to new before completion) lands on the OLD origin, finds its stash and polls to placed');

    process.env[ENV_KEY] = NEW;
    const after = await run(OLD);
    assert.deepStrictEqual([after.landed.origin, !!after.landed.stash, after.landed.out.kind], [OLD, true, 'placed'], `🔴 an old-host submission AFTER the switch returns to the OLD origin (${JSON.stringify(after.landed)})`);
    ok('T2 after the switch: env = new, an old-host page starts a fresh checkout ⇒ the return URL is the old origin, it lands there and finds the stash');

    delete process.env[ENV_KEY];
    const late = await run(OLD);
    assert.deepStrictEqual([late.landed.origin, !!late.landed.stash, late.landed.out.kind], [OLD, true, 'placed'], `🔴 LONG after the switch (final manifest, env unset, default = new): the old host still returns home (${JSON.stringify(late.landed)})`);
    ok('T3 long after: both origins declared, env unset and default = new ⇒ an old-host page still quotes, charges and lands on the old origin with its stash');

    const ctl = await run(NEW);
    assert.deepStrictEqual([ctl.landed.origin, !!ctl.landed.stash, ctl.landed.out.kind], [NEW, true, 'placed'], `control: the new host lands on the new host (${JSON.stringify(ctl.landed)})`);
    ok('T4 control: the same flow from the new host lands on the new host');

    // ── F: the client floor ENABLED ──
    const COMPAT = Number(VERSION.compat);
    await rtdb.ref('platform_config/client_floor/orders').set(COMPAT);
    await new Promise((r) => setTimeout(r, 31000));   // the floor cache TTL (client-floor.js FLOOR_TTL_MS)
    await clean(); HDRS.length = 0;
    const t = await tab();
    try {
      await t.go(`${OLD}/`);
      const cash = await t.ev(startCheckout('cash'));
      assert.strictEqual(cash.out && cash.out.kind, 'placed', `at the floor: admitted (${JSON.stringify(cash)})`);
      const sent = HDRS.filter((h) => h.ep === 'quoteOrder' || h.ep === 'createOrder');
      assert.ok(sent.length >= 2 && sent.every((h) => h.app === 'orders' && h.dep === appDep.id && Number(h.compat) === COMPAT), `🔴 the page's quote + create carry the X-Client headers (${JSON.stringify(sent)})`);
      const bare = await t.ev(`fetch('${FN}/createOrder', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ${process.env.MAKE_SECRET}' }, body: JSON.stringify({ restaurant_id: 'x_pizza', order_id: 'TR-BARE-1' }) }).then(async (r) => ({ s: r.status, j: await r.json() }))`);
      assert.deepStrictEqual([bare.s, bare.j.error], [426, 'client_update_required'], '🔴 a header-less request ⇒ 426 (the wrapper is the only admitted path)');
      ok('F1 floor enabled at the page compat: the page\'s quote + create carry X-Client-* and are admitted; a header-less request ⇒ 426');

      await rtdb.ref('platform_config/client_floor/orders').set(COMPAT + 1);
      await new Promise((r) => setTimeout(r, 31000));
      await clean(); SERVE_STALE = true;
      await t.ev(`(window.__marker = 'alive', CappSelfUpdate.register(SherpaClient, { state: () => ({ screen: 'checkout', placing: false, sheetOpen: false }),
        unresolved: () => !!localStorage.getItem('capp:x_pizza:pending_place') || !!localStorage.getItem('tr_pending_pay'), search: () => location.search, snapshot: () => ({}), restore() {} }), true)`);
      const below = await t.ev(startCheckout('online'));
      assert.strictEqual(below.out && below.out.kind, 'update_required', `below the floor ⇒ 426 ⇒ the update path (${JSON.stringify(below)})`);
      await t.ev('SherpaClient.check().then(() => SherpaClient.poke())');
      await new Promise((r) => setTimeout(r, 1500));
      const still = await t.ev(`({ marker: window.__marker, stale: SherpaClient.isStale(), place: !!localStorage.getItem('capp:x_pizza:pending_place') })`);
      assert.deepStrictEqual(still, { marker: 'alive', stale: true, place: true }, '🔴 a payment is unresolved ⇒ the reload is REFUSED (the page stays)');
      await t.ev(`localStorage.removeItem('capp:x_pizza:pending_place'); localStorage.removeItem('tr_pending_pay'); SherpaClient.poke(); true`).catch(() => {});
      let reloaded = false;
      for (let i = 0; i < 60 && !reloaded; i++) { await new Promise((r) => setTimeout(r, 100)); try { reloaded = (await t.ev('window.__marker')) !== 'alive'; } catch (_) {} }
      assert.ok(reloaded, 'non-vacuity: once nothing is unresolved, the same update path DOES reload');
      ok('F2 below the floor: the page gets 426 ⇒ the update path; the reload is REFUSED while a payment is unresolved and happens once it is resolved');
    } finally { await t.close().catch(() => {}); await rtdb.ref('platform_config/client_floor/orders').remove(); }

    FINISHED = true; code = 0;
    console.log(`\ncapp-domain-transition (emulator + Chrome): ${n} passed`);
    console.log(`##CELLS ${n}`);
  } catch (e) {
    console.error('capp-domain-transition FAILED:', e && (e.stack || e));
  } finally {
    try { ws.close(); } catch (_) {}
    chrome.kill('SIGTERM');   // OUR child process, by handle — never a pattern kill
    server.close();
    try { fsys.rmSync(TMP, { recursive: true, force: true }); fsys.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    process.exit(code);
  }
})().catch((e) => { console.error('capp-domain-transition FAILED:', e && (e.stack || e)); process.exit(1); });
