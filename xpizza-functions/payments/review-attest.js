'use strict';
// «Marcar como revisado» — owner 11-19, option B, rebuilt STRUCTURALLY (owner GO 11-19, D4c-grill/NOTE-5f-review-attest-structural.md, after
// Codex #219): a recorded HUMAN ATTESTATION ONLY — a person handled a parked charge in PixelPay and says so. NO payment, attempt, reward or
// order change, and NOTHING about the review lives on the order node (RTDB rules cascade: a dispatcher's order write could not be fenced off):
//   · manual_review_episodes/{orderId}            the CURRENT episode — the trigger stamps every ENTRY into manual_review (any writer); dispatchers
//                                                 may READ it (Central sends it back); no client writes it
//   · manual_review_closures/{orderId}/{episode}  ONE create-if-absent, append-only record { outcome, amount_cents, note, by, at } — the audit
//                                                 itself (no separate row, no pending state, no backstop); no client reads or writes it
// The request carries the episode the person read: not current ⇒ 409 stale, also when it moves WHILE the request is in flight. «Closed» =
// the CURRENT episode has a closure (isClosed — it ONLY skips reconcilePayments' daily reminder; it never touches an alert). Refuses (409): not manual_review /
// scheduled_blocked (its own follow-up) / an order claim / a reversal in flight on the active attempt / already closed / stale.

const OUTCOMES = new Set(['refunded_in_pixelpay', 'charge_stands']);
const REVERSAL_IN_FLIGHT = new Set(['reversing', 'refund_pending']);
const NOTE_MAX = 200;
const AMOUNT_MAX_CENTS = 10000000;   // L 100,000 — the documented ceiling when an order carries no integer total_cents
const episodeOf = async (db, orderId) => { const v = (await db.ref(`manual_review_episodes/${orderId}`).once('value')).val(); return Number.isSafeInteger(v) ? v : 0; };   // 0 = in review since before the trigger

function refusal(o) {
  if (o.payment_status !== 'manual_review') return 'not_in_review';
  if (o.scheduled_blocked) return 'scheduled_blocked';
  if (o.cancel_claim_id || o.resolving_action || o.resolving_claim_id || o.resolving_phase) return 'claim_in_flight';
  return null;
}

async function attestManualReview(db, { orderId, episode, outcome, amountCents, note, actor, now }) {
  if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) return { status: 400, body: { ok: false, error: 'order_id invalid' } };
  if (!Number.isSafeInteger(episode) || episode < 0) return { status: 400, body: { ok: false, error: 'episode: the review episode this decision is about' } };
  if (!OUTCOMES.has(outcome)) return { status: 400, body: { ok: false, error: 'outcome must be refunded_in_pixelpay|charge_stands' } };
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) return { status: 400, body: { ok: false, error: 'amount_cents must be a whole number of centavos' } };
  if (note != null && (typeof note !== 'string' || note.length > NOTE_MAX)) return { status: 400, body: { ok: false, error: `note: at most ${NOTE_MAX} characters` } };

  const order = (await db.ref(`orders/${orderId}`).once('value')).val();
  if (!order) return { status: 404, body: { ok: false, error: 'Order not found' } };
  const cap = Number.isSafeInteger(order.total_cents) && order.total_cents >= 0 ? order.total_cents : AMOUNT_MAX_CENTS;
  if (amountCents > cap) return { status: 400, body: { ok: false, error: 'amount_cents exceeds the order total' } };
  const pre = refusal(order);
  if (pre) return { status: 409, body: { ok: false, outcome: pre, order_id: orderId } };
  const attempt = order.active_attempt_id ? (await db.ref(`payment_attempts/${order.active_attempt_id}`).once('value')).val() : null;
  if (attempt && REVERSAL_IN_FLIGHT.has(attempt.status)) return { status: 409, body: { ok: false, outcome: 'reversal_in_flight', order_id: orderId } };
  if (await episodeOf(db, orderId) !== episode) return { status: 409, body: { ok: false, outcome: 'stale', order_id: orderId } };

  // ONE create-if-absent transaction on the episode's own node: atomic, append-only, the audit itself
  const tx = await db.ref(`manual_review_closures/${orderId}/${episode}`).transaction((cur) => (cur === null
    ? { outcome, amount_cents: amountCents, note: note || '', by: actor, at: now } : undefined));
  const v = tx.snapshot.val();
  if (!tx.committed || !v || v.by !== actor || v.at !== now) return { status: 409, body: { ok: false, outcome: 'already_closed', order_id: orderId } };
  // the episode moved on while this request was in flight ⇒ the record stays with the episode the person reviewed, and the order is NOT closed
  if (await episodeOf(db, orderId) !== episode) return { status: 409, body: { ok: false, outcome: 'stale', order_id: orderId } };
  return { status: 200, body: { ok: true, outcome: 'review_closed', order_id: orderId, episode } };
}

// Is the order's review CLOSED in its CURRENT episode? Read at the moment of asking (reconcilePayments' daily reminder decides per order):
// the episode, then that episode's closure. Never an order-node field (a client could have written one). Owner GO 11-19 (after Codex
// #222): this ONLY skips the daily aged reminder — a closure is never an input to any alert's raising or pruning.
async function isClosed(db, orderId) {
  return (await db.ref(`manual_review_closures/${orderId}/${await episodeOf(db, orderId)}`).once('value')).exists();
}

// The episode trigger's body (markReviewEpisodeOnPaymentStatus): an ENTRY into manual_review (from any other value, by any writer) starts a
// new episode; the stamp only ever moves forward (a retried / late event is a no-op).
async function onPaymentStatus(db, { orderId, before, after, eventTime }) {
  if (after !== 'manual_review' || before === 'manual_review' || !Number.isSafeInteger(eventTime)) return { action: 'none' };
  await db.ref(`manual_review_episodes/${orderId}`).transaction((cur) => (Number.isSafeInteger(cur) && cur >= eventTime ? undefined : eventTime));
  return { action: 'stamped' };
}

// The HTTP endpoint, wired by index.js with onRequest + authorizeDispatcherActionWithUid. Authorizes FIRST and requires a DISPATCHER
// identity (a human action, never the service secret); the actor is that verified identity.
function endpoint({ onRequest, authorize, getDatabase, sanitizeText }) {
  return onRequest({ region: 'us-central1', cors: true, timeoutSeconds: 60, memory: '256MiB', maxInstances: 5 }, async (req, res) => {
    if (req.method !== 'POST') { res.set('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.code).json({ error: 'Unauthorized', detail: auth.msg });
    if (auth.byKind !== 'dispatcher') return res.status(403).json({ error: 'Forbidden', detail: 'a dispatcher identity is required' });
    const body = req.body || {};
    if (body.note != null && (typeof body.note !== 'string' || body.note.length > NOTE_MAX)) return res.status(400).json({ ok: false, error: `note: at most ${NOTE_MAX} characters` });
    const r = await attestManualReview(getDatabase(), {
      orderId: String(body.order_id || ''), episode: body.episode, outcome: String(body.outcome || ''), amountCents: body.amount_cents,
      note: body.note == null ? '' : sanitizeText(body.note, NOTE_MAX), actor: auth.actor, now: Date.now(),
    });
    return res.status(r.status).json(r.body);
  });
}

module.exports = { attestManualReview, isClosed, onPaymentStatus, endpoint, refusal };
