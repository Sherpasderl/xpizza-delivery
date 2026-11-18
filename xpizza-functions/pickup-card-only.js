'use strict';
// OWNER 2026-11-16 (DECISIONS «Q3», «already decided»): an APP pickup is CARD ONLY — the customer pays online, never cash (or a
// terminal) at the counter, so no app order leaves money in the restaurant's hands. An app-priced request (entry_mode:'app', the
// one app marker the order paths price on — delivery/delivery-wire.js isApp) for a PICKUP that is not paid online ⇒ 400
// pickup_card_only. Called from the order handlers' early seam (tip.js orderRefusal, run first by both order handlers — cash and the online charge), so it runs
// before any read, reserve or write. A FORM pickup (no app marker) keeps cash at the counter: that is the restaurant's own flow.
// The quote endpoints are not gated: a quote body carries no payment method (customer-app/capp-checkout.js quoteBody).
function pickupCardOnlyRefusal(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.order_type !== 'pickup' || !require('./delivery/delivery-wire').isApp(body)) return null;
  return body.payment_method === 'online' ? null : { status: 400, error: 'pickup_card_only' };
}

module.exports = { pickupCardOnlyRefusal };
