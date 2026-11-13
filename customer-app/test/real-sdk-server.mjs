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
// once that request is parked at a paused gate, or at once); issueTicket() — a guest's REAL checkout ticket record bound to an order id.
// THE FENCE — PLAN-sdk-fence-r1 as BUILT by 3a (ef889136 + its r1 P1 fix 10db81aa, feat/sdk-fence-3a: fence.js + finish.js + switch-endpoint.js),
// MIRRORED line for line until the train merge. ⚠ MERGE OBLIGATION (advisor 11-13): at the merge this file imports the REAL fence
// (payments/sdk/fence.js, the real finishSdk / cancelSdkPendingCore paths) and the mirror below is DELETED — a model can mask the real
// thing. Mirrored: sdk_fence/{sha256(order_id + "\n" + owner)} = { order_id, owner, at }, owner = the C6 subject (u_<uid> | p_<phone_hash>),
// create-once, permanent; finish reads it before its first write and again right after the create-once order (a hit cancels that
// order pendingOnly) and refuses through acquireRefusal's closed branch — 409 order_exists 'closed'; cancelSdkPending, when the caller's
// order is absent (≡ foreign) — or a guest's order is absent and its header ticket is bound to THIS id — stores the fence FIRST, THEN
// re-reads (a late create goes through the owned path), else the byte-identical NO_SDK_ORDER; a failed fence write ⇒ 503.
// GO-LIVE: production's is index.js's live write (the emulator suite); here it
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
const C = require(`${FN}payments/sdk/coordinator.js`);
const { sdkPayStatusCore } = require(`${FN}payments/sdk/sdk-pay-flag.js`);
const { orderFingerprint } = require(`${FN}pixelpay-charge.js`);
const TIP = require(`${FN}tip.js`);
const EI = require(`${FN}catalog/extras-intake.js`);
const OE = require(`${FN}order-exists.js`);
const DW = require(`${FN}delivery/delivery-wire.js`);
const SUB = require(`${FN}payments/sdk/subject.js`);
const F = require(`${FN}payments/sdk/flow.js`);
const { authorizeExistingOrder } = require(`${FN}payments/sdk/order-auth.js`);
const { NO_SDK_ORDER } = require(`${FN}payments/sdk/switch-endpoint.js`);
const G = require(`${FN}checkout-guest-lib.js`);
process.env.OTP_SALT = process.env.OTP_SALT || 'test-salt-'.padEnd(40, 'x');   // the server tests' convention (checkout-guest-gate.test.js:7)
const OTP = require(`${FN}otp-lib.js`);
const { normalizePhone } = require(`${FN}whatsapp.js`);
import { createHash } from 'node:crypto';

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
    verifyIdToken, isTombstoned: async () => false, attributionUid: (d, tomb) => (!tomb && d && typeof d.uid === 'string' ? d.uid : null), deadlineMs: 1500,
    normalizePhone, phoneHash: (d) => OTP.phoneHash(d), cartFpFromBody: G.cartFpFromBody };   // the handler's guest intake deps (index.js:1506)
  let armed = { ...NO_FLAGS }; let gate = null; let loseNext = false; let parked = null; const inflight = [];
  // ── the fence MIRROR (fence.js @ ef889136) ──
  const fenceKey = (orderId, owner) => createHash('sha256').update(`${orderId}\n${owner}`).digest('hex');
  const ownerOf = ({ uid = null, phoneHash = null } = {}) => SUB.subjectKey({ uid, phoneHash });
  const writeFence = async (orderId, owner) => { if (typeof owner !== 'string' || !owner) throw new Error('writeFence: owner is required'); const at = clock.t;
    await db.ref(`sdk_fence/${fenceKey(orderId, owner)}`).transaction((cur) => (cur == null ? { order_id: orderId, owner, at } : undefined)); };
  const isFenced = async (orderId, owner) => (typeof owner === 'string' && owner ? (await db.ref(`sdk_fence/${fenceKey(orderId, owner)}`).once('value')).val() != null : false);
  async function guestOwnerForAbsent(ticket, orderId) {
    if (typeof ticket !== 'string' || !ticket) return null;
    const rec = (await db.ref(`checkout_tickets/${G.ticketKey(ticket)}`).once('value')).val();
    if (!rec || !Number.isFinite(rec.exp) || !(clock.t < rec.exp) || rec.order_id !== orderId || typeof rec.phone_hash !== 'string' || !rec.phone_hash) return null;
    return ownerOf({ phoneHash: rec.phone_hash });
  }
  // switch-endpoint.js @ 10db81aa (cancelSdkPendingCore, the fence + its r1 P1 fix), line for line: absent ≡ foreign ⇒ the fence for (id, the
  // caller) FIRST, THEN the re-read by that VERIFIED owner key — never a re-authorization (a token / ticket expiring between the reads must
  // not turn a late create into a safe answer); owned ⇒ the owned path; else NO_SDK_ORDER; a failed write / read ⇒ 503, never safe
  const ownedByKey = (order, owner) => {
    if (!order || typeof owner !== 'string') return false;
    if (owner.startsWith('u_')) return order.customer_uid === owner.slice(2);
    if (owner.startsWith('p_')) return !order.customer_uid && !!order.guest_verified && order.guest_verified.phone_hash === owner.slice(2);
    return false;
  };
  const FENCE_UNAVAILABLE = Object.freeze({ status: 503, body: Object.freeze({ error: 'unavailable', retryable: true }) });
  async function cancelMirror(headers, body) {
    const orderId = body && body.order_id;
    if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) return { status: 400, body: { error: 'bad_request' } };
    const creds = { authorization: headers.authorization, ticket: headers['x-sherpa-order-ticket'] };
    let uid = null;
    let auth = await authorizeExistingOrder({ ...deps, verifyIdToken: async (t) => { const d = await deps.verifyIdToken(t); uid = d && typeof d.uid === 'string' ? d.uid : null; return d; } }, creds, orderId);
    if (!auth.ok) {
      const owner = auth.status === 404 ? ownerOf({ uid })
        : auth.error === 'guest_auth_required' && (await C.readOrder(db, orderId)) == null ? await guestOwnerForAbsent(creds.ticket, orderId) : null;
      if (!owner) return auth.status === 404 ? { status: 200, body: { ...NO_SDK_ORDER } } : { status: auth.status, body: { error: auth.error } };
      try { await writeFence(orderId, owner); } catch (_) { return { status: FENCE_UNAVAILABLE.status, body: { ...FENCE_UNAVAILABLE.body } }; }
      let again;
      try { again = await C.readOrder(db, orderId); } catch (_) { return { status: FENCE_UNAVAILABLE.status, body: { ...FENCE_UNAVAILABLE.body } }; }
      if (!ownedByKey(again, owner)) return { status: 200, body: { ...NO_SDK_ORDER } };
      auth = { ok: true };
    }
    let order = await C.readOrder(db, orderId);
    if (!F.isSdkOrder(order)) return { status: 200, body: { ...NO_SDK_ORDER } };
    if (order.payment_placed && !order.payment_cancel) return { status: 409, body: { error: 'already_placed' } };
    if (!order.payment_cancel) {
      const r = await C.cancelSdkOrder(deps, { orderId, kind: 'cancel', pendingOnly: true });
      order = await C.readOrder(db, orderId);
      if (!order.payment_cancel) return order.payment_placed ? { status: 409, body: { error: 'already_placed' } } : { status: 409, body: { error: r.reason || 'not_cancellable' } };
    } else {
      await C.cancelSdkOrder(deps, { orderId, kind: order.payment_cancel.kind });
    }
    const safe = C.safeToSwitch(await C.readRecord(db, orderId), order);
    if (safe) {
      const subject = SUB.subjectKey({ uid: order.customer_uid, phoneHash: order.guest_verified && order.guest_verified.phone_hash });
      if (subject) await SUB.releaseSubject(deps, subject, orderId);
    }
    return { status: 200, body: { cancelled: true, safe_to_switch: safe } };
  }
  const hdrs = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v]));

  async function placeSdkOrder(req) {
    const flags = armed; armed = { ...NO_FLAGS };
    const myGate = gate; gate = null;
    const body = JSON.parse(JSON.stringify(req.body || {}));
    const r = { headers: hdrs(req.headers), body };
    const a = await INTAKE.authorize(r, deps);                                                       // B1
    if (a.refuse) return a.refuse;
    const uid = a.kind === 'member' ? a.uid : null;
    // a guest's identity is the ticket's (index.js cappGuest.guest: phone + phone_hash) — finish's guestPhoneHash, the order's guest_verified
    const tk = a.kind === 'guest' ? (await db.ref(`checkout_tickets/${G.ticketKey(body.checkout_ticket)}`).once('value')).val() : null;
    const guest = tk ? { phone: tk.phone, phone_hash: tk.phone_hash } : null;
    const rp = await INTAKE.replay(deps, { orderId: body.order_id, attemptId: body.attempt_id, uid, guestPhoneHash: guest ? guest.phone_hash : null });   // B2: a KNOWN attempt
    if (rp) return rp;
    const ad = await INTAKE.admit(deps, { restaurantId: body.restaurant_id, scheduledFor: body.scheduled_for == null ? null : body.scheduled_for });
    if (ad) return ad;
    if (myGate && myGate.at === 'intake') { myGate.mark(); await myGate.wait; }   // pauseIntake(): parked BEFORE finish — the order still absent
    const fenceOwner = ownerOf({ uid, phoneHash: guest ? guest.phone_hash : null });
    if (await isFenced(body.order_id, fenceOwner)) return refusalAnswer({ outcome: 'closed', reason: 'fenced' }, body.order_id, flags);   // MIRROR finish.js: before the first write
    const total = body.expected_net_cents;
    const pendingOrderRecord = { order_id: body.order_id, restaurant_id: body.restaurant_id, status: 'pending_payment', payment_status: 'pending', payment_method: 'online',
      order_type: body.order_type, customer_name: body.customer_name, customer_phone: body.customer_phone, items_text: body.items_text, total: total / 100, total_cents: total,
      created_at: clock.t, ...(uid ? { customer_uid: uid } : {}), ...(guest ? { guest_verified: guest } : {}), ...(TIP.ofBody(body) > 0 ? { tip_cents: TIP.ofBody(body) } : {}) };
    const fin = await finishSdk(deps, {                                                                // B4
      orderId: body.order_id, kind: uid ? 'member' : 'guest', uid, guestPhoneHash: guest ? guest.phone_hash : null, attemptId: body.attempt_id, card: body.card,
      replacesOrderId: body.replaces_order_id == null ? null : body.replaces_order_id, pendingOrderRecord,
      fingerprint: orderFingerprint(body.order_id, total, body.items_text, TIP.extraOf(body)), tipCents: TIP.ofBody(body), nowTs: clock.t, flags,
      runGate: async () => {
        if (await isFenced(body.order_id, fenceOwner)) {   // MIRROR finish.js: right after the create-once order, before the claim: cancelled, then closed
          await C.cancelSdkOrder(deps, { orderId: body.order_id, kind: 'cancel', pendingOnly: true });
          return { refuse: refusalAnswer({ outcome: 'closed', reason: 'fenced' }, body.order_id, flags) };
        }
        if (myGate && myGate.at !== 'intake') { myGate.mark(); await myGate.wait; }
        return { refuse: null, provenance: null };
      },
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
      else if (url.startsWith(E.cancelSdkPending)) res = json(await cancelMirror(hdrs(headers), body || {}));
      else if (url.startsWith(E.sdkPayStatus)) { const q = u.searchParams.get('restaurant_id'); res = { status: 200, json: await sdkPayStatusCore(db, q === null ? undefined : q) }; }
      if (res) return { status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => res.json };
      return other(url, init);
    };
  }
  return {
    db, psp, deps, fetchFor, fenceKey, ownerOf,
    // a guest's checkout ticket, as verifyCheckoutCode stores it (checkout-guest-lib ticketRecord), bound to orderId and the body's cart
    issueTicket: async ({ phone, orderId, body }) => {
      const t = G.newTicketId();
      const rec = G.ticketRecord({ phone, phoneHash: OTP.phoneHash(normalizePhone(phone)), rid: body.restaurant_id, cartFp: await G.cartFpFromBody(body), orderId, now: clock.t });
      await db.ref(`checkout_tickets/${G.ticketKey(t)}`).set(rec);
      return t;
    },
    authorizations: () => psp.callCount('authorize'),
    arm: (f) => { armed = { ...NO_FLAGS, ...f }; },
    pauseGate: (at = 'gate') => { let release, mark; const wait = new Promise((r) => { release = r; }); parked = new Promise((r) => { mark = r; }); gate = { wait, mark, at }; return () => release(); },
    loseNext: () => { loseNext = true; },
    settled: () => Promise.allSettled(inflight),
  };
}
