'use strict';
// ── PLAN-guest-checkout-server r4 (FINAL) §2 — S2: the capp-guest gate in createOrder + chargeOnlineOrder.
// Wire: CONTRACT-capp-guest-checkout-wire.md. The discriminator is the ONLY branch point: when it is false (every form request,
// every member, any absent / malformed / other deployment header) these functions return null with ZERO reads and ZERO writes,
// so the forms' traces and goldens are byte-identical.
//   createOrderRefusal(clientHdr, uid, body)   §2.3 INVARIANT — createOrder places NO capp-guest order: every capp guest is
//                                              refused here (pure, no I/O), before the existence read and every write
//   chargeGate({...})                          §2.2/§2.3 — body refusals, then the READ-ONLY ticket check, then the phone
//                                              binding against an EXISTING order → null | {refuse} | {guest:{phone, phone_hash}}
//   boundToGuest({...})                        §2.5 — the same binding right after the CAS, before any outcome answers
//   chargeUidOf(req, deps)                     Codex r1 P2-4 — the handler's identity rules, for the typed non-online refusal
//   grantFor({...})                            §2.5 — the phone-binding check against the STORED order, then the stateless grant
//                                              → {refuse} | {grant: {token, expires_at} | null}
// Refusals are ONE reason each (guest_ticket_invalid has no oracle: which check failed is never said).
const G = require('./checkout-guest-lib');

const TICKET_RE = /^ct_[0-9a-f]{32}$/;   // checkout-guest-lib newTicketId
const present = (v) => v !== undefined && v !== null && v !== '';

// §2.3: guests are card-online only and createOrder refuses `online` above the gate, so a capp guest can never place here.
// A request carrying a checkout ticket ⇒ guest_ticket_invalid (it can only be a misrouted guest checkout: no order data, no
// grant); otherwise cash / card_delivery ⇒ guest_cash_not_allowed (D4 CLOSED, owner 10-27: online only).
function createOrderRefusal(clientHdr, uid, raw) {
  if (!G.isCappGuest(clientHdr, uid)) return null;
  const body = raw && typeof raw === 'object' ? raw : {};   // named `body` so the charge-inputs census reads these fields
  return present(body.checkout_ticket) ? 'guest_ticket_invalid' : 'guest_cash_not_allowed';
}

// deps: db (RTDB), now (ms), rid (the resolved restaurant), orderId, OTP (otp-lib: phoneHash), normalizePhone (whatsapp.js)
async function chargeGate({ clientHdr, uid, body: raw, rid, orderId, db, now, OTP, normalizePhone }) {
  if (!G.isCappGuest(clientHdr, uid)) return null;                     // forms + members: nothing below runs
  const body = raw && typeof raw === 'object' ? raw : {};   // named `body` so the charge-inputs census reads these fields
  const why = G.guestBodyRefusal(body);                                      // payment → scheduling → email (pure)
  if (why) return { refuse: why };
  const bad = { refuse: 'guest_ticket_invalid' };
  if (typeof body.checkout_ticket !== 'string' || !TICKET_RE.test(body.checkout_ticket)) return bad;
  const digits = typeof body.customer_phone === 'string' ? normalizePhone(body.customer_phone) : null;
  const phoneHash = digits ? OTP.phoneHash(digits) : null;               // the OTP normalisation (never sanitizePhone)
  const cartFp = await G.cartFpFromBody(body);
  const rec = (await db.ref('checkout_tickets/' + G.ticketKey(body.checkout_ticket)).once('value')).val();
  if (!G.ticketValid(rec, { now, rid, orderId, cartFp, phoneHash })) return bad;   // read-only: a refusal consumes nothing
  // §2.5 phone binding, BEFORE anything can answer with this order: an order that already exists under this id must carry
  // THIS ticket's verified phone (another guest's order, or a form's, is never reused, rotated or echoed)
  const existing = (await db.ref('orders/' + orderId).once('value')).val();
  if (existing !== null && !(existing && existing.guest_verified && existing.guest_verified.phone_hash === rec.phone_hash)) return bad;
  return { guest: { phone: rec.phone, phone_hash: rec.phone_hash } };
}

// Right after the CAS (acquireHostedAttempt), BEFORE any outcome answers: an order that exists under this id must carry THIS
// request's verified phone (a concurrent loser that reached another guest's order is refused with no order data). No order
// (the CAS wrote nothing: unavailable item, …) ⇒ nothing to leak ⇒ the outcome answers as today.
async function boundToGuest({ db, orderId, guest }) {
  const o = (await db.ref('orders/' + orderId).once('value')).val();
  return o === null || !!(o && o.guest_verified && o.guest_verified.phone_hash === guest.phone_hash);
}

// After the CAS (acquireHostedAttempt) decided: the STORED order must carry THIS request's verified phone (a concurrent loser
// that reached another guest's order is refused with no order data). The grant is recomputed from the stored order, so a
// replay / reuse / concurrent success returns the SAME bytes. No secret, no created_at, or an expired grant ⇒ grant null (the
// app falls back to normal signup) — never a failed charge.
async function grantFor({ db, orderId, guest, secret, now }) {
  const o = (await db.ref('orders/' + orderId).once('value')).val();
  const gv = o && o.guest_verified;
  if (!gv || gv.phone_hash !== guest.phone_hash) return { refuse: 'guest_ticket_invalid' };
  if (!Number.isFinite(o.created_at)) return { grant: null };
  const payload = G.grantPayload(orderId, gv.phone_hash, o.created_at);
  if (!(now < payload.exp)) return { grant: null };
  let token;
  try { token = G.signGrant(payload, secret); } catch (_) { return { grant: null }; }   // fail-closed secret ⇒ no grant
  return { grant: { token, expires_at: payload.exp } };
}

// Codex r1 P2-4 / r2 P2: chargeOnlineOrder's identity, by its handler's rules — used ONLY to answer a capp guest's non-online body
// with its typed reason before the handler's generic online-only 400. → uid | null | undefined:
//   null       VERIFIED no identity: no token, a token that verifies but is not a customer, or attributionUid's answer after a
//              successful tombstone read (a real guest) — the caller answers guest_cash_not_allowed;
//   undefined  UNRESOLVED: the deadline passed, or ANY error (a token that fails to verify, a tombstone read error) — FAIL-CLOSED:
//              the caller takes the generic answer, byte-identical to today, never the guest path.
async function chargeUidOf(req, { getAuth, getDatabase, attributionUid, deadlineMs = 1500 }) {
  const idTok = req.get('x-firebase-id-token');
  if (!idTok) return null;
  try {
    return await Promise.race([
      (async () => {
        const dec = await getAuth().verifyIdToken(idTok);
        if (dec && dec.customer === true && dec.uid) {
          const tomb = await getDatabase().ref('deleted_uids/' + dec.uid).get();
          return attributionUid(dec, tomb.exists());
        }
        return null;
      })(),
      new Promise((resolve) => setTimeout(() => resolve(undefined), deadlineMs)),   // undecided — never "a guest"
    ]);
  } catch (_) { return undefined; }   // unresolved — never "a guest"
}

module.exports = { createOrderRefusal, chargeGate, boundToGuest, grantFor, chargeUidOf };
