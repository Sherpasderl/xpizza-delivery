'use strict';
// S-F (PLAN §S-F; NOTE-S-F-support-tickets-build) — createSupportTicket: the customer's «Ayuda» ticket for an order it OWNS.
//   POST { order_id, reason: missing|wrong|late|other, text?, channel: inapp|whatsapp[, tracking_token] }
//   proof: member — header x-firebase-id-token → rate-order.customerUidOf (the ONE customer predicate: verified, not tombstoned, never
//          a handheld) ∧ orders/{id}.customer_uid === uid;  guest — body.tracking_token === orders/{id}.tracking_token (the guest-claim
//          capability, bound to exactly one order), compared in CONSTANT time. Any failure ⇒ ONE generic 403, nothing written.
//   → 200 { ok, status:'received' } | 400 bad_request | 403 not_allowed | 405 | 429 rate_limited
// support_tickets/{id} = { order_id, restaurant_id, reason, text|null, channel, created_at, status:'received', via } — NO identity (Central
// reaches the customer through the order). ≤ MAX_PER_ORDER tickets per order — a recoverable reservation (support_ticket_counts) committed
// atomically with the ticket; a per-caller rate limit (an explicit policy) runs BEFORE any ownership-dependent answer.
// Server-only (rules .read/.write false). Each ticket is raised at once as dispatcher_alerts/support_ticket_<id> = { type:
// 'support_ticket_received', order_id, reason, created_at } (ruling F3); its dedicated rendering + status write-back is X-1.
const crypto = require('crypto');

const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REASONS = new Set(['missing', 'wrong', 'late', 'other']);
const CHANNELS = new Set(['inapp', 'whatsapp']);
const TEXT_MAX = 500;
const MAX_PER_ORDER = 5;
const KEYS = new Set(['order_id', 'reason', 'text', 'channel', 'tracking_token']);
const GENERIC = { status: 403, body: { ok: false, error: 'not_allowed' } };
const reply = (status, body) => ({ status, body });
const BAD = reply(400, { ok: false, error: 'bad_request' });

function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y) && a.length === b.length;
}

function parse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !KEYS.has(k))) return null;
  const { order_id: orderId, reason, channel } = body;
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId) || !REASONS.has(reason) || !CHANNELS.has(channel)) return null;
  let text = null;
  if (body.text !== undefined) {
    if (typeof body.text !== 'string' || body.text.length > TEXT_MAX || /[<>\u0000-\u001f\u007f]/.test(body.text)) return null;
    text = body.text.trim() || null;
  }
  if (reason === 'other' && !text) return null;
  if (body.tracking_token !== undefined && (typeof body.tracking_token !== 'string' || body.tracking_token.length > 200)) return null;
  return { orderId, reason, channel, text, trackingToken: body.tracking_token };
}

// Codex S-F r1: an EXPLICIT limiter policy (checkRateLimit requires it — without one it throws inside its transaction and fails OPEN)
const RATE = Object.freeze({ windowMs: 60 * 60 * 1000, max: 10 });   // per caller: a member uid, or a guest's order
const HOLD_MS = 60 * 1000;                                            // a slot reservation is recoverable after this
// a constant-shape dummy so a guest probe on a MISSING order does the same comparison work as on a present one (Codex S-F r1 #2)
const DUMMY_TOKEN = crypto.createHash('sha256').update('support-ticket-dummy-token').digest('hex');

// the per-order cap, as a RECOVERABLE reservation (Codex S-F r1 #3): ONE transaction holds a slot when committed + live holds < MAX;
// the ticket, its alert, the committed mark and the hold's release then land in ONE atomic multi-path update. A failed write never
// burns capacity: its hold expires after HOLD_MS. The updater aborts (undefined) only when the cap is reached on the ACTUAL value.
function reserveUpdater(id, nowMs) {
  return (cur) => {
    const committed = cur && cur.committed && typeof cur.committed === 'object' ? cur.committed : {};
    const held = {};
    for (const [k, at] of Object.entries(cur && cur.held && typeof cur.held === 'object' ? cur.held : {})) if (Number.isFinite(at) && nowMs - at < HOLD_MS) held[k] = at;
    if (Object.keys(committed).length + Object.keys(held).length >= MAX_PER_ORDER) return undefined;
    return { committed, held: { ...held, [id]: nowMs } };
  };
}

async function createSupportTicketCore({ db, verifyIdToken, checkRateLimit, now, newId }, req) {
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'method_not_allowed' });
  const p = parse(req.body);
  if (!p) return BAD;
  // WHO is asking — decided before the order is read, so the throttle runs before anything ownership-dependent (Codex S-F r1 #2)
  const idToken = typeof req.get === 'function' ? req.get('x-firebase-id-token') : null;
  let uid = null;
  if (idToken) { uid = await require('../ratings/rate-order').customerUidOf(db, idToken, verifyIdToken); if (!uid) return GENERIC; }
  else if (p.trackingToken === undefined) return GENERIC;
  const rl = await checkRateLimit(db, 'support_ticket', uid ? `u:${uid}` : `g:${p.orderId}`, RATE);
  if (!rl || rl.allowed !== true) return reply(429, { ok: false, error: 'rate_limited', retry_after: (rl && rl.retryAfterSec) || 60 });
  const order = (await db.ref(`orders/${p.orderId}`).once('value')).val();
  let via = null;
  if (uid) { if (order && order.customer_uid === uid) via = 'member'; }
  else if (tokenEquals(p.trackingToken, order && typeof order.tracking_token === 'string' ? order.tracking_token : DUMMY_TOKEN) && order) via = 'guest';
  if (!via) return GENERIC;
  const id = newId(); const at = now();
  const hold = await db.ref(`support_ticket_counts/${p.orderId}`).transaction(reserveUpdater(id, at));
  if (!hold || !hold.committed) return reply(429, { ok: false, error: 'rate_limited', retry_after: 3600 });
  // ruling F3 + Codex r1 #3: the ticket, its Central alert (order_id + reason only), the committed mark and the hold's release — ONE
  // atomic multi-path update: never a ticket without its alert or its count, never a count without its ticket
  await db.ref().update({
    [`support_tickets/${id}`]: { order_id: p.orderId, restaurant_id: typeof order.restaurant_id === 'string' ? order.restaurant_id : null,
      reason: p.reason, text: p.text, channel: p.channel, created_at: at, status: 'received', via },
    [`dispatcher_alerts/support_ticket_${id}`]: { type: 'support_ticket_received', order_id: p.orderId, reason: p.reason, created_at: at },
    [`support_ticket_counts/${p.orderId}/committed/${id}`]: true,
    [`support_ticket_counts/${p.orderId}/held/${id}`]: null,
  });
  return reply(200, { ok: true, status: 'received' });
}

function makeSupportTickets({ getDatabase, getAuth, checkRateLimit, now = () => Date.now(), newId = () => `${Date.now().toString(36)}_${crypto.randomBytes(9).toString('base64url')}` }) {
  return {
    async createSupportTicket(req, res) {
      res.set('Cache-Control', 'no-store');
      let out;
      try { out = await createSupportTicketCore({ db: getDatabase(), verifyIdToken: (t) => getAuth().verifyIdToken(t), checkRateLimit, now, newId }, req); }
      catch (e) { console.error('createSupportTicket', e && e.message); out = reply(503, { ok: false, error: 'unavailable' }); }
      res.status(out.status).json(out.body);
    },
  };
}

module.exports = { makeSupportTickets, createSupportTicketCore, reserveUpdater, MAX_PER_ORDER, RATE, HOLD_MS, REASONS, CHANNELS };
