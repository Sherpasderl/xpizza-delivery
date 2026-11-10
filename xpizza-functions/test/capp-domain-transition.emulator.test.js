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
//   F  PLAN-capp-S2-r4 §2.4 — the client floor ENABLED (platform_config/client_floor/orders): the page's quote / charge carry the
//      X-Client-* headers and are admitted; below the floor ⇒ 426 ⇒ the update path, but the reload is REFUSED while a payment is
//      unresolved (the app adapter), and allowed once it is resolved; a header-less request ⇒ 426.
//      F3 (S2a r2 P2 #6): the floor rises between the quote and the FIRST placement ⇒ that send is 426'd before any server write
//      ⇒ its just-minted record is cleared ⇒ the update path DOES reload (nothing unresolved blocks it).
//   U  (S2b r2) the REAL UI in the REAL browser — CappUI mounted on the page, its own clicks, ctxBase + the order-intake key;
//      the device fix from Chrome's geolocation (no pin step); the order is admitted, recorded at the fix and the Total shown.
//      The one browser cell whose request headers are built by the app, not by the test.
//   GUEST CONTRACT (owner 10-27 FINAL; 3a's checkout-guest-gate; re-baselined at the web/guest composition, advisor 2026-11-01):
//      every capp guest here runs as launch will — cfg.guestCardOnly, card only, the email, the WhatsApp code (sent through the
//      REAL sendPlatformOtp to a captured UltraMsg call and read back from the message) ⇒ the checkout ticket ⇒ the charge. F1
//      also proves the server REFUSES a capp guest paying cash (guest_cash_not_allowed) or without an email (guest_email_required).
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
// the capp-GUEST contract (owner 10-27 FINAL: guests are CARD ONLY, with an email and a WhatsApp-verified checkout ticket — 3a's
// checkout-guest-gate): the checkout code is sent through the REAL sendPlatformOtp to a captured UltraMsg call, and read back from
// that message exactly as the customer reads it (the RTDB record holds only its hash)
process.env.OTP_SALT = process.env.OTP_SALT || 'c'.repeat(40);   // otp-lib fails closed at require without a >=32-char salt (a TEST value)
process.env.ULTRAMSG_INSTANCE_ID_PLATFORM = process.env.ULTRAMSG_INSTANCE_ID_PLATFORM || 'tr-instance';
process.env.ULTRAMSG_TOKEN_PLATFORM = process.env.ULTRAMSG_TOKEN_PLATFORM || 'tr-token';
process.env.CHECKOUT_OTP_TEMPLATE = '{code}';
const CODES = [];   // [{ to, code }] — every checkout code the server sent
{ const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (typeof u === 'string' && u.startsWith('https://api.ultramsg.com/')) {
      const q = new URLSearchParams(String(init && init.body || '')); CODES.push({ to: q.get('to'), code: q.get('body') });
      return { ok: true, status: 200, json: async () => ({ sent: 'true', id: `tr-${CODES.length}` }) };
    }
    return realFetch(u, init);
  }; }
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
  // by NAME, not position: the native WebView origins (capp native N1) are appended after the app deployment's origins
  assert.deepStrictEqual(PLATFORM.ACCOUNT_ORIGINS.filter((o) => o === OLD || o === NEW), [OLD, NEW], 'premise: the test hosts are declared app origins (CORS)');
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
  // recursive (customer-app/fixtures/ is a directory since S7a-2): every served file, never a *.test.mjs
  fsys.cpSync(path.join(ROOT, 'customer-app'), SITE, { recursive: true, filter: (src) => !/\.test\.mjs$/.test(src) });
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
  // a CORS preflight (OPTIONS) names the headers in Access-Control-Request-Headers but never carries their values ⇒ not recorded
  web.use((req, res, next) => { if (req.method !== 'OPTIONS' && /^\/(createOrder|chargeOnlineOrder|quoteOrder)/.test(req.path)) HDRS.push({ ep: req.path.split('/')[1], auth: req.headers.authorization === `Bearer ${process.env.MAKE_SECRET}`, app: req.headers['x-client-app'] || null, dep: req.headers['x-client-deployment'] || null, compat: req.headers['x-client-compat'] || null }); next(); });
  for (const k of ['quoteOrder', 'createOrder', 'chargeOnlineOrder', 'paymentStatus', 'requestCheckoutCode', 'verifyCheckoutCode']) web.use(`/${k}`, app[k]);
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
  const clean = async () => { for (const n of ['rate_limits', 'recent_order_content', 'otp_ip', 'otp_budget', 'checkout_otp', 'checkout_tickets']) await rtdb.ref(n).remove(); };
  // the code the server last sent to these digits (the WhatsApp message body IS the code: CHECKOUT_OTP_TEMPLATE = '{code}')
  const codeFor = async (digits) => { for (let i = 0; i < 100; i++) { const c = CODES.filter((x) => x.to && x.to.endsWith(digits)).pop(); if (c) return c.code; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`no checkout code was sent to …${digits}`); };

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
    return { ev, go, loaded, sid: sessionId, close: () => send('Target.closeTarget', { targetId }) };
  }
  // the page-side app: the REAL modules, the REAL SherpaClient.fetch (stamped ⇒ X-Client headers)
  // the app's transport with the capp-GUEST contract ON (cfg.guestCardOnly: card only, the email, the WhatsApp code ⇒ the checkout
  // ticket) — what 3a's guest server requires of every capp guest, and what the packager now refuses to ship without (228c3fc4).
  // { guest: false } is the transport WITHOUT those rules: used only to prove the server REFUSES such a guest
  const EP = `{ quoteOrder: '${FN}/quoteOrder', createOrder: '${FN}/createOrder', chargeOnlineOrder: '${FN}/chargeOnlineOrder', paymentStatus: '${FN}/paymentStatus', requestCheckoutCode: '${FN}/requestCheckoutCode', verifyCheckoutCode: '${FN}/verifyCheckoutCode' }`;
  const API = (pay, { guest = true } = {}) => `CappApi.createApi({ config: { restaurantId: 'x_pizza', orderIdPrefix: 'TR', pendingPayKey: 'tr_pending_pay', hours: Array.from({ length: 7 }, () => [0, 0, 23, 59]),
    ${guest ? 'guestCardOnly: true, ' : ''}endpoints: ${EP} } })`;
  let PH = 0;
  const cartJs = `const menu = CappMenu.adaptMenu(${JSON.stringify(ENVELOPE)}); const cart = CappCart.createCart(menu); cart.inc(${JSON.stringify(DISH)});
    const s = CappSerialize.serialize(cart, menu);`;
  const flowJs = (digits, pay, email) => `const f = CappCheckout.freshFlow(null); CappCheckout.setPin(f, ${HUB.lat + 1 / 111.195}, ${HUB.lng}, true);
    Object.assign(f, { details: 'Portón negro', name: 'Ana TR', phone: '${digits}', pay: '${pay}'${email ? `, email: ${JSON.stringify(email)}` : ''} }); CappCheckout.chooseTip(f, 0);
    const ctx = { restaurantId: 'x_pizza', items: s.items, itemsText: s.items_text, member: null, headers: { Authorization: 'Bearer ${process.env.MAKE_SECRET}' } };`;
  // the guest's flow, quote and code REQUEST (the real client's order: the code is bound to the quote's sig), kept on the page
  const beginGuest = () => { const digits = `9977${String(PH += 1).padStart(4, '0')}`; return { digits, js: `(async () => {
    ${cartJs}
    window.__api = ${API('online')};
    ${flowJs(digits, 'online', 'ana.tr@correo.test')}
    const q = await window.__api.quote(f, ctx);
    window.__f = f; window.__ctx = ctx; window.__q = q; window.__phone = '+504${digits}'; window.__ticket = null;
    if (q.kind !== 'ok') return { q };
    const code = await window.__api.requestCheckoutCode({ phone: window.__phone, cartFp: String(q.record.sig) });
    return { q: { kind: q.kind }, code };
  })()` }; };
  // the code ⇒ the ticket, bound to the order identity the next place() sends under (orderIdForCode)
  const ticketWith = (code) => `(async () => {
    const oid = window.__api.orderIdForCode({ flow: window.__f });
    const v = await window.__api.verifyCheckoutCode({ phone: window.__phone, cartFp: String(window.__q.record.sig), code: ${JSON.stringify(code)}, orderId: oid });
    window.__ticket = v.ticket || null; return { ok: !!v.ok, kind: v.kind || null };
  })()`;
  // a quote + its ticket, no placement yet (F3: the placement comes after the floor rises)
  const guestTicketOnly = async (t) => {
    const b = beginGuest(); const s1 = await t.ev(b.js);
    if (!s1.q || s1.q.kind !== 'ok') return { kind: s1.q && s1.q.kind };
    assert.ok(s1.code && s1.code.ok === true, `premise: the checkout code was sent (${JSON.stringify(s1.code)})`);
    const v = await t.ev(ticketWith(await codeFor(b.digits)));
    assert.ok(v.ok, `premise: the code verified into a checkout ticket (${JSON.stringify(v)})`);
    return { kind: 'ok' };
  };
  const placeOnly = `window.__api.place({ flow: window.__f, ctx: window.__ctx, sig: window.__q.record.sig, checkoutTicket: window.__ticket, expectedNetCents: window.__q.record.resp.net_total_cents })
    .then((o) => ({ kind: o.kind, place: !!localStorage.getItem('capp:x_pizza:pending_place') }))`;
  // the WHOLE guest card checkout, as the real client runs it: quote → the WhatsApp code (read from its send) → the ticket → place
  const guestCheckout = async (t) => {
    const b = beginGuest(); const s1 = await t.ev(b.js);
    if (!s1.q || s1.q.kind !== 'ok') return { q: s1.q };
    assert.ok(s1.code && s1.code.ok === true, `premise: the checkout code was sent (${JSON.stringify(s1.code)})`);
    const v = await t.ev(ticketWith(await codeFor(b.digits)));
    assert.ok(v.ok, `premise: the code verified into a checkout ticket (${JSON.stringify(v)})`);
    return t.ev(`window.__api.place({ flow: window.__f, ctx: window.__ctx, sig: window.__q.record.sig, checkoutTicket: window.__ticket, expectedNetCents: window.__q.record.resp.net_total_cents })
      .then((out) => ({ out, origin: location.origin }))`);
  };
  // the SERVER's guest refusals (the transport WITHOUT the guest rules sends what 3a's gate must refuse): their codes, nothing placed
  const refusedGuest = (pay, email) => `(async () => {
    localStorage.removeItem('capp:x_pizza:pending_place'); localStorage.removeItem('tr_pending_pay');   // a fresh send: no unresolved payment to resume
    ${cartJs}
    const api = ${API(pay, { guest: false })};
    ${flowJs(`9966${String(PH += 1).padStart(4, '0')}`, pay, email)}
    const q = await api.quote(f, ctx);
    if (q.kind !== 'ok') return { q: q.kind };
    const out = await api.place({ flow: f, ctx, sig: q.record.sig, expectedNetCents: q.record.resp.net_total_cents });
    return { kind: out.kind };
  })()`;
  const finishReturn = `(async () => ({ origin: location.origin, stash: localStorage.getItem('tr_pending_pay'), out: await ${API('online')}.handleReturn(location.search) }))()`;
  const run = async (host, before) => {
    await clean();
    const t = await tab();
    try {
      await t.go(`${host}/`);
      const s = await guestCheckout(t);
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

    // ── U: the REAL UI on the page (its ctxBase builds the headers) ──
    {
      await clean(); HDRS.length = 0;
      const FIX = { lat: HUB.lat + 1.3 / 111.195, lng: HUB.lng + 0.4 / 111.195 };
      const u = await tab();
      try {
        await send('Browser.grantPermissions', { permissions: ['geolocation'], origin: NEW });
        await send('Emulation.setGeolocationOverride', { latitude: FIX.lat, longitude: FIX.lng, accuracy: 5 }, u.sid);
        await u.go(`${NEW}/`);
        const digits = `9944${String(PH += 1).padStart(4, '0')}`, EMAIL = 'ana.ui@correo.test';
        const HELP = `const wait = async (p, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (p()) return true; await new Promise((x) => setTimeout(x, 50)); } return false; };
          const $ = (s) => document.querySelector(s);
          const click = async (s) => { if (!(await wait(() => $(s) && !$(s).disabled))) throw new Error('missing or disabled ' + s); $(s).dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((x) => setTimeout(x, 40)); };
          const type = (s, v) => { $(s).value = v; $(s).dispatchEvent(new Event('input', { bubbles: true })); };`;
        // step 1 — the guest's own clicks up to the WhatsApp code sheet (guestCardOnly: card only, the email REQUIRED)
        const r1 = await u.ev(`(async () => {
          ${HELP}
          window.__ev = []; window.__nav = [];
          const ui = window.__ui = CappUI.mount(document, { envelope: ${JSON.stringify(ENVELOPE)}, onEvent: (n, d) => window.__ev.push([n, d && d.order_id]), navigate: (url) => window.__nav.push(url),
            config: { name: 'x_pizza', unit: ['pizza', 'pizzas'], hours: Array.from({ length: 7 }, () => [0, 0, 23, 59]), addr: 'Calle 1', etaDel: [30, 45], etaPick: [15, 20],
              restaurantId: 'x_pizza', orderIdPrefix: 'TU', pendingPayKey: 'tu_pending_pay', intakeKey: '${process.env.MAKE_SECRET}', guestCardOnly: true, endpoints: ${EP} } });
          ui.cart.inc(${JSON.stringify(DISH)}); ui.render();
          await click('#cart-bar'); await click('[data-act="checkout"]');
          if (!(await wait(() => ui.state.flow && ui.state.flow.pin && ui.state.flow.pin.confirmed === true))) return { err: 'no device fix', geo: ui.state.geo };
          type('#f-details', 'Portón negro'); type('#f-name', 'Ana UI'); type('#f-phone', '${digits}'); type('#f-email', '${EMAIL}');
          if ($('[data-act="pay"][data-val="online"]')) await click('[data-act="pay"][data-val="online"]');
          await click('#cta'); await click('[data-act="tipc"][data-val="0"]'); await click('[data-act="tip-place"]');
          const sheet = await wait(() => !!$('#layer .otp input[data-i="0"]'));
          return { sheet, pay: ui.state.flow.pay, pin: ui.state.flow.pin, pinStepOk: ui.state.pinStepOk };
        })()`);
        assert.ok(r1.sheet, `🔴 the guest reached the WhatsApp code sheet (${JSON.stringify(r1)})`);
        assert.strictEqual(r1.pay, 'online', 'a capp guest pays by card (guestCardOnly)');
        // step 2 — the code as the customer reads it in WhatsApp, typed into the real sheet ⇒ the ticket ⇒ the card placement
        const code = await codeFor(digits);
        const r = await u.ev(`(async () => {
          ${HELP}
          type('#layer .otp input[data-i="0"]', '${code}');
          await click('[data-act="otp-verify"]');
          await wait(() => window.__nav.length > 0, 20000);
          const ui = window.__ui;
          return { nav: window.__nav.slice(), pin: ui.state.flow.pin, pinStepOk: ui.state.pinStepOk, total: ui.state.sendTotals && ui.state.sendTotals.total };
        })()`);
        assert.ok(r.nav.length === 1 && r.nav[0].startsWith(`${FN}/pay?`), `🔴 the real UI verified the code and sent the card checkout to the hosted page (${JSON.stringify(r)})`);
        const id = new URL(r.nav[0]).searchParams.get('o');
        assert.deepStrictEqual([r.pin.lat, r.pin.lng, r1.pinStepOk], [FIX.lat, FIX.lng, false], 'the device fix from the browser, no pin step');
        const charge = HDRS.filter((h) => h.ep === 'chargeOnlineOrder');
        assert.ok(charge.length === 1 && charge[0].auth === true, `🔴 the app's ctxBase sent the intake key on the charge (${JSON.stringify(charge.map((h) => h.auth))})`);
        assert.strictEqual(HDRS.filter((h) => h.ep === 'createOrder').length, 0, 'a capp guest never reaches createOrder (card only)');
        assert.ok(HDRS.filter((h) => h.ep === 'quoteOrder').every((h) => h.auth === false), 'the public quote gets nothing extra');
        const o = (await rtdb.ref(`orders/${id}`).get()).val();
        assert.ok(o, `premise: the card order exists (${id})`);
        assert.deepStrictEqual([Number(o.lat), Number(o.lng), o.total_cents], [FIX.lat, FIX.lng, r.total], 'recorded at the fix, at the displayed Total');
        assert.ok(o.guest_verified && typeof o.guest_verified.phone_hash === 'string', '🔴 the order carries the WhatsApp-verified guest phone (3a\'s phone binding)');
      } finally { await u.close(); }
      ok('U the REAL UI in the REAL browser (guest contract): the device fix, the email typed, card only, the REAL WhatsApp code sheet (the code read from its send) ⇒ the ticket ⇒ the card checkout admitted at the hosted page, its own ctxBase + intake key, recorded at the fix and the Total shown, the verified phone bound');
    }

    // ── F: the client floor ENABLED ──
    const COMPAT = Number(VERSION.compat);
    await rtdb.ref('platform_config/client_floor/orders').set(COMPAT);
    await new Promise((r) => setTimeout(r, 31000));   // the floor cache TTL (client-floor.js FLOOR_TTL_MS)
    await clean(); HDRS.length = 0;
    const t = await tab(); let t2 = null;
    try {
      await t.go(`${OLD}/`);
      const card0 = await guestCheckout(t);   // the guest contract: card only (cash is refused below) — the charge is the admitted send
      assert.strictEqual(card0.out && card0.out.kind, 'redirect', `at the floor: admitted (${JSON.stringify(card0)})`);
      const sent = HDRS.filter((h) => h.ep === 'quoteOrder' || h.ep === 'chargeOnlineOrder');
      assert.ok(sent.length >= 2 && sent.every((h) => h.app === 'orders' && h.dep === appDep.id && Number(h.compat) === COMPAT), `🔴 the page's quote + charge carry the X-Client headers (${JSON.stringify(sent)})`);
      // 3a's guest gate, through the SAME stamped page: a capp guest without the guest rules is REFUSED with its code, nothing placed
      await clean();
      assert.deepStrictEqual(await t.ev(refusedGuest('cash', 'ana.cash@correo.test')), { kind: 'guest_cash_not_allowed' }, '🔴 a capp guest paying CASH is refused guest_cash_not_allowed');
      assert.deepStrictEqual(await t.ev(refusedGuest('online', null)), { kind: 'guest_email_required' }, '🔴 a capp guest card checkout WITHOUT an email is refused guest_email_required');
      const bare = await t.ev(`fetch('${FN}/createOrder', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ${process.env.MAKE_SECRET}' }, body: JSON.stringify({ restaurant_id: 'x_pizza', order_id: 'TR-BARE-1' }) }).then(async (r) => ({ s: r.status, j: await r.json() }))`);
      assert.deepStrictEqual([bare.s, bare.j.error], [426, 'client_update_required'], '🔴 a header-less request ⇒ 426 (the wrapper is the only admitted path)');
      ok('F1 floor enabled at the page compat: the guest card checkout (code → ticket) — its quote + charge carry X-Client-* and are admitted; a capp guest paying cash / without an email is REFUSED (guest_cash_not_allowed / guest_email_required); a header-less request ⇒ 426');

      // F2 premise: an UNRESOLVED card payment, started while still admitted (pending_place + pay stash written, not returned yet)
      await clean();
      const card = await guestCheckout(t);
      assert.strictEqual(card.out && card.out.kind, 'redirect', `premise: a card checkout admitted at the floor (${JSON.stringify(card)})`);
      // F3 premise, on the OTHER host (its own origin storage, nothing unresolved): a quote while admitted, no placement yet
      t2 = await tab();
      await t2.go(`${NEW}/`);
      await t2.ev('(localStorage.clear(), true)');   // a fresh device: T4 / U card purchases on this origin would (rightly) block a cart with no generation
      const quoted = await guestTicketOnly(t2);
      assert.strictEqual(quoted.kind, 'ok', `premise: the F3 quote admitted at the floor (${JSON.stringify(quoted)})`);
      await rtdb.ref('platform_config/client_floor/orders').set(COMPAT + 1);
      await new Promise((r) => setTimeout(r, 31000));
      await clean(); SERVE_STALE = true;
      await t.ev(`(window.__marker = 'alive', CappSelfUpdate.register(SherpaClient, { state: () => ({ screen: 'checkout', placing: false, sheetOpen: false }),
        unresolved: () => !!localStorage.getItem('capp:x_pizza:pending_place') || !!localStorage.getItem('tr_pending_pay'), search: () => location.search, snapshot: () => ({}), restore() {} }), true)`);
      // the server refuses a below-floor QUOTE 426 before any pricing (index.js P-SELFUPDATE §5) ⇒ the checkout stops at the quote
      const below = await guestCheckout(t);
      assert.strictEqual(below.q && below.q.kind, 'update_required', `below the floor ⇒ 426 ⇒ the update path (${JSON.stringify(below)})`);
      await t.ev('SherpaClient.check().then(() => SherpaClient.poke())');
      await new Promise((r) => setTimeout(r, 1500));
      const still = await t.ev(`({ marker: window.__marker, stale: SherpaClient.isStale(), place: !!localStorage.getItem('capp:x_pizza:pending_place') })`);
      assert.deepStrictEqual(still, { marker: 'alive', stale: true, place: true }, '🔴 a payment is unresolved ⇒ the reload is REFUSED (the page stays)');
      await t.ev(`localStorage.removeItem('capp:x_pizza:pending_place'); localStorage.removeItem('tr_pending_pay'); SherpaClient.poke(); true`).catch(() => {});
      let reloaded = false;
      for (let i = 0; i < 60 && !reloaded; i++) { await new Promise((r) => setTimeout(r, 100)); try { reloaded = (await t.ev('window.__marker')) !== 'alive'; } catch (_) {} }
      assert.ok(reloaded, 'non-vacuity: once nothing is unresolved, the same update path DOES reload');
      ok('F2 below the floor: the page gets 426 ⇒ the update path; the reload is REFUSED while a payment is unresolved and happens once it is resolved');

      // F3: the floor rose between the quote and the FIRST placement ⇒ 426 before any server write ⇒ the record is cleared ⇒ reload
      await clean();
      const n0 = Object.keys((await rtdb.ref('orders').get()).val() || {}).length;
      await t2.ev(`(window.__marker = 'alive', CappSelfUpdate.register(SherpaClient, { state: () => ({ screen: 'checkout', placing: false, sheetOpen: false }),
        unresolved: () => !!localStorage.getItem('capp:x_pizza:pending_place') || !!localStorage.getItem('tr_pending_pay'), search: () => location.search, snapshot: () => ({}), restore() {} }), true)`);
      assert.strictEqual(await t2.ev(`!!(window.__q && window.__q.kind === 'ok' && window.__f)`), true, 'premise: the page that quoted is still the page placing');
      let first = null;
      try { first = await t2.ev(placeOnly); } catch (e) {                                  // the 426 transition may reload mid-evaluate
        assert.match(String(e && e.message), /context was destroyed|navigated|Cannot find context|Target closed/i, `only a NAVIGATION may interrupt the placement (${e && e.message})`);
        first = { navigated: true };
      }
      if (first && first.kind) assert.deepStrictEqual(first, { kind: 'update_required', place: false }, `🔴 the refused first placement leaves no record (${JSON.stringify(first)})`);
      await t2.ev('SherpaClient.check().then(() => SherpaClient.poke())').catch(() => {});
      let reloaded3 = false;
      for (let i = 0; i < 80 && !reloaded3; i++) { await new Promise((r) => setTimeout(r, 100)); try { reloaded3 = (await t2.ev('window.__marker')) !== 'alive'; } catch (_) {} }
      assert.ok(reloaded3, '🔴 nothing unresolved ⇒ the update path DOES reload after a refused first placement');
      await t2.loaded();
      assert.strictEqual(await t2.ev(`localStorage.getItem('capp:x_pizza:pending_place')`), null, 'no placement record survives the reload');
      assert.strictEqual(Object.keys((await rtdb.ref('orders').get()).val() || {}).length, n0, 'and the server wrote nothing');
      ok('F3 the floor rises between the quote and the FIRST placement: the send is 426\'d before any server write, its record is cleared, and the update path reloads');
    } finally { await t.close().catch(() => {}); if (t2) await t2.close().catch(() => {}); await rtdb.ref('platform_config/client_floor/orders').remove(); }

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
