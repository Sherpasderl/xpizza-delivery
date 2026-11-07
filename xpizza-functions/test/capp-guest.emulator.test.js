'use strict';
// PLAN-guest-checkout-server r4 §2 — S2: the capp-guest gate through the REAL createOrder / chargeOnlineOrder handlers on the
// RTDB + Firestore emulators. Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:capp-guest
// The capp side is REAL: the body is capp-checkout.js @ ed70fed8's own orderBody (pinned fixture), the cart_fp its own cartSig,
// and the checkout ticket is issued by S1's REAL verifyCheckoutCode against the same emulator database.
//   C  createOrder: EVERY capp guest (cash, card_delivery, a ticket-bearing body) ⇒ typed 400; the WHOLE database is byte-identical
//      (no order, guest_verified, grant, ticket or idempotency state; a pre-gate dispatcher_alerts diagnostic is the only exclusion)
//   R  chargeOnlineOrder refusals (cash, scheduled_for, no email, a bad / foreign / expired ticket) ⇒ typed 400, database byte-identical
//   S  success: 200 with checkout_url + signup_grant; orders/{id}/guest_verified from the ticket; the grant verifies (order + phone)
//   P  replay: the same request ⇒ the SAME checkout_url and the SAME grant bytes; the ticket is reusable for its own order only
//   B  Codex's A/B: B's VALID ticket for A's order ⇒ 400 guest_ticket_invalid with no order data on BOTH legs; O keeps A's phone
//   X  N concurrent same-id guest charges ⇒ ONE order (the existing CAS), ONE guest_verified, every 200 carries the same grant
//   T  the capp-guest TRACE (separate NEW golden, test/capp-guest-trace.golden.json — the 3 existing goldens are never touched):
//      the guest-relevant RTDB families (orders, checkout_tickets, grants_used, payment_attempts, recent_order_content, rate_limits,
//      user_rewards) recorded op + path + write keys for: createOrder refusal (ZERO writes, NO orders/<oid> read — the gate sits
//      before the existence read), the charge refusals, a fresh success and its replay. Captured from the REAL handlers with
//      CAPP_GUEST_TRACE_CAPTURE=<file> and reviewed as a diff; a missing golden FAILS (never silently captured).
//   F  forms / members with the gate in place: unchanged answers (orders-xpizza / orders-lamusa / header-less / a member with the
//      orders-app header) — the existing trace goldens (pselfupdate-createorder-trace, d4b-charge-trace, order-control-base) are
//      the byte-identical differential and re-run in the same heavy slot
require('./_emulator-required')('database', 'firestore');
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'guest-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
process.env.OTP_SALT = process.env.OTP_SALT || 'test-salt-'.padEnd(40, 'x');
process.env.SIGNUP_GRANT_SECRET = 'g'.repeat(40);   // defineSecret(...).value() reads the env outside the functions runtime
const realWhatsapp = require('../whatsapp');
const wr = require.resolve('../whatsapp');
require.cache[wr] = { id: wr, filename: wr, loaded: true, children: [], paths: [], exports: { ...realWhatsapp, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) } };
const ph = require.resolve('../pixelpay-hosted');
const realHosted = require('../pixelpay-hosted');
let URLSEQ = 0;
require.cache[ph] = { id: ph, filename: ph, loaded: true, children: [], paths: [], exports: { ...realHosted, createHostedCharge: async (r) => ({ ok: true, url: `https://pay.test/${r.pixelpayOrderId}/${URLSEQ += 1}` }) } };
const fa = require.resolve('firebase-admin/auth');
const realAuth = require('firebase-admin/auth');
require.cache[fa] = { id: fa, filename: fa, loaded: true, children: [], paths: [], exports: { ...realAuth, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) } };

const RP = require('./_render-pin');
RP.setRender(RP.SHIPPED);
const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const G = require('../checkout-guest-lib');
const OTP = require('../otp-lib');
const { makeCheckoutOtp } = require('../checkout-otp');
const CAPP = require(path.join(__dirname, 'fixtures', 'capp-checkout.ed70fed8.js'));
const fsys = require('fs');
const GOLDEN = path.join(__dirname, 'capp-guest-trace.golden.json');
const CAPTURE = process.env.CAPP_GUEST_TRACE_CAPTURE || '';

// ── the recorder (the d4b-charge-trace recipe, narrowed): RTDB Reference/Query prototypes, op + path + a write's sorted keys;
// only the guest-relevant families (config / catalog caches are TTL-dependent and outside this slice's claim) ──
let REC = null;
const Q = require('./_quiescence').makeQuiescence();
const rel = (u) => { try { return decodeURIComponent(new URL(u).pathname).replace(/^\//, ''); } catch (_) { return String(u); } };
const FAMILIES = /^(orders|checkout_tickets|grants_used|payment_attempts|recent_order_content|rate_limits|user_rewards)(\/|$)/;
function patchChain(obj, names, describe) {
  const done = new Set();
  for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const nm of names) {
      if (done.has(nm) || !Object.prototype.hasOwnProperty.call(p, nm) || typeof p[nm] !== 'function') continue;
      done.add(nm);
      const orig = p[nm];
      p[nm] = function (...a) { if (REC) { const e = describe(this, nm, a); if (FAMILIES.test(e.path)) REC.push(e); } return Q.track(orig.apply(this, a), nm); };
    }
  }
}
const writeShape = (v) => (v && typeof v === 'object' ? { keys: Object.keys(v).sort() } : { type: v === null ? 'null' : typeof v });
patchChain(rtdb.ref('x'), ['get', 'once', 'set', 'update', 'remove', 'transaction', 'push'], (self, nm, a) => {
  const ref = self.ref || self;
  const e = { op: nm, path: typeof ref.toString === 'function' ? rel(ref.toString()) : '?' };
  if (nm === 'update' || nm === 'set' || (nm === 'push' && a.length)) Object.assign(e, writeShape(a[0]));
  return e;
});
const WRITES = new Set(['set', 'update', 'remove', 'transaction', 'push']);
// one recorded call; request-local ids normalised after it (order id, ticket key, attempt id, poll token, phone keys)
async function recorded(fn, subs) {
  REC = [];
  const r = await fn();
  await Q.quiescent();
  const calls = REC; REC = null;
  let txt = JSON.stringify(calls);
  for (const [v, name] of subs.filter(([v]) => typeof v === 'string' && v.length >= 4).sort((a, b) => b[0].length - a[0].length)) txt = txt.split(v).join(name);
  return { r, trace: JSON.parse(txt) };
}
const TRACES = {};

const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { publishVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('capp-guest(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

async function seed(rid) {
  await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: `guest-${rid}` });
  const res = await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(fs, rid, catalogSnapshot(rid), { captured: await getActivePointer(fs, rid) });
  return res.versionId;
}
function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...headers }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const OPEN = { open: true, start: '00:00', end: '24:00' };
const identityFor = (rid) => ({ name: rid, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1,
  hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } });
const APP_H = { 'x-client-app': 'orders', 'x-client-deployment': 'orders-app', 'x-client-build': 'capp-1', 'x-client-compat': '2' };
const FORM_H = (dep) => ({ 'x-client-app': 'orders', 'x-client-deployment': dep, 'x-client-build': 'b2', 'x-client-compat': '2' });
// the tree, minus the pre-gate diagnostic alerts the invariant excludes (pricing-tables.js:195 → payment-alert.js:9)
const tree = async () => { const v = (await rtdb.ref().get()).val() || {}; delete v.dispatcher_alerts; return JSON.stringify(v); };

// ── the capp's REAL writer ──
const subtle = globalThis.crypto.subtle;
function capp(rid, oid, { phone = '9955-0001', pay = 'online', mode = 'pickup', email = 'ana@example.com' } = {}) {
  const s = catalogSnapshot(rid);
  const it = s.items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
  const items = rid === 'x_pizza' ? [{ name: it.display.name, qty: 1, price: it.price, extras: [] }] : [{ id: it.key, name: it.display.name, cat: it.display.cat, qty: 1, price: it.price, extras: [] }];
  const f = CAPP.freshFlow(null);
  CAPP.setMode(f, mode);
  if (mode === 'delivery') { CAPP.setPin(f, 14.1005, -87.2005, true); CAPP.chooseTip(f, 0); f.details = 'casa azul'; }
  Object.assign(f, { name: 'Ana Pérez', phone, email, pay });
  const ctx = { restaurantId: rid, items, itemsText: `1x ${it.display.name}`, orderId: oid, member: null };
  return { f, ctx, body: JSON.parse(JSON.stringify(CAPP.orderBody(f, ctx))) };
}
let clock = Date.now();
const SENT = [];
const S1 = makeCheckoutOtp({ getDatabase: () => rtdb, registry: () => ({ ready: async () => {}, known: () => new Set(['x_pizza', 'la_musa']) }), now: () => clock,
  env: { ULTRAMSG_INSTANCE_ID_PLATFORM: 'i', ULTRAMSG_TOKEN_PLATFORM: 't', CHECKOUT_OTP_TEMPLATE: '{code}' },
  fetchImpl: async (u, init) => { SENT.push(new URLSearchParams(init.body).get('body')); return { ok: true, json: async () => ({ sent: 'true', id: 1 }) }; } });
async function s1(fn, body) { const r = { status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; await S1[fn]({ method: 'POST', body, ip: '7.7.7.7' }, r); return r; }
async function ticketFor(c, phoneE164) {
  const cart_fp = await CAPP.cartSig(c.f, c.ctx, subtle);
  clock += G.BUDGET.WINDOW + 1;   // the logical OTP clock only moves FORWARD (heavy run 1: a rewind put a same-phone send inside MIN_GAP)
  await rtdb.ref('otp_ip').remove();
  const a = await s1('requestCheckoutCode', { phone_e164: phoneE164, restaurant_id: c.ctx.restaurantId, cart_fp });
  assert.strictEqual(a.code, 200, JSON.stringify(a.body));
  const v = await s1('verifyCheckoutCode', { phone_e164: phoneE164, restaurant_id: c.ctx.restaurantId, cart_fp, order_id: c.ctx.orderId, code: SENT[SENT.length - 1] });
  assert.strictEqual(v.code, 200, JSON.stringify(v.body));
  clock = Math.max(clock, Date.now());   // monotonic, NEVER rewound: the real budget path stays exercised across restaurants (the gate checks the ticket's exp against the real clock)
  return v.body.checkout_ticket;
}
const charge = (body, h = APP_H) => post(app.chargeOnlineOrder, body, h);
const cash = (body, h = APP_H) => post(app.createOrder, body, h);
const is400 = (r, reason, label) => { assert.strictEqual(r.status, 400, `${label}: ${r.status} ${r.text.slice(0, 200)}`); assert.deepStrictEqual(r.json, { error: reason }, `${label}: ONE reason, no order data`); };

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) { await seed(rid); await rtdb.ref(`restaurants/${rid}/identity`).set(identityFor(rid)); }

  // ═══ U — Codex r1 P1-1: issued on one SDK instance, verified on ANOTHER (a fresh admin app: nothing cached) ═══
  {
    const second = admin.initializeApp({ ...admin.app().options }, 'capp-guest-second');
    const db2 = second.database();
    const S1b = makeCheckoutOtp({ getDatabase: () => db2, registry: () => ({ ready: async () => {}, known: () => new Set(['x_pizza', 'la_musa']) }), now: () => clock,
      env: { ULTRAMSG_INSTANCE_ID_PLATFORM: 'i', ULTRAMSG_TOKEN_PLATFORM: 't', CHECKOUT_OTP_TEMPLATE: '{code}' }, fetchImpl: async () => ({ ok: true, json: async () => ({ sent: 'true' }) }) });
    const c = capp('x_pizza', 'u_sdk', { phone: '9955-0005' });
    const cart_fp = await CAPP.cartSig(c.f, c.ctx, subtle);
    clock += G.BUDGET.WINDOW + 1; await rtdb.ref('otp_ip').remove();
    assert.strictEqual((await s1('requestCheckoutCode', { phone_e164: '+50499550005', restaurant_id: 'x_pizza', cart_fp })).code, 200);
    const r = { status(x) { r.code = x; return r; }, json(b) { r.body = b; return r; } };
    await S1b.verifyCheckoutCode({ method: 'POST', body: { phone_e164: '+50499550005', restaurant_id: 'x_pizza', cart_fp, order_id: 'u_sdk', code: SENT[SENT.length - 1] }, ip: '7.7.7.7' }, r);
    assert.strictEqual(r.code, 200, `🔴 a valid code verified on another SDK instance (${JSON.stringify(r.body)})`);
    assert.ok((await rtdb.ref(`checkout_tickets/${G.ticketKey(r.body.checkout_ticket)}`).get()).exists(), 'the ticket is written');
    await second.delete();
    clock = Math.max(clock, Date.now());
  }
  ok('U issuance on one SDK instance, verification on a SECOND uncached one ⇒ 200 + ticket (Codex r1 P1-1)');

  // ═══ C — createOrder refuses every capp guest; zero mutation ═══
  for (const rid of ['x_pizza', 'la_musa']) {
    const c = capp(rid, `c_${rid}`, { pay: 'cash' });
    const t = await ticketFor(capp(rid, `c_${rid}`), '+50499550001');
    for (const [label, body, why] of [['cash', c.body, 'guest_cash_not_allowed'], ['card_delivery', { ...c.body, payment_method: 'card_delivery' }, 'guest_cash_not_allowed'],
      ['cash + a ticket', { ...c.body, checkout_ticket: t }, 'guest_ticket_invalid'], ['scheduled cash', { ...c.body, scheduled_for: Date.now() + 3 * 3600e3 }, 'guest_cash_not_allowed']]) {
      await rtdb.ref('rate_limits').remove();
      const before = await tree();
      is400(await cash(body), why, `${rid} createOrder ${label}`);
      assert.strictEqual(await tree(), before, `🔴 ${rid} createOrder ${label}: the database changed (orders / guest_verified / grants / tickets / recent_order_content / rate_limits must be untouched)`);
    }
  }
  ok('C createOrder: every capp guest (cash, card_delivery, ticket-bearing, scheduled) ⇒ typed 400; the WHOLE database byte-identical (pre-gate diagnostics excluded)');

  // ═══ R — chargeOnlineOrder refusals; zero mutation ═══
  for (const rid of ['x_pizza', 'la_musa']) {
    const c = capp(rid, `r_${rid}`);
    const t = await ticketFor(c, '+50499550001');
    const good = { ...c.body, checkout_ticket: t };
    const noEmail = { ...good }; delete noEmail.customer_email;
    const other = capp(rid, `r2_${rid}`);
    const tOther = await ticketFor(other, '+50499550001');
    for (const [label, body, why] of [['cash', { ...good, payment_method: 'cash' }, 'guest_cash_not_allowed'], ['card_delivery', { ...good, payment_method: 'card_delivery' }, 'guest_cash_not_allowed'], ['scheduled', { ...good, scheduled_for: Date.now() + 3 * 3600e3 }, 'guest_schedule_requires_account'],
      ['no email', noEmail, 'guest_email_required'], ['no ticket', { ...c.body }, 'guest_ticket_invalid'], ['unknown ticket', { ...good, checkout_ticket: 'ct_' + 'f'.repeat(32) }, 'guest_ticket_invalid'],
      ['another order\'s ticket', { ...good, checkout_ticket: tOther }, 'guest_ticket_invalid'], ['a changed cart', { ...good, items: [{ ...good.items[0], qty: 2 }], items_text: good.items_text }, 'guest_ticket_invalid'],
      ['another phone', { ...good, customer_phone: '+504 9955-0099' }, 'guest_ticket_invalid']]) {
      await rtdb.ref('rate_limits').remove();
      const before = await tree();
      is400(await charge(body), why, `${rid} charge ${label}`);
      assert.strictEqual(await tree(), before, `🔴 ${rid} charge ${label}: the database changed`);
    }
    // expiry: the same ticket, past exp
    await rtdb.ref(`checkout_tickets/${G.ticketKey(t)}/exp`).set(Date.now() - 1);
    await rtdb.ref('rate_limits').remove();
    is400(await charge(good), 'guest_ticket_invalid', `${rid} expired ticket`);
  }
  ok('R chargeOnlineOrder: cash / scheduled / no email / no, unknown, foreign-order, changed-cart, other-phone, expired ticket ⇒ the typed reason in order; database byte-identical');

  // ═══ S + P — success, guest_verified, grant; replay = same URL + same grant ═══
  const winners = {};
  for (const rid of ['x_pizza', 'la_musa']) {
    const c = capp(rid, `s_${rid}`);
    const t = await ticketFor(c, '+50499550001');
    const body = { ...c.body, checkout_ticket: t };
    await rtdb.ref('rate_limits').remove();
    const r = await charge(body);
    assert.strictEqual(r.status, 200, r.text.slice(0, 300));
    assert.ok(r.json.checkout_url && r.json.signup_grant && r.json.signup_grant.token, 'checkout + grant');
    const o = (await rtdb.ref(`orders/s_${rid}`).get()).val();
    assert.deepStrictEqual(o.guest_verified, { phone: '50499550001', phone_hash: OTP.phoneHash('50499550001') }, 'guest_verified from the ticket, in the CAS write');
    assert.strictEqual(r.json.signup_grant.expires_at, o.created_at + G.GRANT_TTL_MS);
    const v = G.verifyGrant(r.json.signup_grant.token, process.env.SIGNUP_GRANT_SECRET, Date.now());
    assert.ok(v.ok && v.payload.order_id === `s_${rid}` && v.payload.phone_hash === o.guest_verified.phone_hash, 'the grant binds THIS order + THIS phone');
    await rtdb.ref('rate_limits').remove();
    const r2 = await charge(body);
    assert.strictEqual(r2.status, 200, r2.text.slice(0, 300));
    assert.strictEqual(r2.json.checkout_url, r.json.checkout_url, 'replay = the live checkout');
    assert.deepStrictEqual(r2.json.signup_grant, r.json.signup_grant, 'replay = the SAME grant bytes (no TTL reset)');
    winners[rid] = { c, t, body, url: r.json.checkout_url };
  }
  ok('S+P success: 200 with checkout_url + signup_grant; guest_verified written in the CAS record; the grant verifies for this order + phone; a replay returns the same checkout and the same grant');

  // ═══ B — Codex's A/B sequence ═══
  for (const rid of ['x_pizza', 'la_musa']) {
    const A = winners[rid];
    const cB = capp(rid, `s_${rid}`, { phone: '9955-0002' });
    const tB = await ticketFor(cB, '+50499550002');   // a VALID ticket for the same O / rid / cart, B's own phone
    for (const [leg, call, body] of [['online', charge, { ...cB.body, checkout_ticket: tB }], ['cash', cash, { ...cB.body, payment_method: 'cash', checkout_ticket: tB }]]) {
      await rtdb.ref('rate_limits').remove();
      const before = await tree();
      const r = await call(body);
      is400(r, 'guest_ticket_invalid', `${rid} B ${leg}`);
      assert.ok(!r.text.includes('pay.test') && !r.text.includes('signup_grant'), 'no checkout, no grant');
      assert.strictEqual(await tree(), before, `🔴 ${rid} B ${leg}: the database changed`);
    }
    assert.strictEqual((await rtdb.ref(`orders/s_${rid}/guest_verified/phone`).get()).val(), '50499550001', 'O keeps A\'s phone');
    void A;
  }
  ok('B Codex\'s A/B: B\'s VALID ticket for A\'s order ⇒ 400 guest_ticket_invalid with no checkout / grant / order data on BOTH legs; database unchanged; O keeps A\'s phone');

  // ═══ X — N concurrent same-id guest charges ⇒ one order ═══
  {
    const c = capp('x_pizza', 'x_race', { phone: '9955-0003' });   // Codex r1 P2-5: the body's phone IS the ticket's
    const t = await ticketFor(c, '+50499550003');
    const body = { ...c.body, checkout_ticket: t };
    await rtdb.ref('rate_limits').remove();
    const rs = await Promise.all(Array.from({ length: 5 }, () => charge(body)));
    const okRs = rs.filter((r) => r.status === 200);
    assert.ok(okRs.length >= 1, rs.map((r) => r.status).join(','));
    for (const r of rs) assert.ok([200, 202, 409, 429].includes(r.status), `a race loser takes today's CAS-loss path: ${r.status} ${r.text.slice(0, 120)}`);
    const grants = new Set(okRs.map((r) => JSON.stringify(r.json.signup_grant)));
    assert.strictEqual(grants.size, 1, 'every 200 carries the SAME grant');
    const attempts = Object.values((await rtdb.ref('payment_attempts').get()).val() || {}).filter((a) => a && a.order_id === 'x_race');
    assert.strictEqual(new Set(okRs.map((r) => r.json.checkout_url)).size, 1, 'one live checkout');
    assert.ok(attempts.length === 1, `one attempt (${attempts.length})`);
    assert.strictEqual((await rtdb.ref('orders/x_race/guest_verified/phone').get()).val(), '50499550003');
  }
  ok('X 5 concurrent same-id guest charges ⇒ one order, one attempt, one checkout; every 200 carries the same grant');

  // ═══ T — the capp-guest trace (separate golden) ═══
  {
    const { rateLimitKey } = require('../order-dedup');
    const c = capp('x_pizza', 't_trace', { phone: '9955-0004' });   // Codex r1 P2-5: the body's phone IS the ticket's
    const t = await ticketFor(c, '+50499550004');
    const subs = (oid) => [[oid, '<oid>'], [G.ticketKey(t), '<ticketKey>'], [OTP.phoneHash('50499550004'), '<phoneHash>'], [rateLimitKey(c.body.customer_phone), '<phoneKey>']];
    await rtdb.ref('rate_limits').remove();
    const cr = await recorded(() => cash({ ...c.body, payment_method: 'cash' }), subs('t_trace'));
    is400(cr.r, 'guest_cash_not_allowed', 'trace createOrder');
    assert.deepStrictEqual(cr.trace.filter((e) => WRITES.has(e.op)), [], '🔴 createOrder wrote for a capp guest');
    assert.ok(!cr.trace.some((e) => e.path === 'orders/<oid>'), '🔴 createOrder read the order (the gate must precede the existence read)');
    await rtdb.ref('rate_limits').remove();
    const rr = await recorded(() => charge({ ...c.body, checkout_ticket: 'ct_' + 'e'.repeat(32) }), subs('t_trace'));
    is400(rr.r, 'guest_ticket_invalid', 'trace charge refusal');
    assert.deepStrictEqual(rr.trace.filter((e) => WRITES.has(e.op)), [], '🔴 a refused guest charge wrote');
    await rtdb.ref('rate_limits').remove();
    const fr = await recorded(() => charge({ ...c.body, checkout_ticket: t }), subs('t_trace'));
    assert.strictEqual(fr.r.status, 200, fr.r.text.slice(0, 200));
    const o = (await rtdb.ref('orders/t_trace').get()).val();
    const idSubs = [...subs('t_trace'), ...Object.entries(o).filter(([k, v]) => /attempt_id$|poll_token$/.test(k) && typeof v === 'string').map(([k, v]) => [v, `<${k}>`])];
    const norm = (tr) => JSON.parse(idSubs.sort((a, b) => b[0].length - a[0].length).reduce((x, [v, nm]) => x.split(v).join(nm), JSON.stringify(tr)));
    await rtdb.ref('rate_limits').remove();
    const pr = await recorded(() => charge({ ...c.body, checkout_ticket: t }), subs('t_trace'));
    assert.strictEqual(pr.r.status, 200);
    Object.assign(TRACES, { create_refusal: cr.trace, charge_refusal: rr.trace, charge_fresh: norm(fr.trace), charge_replay: norm(pr.trace) });
    if (CAPTURE) {
      fsys.writeFileSync(CAPTURE, `${JSON.stringify(TRACES, null, 1)}\n`);
      console.log(`capp-guest(emulator): TRACE CAPTURED → ${CAPTURE} (review as a diff, then commit as test/capp-guest-trace.golden.json)`);
    } else {
      assert.ok(fsys.existsSync(GOLDEN), '🔴 test/capp-guest-trace.golden.json is missing — capture it with CAPP_GUEST_TRACE_CAPTURE=<file> and review it (never auto-written)');
      assert.deepStrictEqual(TRACES, JSON.parse(fsys.readFileSync(GOLDEN, 'utf8')), '🔴 the capp-guest trace moved — review the diff');
    }
  }
  ok('T the capp-guest trace: createOrder refusal = zero writes and no order read; a refused charge writes nothing; fresh + replay traces equal the reviewed golden');

  // ═══ F — forms + members with the gate in place ═══
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const [label, h, tok] of [['the form', FORM_H(rid === 'x_pizza' ? 'orders-xpizza' : 'orders-lamusa'), null], ['header-less', {}, null], ['a member with the orders-app header', APP_H, `u_${rid}`]]) {
      const c = capp(rid, `f_${rid}_${label.length}`);
      const hh = { ...h, ...(tok ? { 'x-firebase-id-token': tok } : {}) };
      await rtdb.ref('rate_limits').remove();
      const r = await charge({ ...c.body, pickup_time: 'standard' }, hh);
      assert.strictEqual(r.status, 200, `${rid} ${label} charge: ${r.text.slice(0, 200)}`);
      assert.ok(!('signup_grant' in r.json), 'no grant outside the capp-guest path');
      assert.strictEqual((await rtdb.ref(`orders/f_${rid}_${label.length}/guest_verified`).get()).val(), null, 'no guest_verified outside the capp-guest path');
      await rtdb.ref('rate_limits').remove();
      const rc = await cash({ ...c.body, order_id: `fc_${rid}_${label.length}`, payment_method: 'cash' }, hh);
      assert.strictEqual(rc.status, 200, `${rid} ${label} cash: ${rc.text.slice(0, 200)}`);
    }
  }
  // Codex r1 P2-4 differential: a NON-online body to chargeOnlineOrder — the form, header-less and a member (even with the
  // orders-app header) get the generic online-only answer, byte-identical to each other; only the capp guest gets its reason
  for (const rid of ['x_pizza', 'la_musa']) {
    const c = capp(rid, `m_${rid}`, { pay: 'cash' });
    const answers = [];
    for (const [h, tok] of [[FORM_H(rid === 'x_pizza' ? 'orders-xpizza' : 'orders-lamusa'), null], [{}, null], [APP_H, `u_${rid}`]]) {
      await rtdb.ref('rate_limits').remove();
      const before = await tree();
      const r = await charge({ ...c.body, payment_method: 'cash' }, { ...h, ...(tok ? { 'x-firebase-id-token': tok } : {}) });
      assert.strictEqual(r.status, 400); answers.push(r.text);
      assert.strictEqual(await tree(), before);
    }
    assert.ok(answers.every((a) => a === answers[0]) && !answers[0].includes('guest_'), `${rid}: forms / header-less / member answers are the SAME generic body (${answers[0].slice(0, 120)})`);
    await rtdb.ref('rate_limits').remove();
    is400(await charge({ ...c.body, payment_method: 'cash' }), 'guest_cash_not_allowed', `${rid}: the capp guest's typed reason is reachable`);
  }
  ok('F forms / header-less / members (even with the orders-app header) are untouched: cash + online accepted as today, no grant, no guest_verified; a non-online charge body gets the same generic answer for all of them, the capp guest its typed reason');

  FINISHED = true;
  console.log(`\ncapp-guest(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
