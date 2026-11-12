'use strict';
// D4 §A2 B4 + §A4 (PLAN-sdk-d4-r11) — the SDK finish, called by chargeOnlineOrder's handler in SDK mode exactly where hosted calls
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
const UNRESOLVED = Object.freeze({ status: 409, body: Object.freeze({ error: 'previous_payment_unresolved' }) });

// an order of THIS caller: the verified member, or a guest whose verified phone is the order's (never a member's / claimed order)
const ownedBy = (c, o) => (c.uid ? o.customer_uid === c.uid
  : !o.customer_uid && !!(c.pendingOrderRecord && c.pendingOrderRecord.guest_verified) && !HC.guestForeign(o, c.pendingOrderRecord));
// placed, or safe_to_switch from durable state (§5)
async function resolvedOrder(deps, orderId, order) {
  const o = order || await C.readOrder(deps.db, orderId);
  if (!o) return true;
  if (o.payment_placed) return true;
  return C.safeToSwitch(await C.readRecord(deps.db, orderId), o);
}
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
  if (typeof c.replacesOrderId === 'string' && c.replacesOrderId !== c.orderId) {
    const prev = await C.readOrder(deps.db, c.replacesOrderId);
    if (F.isSdkOrder(prev) && ownedBy(c, prev) && !(await resolvedOrder(deps, c.replacesOrderId, prev))) return { status: UNRESOLVED.status, body: { ...UNRESOLVED.body } };
  }
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
  let refusal = null;
  const tx = await deps.db.ref(`orders/${c.orderId}`).transaction((cur) => {
    refusal = null;
    if (cur === null) return { ...c.pendingOrderRecord, payment_flow: F.SDK_FLOW, pay_deadline_at: c.nowTs + R.TTL_MS, payment_fingerprint: c.fingerprint };
    refusal = bindingRefusal(c, cur);
    return undefined;   // a reuse or a refusal writes nothing
  });
  const stored = tx.snapshot.val();
  const post = refusal || (stored ? bindingRefusal(c, stored) : { outcome: 'conflict', reason: 'conflict' });   // hosted's post-commit re-check
  if (post) return c.answerRefusal(post);
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
