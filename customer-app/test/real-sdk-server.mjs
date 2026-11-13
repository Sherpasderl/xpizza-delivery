// TEST-ONLY: the SDK checkout server as PRODUCTION runs it, in-process (Codex capp-d4-client r1 P2-7: never laxer than production).
// placeSdkOrder = chargeOnlineOrder's SDK branch (index.js §A2 B1 → B2 → B4) composed from the REAL cores: intake.authorize (the exact
// envelope, the sdk_ namespace, a 20-char saved card_id), intake.replay (a KNOWN attempt answers), intake.admit (the availability flag),
// finish.finishSdk (create-once order, the binding re-check, the C6 subject, placeOriginal at the STORED total) and the handler's own
// refusal mapping (acquireRefusal: extras-intake / order-exists bodies). placeSdkStatus / cancelSdkPending are their real cores. Money
// goes through the real coordinator to a fake PSP whose authorize calls are COUNTED. The honest RTDB model holds every write.
// What the handler computes from its own pricing reads is fed from the body the client sent: total_cents = the client's
// expected_net_cents (the server quote it stands behind), the fingerprint = the REAL orderFingerprint over (id, total, items_text, tip).
// Controls a cell may use: arm(flags) — the handler's deferred refusal flags for the NEXT request (e.g. { extrasRefuseFresh:
// 'extra_not_allowed' }); pauseGate() — the next finish waits at its gate (after the create-once order, BEFORE any attempt is claimed)
// until release(); loseNext() — the next placeSdkOrder reaches the server but its response is lost (the client sees a network error —
// once that request is parked at a paused gate, or at once). THE FENCE (advisor contract 11-12; 3a's approved sdk_fence/{id}, store-then-
// check, shipping before this build goes live): MODELLED here — a cancel of an ABSENT order stores the fence (its answer stays the
// byte-identical NO_SDK_ORDER), and a fenced id is refused at intake and again after the gate (before any attempt is claimed). The
// refusal body is the model's own until 3a's plan names it. GO-LIVE: production's is index.js's live write (the emulator suite); here it
// writes ONLY the tracking token — the one field the status answer reads before it says «placed» (status.js: «no token yet ⇒ keep polling»).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const FN = '../../xpizza-functions/';
const { makeHonestDb } = require(`${FN}_honest-rtdb-model.js`);
const { makeAdapter } = require(`${FN}payments/sdk/psp-adapter.js`);
const { makeFakePsp } = require(`${FN}payments/sdk/fake-adapter.js`);
const INTAKE = require(`${FN}payments/sdk/intake.js`);
const { finishSdk } = require(`${FN}payments/sdk/finish.js`);
const { placeSdkStatusCore } = require(`${FN}payments/sdk/status-endpoint.js`);
const { cancelSdkPendingCore } = require(`${FN}payments/sdk/switch-endpoint.js`);
const { sdkPayStatusCore } = require(`${FN}payments/sdk/sdk-pay-flag.js`);
const { orderFingerprint } = require(`${FN}pixelpay-charge.js`);
const TIP = require(`${FN}tip.js`);
const EI = require(`${FN}catalog/extras-intake.js`);
const OE = require(`${FN}order-exists.js`);
const DW = require(`${FN}delivery/delivery-wire.js`);

const NO_FLAGS = Object.freeze({ controlRefuseFresh: false, menuRefuseFresh: false, choiceRefuseFresh: false, extrasRefuseFresh: null, cartBlocked: [], refuseFresh: false, payerRefuseFresh: false });

// members: { [idToken]: uid }; cards: { [uid]: { [card_id]: { token, brand, last4, exp_month, exp_year } } }; rids: the allowlist
export function realSdkServer({ clock, members = {}, cards = {}, rids = [], pspScript = {} } = {}) {
  const seedCards = {};
  for (const [uid, cs] of Object.entries(cards)) seedCards[uid] = { cards: Object.fromEntries(Object.entries(cs).map(([id, c]) => [id, { token_hash: `h_${id}`, ...c }])) };
  const db = makeHonestDb({ platform_config: { sdk_pay: { available: true, retry_after_s: 120, restaurants: Object.fromEntries(rids.map((r) => [r, true])) } }, customer_cards: seedCards }, { now: () => clock.t });
  const psp = makeFakePsp(pspScript);
  const verifyIdToken = async (t) => { if (Object.prototype.hasOwnProperty.call(members, t)) return { uid: members[t] }; throw new Error('auth_invalid'); };
  const deps = { db, psp: makeAdapter(psp.impl), clock: () => clock.t, voidEligible: () => false, ppNamespace: 'sandbox', releaseResources: async () => {},
    goLive: async (dp, id) => { await db.ref(`orders/${id}/tracking_token`).set(`tok_${id.replace(/[^A-Za-z0-9]/g, '').slice(-12)}`); },
    verifyIdToken, isTombstoned: async () => false, attributionUid: (d, tomb) => (!tomb && d && typeof d.uid === 'string' ? d.uid : null), deadlineMs: 1500 };
  let armed = { ...NO_FLAGS }; let gate = null; let loseNext = false; let parked = null; const inflight = [];
  const FENCED = Object.freeze({ status: 409, body: Object.freeze({ error: 'order_fenced' }) });   // MODEL (see the header)
  const fenced = async (id) => (await db.ref(`sdk_fence/${id}`).once('value')).val() != null;
  const hdrs = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v]));

  async function placeSdkOrder(req) {
    const flags = armed; armed = { ...NO_FLAGS };
    const myGate = gate; gate = null;
    const body = JSON.parse(JSON.stringify(req.body || {}));
    const r = { headers: hdrs(req.headers), body };
    const a = await INTAKE.authorize(r, deps);                                                       // B1
    if (a.refuse) return a.refuse;
    if (await fenced(body.order_id)) return { ...FENCED };                                            // MODEL: the fence, at intake
    const uid = a.kind === 'member' ? a.uid : null;
    const rp = await INTAKE.replay(deps, { orderId: body.order_id, attemptId: body.attempt_id, uid });   // B2: a KNOWN attempt
    if (rp) return rp;
    const ad = await INTAKE.admit(deps, { restaurantId: body.restaurant_id, scheduledFor: body.scheduled_for == null ? null : body.scheduled_for });
    if (ad) return ad;
    const total = body.expected_net_cents;
    const pendingOrderRecord = { order_id: body.order_id, restaurant_id: body.restaurant_id, status: 'pending_payment', payment_status: 'pending', payment_method: 'online',
      order_type: body.order_type, customer_name: body.customer_name, customer_phone: body.customer_phone, items_text: body.items_text, total: total / 100, total_cents: total,
      created_at: clock.t, ...(uid ? { customer_uid: uid } : {}), ...(TIP.ofBody(body) > 0 ? { tip_cents: TIP.ofBody(body) } : {}) };
    const fin = await finishSdk(deps, {                                                                // B4
      orderId: body.order_id, kind: uid ? 'member' : 'guest', uid, guestPhoneHash: null, attemptId: body.attempt_id, card: body.card,
      replacesOrderId: body.replaces_order_id == null ? null : body.replaces_order_id, pendingOrderRecord,
      fingerprint: orderFingerprint(body.order_id, total, body.items_text, TIP.extraOf(body)), tipCents: TIP.ofBody(body), nowTs: clock.t, flags,
      runGate: async () => { if (myGate) { myGate.mark(); await myGate.wait; } return (await fenced(body.order_id)) ? { refuse: { ...FENCED } } : { refuse: null, provenance: null }; },   // MODEL: store-then-check
      deliveryResume: (o) => DW.deliveryResumeRefusal(db, o, DW.loadPricing(db)),
      answerRefusal: (x) => ({ answer: refusalAnswer(x, body.order_id, flags) }),
    });
    return fin.answer || { status: fin.status, body: fin.body };
  }
  // index.js acquireRefusal, the outcomes a finish can hand it
  function refusalAnswer(acq, orderId, flags) {
    if (acq.outcome === 'item_unavailable') return { status: 400, body: { error: 'item_unavailable', blocked: acq.blocked || [] } };
    if (acq.outcome === 'conflict' && (acq.reason === 'extra_not_allowed' || acq.reason === 'eligibility_unavailable')) {
      const xr = { outcome: acq.reason === 'extra_not_allowed' ? 'denied' : 'unavailable', denied: acq.reason === 'extra_not_allowed' ? (flags.extrasDenied || []) : [] };
      return { status: EI.refusalStatus(xr), body: { ...EI.refusalBody(xr), order_id: orderId } };
    }
    if (acq.outcome === 'conflict') return { status: 409, body: OE.orderExistsBody(acq.reason || 'conflict', orderId) };
    return { status: 409, body: OE.orderExistsBody('closed', orderId) };
  }
  const json = (r) => ({ status: r.status, json: r.body });
  // the fetch the app's createApi takes: routes the SDK endpoints; anything else ⇒ `other` (the cell's own script)
  function fetchFor(E, other) {
    return async (url, init) => {
      const method = (init && init.method) || 'GET', headers = (init && init.headers) || {}, body = init && init.body ? JSON.parse(init.body) : null;
      const u = new URL(url);
      let res = null;
      if (url.startsWith(E.placeSdkOrder)) {
        const lose = loseNext; loseNext = false;
        const p = placeSdkOrder({ headers, body }); inflight.push(p);
        if (lose) { p.catch(() => {}); await Promise.race([p.catch(() => {}), parked || Promise.resolve()]); throw new TypeError('Failed to fetch'); }   // the server goes on; the response is lost
        res = json(await p);
      } else if (url.startsWith(E.placeSdkStatus)) res = json(await placeSdkStatusCore(deps, { headers: hdrs(headers), query: { order_id: u.searchParams.get('order_id') } }));
      else if (url.startsWith(E.cancelSdkPending)) {
        const r = await cancelSdkPendingCore(deps, { headers: hdrs(headers), body: body || {} });
        if (r.status === 200 && r.body && r.body.reason === 'no_sdk_order' && body && typeof body.order_id === 'string') await db.ref(`sdk_fence/${body.order_id}`).set(clock.t);   // MODEL: the fence is stored
        res = json(r);
      }
      else if (url.startsWith(E.sdkPayStatus)) { const q = u.searchParams.get('restaurant_id'); res = { status: 200, json: await sdkPayStatusCore(db, q === null ? undefined : q) }; }
      if (res) return { status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => res.json };
      return other(url, init);
    };
  }
  return {
    db, psp, deps, fetchFor,
    authorizations: () => psp.callCount('authorize'),
    arm: (f) => { armed = { ...NO_FLAGS, ...f }; },
    pauseGate: () => { let release, mark; const wait = new Promise((r) => { release = r; }); parked = new Promise((r) => { mark = r; }); gate = { wait, mark }; return () => release(); },
    loseNext: () => { loseNext = true; },
    settled: () => Promise.allSettled(inflight),
  };
}
