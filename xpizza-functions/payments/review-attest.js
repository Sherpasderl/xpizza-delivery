'use strict';
// «Marcar como revisado» — owner 11-19, option B (D4c-grill/PLAN-5f-review-action-r1.md): a recorded HUMAN ATTESTATION ONLY.
// A person has handled a parked charge in PixelPay (refunded it, or confirmed the charge stands) and says so. ONE order CAS adds
// manual_review_closed { outcome, amount_cents, note, by, at, episode, audited }; payment_status STAYS manual_review, so nothing that reads
// it changes (the cancel gate and the resolver keep refusing the order). NO payment, attempt, reward or status change — the money and any
// reward fix stay with the person (PixelPay; the owner for rewards).
// Codex #217:
//   · P1 — a closure belongs to ONE manual_review EPISODE. The episode trigger (onPaymentStatus, deployed as
//     markReviewEpisodeOnPaymentStatus) stamps orders/{id}/manual_review_since whenever ANY writer moves an order INTO manual_review; the
//     closure records the stamp it closed (episode). alert-prune's reviewClosed() — the one predicate the daily rule, the prune and the
//     refusal below share — honours a closure only while the two still match, so a later re-entry re-opens the review.
//   · P2-1 — the rules pin every closure leaf + manual_review_since against client writes (server only).
//   · P2-2 — a HUMAN action: a dispatcher's identity is required; the service secret is refused.
//   · P2-3 — the payment_audit row has a DETERMINISTIC key and the closure carries audited:false until it is written; completeAudit (here
//     and in the daily reconcilePayments pass) finishes it idempotently.
//   · P3 — the raw note is validated before sanitizing; amount_cents is bounded by the order's charged total.
// Refuses (409): not manual_review / already closed in this episode / scheduled_blocked / an order claim / a reversal in flight on the
// active attempt (`reversing`, or `refund_pending` that the refund reconciler retries).
const { reviewClosed } = require('../alert-prune');

const OUTCOMES = new Set(['refunded_in_pixelpay', 'charge_stands']);
const REVERSAL_IN_FLIGHT = new Set(['reversing', 'refund_pending']);
const NOTE_MAX = 200;
const AMOUNT_MAX_CENTS = 10000000;   // L 100,000 — the documented ceiling when an order carries no integer total_cents
const RECORD_FIELDS = ['outcome', 'amount_cents', 'note', 'by', 'at', 'episode', 'audited'];   // pinned leaf by leaf in the rules
const auditKey = (orderId, at) => `review_${orderId}_${at}`;

// why the order cannot be closed now (null = it can) — checked on the read AND inside the CAS
function refusal(o) {
  if (o.payment_status !== 'manual_review') return 'not_in_review';
  if (reviewClosed(o)) return 'already_closed';
  if (o.scheduled_blocked) return 'scheduled_blocked';
  if (o.cancel_claim_id || o.resolving_action || o.resolving_claim_id || o.resolving_phase) return 'claim_in_flight';
  return null;
}

// P2-3: write the closure's deterministic audit row, then flip audited — only on the SAME closure (its `at`). Idempotent; a failure leaves
// audited:false for the next call (the daily reconcilePayments pass). Returns true when the closure is audited.
async function completeAudit(db, orderId) {
  const c = (await db.ref(`orders/${orderId}/manual_review_closed`).once('value')).val();
  if (!c || c.audited !== false) return !!c;
  await db.ref(`payment_audit/${auditKey(orderId, c.at)}`).set({ order_id: orderId, action: 'review_attest', actor: c.by, outcome: c.outcome, amount_cents: c.amount_cents, note: c.note || '', episode: c.episode == null ? null : c.episode, at: c.at });
  const tx = await db.ref(`orders/${orderId}/manual_review_closed`).transaction((cur) => {
    if (cur === null) return null;                                     // null-first-safe
    if (!cur || cur.at !== c.at || cur.audited !== false) return;     // another closure / already audited → leave it
    return { ...cur, audited: true };
  });
  const v = tx.snapshot.val();
  return !!v && v.audited === true;
}

async function attestManualReview(db, { orderId, outcome, amountCents, note, actor, now }) {
  if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) return { status: 400, body: { ok: false, error: 'order_id invalid' } };
  if (!OUTCOMES.has(outcome)) return { status: 400, body: { ok: false, error: 'outcome must be refunded_in_pixelpay|charge_stands' } };
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) return { status: 400, body: { ok: false, error: 'amount_cents must be a whole number of centavos' } };
  if (note != null && (typeof note !== 'string' || note.length > NOTE_MAX)) return { status: 400, body: { ok: false, error: `note: at most ${NOTE_MAX} characters` } };

  const orderRef = db.ref(`orders/${orderId}`);
  const order = (await orderRef.once('value')).val();
  if (!order) return { status: 404, body: { ok: false, error: 'Order not found' } };
  const cap = Number.isSafeInteger(order.total_cents) && order.total_cents >= 0 ? order.total_cents : AMOUNT_MAX_CENTS;
  if (amountCents > cap) return { status: 400, body: { ok: false, error: 'amount_cents exceeds the order total' } };
  const pre = refusal(order);
  if (pre) return { status: 409, body: { ok: false, outcome: pre, order_id: orderId } };
  const attempt = order.active_attempt_id ? (await db.ref(`payment_attempts/${order.active_attempt_id}`).once('value')).val() : null;
  if (attempt && REVERSAL_IN_FLIGHT.has(attempt.status)) return { status: 409, body: { ok: false, outcome: 'reversal_in_flight', order_id: orderId } };

  let why = null;
  const tx = await orderRef.transaction((cur) => {
    if (cur === null) return null;                                     // null-first-safe
    if (!cur) return;
    why = refusal(cur);
    if (why) return;                                                   // moved since the read → refuse with its reason
    return { ...cur, manual_review_closed: { outcome, amount_cents: amountCents, note: note || '', by: actor, at: now, episode: cur.manual_review_since == null ? null : cur.manual_review_since, audited: false } };
  });
  const v = tx.snapshot.val();
  const landed = tx.committed && !!v && !!v.manual_review_closed && v.manual_review_closed.by === actor && v.manual_review_closed.at === now;
  if (!landed) return { status: 409, body: { ok: false, outcome: why || 'not_in_review', order_id: orderId } };
  let audited = false;
  try { audited = await completeAudit(db, orderId); } catch (_) { audited = false; }
  // the decision is recorded either way; a pending audit is finished by the daily pass (never a lost or half-told outcome)
  return audited ? { status: 200, body: { ok: true, outcome: 'review_closed', order_id: orderId } }
    : { status: 202, body: { ok: true, outcome: 'review_closed', audit: 'pending', order_id: orderId } };
}

// P1: the episode trigger's body — an ENTRY into manual_review (from any other value, by any writer) stamps the episode. Only while the order
// is still in review; never moves a stamp backwards (a retried / late event is a no-op).
async function onPaymentStatus(db, { orderId, before, after, eventTime }) {
  if (after !== 'manual_review' || before === 'manual_review' || !Number.isSafeInteger(eventTime)) return { action: 'none' };
  await db.ref(`orders/${orderId}`).transaction((cur) => {
    if (cur === null) return null;                                     // null-first-safe
    if (!cur || cur.payment_status !== 'manual_review') return;       // already left review again → nothing to stamp
    if (Number.isSafeInteger(cur.manual_review_since) && cur.manual_review_since >= eventTime) return;   // same or newer episode
    return { ...cur, manual_review_since: eventTime };
  });
  return { action: 'stamped' };
}

// The HTTP endpoint, wired by index.js with its own onRequest + authorizeDispatcherActionWithUid. Authorizes FIRST and requires a
// DISPATCHER identity (P2-2: a human-only action, never the service secret); the actor is that verified identity.
function endpoint({ onRequest, authorize, getDatabase, sanitizeText }) {
  return onRequest({ region: 'us-central1', cors: true, timeoutSeconds: 60, memory: '256MiB', maxInstances: 5 }, async (req, res) => {
    if (req.method !== 'POST') { res.set('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.code).json({ error: 'Unauthorized', detail: auth.msg });
    if (auth.byKind !== 'dispatcher') return res.status(403).json({ error: 'Forbidden', detail: 'a dispatcher identity is required' });
    const body = req.body || {};
    if (body.note != null && (typeof body.note !== 'string' || body.note.length > NOTE_MAX)) return res.status(400).json({ ok: false, error: `note: at most ${NOTE_MAX} characters` });
    const r = await attestManualReview(getDatabase(), {
      orderId: String(body.order_id || ''), outcome: String(body.outcome || ''), amountCents: body.amount_cents,
      note: body.note == null ? '' : sanitizeText(body.note, NOTE_MAX), actor: auth.actor, now: Date.now(),
    });
    return res.status(r.status).json(r.body);
  });
}

module.exports = { attestManualReview, completeAudit, onPaymentStatus, endpoint, refusal, RECORD_FIELDS, auditKey };
