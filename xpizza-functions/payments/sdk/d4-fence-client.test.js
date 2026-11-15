'use strict';
// CROSS-LANE (PLAN-sdk-fence-r1 §4b; Codex plan r1 P2-3) — the fence proven through the REAL capp client response handling, not a cell
// that supplies the cancel itself: customer-app/capp-api.js (placeSdk → its refusal answer → cancelSdkPending → release ONLY on
// safe_to_switch === true → a NEW sdk_ id) over the REAL server cores (intake.authorize / replay / admit → finishSdk → the coordinator;
// cancelSdkPendingCore with the fence), the honest RTDB model and a fake PSP that COUNTS authorizations. No fence is modelled here.
// The sequence: ONE placement whose request is delivered twice (copy A parked at its create-once order; copy B refused pre-admission,
// extra_not_allowed — B's answer is the one the app hears); the app ends the placement; the customer pays again (Y); A resumes.
// TRUE ONLY ONCE BOTH LANES MERGE (the assembly rule): RED with 1d862e17's capp-api.js (it mints outside the sdk_ namespace — capp F1 —
// and its item refusal releases with no cancel); RED with the corrected client over a server WITHOUT the fence (two holds); GREEN with feat/capp-d4-client's (the cancel's safe answer releases ⇒ the fence) + this server. Wired into the chain at the
// train merge. CAPP_DIR=<a customer-app dir> runs it against another client tree (read-only). Run: node payments/sdk/d4-fence-client.test.js
const assert = require('assert');
const path = require('path');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const { makeAdapter } = require('./psp-adapter');
const { makeFakePsp } = require('./fake-adapter');
const INTAKE = require('./intake');
const { finishSdk } = require('./finish');
const { placeSdkStatusCore } = require('./status-endpoint');
const { cancelSdkPendingCore } = require('./switch-endpoint');
const { sdkPayStatusCore } = require('./sdk-pay-flag');
const C0 = require('./coordinator');
const { orderFingerprint } = require('../../pixelpay-charge');
const TIP = require('../../tip');
const EI = require('../../catalog/extras-intake');
const OE = require('../../order-exists');
const DW = require('../../delivery/delivery-wire');

const { SDK_ORDER_ID_RE: SDK_ID } = require('./order-id');
const CAPP = process.env.CAPP_DIR ? path.resolve(process.env.CAPP_DIR) : path.join(__dirname, '..', '..', '..', 'customer-app');
const CC = require(path.join(CAPP, 'capp-checkout.js'));
const A = require(path.join(CAPP, 'capp-api.js'));

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const NO_FLAGS = Object.freeze({ controlRefuseFresh: false, menuRefuseFresh: false, choiceRefuseFresh: false, extrasRefuseFresh: null, cartBlocked: [], refuseFresh: false, payerRefuseFresh: false });
const E = { quoteOrder: 'https://fn.test/quoteOrder', createOrder: 'https://fn.test/createOrder', chargeOnlineOrder: 'https://fn.test/chargeOnlineOrder', paymentStatus: 'https://fn.test/paymentStatus',
  placeSdkOrder: 'https://fn.test/placeSdkOrder', placeSdkStatus: 'https://fn.test/placeSdkStatus', cancelSdkPending: 'https://fn.test/cancelSdkPending', listCards: 'https://fn.test/listCards', sdkPayStatus: 'https://fn.test/sdkPayStatus' };
const OPEN_ALL = Array.from({ length: 7 }, () => [11, 0, 22, 0]);
const at = (h, m = 0) => new Date(2026, 9, 26, h, m, 0, 0).getTime();
const KEY = 'capp:rid_a:pending_place';
const JWT = (() => { const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); return `${b({ alg: 'RS256' })}.${b({ exp: Math.floor(at(23) / 1000) })}.sig`; })();
const ANA = { uid: 'u_ana', idToken: null, getIdToken: async () => JWT };
const CARD20 = 'CV4242000000000000AB';
const SAVED20 = { kind: 'saved', card_id: CARD20 };
const ITEMS = [{ id: 'margherita', name: 'Margherita', dish_id: 'd_1', qty: 1, price: 250, subtotal: 250, extras: [], extrasTotal: 0 }];
const CTX = { restaurantId: 'rid_a', items: ITEMS, itemsText: '1x Margherita (L250)', member: null };
const flowOf = () => { const f = CC.freshFlow(null); CC.setPin(f, 15.5, -88, true); Object.assign(f, { details: 'Portón', name: 'Ana', phone: '99990000', pay: 'online' }); CC.chooseTip(f, 20); return f; };
const args = () => ({ flow: flowOf(), ctx: CTX, sig: 'sig1', expectedNetCents: 31500, card: SAVED20 });
function memStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
const rec = (s) => JSON.parse(s.getItem(KEY) || 'null');
let RNG = 0;

// production's placeSdkOrder (index.js §A2 B1 → B2 → B4 + acquireRefusal) composed from the REAL cores; the cancel / status are their cores
function realServer(clock) {
  let txHook = null;
  const db = makeHonestDb({ platform_config: { sdk_pay: { available: true, retry_after_s: 120, restaurants: { rid_a: true } } },
    customer_cards: { u_ana: { cards: { [CARD20]: { token_hash: `h_${CARD20}`, token: 'tok_saved_1', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } } } } },
  { now: () => clock.t, beforeTx: async (p) => { if (txHook) await txHook(p); } });
  const psp = makeFakePsp({ authorize: Array.from({ length: 8 }, () => ({ outcome: 'approved' })) });
  const deps = { db, psp: makeAdapter(psp.impl), clock: () => clock.t, voidEligible: () => false, ppNamespace: 'sandbox', releaseResources: async () => {},
    goLive: async (dp, id) => { await db.ref(`orders/${id}/tracking_token`).set(`tok_${id.replace(/[^A-Za-z0-9]/g, '').slice(-12)}`); },
    verifyIdToken: async (t) => { if (t === JWT) return { uid: 'u_ana' }; throw new Error('auth_invalid'); },
    isTombstoned: async () => false, attributionUid: (d, tomb) => (!tomb && d && typeof d.uid === 'string' ? d.uid : null), deadlineMs: 1500 };
  const hdrs = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v]));
  async function placeSdkOrder(req, flags = NO_FLAGS) {
    const body = JSON.parse(JSON.stringify(req.body || {}));
    const a = await INTAKE.authorize({ headers: hdrs(req.headers), body }, deps);
    if (a.refuse) return a.refuse;
    const uid = a.kind === 'member' ? a.uid : null;
    const rp = await INTAKE.replay(deps, { orderId: body.order_id, attemptId: body.attempt_id, uid });
    if (rp) return rp;
    const ad = await INTAKE.admit(deps, { restaurantId: body.restaurant_id, scheduledFor: body.scheduled_for == null ? null : body.scheduled_for });
    if (ad) return ad;
    const total = body.expected_net_cents;
    const pendingOrderRecord = { order_id: body.order_id, restaurant_id: body.restaurant_id, status: 'pending_payment', payment_status: 'pending', payment_method: 'online',
      order_type: body.order_type, customer_name: body.customer_name, customer_phone: body.customer_phone, items_text: body.items_text, total: total / 100, total_cents: total,
      created_at: clock.t, ...(uid ? { customer_uid: uid } : {}), ...(TIP.ofBody(body) > 0 ? { tip_cents: TIP.ofBody(body) } : {}) };
    const fin = await finishSdk(deps, {
      orderId: body.order_id, kind: uid ? 'member' : 'guest', uid, guestPhoneHash: null, attemptId: body.attempt_id, card: body.card,
      replacesOrderId: body.replaces_order_id == null ? null : body.replaces_order_id, pendingOrderRecord,
      fingerprint: orderFingerprint(body.order_id, total, body.items_text, TIP.extraOf(body)), tipCents: TIP.ofBody(body), nowTs: clock.t, flags,
      runGate: async () => ({ refuse: null, provenance: null }), deliveryResume: (o) => DW.deliveryResumeRefusal(db, o, DW.loadPricing(db)),
      answerRefusal: (x) => ({ answer: refusalAnswer(x, body.order_id) }),
    });
    return fin.answer || { status: fin.status, body: fin.body };
  }
  // index.js acquireRefusal, for the outcomes a finish hands it
  function refusalAnswer(acq, orderId) {
    if (acq.outcome === 'conflict' && acq.reason === 'extra_not_allowed') { const xr = { outcome: 'denied', denied: [{ item: 'Margherita', extra: 'Pepperoni' }] }; return { status: EI.refusalStatus(xr), body: { ...EI.refusalBody(xr), order_id: orderId } }; }
    if (acq.outcome === 'conflict') return { status: 409, body: OE.orderExistsBody(acq.reason || 'conflict', orderId) };
    return { status: 409, body: OE.orderExistsBody('closed', orderId) };
  }
  let dup = null; let cancelFault = null; let cancels = 0; const inflight = [];
  const fetch = async (url, init) => {
    const headers = (init && init.headers) || {}; const body = init && init.body ? JSON.parse(init.body) : null; const u = new URL(url);
    let res;
    if (url.startsWith(E.placeSdkOrder)) {
      if (dup) {   // the SAME request delivered twice: copy A parked at its create-once order; copy B (the app hears it) refused pre-admission
        const d = dup; dup = null; let parked; const atTx = new Promise((r) => { parked = r; });
        txHook = async (p) => { if (p === `orders/${body.order_id}`) { txHook = null; parked(); await d.gate; } };
        const a = placeSdkOrder({ headers, body }); inflight.push(a);
        const early = await Promise.race([atTx.then(() => null), a]);   // A answered without reaching its create-once order ⇒ that IS the answer
        if (early) { txHook = null; res = early; } else res = await placeSdkOrder({ headers, body }, { ...NO_FLAGS, extrasRefuseFresh: 'extra_not_allowed' });
      } else res = await placeSdkOrder({ headers, body });
    } else if (url.startsWith(E.placeSdkStatus)) res = await placeSdkStatusCore(deps, { headers: hdrs(headers), query: { order_id: u.searchParams.get('order_id') } });
    else if (url.startsWith(E.cancelSdkPending)) {
      const f = cancelFault; cancelFault = null; cancels += 1;
      if (f === 'network') throw new TypeError('Failed to fetch');
      res = f || await cancelSdkPendingCore(deps, { headers: hdrs(headers), body: body || {} });
    } else if (url.startsWith(E.sdkPayStatus)) { const q = u.searchParams.get('restaurant_id'); res = { status: 200, body: await sdkPayStatusCore(db, q === null ? undefined : q) }; }
    else throw new Error(`unscripted ${url}`);
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => res.body };
  };
  return { db, psp, fetch, authorizations: () => psp.callCount('authorize'),
    duplicateNext: () => { let release; const gate = new Promise((r) => { release = r; }); dup = { gate }; return () => release(); },
    faultNextCancel: (f) => { cancelFault = f; }, cancels: () => cancels, settled: () => Promise.allSettled(inflight) };
}
function rig() {
  const clock = { t: at(12) }; const storage = memStorage(); const srv = realServer(clock); const posted = [];
  const fetch = async (url, init) => { if (url.startsWith(E.placeSdkOrder)) posted.push(JSON.parse(init.body).order_id); return srv.fetch(url, init); };
  const make = () => A.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: E, hours: OPEN_ALL, sdkCheckout: true },
    fetch, storage, now: () => clock.t, sleep: async () => {}, randomBytes: (k) => Uint8Array.from({ length: k }, () => { RNG = (RNG * 1103515245 + 12345) >>> 0; return (RNG >>> 16) & 255; }),
    setInterval: () => 0, clearInterval: () => {}, member: () => ANA });
  return { api: make(), reload: make, srv, storage, clock, posted };
}

(async () => {
  console.log(`  (client: ${path.relative(path.join(__dirname, '..', '..', '..'), CAPP) || CAPP})`);
  await cell('SDK-FENCE-CLIENT-ONE-HOLD', async (L) => {
    // the app ends the refused placement ONLY through the cancel's safe answer ⇒ the id is fenced ⇒ A (resumed after Y) never authorizes
    const s = rig();
    const releaseA = s.srv.duplicateNext();
    const first = await s.api.placeSdk(args());
    const X = s.posted[0];
    assert.ok(SDK_ID.test(X), `premise: the app placed in the SDK namespace (${X})`);
    assert.ok(first && first.order_id === X && first.kind === 'extra_not_allowed', `premise: the app heard B's refusal (${JSON.stringify(first)})`);
    assert.strictEqual(rec(s.storage), null, `premise: the app ended the placement (${JSON.stringify(rec(s.storage))})`);
    const y = await s.api.placeSdk(args());
    assert.strictEqual(y.kind, 'placed', `premise: the customer paid again (${JSON.stringify(y)})`);
    assert.notStrictEqual(s.posted[s.posted.length - 1], X, `${L}: a NEW sdk_ id after the release`);
    releaseA(); await s.srv.settled();
    assert.strictEqual(s.srv.authorizations(), 1, `${L}: exactly ONE authorization — the late original never authorizes (${s.srv.authorizations()})`);
    const ox = s.srv.db.getAt(`orders/${X}`);
    assert.ok(!ox || (ox.status === 'cancelled' && ox.payment_cancel), `${L}: X is absent or cancelled, never live (${JSON.stringify(ox && ox.status)})`);
  });

  for (const [name, fault] of [['SAFE-FALSE', { status: 200, body: { cancelled: true, safe_to_switch: false } }], ['401', { status: 401, body: { error: 'auth_invalid' } }],
    ['503', { status: 503, body: { error: 'unavailable', retryable: true } }], ['TRANSPORT', 'network']]) {
    await cell(`SDK-FENCE-CLIENT-RETAIN-${name}`, async (L) => {
      // the cancel did not answer safe_to_switch:true ⇒ the app keeps the ORIGINAL id (across a reload): no release, no new sdk_ id
      const s = rig();
      const releaseA = s.srv.duplicateNext();
      s.srv.faultNextCancel(fault);
      const first = await s.api.placeSdk(args());
      const X = s.posted[0];
      assert.ok(SDK_ID.test(X), `premise: the app placed in the SDK namespace (${X})`);
      assert.ok(first && first.order_id === X, `premise: the refused placement answered for X (${JSON.stringify(first)})`);
      assert.strictEqual(s.srv.cancels(), 1, `premise: the app asked the server to cancel (the fault was served)`);
      assert.ok(rec(s.storage) && rec(s.storage).order_id === X, `${L}: the original id is RETAINED (${JSON.stringify(rec(s.storage))})`);
      const again = s.reload();
      assert.ok(rec(s.storage) && rec(s.storage).order_id === X, `${L}: retained across a reload`);
      releaseA(); await s.srv.settled();
      await again.placeSdk(args());
      assert.deepStrictEqual([...new Set(s.posted)], [X], `${L}: never a second sdk_ id (${JSON.stringify(s.posted)})`);
      assert.ok(s.srv.authorizations() <= 1, `${L}: at most one authorization (${s.srv.authorizations()})`);
    });
  }

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-fence-client: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
