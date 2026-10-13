'use strict';
/* R3 P1 §4a — THE ORACLE and its TYPED comparators (PLAN-R3-P1 rev 4).
 * The oracle derives expectations ONLY from what the writer was asked for and produced: the fixture intent, the writer's
 * acknowledged response, and the persisted evidence (PLAN §1 / §1a). It never reads a reader's output and imports no reader
 * helper. Each fact records its AUTHORITATIVE EVIDENCE beside its comparator.
 *
 *  · MONEY is { centavos: integer, currency: 'HNL' }. null / missing / 0 are distinct: `money(null)` is "no amount", which
 *    never equals L0.00.
 *  · A surface declares a PRECISION ('cents' | 'lempiras') and its text is parsed by a STRICT grammar. Text that does not
 *    parse is a FAILURE, never 0. A 'lempiras' surface is compared at whole-lempira precision ONLY where §1 permits it; a
 *    surface that rounds away centavos the contract requires is a DIVERGENCE (pinned), never normalized here.
 */

const CURRENCY = 'HNL';
const money = (centavos, currency = CURRENCY) => {
  if (centavos === null || centavos === undefined) return null;
  if (!Number.isInteger(centavos)) throw new TypeError(`oracle: money must be integer centavos (got ${centavos})`);
  return Object.freeze({ centavos, currency });
};
const fmt = (m) => (m ? `${m.currency} ${(m.centavos / 100).toFixed(2)}` : 'no amount');

// strict surface grammars: the Honduran lempira as the pages print it ('L 223.00', 'L223', 'L 1,234.50')
const GRAMMAR = {
  cents: /^L\s?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/,
  lempiras: /^L\s?(\d{1,3}(?:,\d{3})*|\d+)$/,
};
function parseMoney(text, precision) {
  const t = String(text == null ? '' : text).replace(/ /g, ' ').trim();
  const g = GRAMMAR[precision];
  if (!g) throw new Error(`oracle: unknown precision ${precision}`);
  const m = g.exec(t);
  if (!m) return { ok: false, reason: `"${t}" does not parse as ${precision === 'cents' ? 'L N.NN' : 'L N'} (HNL)` };
  const whole = Number(m[1].replace(/,/g, ''));
  return { ok: true, money: money(precision === 'cents' ? whole * 100 + Number(m[2]) : whole * 100) };
}

/* compareMoney(expected, observedText, { precision, permitsLempiras }) — expected is typed money (or null = "no amount
 * shown"). A 'lempiras' surface may only be compared where `permitsLempiras` (the approved §1 rule for that surface) is true. */
function compareMoney(expected, observedText, { precision = 'cents', permitsLempiras = false } = {}) {
  if (expected === null) {
    const empty = observedText == null || String(observedText).trim() === '';
    return empty ? { ok: true } : { ok: false, reason: `expected no amount, observed "${observedText}"` };
  }
  if (precision === 'lempiras' && !permitsLempiras) return { ok: false, reason: 'whole-lempira precision is not permitted for this surface by §1 — a divergence, not a comparison' };
  const p = parseMoney(observedText, precision);
  if (!p.ok) return p;
  if (p.money.currency !== expected.currency) return { ok: false, reason: `currency ${p.money.currency} ≠ ${expected.currency}` };
  if (precision === 'lempiras') {
    if (expected.centavos % 100 !== 0) return { ok: false, reason: `expected ${fmt(expected)} has centavos; a whole-lempira surface cannot show it — divergence` };
    return p.money.centavos === expected.centavos ? { ok: true } : { ok: false, reason: `observed ${fmt(p.money)} ≠ expected ${fmt(expected)}` };
  }
  return p.money.centavos === expected.centavos ? { ok: true } : { ok: false, reason: `observed ${fmt(p.money)} ≠ expected ${fmt(expected)}` };
}

// §1 F-BREAKDOWN relationships (codex P1-a r1 P2: the ORDER footing and the FACTURA footing are separate rules)
// ORDER footing: subtotal_cents + tax_cents = total_cents, exact to the centavo. A discount never enters it
// (discount_cents = 0: add-free never discounts the charged total), and the factura rebaja is never subtracted from it.
function footing({ subtotal, tax = money(0), total }) {
  const need = subtotal.centavos + tax.centavos;
  return need === total.centavos ? { ok: true } : { ok: false, reason: `order footing: subtotal ${fmt(subtotal)} + tax ${fmt(tax)} = ${fmt(money(need))} ≠ total ${fmt(total)}` };
}
// FACTURA footing (redeemed x_pizza): full net = subtotal_cents + desc_rebaja_cents; Σ factura_items gross = total_cents +
// the comped gross. Checked on its own — never folded into the order footing.
function facturaFooting({ subtotal, rebaja, itemsGross, total, compedGross }) {
  const p = [];
  if (itemsGross.centavos !== total.centavos + compedGross.centavos) p.push(`Σ factura_items gross ${fmt(itemsGross)} ≠ total ${fmt(total)} + comped ${fmt(compedGross)}`);
  return p.length ? { ok: false, reason: `factura footing: ${p.join('; ')}`, fullNet: money(subtotal.centavos + rebaja.centavos) } : { ok: true, fullNet: money(subtotal.centavos + rebaja.centavos) };
}
const change = (tender, total) => (tender ? money(tender.centavos - total.centavos) : null);

/* §1 F-PAYLIFE — the state label per (status, payment_status). Written from the contract table, never from a reader. */
function payLife(o) {
  const ps = o.payment_status; const st = o.status;
  if (o.refunded_at || ps === 'refunded') return 'refunded';
  if (ps === 'refund_pending' || ps === 'refunding_paid_after_close') return 'refund_pending';
  if (ps === 'manual_reconciliation' || ps === 'manual_review') return 'manual_reconciliation';
  if (typeof ps === 'string' && ps.startsWith('resolving')) return 'resolving';
  if (st === 'cancelled') return ps === 'confirmed' ? 'cancelled' : 'cancelled-unpaid';
  if (ps === 'abandoned') return 'abandoned';
  if (ps === 'failed') return 'failed';
  if (ps === 'confirmed') return 'paid';
  if (o.free_order) return 'paid';   // nothing to collect: the order value is covered
  return 'pending';                  // cash / card on delivery / online not yet confirmed: not paid yet
}

/* the canonical facts of one persisted order, with their AUTHORITATIVE EVIDENCE (never a reader output):
 *   intent    — what the scenario ordered (items, qty, fulfil, tender, payment method)
 *   response  — the writer's acknowledged response (createOrder / charge)
 *   persisted — the order record the writer stored (orders/<id>), and the restaurant identity record */
function factsOf({ intent, response, persisted, restaurant }) {
  const lines = (persisted.summary_lines || []).map((l) => ({ name: l.name, qty: l.qty, cents: money(l.cents) }));
  const total = Number.isInteger(persisted.total_cents) ? money(persisted.total_cents) : null;
  const cash = persisted.payment_method === 'cash';
  const tender = Number.isInteger(persisted.cash_tendered_cents) && persisted.cash_tendered_cents > 0 ? money(persisted.cash_tendered_cents) : null;
  return {
    ITEMS: { value: lines, evidence: 'persisted summary_lines (name / qty / cents), bound to intent' },
    MONEY: { value: total, evidence: 'persisted total_cents = the acknowledged writer response' },
    NUM: { value: persisted.display_number, evidence: 'persisted display_number (the writer allocates it)' },
    STATUS: { value: persisted.status, evidence: 'persisted status at this LP' },
    FULFIL: { value: persisted.order_type, evidence: 'intent fulfilment = persisted order_type' },
    COLLECT: { value: cash ? { collect: total } : { collect: null }, evidence: 'payment method + payment status: cash → collect the total; paid online / free → collect nothing' },
    TENDER: { value: cash ? { tender, change: change(tender, total) } : null, evidence: 'intent tender; change = tender − total (§1)' },
    PLACE: { value: persisted.order_type === 'pickup' ? { pickupAt: restaurant && restaurant.display_name } : { address: persisted.address_detected || null }, evidence: persisted.order_type === 'pickup' ? 'restaurant IDENTITY (config display name) — never address_short' : 'intent address (persisted address_detected)' },
    BRAND: { value: restaurant && restaurant.display_name, evidence: 'restaurant identity record for persisted restaurant_id' },
    PAYLIFE: { value: payLife(persisted), evidence: '§1 F-PAYLIFE state label per (status, payment_status, payment_method)' },
    SCHED: { value: persisted.scheduled_for ? { asap: false, slot: persisted.scheduled_for } : { asap: true, slot: null }, evidence: 'persisted scheduled_for (absent = ASAP)' },
    REWARD: { value: { redemption: persisted.redemption || null, earn: persisted.earn_preview || null }, evidence: 'persisted redemption / earn_preview (as persisted, §1 F-REWARD)' },
    DRIVER: { value: persisted.status === 'delivered' ? { uid: persisted.delivered_by_uid || null, name: persisted.delivered_by_name || null } : null, evidence: '§1 F-DRIVER: applicable only to a delivery order that reached delivered' },
    CASH: { value: persisted.status === 'delivered' && cash ? { owed: total } : null, evidence: '§1 F-CASH: only a delivered cash order counts toward a driver\'s cash' },
    _meta: { orderId: response && response.order_id, intent, persisted },
  };
}

module.exports = { money, fmt, parseMoney, compareMoney, footing, facturaFooting, change, factsOf, payLife, CURRENCY, GRAMMAR };
