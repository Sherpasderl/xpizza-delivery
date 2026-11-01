'use strict';
// PLAN-guest-checkout-server r4 §1.4 + §2 — S2: the capp-guest gate, the one-source cart signature, and the manifest premise.
// Pure + an in-memory RTDB (the S1 test's transaction-faithful fake + once()); the TICKET comes from the REAL writer (S1's
// verifyCheckoutCode), the cart signature from the capp's REAL capp-checkout.js (pinned fixture), and the manifest premise from
// f838eaa7's EXACT orders-app line (pinned fixture) through the REAL platform-manifest loader. The emulator cells (both handlers,
// the CAS race, createOrder's zero-write trace, the forms differential) are the S2 heavy suite.
// Run: node checkout-guest-gate.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'test-salt-'.padEnd(40, 'x');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const G = require('./checkout-guest-lib');
const GATE = require('./checkout-guest-gate');
const OTP = require('./otp-lib');
const { normalizePhone } = require('./whatsapp');
const { makeCheckoutOtp } = require('./checkout-otp');
const PM = require('./platform-manifest');
const CF = require('./client-floor');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const FIX = path.join(__dirname, 'test', 'fixtures');
// git's blob id of a file's bytes — the fixtures are pinned to the EXACT blobs they were copied from (no git needed at test time)
const blobId = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

function fakeDb() {
  const tree = {}; const calls = [];
  const get = (p) => p.split('/').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = p.split('/').filter(Boolean); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v); };
  const snap = (v) => ({ exists: () => v != null, val: () => (v == null ? null : clone(v)) });
  return { tree, calls, get, set, ref: (p) => { calls.push(p); return {
    get: async () => snap(get(p)), once: async () => snap(get(p)),
    set: async (v) => set(p, v),
    update: async (m) => { for (const [k, v] of Object.entries(m)) set(`${p}/${k}`, v); },
    transaction: async (fn) => { const next = fn(clone(get(p)) ?? null); if (next === undefined) return { committed: false, snapshot: snap(get(p)) }; set(p, next); return { committed: true, snapshot: snap(get(p)) }; },
  }; } };
}
// a db that FAILS on any access — proves "zero reads, zero writes" for the non-guest path
const noTouchDb = { ref: (p) => { throw new Error(`🔴 the gate touched the database (${p}) for a non-guest`); } };

// ── the capp's REAL writer: capp-checkout.js @ ed70fed8 (customer-app/capp-checkout.js), verbatim ──
const CAPP_SRC = fs.readFileSync(path.join(FIX, 'capp-checkout.ed70fed8.js'));
const CAPP_FIXTURE = require(path.join(FIX, 'capp-checkout.ed70fed8.js'));
// ASSEMBLY OBLIGATION (ruling C): once the capp has LANDED, cell 3's real-writer equivalence ALSO runs on the landed module
const CAPP_LANDED_PATH = path.join(__dirname, '..', 'customer-app', 'capp-checkout.js');
const CAPP_WRITERS = [['ed70fed8 fixture', CAPP_FIXTURE], ...(fs.existsSync(CAPP_LANDED_PATH) ? [['the LANDED customer-app/capp-checkout.js', require(CAPP_LANDED_PATH)]] : [])];
let CAPP = CAPP_FIXTURE;   // flow() / the later cells use the pinned fixture; cell 3 iterates every writer
const subtle = globalThis.crypto.subtle;
const RID = 'x_pizza';
const ITEMS = [{ id: 33, name: 'NY Plain Slice - Combinada', qty: 2, price: 654, extras: [{ instance: 0, name: 'Salsa Roja', price: 39 }] }];
function flow({ mode = 'delivery', lat = 14.0723, lng = -87.1921, confirmed = true, tip = null, email = 'ana@example.com', pay = 'online' } = {}) {
  const f = CAPP.freshFlow(null);
  CAPP.setMode(f, mode);
  if (mode === 'delivery') CAPP.setPin(f, lat, lng, confirmed);
  if (tip !== null) CAPP.chooseTip(f, tip);
  Object.assign(f, { name: 'Ana Pérez', phone: '9999-0000', email, pay });
  return f;
}
const ctxOf = (o = {}) => ({ restaurantId: RID, items: ITEMS, itemsText: '2x NY Plain Slice - Combinada', orderId: 'XPZ-guest-1', member: null, ...o });
const wire = (b) => JSON.parse(JSON.stringify(b));   // as the wire delivers it

(async () => {
  // ── 1. the fixtures are the EXACT upstream bytes ──
  assert.strictEqual(blobId(CAPP_SRC), '0a87683205829b1a089c4a55e650b44a6722491a', '🔴 the capp-checkout fixture drifted from ed70fed8:customer-app/capp-checkout.js');
  const SITES_F838 = fs.readFileSync(path.join(FIX, 'sites.f838eaa7.json'));
  assert.strictEqual(blobId(SITES_F838), 'ce603dec901bbd417f41ca7d6d153611e7e67014', '🔴 the sites fixture drifted from f838eaa7:platform/sites.json');
  ok('fixtures pinned to their git blobs: ed70fed8:customer-app/capp-checkout.js and f838eaa7:platform/sites.json');

  // ── 2. the manifest premise: main's REAL sites.json + f838eaa7's EXACT orders-app entry, through the REAL loader ──
  {
    const f838 = JSON.parse(SITES_F838.toString('utf8'));
    const appEntry = f838.deployments.filter((d) => d.id === G.CAPP_DEPLOYMENT);
    assert.strictEqual(appEntry.length, 1, 'f838eaa7 carries exactly one orders-app entry');
    const line = SITES_F838.toString('utf8').split('\n').find((l) => l.includes('"id": "orders-app"'));
    assert.deepStrictEqual(JSON.parse(line.trim().replace(/,$/, '')), appEntry[0], 'the entry IS the line (no hand-built object)');
    const mainSites = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'platform', 'sites.json'), 'utf8'));
    const compat = require('./platform/compat.json');
    const landed = mainSites.deployments.filter((d) => d.id === G.CAPP_DEPLOYMENT);
    let P, entry, formsOrigins;
    if (landed.length) {
      // ASSEMBLY OBLIGATION (ruling C, DECISIONS 2026-10-27): f838eaa7 has LANDED — the S2 cells now run on the REAL merged
      // manifest. The landed entry must carry f838eaa7's S2-relevant fields (the discriminator id + app + context, the CORS
      // origins); other fields (entrypoints) are the app shell's. A moved S2 field ⇒ RED ⇒ re-review S2 against it.
      assert.strictEqual(landed.length, 1, 'exactly one orders-app entry landed');
      const s2 = (d) => ({ id: d.id, app: d.app, context: d.context, origins: d.origins });
      assert.deepStrictEqual(s2(landed[0]), s2(appEntry[0]), '🔴 the LANDED orders-app entry moved an S2-relevant field vs f838eaa7 — re-review S2');
      entry = landed[0];
      P = PM.loadPlatform(mainSites, compat);
      formsOrigins = PM.loadPlatform({ ...mainSites, deployments: mainSites.deployments.filter((d) => d.id !== G.CAPP_DEPLOYMENT) }, compat).ACCOUNT_ORIGINS;
    } else {
      // a pre-landing base: main's REAL sites.json + f838eaa7's EXACT line spliced in (S2 inert in prod until it lands)
      const at = mainSites.deployments.findIndex((d) => d.id === 'orders-lamusa');
      entry = appEntry[0];
      P = PM.loadPlatform({ ...mainSites, deployments: [...mainSites.deployments.slice(0, at + 1), entry, ...mainSites.deployments.slice(at + 1)] }, compat);
      formsOrigins = PM.PLATFORM.ACCOUNT_ORIGINS;
    }
    const platformOrders = P.sites.deployments.filter((d) => d.app === 'orders' && d.context === PM.PLATFORM_CONTEXT);
    assert.deepStrictEqual(platformOrders.map((d) => d.id), [G.CAPP_DEPLOYMENT], '🔴 the discriminator names THE platform orders deployment');
    assert.ok(entry.origins.every((o) => P.ACCOUNT_ORIGINS.includes(o)), 'its origins join ACCOUNT_ORIGINS by derivation (the checkout endpoints\' CORS)');
    assert.deepStrictEqual(P.ACCOUNT_ORIGINS.filter((o) => !entry.origins.includes(o)), formsOrigins, 'the forms\' origins are unchanged');
    // the header the capp stamps from that id parses to exactly the discriminator's value
    const hdr = CF.readClientHeaders({ headers: { 'x-client-app': 'orders', 'x-client-deployment': entry.id } });
    assert.strictEqual(G.isCappGuest(hdr, null), true);
  }
  ok('manifest (the REAL merged sites.json once f838eaa7 landed — its S2 fields == f838eaa7\'s line; else the exact line spliced in) through the real loader; it is THE platform orders deployment, its id is the discriminator, its origin joins ACCOUNT_ORIGINS, form origins unchanged');

  // ── 3. cart_fp equivalence FROM THE REAL WRITER: capp cartSig(f) === server recompute(the capp's own order body, over the wire) ──
  try {
  for (const [writer, mod] of CAPP_WRITERS) {
    CAPP = mod;
    {
      const cases = [
        ['delivery, no tip chosen', flow()], ['delivery, «Sin propina»', flow({ tip: 0 })], ['delivery, preset tip', flow({ tip: 40 })],
        ['delivery, «Otro» tip', flow({ tip: { other: 75 } })], ['pickup', flow({ mode: 'pickup' })], ['floating lat/lng', flow({ lat: 14.07230000000001, lng: -87.19219999999999 })],
      ];
      const extrasCtx = ctxOf({ items: [{ id: 7, name: 'Pizza Ñandú — «especial»', qty: 1, price: 300, extras: [{ instance: 0, name: 'Jalapeño', price: 25 }, { instance: 1, name: 'Piña', price: 25 }] }] });
      for (const [label, f] of cases) {
        for (const ctx of [ctxOf(), extrasCtx]) {
          const capp = await CAPP.cartSig(f, ctx, subtle);
          const server = await G.cartFpFromBody(wire(CAPP.orderBody(f, ctx)));
          assert.strictEqual(server, capp, `🔴 ${label}: the server recompute differs from the capp's cartSig`);
        }
      }
      // the one-source module IS the capp's algorithm (same canonical form)
      const f = flow({ tip: 20 });
      assert.strictEqual(require('./cart-sig').canonicalJson(CAPP.sigInput(f, ctxOf())), CAPP.canonicalJson(CAPP.sigInput(f, ctxOf())));
      // negatives — a different cart than the one signed never matches
      const signed = await CAPP.cartSig(flow(), ctxOf(), subtle);
      const body = wire(CAPP.orderBody(flow(), ctxOf()));
      for (const [why, mut] of [['items', (b) => { b.items = [{ ...b.items[0], qty: 3 }]; }], ['mode', (b) => { b.order_type = 'pickup'; }], ['pin lat', (b) => { b.lat += 0.0001; }],
        ['tip', (b) => { b.tip_cents = 2000; }], ['rid', (b) => { b.restaurant_id = 'la_musa'; }], ['pin unconfirmed on the wire', (b) => { b.pin_confirmed = false; }]]) {
        const m = clone(body); mut(m);
        assert.notStrictEqual(await G.cartFpFromBody(m), signed, `🔴 a changed ${why} must not match`);
      }
      // an UNCONFIRMED pin signed by the capp can never match what the wire carries (orderBody always sends pin_confirmed:true)
      const unconf = flow({ confirmed: false });
      assert.notStrictEqual(await G.cartFpFromBody(wire(CAPP.orderBody(unconf, ctxOf()))), await CAPP.cartSig(unconf, ctxOf(), subtle), 'an unconfirmed-pin signature never matches');
      for (const bad of [{ ...body, items: 'x' }, { ...body, order_type: 'dinein' }, { ...body, lat: '14.07' }, { ...body, lng: NaN }, { ...body, tip_cents: -1 }, { ...body, tip_cents: 1.5 },
        { ...body, tip_cents: null }, { ...body, restaurant_id: 7 }, null]) assert.strictEqual(await G.cartFpFromBody(bad), null, `unrepresentable ⇒ null: ${JSON.stringify(bad && Object.keys(bad))}`);
      assert.strictEqual(await G.cartFpFromBody({ ...wire(CAPP.orderBody(flow({ mode: 'pickup' }), ctxOf())), lat: 1, lng: 2, pin_confirmed: true }),
        await CAPP.cartSig(flow({ mode: 'pickup' }), ctxOf(), subtle), 'pickup ⇒ pin null regardless of stray lat/lng');
      assert.strictEqual(await G.cartFpFromBody({ ...body, tip_cents: 0 }), signed, 'an explicit tip_cents 0 = omitted (the capp\'s tipCentsOf)');
    }
  }
  } finally { CAPP = CAPP_FIXTURE; }
  ok(`cart_fp (${CAPP_WRITERS.map(([w]) => w).join(' + ')}): the server recompute of the capp\'s REAL order body (via the wire) === the capp\'s REAL cartSig for delivery/pickup, tip omitted/0/preset/other, extras, unicode, floating pins; each changed field, an unconfirmed pin and every unrepresentable body never match`);

  // ── 4. createOrder: every capp guest refused, pure; everyone else untouched ──
  {
    const APP = { deployment: 'orders-app' };
    for (const [hdr, uid] of [[{ deployment: 'orders-xpizza' }, null], [{ deployment: 'orders-lamusa' }, null], [{ deployment: null }, null], [APP, 'u_member'], [null, null], [{ deployment: 'orders-app2' }, null]])
      assert.strictEqual(GATE.createOrderRefusal(hdr, uid, { payment_method: 'cash' }), null, `untouched: ${JSON.stringify(hdr)} / ${uid}`);
    assert.strictEqual(GATE.createOrderRefusal(APP, null, { payment_method: 'cash' }), 'guest_cash_not_allowed');
    assert.strictEqual(GATE.createOrderRefusal(APP, null, { payment_method: 'card_delivery' }), 'guest_cash_not_allowed', 'D4 closed: online only');
    assert.strictEqual(GATE.createOrderRefusal(APP, null, { payment_method: 'cash', scheduled_for: 1.9e12 }), 'guest_cash_not_allowed');
    assert.strictEqual(GATE.createOrderRefusal(APP, null, { payment_method: 'cash', checkout_ticket: 'ct_' + 'a'.repeat(32) }), 'guest_ticket_invalid', 'a ticket-bearing guest body (Codex\'s B sequence, cash leg)');
    assert.strictEqual(GATE.createOrderRefusal(APP, null, null), 'guest_cash_not_allowed');
  }
  ok('createOrder: forms / members / absent / unknown headers ⇒ null; EVERY capp guest refused (cash + card_delivery ⇒ guest_cash_not_allowed, a ticket-bearing body ⇒ guest_ticket_invalid)');

  // ── the S2 charge harness: the ticket is issued by the REAL S1 writer (verifyCheckoutCode) for the capp's REAL signature ──
  let clock = 1.8e12;
  const db = fakeDb();
  const sent = [];
  const S1 = makeCheckoutOtp({ getDatabase: () => db, knownRid: async (r) => r === RID || r === 'la_musa', now: () => clock,
    env: { ULTRAMSG_INSTANCE_ID_PLATFORM: 'i', ULTRAMSG_TOKEN_PLATFORM: 't', CHECKOUT_OTP_TEMPLATE: '{code}' },
    fetchImpl: async (u, init) => { sent.push(new URLSearchParams(init.body).get('body')); return { ok: true, json: async () => ({ sent: 'true', id: 1 }) }; } });
  const call = async (fn, body) => { const r = { status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; await S1[fn]({ method: 'POST', body, ip: '9.9.9.9' }, r); return r; };
  async function ticketFor({ phone = '+50499990000', f = flow(), ctx = ctxOf() } = {}) {
    const cart_fp = await CAPP.cartSig(f, ctx, subtle);
    clock += G.BUDGET.WINDOW + 1;   // the per-phone send budget (3 per 10 min) is S1's, not under test here
    const a = await call('requestCheckoutCode', { phone_e164: phone, restaurant_id: ctx.restaurantId, cart_fp });
    assert.strictEqual(a.code, 200, JSON.stringify(a.body));
    const v = await call('verifyCheckoutCode', { phone_e164: phone, restaurant_id: ctx.restaurantId, cart_fp, order_id: ctx.orderId, code: sent[sent.length - 1] });
    assert.strictEqual(v.code, 200, JSON.stringify(v.body));
    return v.body.checkout_ticket;
  }
  const APP = { deployment: 'orders-app' };
  const guestBody = (ticket, f = flow(), ctx = ctxOf()) => ({ ...wire(CAPP.orderBody(f, ctx)), checkout_ticket: ticket });
  const gate = (body, o = {}) => GATE.chargeGate({ clientHdr: APP, uid: null, body, rid: RID, orderId: body.order_id, db, now: clock, OTP, normalizePhone, ...o });

  // ── 5. charge: non-guests never touch the database ──
  {
    const t = await ticketFor();
    for (const [hdr, uid] of [[{ deployment: 'orders-xpizza' }, null], [{ deployment: 'orders-lamusa' }, null], [{ deployment: null }, null], [APP, 'u_member'], [{ deployment: 'orders-app2' }, null]])
      assert.strictEqual(await gate(guestBody(t), { clientHdr: hdr, uid, db: noTouchDb }), null, `zero I/O: ${JSON.stringify(hdr)} / ${uid}`);
    const before = db.calls.length;
    assert.deepStrictEqual(await gate({ ...guestBody(t), payment_method: 'cash' }), { refuse: 'guest_cash_not_allowed' });
    assert.deepStrictEqual(await gate({ ...guestBody(t), scheduled_for: 1.9e12 }), { refuse: 'guest_schedule_requires_account' });
    const noEmail = guestBody(t); delete noEmail.customer_email;
    assert.deepStrictEqual(await gate(noEmail), { refuse: 'guest_email_required' });
    assert.strictEqual(db.calls.length, before, 'the body refusals answer with ZERO reads');
  }
  ok('charge: forms / members / absent / unknown headers ⇒ null with ZERO database access; the body refusals (payment → scheduling → email) answer with zero reads');

  // ── 6. charge: the ticket — valid only for ITS order / cart / phone / restaurant, before exp; read-only ──
  {
    const t = await ticketFor();
    const body = guestBody(t);
    const okv = await gate(body);
    assert.deepStrictEqual(okv, { guest: { phone: '50499990000', phone_hash: OTP.phoneHash('50499990000') } });
    assert.deepStrictEqual(await gate(body), okv, 'read-only: a second check answers the same (a refused / failed attempt consumes nothing)');
    const bad = { refuse: 'guest_ticket_invalid' };
    for (const [why, b, o] of [
      ['no ticket', { ...body, checkout_ticket: undefined }], ['malformed ticket', { ...body, checkout_ticket: 'ct_zz' }], ['unknown ticket', { ...body, checkout_ticket: 'ct_' + 'f'.repeat(32) }],
      ['another order id', { ...body, order_id: 'XPZ-guest-2' }], ['a changed cart', { ...body, items: [{ ...body.items[0], qty: 5 }] }], ['a changed tip', { ...body, tip_cents: 100 }],
      ['another phone', { ...body, customer_phone: '+504 8888-1111' }], ['no phone', { ...body, customer_phone: undefined }], ['another restaurant', body, { rid: 'la_musa' }],
      ['expired', body, { now: clock + G.TICKET_TTL_MS }]]) assert.deepStrictEqual(await gate(b, o), bad, `🔴 ${why}`);
    // the phone is matched through the OTP normalisation, whatever the display format
    assert.deepStrictEqual(await gate({ ...body, customer_phone: '50499990000' }), okv, 'the same phone in another format');
  }
  ok('charge: a REAL S1 ticket passes only for its own order id / cart / phone / restaurant before exp (one reason, no oracle); read-only; phone matched via the OTP normalisation');

  // ── 7. phone binding: an EXISTING order under the id must carry THIS ticket's phone (Codex's A/B sequence) ──
  {
    const ctx = ctxOf({ orderId: 'XPZ-O' });
    const tA = await ticketFor({ ctx });
    const A = await gate(guestBody(tA, flow(), ctx));
    assert.ok(A.guest);
    db.set('orders/XPZ-O', { status: 'pending_payment', created_at: clock, guest_verified: A.guest });   // A placed O (the CAS write)
    assert.deepStrictEqual(await gate(guestBody(tA, flow(), ctx)), A, 'A\'s replay passes');
    const fB = flow(); fB.phone = '8888-1111';
    const tB = await ticketFor({ phone: '+50488881111', f: fB, ctx });   // B: a VALID ticket for the same O / rid / cart, B's own phone
    const bodyB = guestBody(tB, fB, ctx);
    assert.deepStrictEqual(await gate(bodyB), { refuse: 'guest_ticket_invalid' }, '🔴 B is refused on the online leg');
    assert.strictEqual(GATE.createOrderRefusal(APP, null, { ...bodyB, payment_method: 'cash' }), 'guest_ticket_invalid', '🔴 … and on the cash leg');
    assert.strictEqual(db.get('orders/XPZ-O/guest_verified/phone'), '50499990000', 'O still carries A\'s phone');
    assert.strictEqual(await GATE.boundToGuest({ db, orderId: 'XPZ-O', guest: { phone_hash: OTP.phoneHash('50488881111') } }), false, 'post-CAS: B is not bound');
    assert.strictEqual(await GATE.boundToGuest({ db, orderId: 'XPZ-O', guest: A.guest }), true);
    assert.strictEqual(await GATE.boundToGuest({ db, orderId: 'XPZ-none', guest: A.guest }), true, 'no order ⇒ nothing to leak ⇒ the outcome answers as today');
    // a FORM's order under that id (no guest_verified) is never reused by a guest
    const ctxF = ctxOf({ orderId: 'XPZ-F' });
    const tF = await ticketFor({ ctx: ctxF });
    db.set('orders/XPZ-F', { status: 'new', created_at: clock, payment_method: 'cash' });
    assert.deepStrictEqual(await gate(guestBody(tF, flow(), ctxF)), { refuse: 'guest_ticket_invalid' });
  }
  ok('binding: B\'s VALID ticket for A\'s order is refused (online + cash legs), O keeps A\'s phone; post-CAS boundToGuest agrees; a form\'s order under the id is never reused');

  // ── 8. the grant: from the STORED order, the same bytes on every replay; mismatch refused; fail-closed secret ──
  {
    const S = 'k'.repeat(40);
    const guest = { phone: '50499990000', phone_hash: OTP.phoneHash('50499990000') };
    const created = clock;
    db.set('orders/XPZ-G', { status: 'pending_payment', created_at: created, guest_verified: guest });
    const g1 = await GATE.grantFor({ db, orderId: 'XPZ-G', guest, secret: S, now: created + 1000 });
    const g2 = await GATE.grantFor({ db, orderId: 'XPZ-G', guest, secret: S, now: created + 9 * 60e3 });
    assert.deepStrictEqual(g1, g2, 'a replay / reuse / concurrent success recomputes the SAME grant (no TTL reset)');
    assert.strictEqual(g1.grant.expires_at, created + 15 * 60e3);
    const v = G.verifyGrant(g1.grant.token, S, created + 1000);
    assert.ok(v.ok && v.payload.order_id === 'XPZ-G' && v.payload.phone_hash === guest.phone_hash, 'the grant verifies and binds order + phone');
    assert.deepStrictEqual(await GATE.grantFor({ db, orderId: 'XPZ-G', guest: { phone_hash: OTP.phoneHash('50488881111') }, secret: S, now: created }), { refuse: 'guest_ticket_invalid' }, '🔴 another phone: no grant');
    assert.deepStrictEqual(await GATE.grantFor({ db, orderId: 'XPZ-nope', guest, secret: S, now: created }), { refuse: 'guest_ticket_invalid' }, 'no stored order: no grant');
    assert.deepStrictEqual(await GATE.grantFor({ db, orderId: 'XPZ-G', guest, secret: 'short', now: created }), { grant: null }, 'a missing / short secret ⇒ no grant, never a failed charge');
    assert.deepStrictEqual(await GATE.grantFor({ db, orderId: 'XPZ-G', guest, secret: S, now: created + 15 * 60e3 }), { grant: null }, 'an expired grant is not handed out');
    db.set('orders/XPZ-G2', { status: 'pending_payment', guest_verified: guest });
    assert.deepStrictEqual(await GATE.grantFor({ db, orderId: 'XPZ-G2', guest, secret: S, now: created }), { grant: null }, 'no created_at ⇒ no grant (fallback: normal signup)');
  }
  ok('grant: recomputed from the stored order (same bytes on replay, exp = created_at + 15 min, verifies); another phone / no order ⇒ refused; no secret / expired / no created_at ⇒ null, never a failed charge');

  // ── 9. Codex r1 P1-2: the REAL acquireHostedAttempt never lets a foreign guest phone touch another guest's order / attempts ──
  {
    const { acquireHostedAttempt } = require('./pixelpay-hosted-charge');
    const adb = fakeDb();
    const gA = { phone: '50499990000', phone_hash: OTP.phoneHash('50499990000') }, gB = { phone: '50488881111', phone_hash: OTP.phoneHash('50488881111') };
    const rec = (g) => ({ order_id: 'XPZ-R', status: 'pending_payment', payment_status: 'pending', total_cents: 1000, created_at: 1, guest_verified: g });
    const T = 1.8e12, FPX = 'fp-1';
    const a1 = await acquireHostedAttempt(adb, 'XPZ-R', rec(gA), FPX, T);
    assert.strictEqual(a1.outcome, 'claimed', 'A creates O');
    adb.set(`payment_attempts/${a1.attempt_id}/hosted_state`, 'failed_create');   // A's checkout creation failed (a non-money terminal)
    const before = JSON.stringify(adb.tree);
    const b = await acquireHostedAttempt(adb, 'XPZ-R', rec(gB), FPX, T + 1000);
    assert.deepStrictEqual(b, { outcome: 'conflict', reason: 'guest_phone' }, '🔴 B (another verified phone) is refused before any rotation');
    assert.strictEqual(JSON.stringify(adb.tree), before, '🔴 B wrote NOTHING: A\'s order and attempts untouched (A is not stranded)');
    assert.strictEqual(await GATE.boundToGuest({ db: adb, orderId: 'XPZ-R', guest: gB }), false, 'the handler then answers B guest_ticket_invalid (gate-bind)');
    const a2 = await acquireHostedAttempt(adb, 'XPZ-R', rec(gA), FPX, T + 2000);
    assert.strictEqual(a2.outcome, 'claimed', 'A\'s retry rotates its own failed attempt (never in_progress forever)');
    assert.notStrictEqual(a2.attempt_id, a1.attempt_id);
    // INSIDE the CAS: a pre-read that looked like A's order, while the server holds another phone → the CAS is a no-op, the re-read refuses
    adb.set('orders/XPZ-R/guest_verified', gB);
    adb.set(`payment_attempts/${a2.attempt_id}/hosted_state`, 'failed_create');
    let first = true;
    const stale = { ...adb, ref: (p) => { const r = adb.ref(p); if (p !== 'orders/XPZ-R') return r; return { ...r, once: async () => { if (first) { first = false; const v = clone(adb.get(p)); v.guest_verified = gA; return { exists: () => true, val: () => v }; } return r.once(); } }; } };
    const before2 = JSON.stringify(adb.tree);
    const c = await acquireHostedAttempt(stale, 'XPZ-R', rec(gA), FPX, T + 3000);
    assert.deepStrictEqual(c, { outcome: 'conflict', reason: 'guest_phone' }, 'the CAS itself refuses a foreign phone');
    assert.strictEqual(JSON.stringify(adb.tree), before2, '🔴 nothing rotated inside the CAS');
    // Codex r2 P1 — RECOVERY: a pre-read showing A's order with a pointer whose attempt record is MISSING (⇒ `recover`), while the
    // AUTHORITATIVE record carries another phone: the guarded CAS returns it unchanged (committed) — and still NO attempt is written
    adb.set('orders/XPZ-R/guest_verified', gB);
    adb.set('orders/XPZ-R/active_attempt_id', 'att_missing_000000');
    let firstR = true;
    const staleR = { ...adb, ref: (p) => { const r = adb.ref(p); if (p !== 'orders/XPZ-R') return r; return { ...r, once: async () => { if (firstR) { firstR = false; const v = clone(adb.get(p)); v.guest_verified = gA; return { exists: () => true, val: () => v }; } return r.once(); } }; } };
    const before3 = JSON.stringify(adb.tree);
    const rc = await acquireHostedAttempt(staleR, 'XPZ-R', rec(gA), FPX, T + 4000);
    assert.deepStrictEqual(rc, { outcome: 'conflict', reason: 'guest_phone' }, 'a foreign recovery is refused on the AUTHORITATIVE record');
    assert.strictEqual(adb.get('payment_attempts/att_missing_000000'), undefined, '🔴 no payment_attempts row written for the foreign phone');
    assert.strictEqual(JSON.stringify(adb.tree), before3, '🔴 nothing written at all');
    // the PRE-READ refusal: acquire never answers ABOUT another guest's order — not its live checkout (reuse + A's URL), not its
    // in-flight attempt, not its paid state — before any terminal / reuse return
    {
      const pdb = fakeDb();
      const p1 = await acquireHostedAttempt(pdb, 'XPZ-P', rec(gA), FPX, T);
      pdb.set(`payment_attempts/${p1.attempt_id}`, { ...pdb.get(`payment_attempts/${p1.attempt_id}`), hosted_state: 'created', hosted_checkout_url: 'https://pay.test/A', hosted_expires_at: T + 3600e3 });
      assert.strictEqual((await acquireHostedAttempt(pdb, 'XPZ-P', rec(gA), FPX, T + 1)).outcome, 'reuse', 'premise: A reuses its live checkout');
      for (const [state, set] of [['a live checkout', () => {}], ['in flight', () => pdb.set(`payment_attempts/${p1.attempt_id}/hosted_state`, 'creating')], ['paid', () => pdb.set('orders/XPZ-P/payment_status', 'confirmed')]]) {
        set();
        const before = JSON.stringify(pdb.tree);
        const got = await acquireHostedAttempt(pdb, 'XPZ-P', rec(gB), FPX, T + 2);
        assert.deepStrictEqual(got, { outcome: 'conflict', reason: 'guest_phone' }, `🔴 ${state}: B learns nothing about A's order (no reuse URL / in_progress / already_paid)`);
        assert.strictEqual(JSON.stringify(pdb.tree), before);
      }
    }
    // forms / members (no guest_verified on the pending record) are unchanged — the same rotation as today
    const fdb = fakeDb();
    const f1 = await acquireHostedAttempt(fdb, 'XPZ-F', { order_id: 'XPZ-F', total_cents: 1, status: 'pending_payment' }, FPX, T);
    fdb.set(`payment_attempts/${f1.attempt_id}/hosted_state`, 'failed_create');
    assert.strictEqual((await acquireHostedAttempt(fdb, 'XPZ-F', { order_id: 'XPZ-F', total_cents: 1, status: 'pending_payment' }, FPX, T + 1)).outcome, 'claimed', 'a form retry rotates as today');
  }
  ok('acquire (Codex r1 P1-2 / r2 P1): B\'s foreign phone is refused at the pre-read, inside the CAS, and on the authoritative record after it (incl. Codex\'s recover repro: a missing attempt, no row written) with nothing written — A\'s failed attempt is never rotated by B, A\'s retry rotates it; form records unchanged');

  // ── 10. Codex r1 P2-4: chargeUidOf = the charge handler's identity rules (guest ⇔ null) ──
  {
    const { attributionUid } = require('./create-order-build');
    const tomb = new Set(['u_gone']);
    const mk = (verify) => ({ getAuth: () => ({ verifyIdToken: verify }), getDatabase: () => ({ ref: (p) => ({ get: async () => ({ exists: () => tomb.has(p.split('/')[1]) }) }) }), attributionUid });
    const req = (tok) => ({ get: (h) => (h === 'x-firebase-id-token' ? tok : undefined) });
    assert.strictEqual(await GATE.chargeUidOf(req(undefined), mk(async () => { throw new Error('never'); })), null, 'no token ⇒ guest');
    assert.strictEqual(await GATE.chargeUidOf(req('t'), mk(async () => ({ uid: 'u_a', customer: true }))), attributionUid({ uid: 'u_a', customer: true }, false), 'a verified customer ⇒ the handler\'s attribution');
    assert.ok(await GATE.chargeUidOf(req('t'), mk(async () => ({ uid: 'u_a', customer: true }))), 'premise: a member resolves to a uid (⇒ the generic answer below, unchanged)');
    assert.strictEqual(await GATE.chargeUidOf(req('t'), mk(async () => ({ uid: 'u_a' }))), null, 'a non-customer token ⇒ guest');
    assert.strictEqual(await GATE.chargeUidOf(req('t'), mk(async () => ({ uid: 'u_gone', customer: true }))), attributionUid({ uid: 'u_gone', customer: true }, true), 'a tombstoned uid ⇒ as the handler');
    assert.strictEqual(await GATE.chargeUidOf(req('t'), mk(async () => { throw new Error('expired'); })), undefined, '🔴 a verify ERROR is unresolved (generic answer), never "a guest"');
    const slowTomb = { ...mk(async () => ({ uid: 'u_a', customer: true })), getDatabase: () => ({ ref: () => ({ get: () => new Promise((r) => setTimeout(() => r({ exists: () => false }), 60)) }) }), deadlineMs: 20 };
    assert.strictEqual(await GATE.chargeUidOf(req('t'), slowTomb), undefined, '🔴 a slow tombstone read ⇒ unresolved');
    const errTomb = { ...mk(async () => ({ uid: 'u_a', customer: true })), getDatabase: () => ({ ref: () => ({ get: async () => { throw new Error('UNAVAILABLE'); } }) }) };
    assert.strictEqual(await GATE.chargeUidOf(req('t'), errTomb), undefined, '🔴 a tombstone read ERROR ⇒ unresolved');
    assert.strictEqual(await GATE.chargeUidOf(req('t'), { ...mk(() => new Promise(() => {})), deadlineMs: 20 }), undefined, '🔴 FAIL-CLOSED: a hung verify is UNDECIDED (a timed-out member must get the generic 400, never the guest path)');
    assert.strictEqual(await GATE.chargeUidOf(req('t'), { ...mk(async () => { await new Promise((r) => setTimeout(r, 60)); return { uid: 'u_a', customer: true }; }), deadlineMs: 20 }), undefined, 'a slow member ⇒ undecided');
  }
  ok('chargeUidOf (Codex r1 P2-4 / r2 P2): no token / a non-customer token ⇒ null (a verified guest); a slow / hung / failing verify, a slow or failing tombstone read ⇒ undefined (fail-closed: the generic answer); a verified customer ⇒ the handler\'s attributionUid (tombstone included)');

  console.log(`\ncheckout-guest-gate: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
