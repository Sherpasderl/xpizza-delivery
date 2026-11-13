'use strict';
// D4 §A2 B4 + §A4 (PLAN-sdk-d4-r11) — the SDK finish, called by the hosted card handler (chargeOnlineApp) in SDK mode exactly where hosted calls
// acquireHostedAttempt, with hosted's intake snapshot (the same captured flags, the same pending record, the same fingerprint).
// Hosted's order: refusal → create → gate; no reward hold exists for an SDK order (§A00), so nothing is reserved or released.
const crypto = require('crypto');
const HC = require('../../pixelpay-hosted-charge');
const { paymentBindingConflict, conflictOutcome } = require('../../catalog/canonical-binding');
const { tipBindingConflict } = require('../../tip');
const F = require('./flow');
const C = require('./coordinator');
const R = require('./record');
const SUB = require('./subject');
const CARDS = require('./cards');
const { REVISIT_MS } = require('./sweeper');
const { answerOrder } = require('./status-endpoint');
const { UNRESOLVED } = require('./replaces');
const SA = require('./stored-admission');
const FN = require('./fence');

const RP = require('./replaces');
const ownedBy = (c, o) => RP.ownedBy(c, o);
const resolvedOrder = RP.resolvedOrder;
// hosted acquisition's checks, on the order held under this id (null ⇒ reusable by THIS request)
function bindingRefusal(c, o) {
  if (!F.isSdkOrder(o)) return { outcome: 'conflict', reason: 'conflict' };          // a hosted / cash order under the id
  if (HC.guestForeign(o, c.pendingOrderRecord)) return { outcome: 'conflict', reason: 'guest_phone' };
  if (!ownedBy(c, o)) return { outcome: 'conflict', reason: 'conflict' };
  { const t = tipBindingConflict(o, c.tipCents); if (t) return conflictOutcome(t); }
  { const d = paymentBindingConflict(o, c.fingerprint, () => null, null); if (d) return conflictOutcome(d); }
  if (o.status !== 'pending_payment' || o.payment_placed || o.payment_cancel || ['confirmed', 'refunded', 'refund_pending'].includes(o.payment_status)) return { outcome: 'closed', reason: o.payment_status || o.status };
  return null;
}

async function finishSdk(deps, c) {
  // 1. the deferred refusals, over hosted's captured flags ⇒ hosted's answer for that outcome
  const fresh = HC.freshIssueRefusal(c.flags);
  if (fresh) return c.answerRefusal(fresh);
  // 2. BEFORE any write: the order this one replaces (A2), and the card (A3)
  { const rr = await RP.replacesRefusal(deps, { orderId: c.orderId, replacesOrderId: c.replacesOrderId, uid: c.uid, pendingOrderRecord: c.pendingOrderRecord }); if (rr) return rr; }
  // asm7 gate P1: an EXISTING order's stored delivery facts, by Envío's resume guard (c.deliveryResume), BEFORE enrol / claim / dispatch
  const seen = await SA.storedAdmission(deps.db, c.orderId, c.deliveryResume);
  if (seen.refusal) return seen.refusal;
  // THE FENCE (PLAN-sdk-fence-r1): a cancel of this caller's absent order fenced the id ⇒ refused closed, BEFORE finishSdk's first write
  const fenceOwner = FN.ownerOf({ uid: c.uid, phoneHash: c.guestPhoneHash });
  const FENCED = { outcome: 'closed', reason: 'fenced' };
  if (await FN.isFenced(deps.db, c.orderId, fenceOwner)) return c.answerRefusal(FENCED);
  let token; let card; let authenticationIdentifier = null;
  if (c.card.kind === 'saved') {
    const s = await CARDS.resolveSavedCard(deps, c.uid, c.card.card_id);
    if (!s) return { status: CARDS.SAVED_CARD_UNAVAILABLE.status, body: { ...CARDS.SAVED_CARD_UNAVAILABLE.body } };
    token = s.token; card = { display: s.display, save: false, card_ref: `saved:${s.card_id}` };
  } else {
    token = c.card.sdk_token; authenticationIdentifier = c.card.authentication_identifier;
    const save = c.kind === 'member' && c.card.save === true;
    card = { display: c.card.display, save, card_ref: 'new', ...(save ? { vault_gen: await CARDS.vaultGenOf(deps, c.uid, crypto.createHash('sha256').update(token).digest('hex')) } : {}) };
  }
  // 3. enrol-first (C4)  4. the create-once order  5. re-enrol immediately after the commit
  const enrol = () => deps.db.ref(`payment_sdk_due/${c.orderId}`).set(deps.clock() + REVISIT_MS);
  await enrol();
  let refusal = null; let reused = false;
  const tx = await deps.db.ref(`orders/${c.orderId}`).transaction((cur) => {
    refusal = null; reused = cur !== null;
    if (cur === null) return { ...c.pendingOrderRecord, payment_flow: F.SDK_FLOW, pay_deadline_at: c.nowTs + R.TTL_MS, payment_fingerprint: c.fingerprint };
    refusal = bindingRefusal(c, cur);
    return undefined;   // a reuse or a refusal writes nothing
  });
  const stored = tx.snapshot.val();
  const post = refusal || (stored ? bindingRefusal(c, stored) : { outcome: 'conflict', reason: 'conflict' });   // hosted's post-commit re-check
  if (post) return c.answerRefusal(post);
  // the fence AGAIN, after the create-once order and before the claim / any attempt (store-then-check: a cancel that missed this order
  // fenced it first ⇒ seen here) ⇒ this request's own pending order is cancelled (no money was asked) and refused closed
  if (await FN.isFenced(deps.db, c.orderId, fenceOwner)) {
    await C.cancelSdkOrder(deps, { orderId: c.orderId, kind: 'cancel', pendingOnly: true });
    return c.answerRefusal(FENCED);
  }
  // the race backstop: the txn REUSED an order the first read did not see (a concurrent same-owner create) ⇒ admitted here, still before
  // the claim and any dispatch (its only write so far is enrol's sweeper due entry)
  if (reused && seen.order == null) { const late = await SA.admitOrder(stored, c.orderId, c.deliveryResume); if (late) return late; }
  await enrol();
  // 6. the hosted gate, at the STORED total (no hold to release: §A00)
  const applied = await c.runGate(stored.total_cents);
  if (applied && applied.refuse) return { status: applied.refuse.status, body: applied.refuse.body };
  if (applied && applied.provenance) await deps.db.ref(`orders/${c.orderId}/quote`).set(applied.provenance).catch(() => {});
  // 7. the C6 subject: one unresolved SDK checkout per member / guest phone
  const subject = SUB.subjectKey({ uid: c.uid, phoneHash: c.guestPhoneHash });
  const claim = await SUB.claimSubject(deps, subject, c.orderId, (heldId) => resolvedOrder(deps, heldId));
  if (!claim.ok) {
    await C.cancelSdkOrder(deps, { orderId: c.orderId, kind: 'cancel', pendingOnly: true });   // THIS request's own pending order: no money was asked
    return { status: UNRESOLVED.status, body: { ...UNRESOLVED.body } };
  }
  // 8. the attempt, at the STORED total (row 20)  9. the §2.4 answer for THIS attempt
  await C.placeOriginal(deps, { orderId: c.orderId, attempt_id: c.attemptId, token, amount_cents: stored.total_cents, authentication_identifier: authenticationIdentifier, card });
  const order = await C.readOrder(deps.db, c.orderId);
  const answer = await answerOrder(deps, c.orderId, order, { attempt_id: c.attemptId });
  if (await resolvedOrder(deps, c.orderId)) await SUB.releaseSubject(deps, subject, c.orderId);
  return answer;
}
module.exports = { finishSdk };
