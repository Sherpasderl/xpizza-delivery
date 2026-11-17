'use strict';
// LEDGER S3 (PLAN-5f-ledger-shadow-s1-r3 §4) — the PURE per-order projector of the nightly rebuild. projectOrder(sources, { rateBp }) ⇒
//   { status: 'final' | 'open' | 'quarantined' | 'unresolved', reasons: [...], journals: { [id]: { id, family, date, lines } } }
// Sources (all read by S5; this module does no I/O): orders/{id} (status + the AUTHORITATIVE created_at — every journal is dated by it,
// never by the snapshot's informational created_at: Codex #110 r2), the S1 snapshot (the ONLY trusted money source — never orders/{id}
// money fields), every payment_attempts/{aid} of the order, and payment_sdk/{id}.
// Money comes from the snapshot + PROVIDER-reported amounts only. Every journal balances (zero-sum, refused otherwise); ids are
// deterministic (idOf(family, source key)); the same sources give byte-identical output, so a re-run REPLACES an order's projection.
// Policy (owner, pinned): commission = 1,000 bp (the rate is the caller's, by effective_from at orders.created_at) of the food the
// customer PAID incl. ISV (total − net envío − tip, every restaurant alike — never subtotal_cents), round half up; ISV 15 % on the
// commission, round half up; a full reversal reverses the commission + its ISV. Rewards are restaurant-funded (food is already net).
// NOT posted (r3 §4): cash / card_delivery collection, handoff or retained-cash settlement — non-card orders get the commission accrual
// only, with reason cash_not_evidenced; driver earnings (S8 stays the driver ledger).
const crypto = require('crypto');
const { isFinanciallyClosed, pendingProjection } = require('../payments/sdk/record');

const ISV_BP = 1500;
const TERMINAL = new Set(['delivered', 'completed', 'cancelled']);
const FULFILLED = new Set(['delivered', 'completed']);
const UNRESOLVED = new Set(['capture_unproven', 'manual_unverified', 'manual_review', 'manual_reconciliation', 'attempt_state_unknown', 'reversal_unproven', 'reversal_pending', 'amount_mismatch', 'rate_missing', 'components_invalid', 'no_order_date']);
// every state the writers give an attempt (Codex #114 #1): anything else is unresolved, never silently final
const ATTEMPT_STATUS = new Set([undefined, null, 'active', 'captured', 'capturing', 'capture_unverified', 'declined', 'voided_inactive', 'manual_review', 'manual_reconciliation', 'reversing', 'refund_pending', 'refunded', 'voided']);
const HOSTED_STATE = new Set([undefined, null, 'creating', 'created', 'failed_create', 'paid', 'voided', 'refund_pending', 'manual_reconciliation', 'abandoned']);
const int = (x) => Number.isSafeInteger(x);
const pos = (x) => (int(x) && x > 0 ? x : 0);

const idOf = (family, key) => crypto.createHash('sha256').update(`${family}\u0000${key}`).digest('hex').slice(0, 32);
const halfUp = (num, den) => Math.floor((2 * num + den) / (2 * den));   // non-negative integers
function commissionOf(base, rateBp) {
  const commission = halfUp(base * rateBp, 10000);
  return { commission, isv: halfUp(commission * ISV_BP, 10000) };
}

function journal(family, key, date, lines, idFamily = family) {   // idFamily: the canonical-id family when it differs from the journal's
  const ls = lines.filter((l) => (l.dr || l.cr) > 0);
  const dr = ls.reduce((s, l) => s + (l.dr || 0), 0); const cr = ls.reduce((s, l) => s + (l.cr || 0), 0);
  if (dr !== cr || !ls.length) throw new Error(`ledger projector: ${family} does not balance (${dr} / ${cr})`);
  return { id: idOf(idFamily, key), family, date, lines: ls };
}
const mirror = (family, key, date, j) => journal(family, key, date, j.lines.map((l) => (l.dr ? { account: l.account, cr: l.dr } : { account: l.account, dr: l.cr })));

function quarantineOf(alloc, sdk, order) {
  if (!alloc || typeof alloc !== 'object') return 'no_snapshot';
  if (alloc.v !== 1 || !['sdk', 'app', 'direct'].includes(alloc.mode)) return 'snapshot_unparsed';
  if (alloc.mismatch === true) return 'mode_mismatch';
  if ((alloc.mode === 'app' || alloc.mode === 'sdk') && alloc.order_type === 'pickup' && alloc.payment_method !== 'online') return 'app_pickup_cash';
  // an ADJUSTED SDK order (r3 #2): a committed revision, or one committed on the order and not yet projected. Every refund obligation is
  // opened only by a decrease / rule-4 path that commits a revision first (coordinator.js:101 / :549), so it is covered by these two.
  if (sdk && ((sdk.committed_revision || 0) > 0 || pendingProjection(sdk, order))) return 'sdk_adjusted';
  return null;
}

// the hosted / legacy attempt ⇒ { kind: 'sale' | 'mismatch', amount, reversed, pending } | { unresolved } | null (no money), from the
// PROVIDER-reported capture facts READ INDEPENDENTLY of the reversal state (Codex #114 #2), and the reversal proven by the attempt's own
// terminal state OR by its bound immutable refund evidence (refund_attempts, voided, written by voidOrRefund — Codex #114 #1). A
// surviving hosted `paid` never implies closure: reversing / refund_pending without proof ⇒ pending (unresolved).
function attemptFacts(aid, a, refunds) {
  if (!a || typeof a !== 'object') return null;
  if (!ATTEMPT_STATUS.has(a.status) || !HOSTED_STATE.has(a.hosted_state)) return { unresolved: 'attempt_state_unknown' };
  if (a.status === 'capturing' || a.status === 'capture_unverified') return { unresolved: 'capture_unproven' };
  if (a.manual_verified) return { unresolved: 'manual_unverified' };
  if (a.status === 'manual_review' || a.no_uuid_paid_callback) return { unresolved: 'manual_review' };
  if (a.status === 'manual_reconciliation' || a.hosted_state === 'manual_reconciliation') return { unresolved: 'manual_reconciliation' };
  const boundVoid = Object.values(refunds || {}).some((r) => r && r.attempt_id === aid && r.voided === true && r.code !== 'no_payment_to_void');
  const reversed = a.status === 'refunded' || a.status === 'voided' || a.hosted_state === 'voided' || boundVoid;
  const pending = !reversed && (a.status === 'refund_pending' || a.status === 'reversing' || a.hosted_state === 'refund_pending');
  if (a.mismatch_reason) {   // a mismatched capture (S2 evidence): its PROVIDER amount, whatever became of the void
    const ev = a.capture_evidence && a.capture_evidence.confirm;
    return ev && pos(ev.amount_cents) ? { kind: 'mismatch', amount: ev.amount_cents, reversed, pending } : { unresolved: 'capture_unproven' };
  }
  const hosted = ['paid', 'voided', 'refund_pending'].includes(a.hosted_state) && pos(a.paid_amount_cents);
  const legacy = a.capture_verified === true && pos(a.amount_cents);
  const amount = hosted ? a.paid_amount_cents : legacy ? a.amount_cents : null;
  if (amount === null) return pending ? { unresolved: 'reversal_unproven' } : null;   // a reversal of nothing proven captured
  return { kind: 'sale', amount, reversed, pending };
}

function projectOrder(src, { rateBp } = {}) {
  const { orderId, order, alloc, attempts, sdk, refunds, rewardState } = src || {};
  const reasons = new Set(); const out = [];
  const q = quarantineOf(alloc, sdk, order);
  if (q) return { status: 'quarantined', reasons: [q], journals: {} };
  const date = order && int(order.created_at) ? order.created_at : null;
  if (date === null) reasons.add('no_order_date');
  const rateOk = int(rateBp) && rateBp >= 0 && rateBp <= 10000;
  if (!rateOk) reasons.add('rate_missing');

  const total = pos(alloc.total_cents); const tip = pos(alloc.tip_cents); const env = alloc.envio || {};
  const gross = pos(env.delivery_cents); const promo = Math.min(pos(env.promo_discount_cents), gross); const netEnv = gross - promo;
  const food = total - netEnv - tip;
  if (food < 0) reasons.add('components_invalid');
  const saleLines = () => [{ account: 'processor_receivable', dr: total }, { account: 'restaurant_payable', cr: food }, { account: 'delivery_revenue', cr: netEnv }, { account: 'tip_liability', cr: tip }];
  const k = rateOk && food >= 0 ? commissionOf(food, rateBp) : null;
  const kPositive = !!k && k.commission + k.isv > 0;   // Codex #114 #5: a fully discounted food price has no commission journal
  const commission = () => journal('commission', orderId, date, [{ account: 'restaurant_payable', dr: k.commission + k.isv }, { account: 'commission_revenue', cr: k.commission }, { account: 'isv_payable', cr: k.isv }]);
  const promoJ = () => (env.delivery_discount_funder === 'sherpa' && promo > 0 ? journal('envio_promo', orderId, date, [{ account: 'delivery_promo_expense', dr: promo }, { account: 'delivery_revenue', cr: promo }]) : null);

  let open = !order || !TERMINAL.has(order.status);
  if (alloc.payment_method === 'online') {
    // collections: hosted / legacy attempts (provider facts) and SDK legs; the order's active attempt is the PRIMARY (the sale)
    const cols = [];
    // Codex #114 #4: a manual offline fulfilment (resolve-manual close_fulfilled) is the planned manual hold — never posted as a sale
    if (order && (order.resolution === 'offline_fulfilled' || order.fulfilled_offline_at)) reasons.add('manual_unverified');
    for (const aid of Object.keys(attempts || {}).sort()) {
      const a = attempts[aid]; const f = attemptFacts(aid, a, refunds);
      for (const xk of Object.keys((a && a.extra_payments) || {}).sort()) {   // Codex #108 r2 #4: an extra receipt → suspense, no commission
        const x = a.extra_payments[xk];
        if (pos(x && x.amount_cents)) out.push(journal('extra_receipt', `${aid}+${xk}`, date, [{ account: 'processor_receivable', dr: x.amount_cents }, { account: 'customer_refund_suspense', cr: x.amount_cents }], 'extra'));   // r1 §3: hash(extra, attempt + extra key)
      }
      if (!f) continue;
      if (f.unresolved) { reasons.add(f.unresolved); continue; }
      if (f.kind === 'mismatch') {   // captured the wrong amount / binding: in to suspense; out again once the void is PROVEN
        const j = journal('mismatch_capture', aid, date, [{ account: 'processor_receivable', dr: f.amount }, { account: 'customer_refund_suspense', cr: f.amount }]);
        out.push(j);
        if (f.reversed) out.push(mirror('reversal', j.id, date, j)); else reasons.add(f.pending ? 'reversal_pending' : 'reversal_unproven');
        continue;
      }
      cols.push({ key: aid, idFamily: 'collection', primary: order && order.active_attempt_id === aid, ...f });
    }
    if (sdk && sdk.legs) {
      for (const lid of Object.keys(sdk.legs).sort()) {
        const l = sdk.legs[lid];
        const captured = l && int(l.amount_cents) && (l.state === 'captured' || (l.state === 'voided' && int(l.captured_at)));
        if (captured) cols.push({ key: `${orderId}+${lid}`, idFamily: 'sdk_collection', primary: true, amount: l.amount_cents, reversed: l.state === 'voided', pending: false });
      }
      if (!isFinanciallyClosed(sdk, order, { rewardState })) open = true;   // Codex #114 #3: the reward reservation state is an input
    }
    if (reasons.has('manual_unverified')) cols.length = 0;
    let sold = false;
    for (const c of cols) {
      if (!c.primary || sold) {   // a second paid attempt on one order: the extra receipt is the customer's, held in suspense
        const j = journal('superseded_receipt', c.key, date, [{ account: 'processor_receivable', dr: c.amount }, { account: 'customer_refund_suspense', cr: c.amount }]);
        out.push(j); if (c.reversed) out.push(mirror('reversal', j.id, date, j)); if (c.pending) reasons.add('reversal_pending');
        continue;
      }
      if (c.amount !== total) { reasons.add('amount_mismatch'); continue; }
      if (food < 0) continue;
      sold = true;
      if (total === 0) continue;   // nothing was charged
      const col = journal('collection', c.key, date, saleLines(), c.idFamily); out.push(col);
      const p = promoJ(); if (p) out.push(p);
      const kj = kPositive ? commission() : null; if (kj) out.push(kj);
      if (c.reversed) {   // Codex #108 r2 #3: ONE economic reversal per collection, whichever observer proved it
        out.push(mirror('reversal', col.id, date, col));
        if (p) out.push(mirror('envio_promo_reversal', orderId, date, p));
        if (kj) out.push(mirror('commission_reversal', orderId, date, kj));
      }
      if (c.pending) reasons.add('reversal_pending');
    }
  } else if (order && FULFILLED.has(order.status) && food >= 0) {
    reasons.add('cash_not_evidenced');
    if (kPositive) out.push(commission());
  }
  const journals = {};
  for (const j of out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) journals[j.id] = j;
  const rs = [...reasons].sort();
  const status = rs.some((r) => UNRESOLVED.has(r)) ? 'unresolved' : open ? 'open' : 'final';
  return { status, reasons: rs, journals };
}

module.exports = { projectOrder, commissionOf, idOf, ISV_BP };
