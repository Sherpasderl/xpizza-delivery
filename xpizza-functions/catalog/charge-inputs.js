'use strict';
// ---------------------------------------------------------------------------
// 1D add-product B (codex PB-1 r1 P1-3; advisor conditions 2026-10-10) — THE CHARGE-INPUT CANONICALIZER.
//
// ONE canonical form of EVERY client-supplied input that can affect what an order charges (its lines with every option /
// variant / instance structure as sent, the reward selection, restaurant, order id, fulfilment, schedule, location and
// address, payment method, the client total and items text, the fiscal fields). Its fingerprint is BOUND on a reward
// order at issuance (orders/{id}.charge_inputs_fp) and a later request may take the bound-reuse path (catalog/bound-
// reuse.js) only when its fingerprint is EQUAL — never a hand-picked subset.
//
// Every body field the order paths read is classified HERE, once: CHARGE_INPUT_FIELDS (in the fingerprint) or
// NON_CHARGE_FIELDS (with the reason it cannot change the charge). A request carrying a field in NEITHER list has no
// fingerprint (null) — the caller must fall through to the current path. The census test proves the lists cover every
// `body.X` the handlers read.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { canonicalJson } = require('./canonical-json');

const CHARGE_INPUT_FIELDS = Object.freeze([
  'order_id', 'restaurant_id', 'items', 'redeem', 'order_type', 'scheduled_for', 'pickup_time',
  'lat', 'lng', 'address_detected', 'address_details', 'payment_method', 'total', 'items_text',
  'razon_social', 'rtn_cliente',
]);
const NON_CHARGE_FIELDS = Object.freeze({
  customer_name: 'contact display only (and the PixelPay cardholder name padding); never priced',
  customer_phone: 'contact + rate-limit identity; never priced',
  customer_email: 'the PixelPay receipt address only; never priced',
  notes: 'kitchen notes; never priced',
  quote_token: 'verification evidence for the confirmed-net gate on a FRESH issuance; a reuse answers before that gate today',
  expected_net_cents: 'the client\'s view of the net, checked only by the confirmed-net gate on a FRESH issuance',
  cash_tendered: 'the cash path\'s change-to-bring; never priced, never read by the card path',
  free_order: 'the cash path\'s $0 routing claim; the server re-prices regardless and the card path refuses $0',
});
// Fields the order forms SEND that NO order path reads (the census proves it) — non-charge by construction.
const UNREAD_FORM_FIELDS = Object.freeze({
  maps_link: 'derived from lat/lng for staff display; never read', waze_link: 'derived from lat/lng for staff display; never read',
  payment_status: 'a client-side label; never read', timestamp: 'the client clock at build time; never read',
  redeem_total_cents: 'the client\'s display of the reward total; never read', redemption: 'the client\'s display copy of the reward; never read',
  scheduled: 'a client-side boolean (scheduled_for is the input); never read', total_cents: 'a client-side display total (total is the input); never read',
});

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// → the hex fingerprint, or null when the body is not an object or carries a field this module does not classify.
function chargeInputsFingerprint(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  for (const k of Object.keys(body)) if (!CHARGE_INPUT_FIELDS.includes(k) && !own(NON_CHARGE_FIELDS, k) && !own(UNREAD_FORM_FIELDS, k)) return null;
  const picked = {};
  for (const k of CHARGE_INPUT_FIELDS) if (own(body, k) && body[k] !== undefined) picked[k] = body[k];
  let text;
  try { text = canonicalJson(picked); } catch (_) { return null; }
  return crypto.createHash('sha256').update(text).digest('hex');
}

module.exports = { CHARGE_INPUT_FIELDS, NON_CHARGE_FIELDS, UNREAD_FORM_FIELDS, chargeInputsFingerprint };
