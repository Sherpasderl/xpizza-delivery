'use strict';
// RETIRED for offers v1 (owner 11-16, limits = A: no caps). NOTHING requires this file; it is kept as the v2 starting point (an optional
// weekly cap on the payout ledger — PLAN-5f-marketing-usage-r5/r6, after PLAN-sherpa-ledger). Its tests were removed with the wiring.
// PLAN-5f-marketing-price r0 step 2 (Q5 ruled: count at placement, release on cancel) — the offer USAGE the caps are enforced on.
//   marketing_usage/{offerId} = { redemptions, spend_cents, week: { key, redemptions, spend_cents }, orders, sales_cents, new_customers }
//   (3a's §2.2 shape; 3a only READS it). spend = the restaurant's cost (discount + waived envío); week = the HN Monday week (ledger-core
//   weekOf, the payout week); a `weekly` offer's caps apply to the current week's bucket, otherwise to the totals.
// Safety direction: a crash between two writes can only OVER-count (a cap is never over-run; the restaurant never funds beyond its cap):
//   · cash: holdCounters BEFORE the order write, the order then written with offer.usage 'held'; a failed write ⇒ unholdCounters;
//   · card: the pending order exists when the gate runs — holdForOrder counts, THEN flags the order (a lost race gives the count back);
//   · release: the order flag 'held' → 'released' FIRST (set-once), THEN the counters given back — so a release happens at most once.
// RTDB transactions: the SDK's first run may see a cold null — every callback here returns a value for null (committed only if the server
// is null too, else re-run on the real node); `undefined` aborts only for a real refusal. new_customers stays 0 (phase 2, Q5).
const { weekOf } = require('../driver-ledger/ledger-core');

const ref = (db, offerId) => db.ref(`marketing_usage/${offerId}`);
const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const costOf = (offer) => int(offer.discount_cents) + int(offer.waived_envio_cents);
function shape(cur) {
  const u = cur && typeof cur === 'object' ? cur : {};
  const w = u.week && typeof u.week === 'object' ? u.week : {};
  return { redemptions: int(u.redemptions), spend_cents: int(u.spend_cents), week: { key: typeof w.key === 'string' ? w.key : null, redemptions: int(w.redemptions), spend_cents: int(w.spend_cents) },
    orders: int(u.orders), sales_cents: int(u.sales_cents), new_customers: int(u.new_customers) };
}

// THE cap rule on a usage node as read: would one more use costing `cost` exceed a cap? (weekly caps read the current HN week's bucket;
// a past week's bucket is history.) capReached and headroomGone are this rule; the hold enforces the same rule inside its transaction.
function overCap(cur, caps, nowMs, cost) {
  const u = shape(cur); const key = weekOf(nowMs);
  const base = caps.weekly ? (u.week.key === key ? u.week : { redemptions: 0, spend_cents: 0 }) : u;
  return (caps.redemptions != null && base.redemptions + 1 > caps.redemptions) || (caps.spend_cents != null && base.spend_cents + cost > caps.spend_cents);
}
const capsOk = (caps) => !!caps && typeof caps === 'object' && typeof caps.weekly === 'boolean';

/* Would ONE more use of `offer` exceed a cap, given the usage node as read? The SAME rule the hold enforces (the hold stays the
   authority; this lets the quote and the placement skip a capped offer instead of answering offer_changed forever). */
function capReached(cur, offer, nowMs) {
  const caps = offer && offer.caps;
  if (!capsOk(caps)) return true;
  return overCap(cur, caps, nowMs, costOf(offer));
}

/* Is the offer's headroom GONE — redemptions ≥ cap or spend ≥ cap (weekly ⇒ this HN week)? i.e. capReached for a 1-centavo use: no
   use of any size fits. Pure (3a's offers memo drops exhausted offers from menu.offers with it; advisor 11-14). Malformed caps ⇒ gone. */
function headroomGone(usage, caps, nowMs) {
  if (!capsOk(caps)) return true;
  return overCap(usage, caps, nowMs, 1);
}

/* → { ok: true, week } | { ok: false, reason: 'cap' }. Never exceeds a cap: the check and the increment are one transaction. */
async function holdCounters(db, offer, { salesCents, nowMs = Date.now() }) {
  const caps = offer && offer.caps;
  if (!caps || typeof caps.weekly !== 'boolean') return { ok: false, reason: 'cap' };   // an offer without its caps is never counted blind
  const key = weekOf(nowMs); const cost = costOf(offer); const sales = int(salesCents);
  let refused = false;
  const r = await ref(db, offer.offer_id).transaction((cur) => {
    const u = shape(cur); refused = false;
    const wk = u.week.key === key ? u.week : { key, redemptions: 0, spend_cents: 0 };
    const base = caps.weekly ? wk : u;
    if ((caps.redemptions != null && base.redemptions + 1 > caps.redemptions) || (caps.spend_cents != null && base.spend_cents + cost > caps.spend_cents)) { refused = true; return undefined; }
    return { redemptions: u.redemptions + 1, spend_cents: u.spend_cents + cost, week: { key, redemptions: wk.redemptions + 1, spend_cents: wk.spend_cents + cost },
      orders: u.orders + 1, sales_cents: u.sales_cents + sales, new_customers: u.new_customers };
  });
  if (!r.committed || refused) return { ok: false, reason: 'cap' };
  return { ok: true, week: key };
}

/* Give a hold back (the cash write failed, a card race was lost, a cancel): the totals always, the week bucket only while it is still
   the hold's week (a past week's bucket is history; the current one is untouched). */
async function unholdCounters(db, offer, { salesCents, week }) {
  const cost = costOf(offer); const sales = int(salesCents);
  await ref(db, offer.offer_id).transaction((cur) => {
    if (cur == null) return null;
    const u = shape(cur);
    const wk = u.week.key === week ? { key: week, redemptions: Math.max(0, u.week.redemptions - 1), spend_cents: Math.max(0, u.week.spend_cents - cost) } : u.week;
    return { redemptions: Math.max(0, u.redemptions - 1), spend_cents: Math.max(0, u.spend_cents - cost), week: wk,
      orders: Math.max(0, u.orders - 1), sales_cents: Math.max(0, u.sales_cents - sales), new_customers: u.new_customers };
  });
}

/* The card path: the pending order (with its frozen offer) exists. Counted once per order: an order already 'held' answers ok (a retried
   gate); a 'released' order (cancelled) is never counted again ⇒ refused. → { ok } */
async function holdForOrder(db, orderId, offer, { salesCents, nowMs = Date.now() }) {
  const flagRef = db.ref(`orders/${orderId}/offer`);
  const cur = (await flagRef.once('value')).val();
  if (!cur || cur.offer_id !== offer.offer_id) return { ok: false };
  if (cur.usage === 'held') return { ok: true };
  if (cur.usage != null) return { ok: false };
  const h = await holdCounters(db, offer, { salesCents, nowMs });
  if (!h.ok) return { ok: false };
  let mine = false;
  const r = await flagRef.transaction((o) => {
    mine = false;
    if (o == null) return null;
    if (o.offer_id !== offer.offer_id || o.usage != null) return undefined;
    mine = true;
    return { ...o, usage: 'held', usage_week: h.week, usage_sales_cents: int(salesCents) };
  });
  if (!(r.committed && mine)) {
    await unholdCounters(db, offer, { salesCents, week: h.week });
    const after = (await flagRef.once('value')).val();
    return { ok: !!after && after.usage === 'held' };   // a concurrent retry flagged it first ⇒ counted once, by it
  }
  return { ok: true };
}

/* A cancel: 'held' → 'released' (set-once), then the counters given back. → true when THIS call released it. */
async function releaseForOrder(db, orderId) {
  const flagRef = db.ref(`orders/${orderId}/offer`);
  let held = null;
  const r = await flagRef.transaction((o) => {
    held = null;
    if (o == null) return null;
    if (o.usage !== 'held') return undefined;
    held = o;
    return { ...o, usage: 'released' };
  });
  if (!(r.committed && held)) return false;
  await unholdCounters(db, held, { salesCents: held.usage_sales_cents, week: held.usage_week });
  return true;
}

/* The card gate's tail (index.js runGate, before any money): an ACCEPTED gate with an offer holds the usage; a cap ⇒ 409 offer_changed,
   the reward hold released exactly as the gate's own refusals do. A refusal / no offer passes through untouched. */
async function afterGate({ db, orderId, offer, salesCents, nowMs = Date.now(), releaseHold }, gate) {
  if (!gate || gate.refuse || !offer) return gate;
  const h = await holdForOrder(db, orderId, offer, { salesCents, nowMs });
  if (h.ok) return gate;
  try { await releaseHold(); } catch (_) { /* the gate's own convention: best-effort */ }
  return { refuse: { status: 409, body: { error: 'offer_changed', order_id: orderId } }, provenance: null, result: gate.result };
}

module.exports = { holdCounters, unholdCounters, holdForOrder, releaseForOrder, afterGate, capReached, headroomGone };
