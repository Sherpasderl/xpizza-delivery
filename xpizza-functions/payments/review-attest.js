'use strict';
// «Marcar como revisado» — owner 11-19, option B (D4c-grill/PLAN-5f-review-action-r1.md): a recorded HUMAN ATTESTATION ONLY.
// A person has handled a parked charge in PixelPay (refunded it, or confirmed the charge stands) and says so. ONE order CAS adds
// manual_review_closed { outcome, amount_cents, note, by, at }; payment_status STAYS manual_review, so nothing that reads it changes
// (the cancel gate and the resolver keep refusing the order). NO payment, attempt, reward or status change — the money and any reward
// fix stay with the person (PixelPay; the owner for rewards). The daily aged_manual_review rule and alert-prune's unresolvedMoney skip
// a closed review. The closed record is itself the durable audit (who / when / what / note); the payment_audit row follows it.
// Refuses (409): not manual_review / already closed / scheduled_blocked (its own follow-up) / an order claim (cancel or resolver) /
// a reversal in flight on the active attempt (`reversing`, or `refund_pending` that the refund reconciler retries).

const OUTCOMES = new Set(['refunded_in_pixelpay', 'charge_stands']);
const REVERSAL_IN_FLIGHT = new Set(['reversing', 'refund_pending']);
const NOTE_MAX = 200;

// why the order cannot be closed now (null = it can) — checked on the read AND inside the CAS
function refusal(o) {
  if (o.payment_status !== 'manual_review') return 'not_in_review';
  if (o.manual_review_closed) return 'already_closed';
  if (o.scheduled_blocked) return 'scheduled_blocked';
  if (o.cancel_claim_id || o.resolving_action || o.resolving_claim_id || o.resolving_phase) return 'claim_in_flight';
  return null;
}

async function attestManualReview(db, { orderId, outcome, amountCents, note, actor, now, serverTimestamp }) {
  if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) return { status: 400, body: { ok: false, error: 'order_id invalid' } };
  if (!OUTCOMES.has(outcome)) return { status: 400, body: { ok: false, error: 'outcome must be refunded_in_pixelpay|charge_stands' } };
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) return { status: 400, body: { ok: false, error: 'amount_cents must be a whole number of centavos' } };
  if (note != null && (typeof note !== 'string' || note.length > NOTE_MAX)) return { status: 400, body: { ok: false, error: `note: at most ${NOTE_MAX} characters` } };

  const orderRef = db.ref(`orders/${orderId}`);
  const order = (await orderRef.once('value')).val();
  if (!order) return { status: 404, body: { ok: false, error: 'Order not found' } };
  const pre = refusal(order);
  if (pre) return { status: 409, body: { ok: false, outcome: pre, order_id: orderId } };
  const attempt = order.active_attempt_id ? (await db.ref(`payment_attempts/${order.active_attempt_id}`).once('value')).val() : null;
  if (attempt && REVERSAL_IN_FLIGHT.has(attempt.status)) return { status: 409, body: { ok: false, outcome: 'reversal_in_flight', order_id: orderId } };

  const record = { outcome, amount_cents: amountCents, note: note || '', by: actor, at: now };
  let why = null;
  const tx = await orderRef.transaction((cur) => {
    if (cur === null) return null;                                     // null-first-safe
    if (!cur) return;
    why = refusal(cur);
    if (why) return;                                                   // moved since the read → refuse with its reason
    return { ...cur, manual_review_closed: record };
  });
  const v = tx.snapshot.val();
  const landed = tx.committed && !!v && !!v.manual_review_closed && v.manual_review_closed.by === actor && v.manual_review_closed.at === now;
  if (!landed) return { status: 409, body: { ok: false, outcome: why || 'not_in_review', order_id: orderId } };
  await db.ref('payment_audit').push({ order_id: orderId, action: 'review_attest', actor, outcome, amount_cents: amountCents, note: note || '', at: serverTimestamp });
  return { status: 200, body: { ok: true, outcome: 'review_closed', order_id: orderId } };
}

// The HTTP endpoint, wired by index.js with its own onRequest + authorizeDispatcherAction (the reconciliation resolver's gate: a
// dispatcher's ID token or RECON_SECRET, never MAKE_SECRET). Authorizes FIRST; a dispatcher's actor is its verified identity.
function endpoint({ onRequest, authorize, getDatabase, sanitizeText }) {
  return onRequest({ region: 'us-central1', cors: true, timeoutSeconds: 60, memory: '256MiB', maxInstances: 5 }, async (req, res) => {
    if (req.method !== 'POST') { res.set('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.code).json({ error: 'Unauthorized', detail: auth.msg });
    const body = req.body || {};
    const actor = auth.actor === 'recon_secret' ? sanitizeText(body.actor || 'server', 80) : auth.actor;
    const r = await attestManualReview(getDatabase(), {
      orderId: String(body.order_id || ''), outcome: String(body.outcome || ''), amountCents: body.amount_cents,
      note: body.note == null ? '' : sanitizeText(body.note, NOTE_MAX), actor, now: Date.now(), serverTimestamp: { '.sv': 'timestamp' },
    });
    return res.status(r.status).json(r.body);
  });
}

module.exports = { attestManualReview, endpoint, refusal };
