'use strict';
/* R3 P1-b — THE SCENARIO STATE VECTOR (DESIGN-R3-P1B.md; advisor GO 2026-10-13). For every (scenario, brand, LP) in P1 the
 * CONTRACT state of the order at that LP, derived — never hand-listed per cell — from:
 *   · contract/p1-scenario-paths.json (reviewed): each scenario's ordered path of contract EFFECTS, with its LPs marked on
 *     it, plus its constants (fulfilment, payment class, account, redemption, auto-assign, …);
 *   · EFFECTS below: what each step does to the vector.
 * The vector at an LP is the fold of the effects up to that LP. A region's appliesWhen (P1-b applicability) is a condition
 * over these fields; a derived exclusion applies only after the run ASSERTS the vector from evidence (CHECKS below —
 * persisted order, step log, routed calls, recorders), never from fixture intent alone (advisor condition).
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'p1-scenario-paths.json');

// the vector's fields and their domains (an appliesWhen may only use these)
const FIELDS = Object.freeze({
  phase: 'the LP name',
  brand: ['x_pizza', 'la_musa', 'r3_synth'],
  fulfil: ['delivery', 'pickup'],
  pay: ['cash', 'card_delivery', 'free', 'empty', 'online', 'mixed'],
  account: ['guest', 'signed_in'],
  redemption: [true, false],
  autoAssign: [true, false],
  scheduled: [true, false],
  cancelled: [true, false],
  inbound: [true, false],
  extras: [true, false],
  // the order STATUS the contract expects at this LP (codex P1-b mech r1 P1-3) — persisted status must agree
  status: ['new', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'completed', 'cancelled'],
  // the contract ACTION that produced this LP (advisor ruling: evidenced by the runner's executed action + the writer's ack)
  lpAction: ['create', 'kitchenStart', 'kitchenReady', 'assign', 'autoAssign', 'reassign', 'unassign', 'manualTakeover', 'pickupComplete', 'completeDelivery', 'completePickup', 'cuadre'],
  // a failed (then retried) write — false only on a COMPLETE ack log with no failure
  writeFailure: [true, false],
  kitchen: ['none', 'started', 'ready'],
  driver: ['none', 'assigned', 'reassigned', 'unassigned'],
  takeover: [true, false],
  outForDelivery: [true, false],
  terminal: ['none', 'delivered', 'completed'],
  cuadre: [true, false],
  // customer-side form actions (the scenario definition says none of these happen unless stated)
  reorder: [true, false],
  restore: [true, false],
  anotherOrder: [true, false],
  sheetEdit: [true, false],
  otp: [true, false],
  refund: [true, false],
});

// what each contract step does to the vector (reviewed)
// order assignment lives on the TASK (index.js: tasks 'assigned' / 'accepted'), so assign / reassign / unassign /
// takeover / cuadre leave the ORDER status unchanged
const EFFECTS = Object.freeze({
  create: (v) => ({ ...v, phase: 'new', status: 'new', kitchen: 'none', driver: 'none', takeover: false, outForDelivery: false, terminal: 'none', cuadre: false }),
  kitchenStart: (v) => ({ ...v, kitchen: 'started', status: 'preparing' }),
  kitchenReady: (v) => ({ ...v, kitchen: 'ready', status: 'ready' }),
  assign: (v) => ({ ...v, driver: 'assigned' }),
  autoAssign: (v) => ({ ...v, driver: 'assigned' }),
  reassign: (v) => ({ ...v, driver: 'reassigned' }),
  unassign: (v) => ({ ...v, driver: 'unassigned' }),
  manualTakeover: (v) => ({ ...v, driver: 'assigned', takeover: true }),
  pickupComplete: (v) => ({ ...v, outForDelivery: true, status: 'out_for_delivery' }),
  completeDelivery: (v) => ({ ...v, terminal: 'delivered', status: 'delivered' }),
  completePickup: (v) => ({ ...v, terminal: 'completed', status: 'completed' }),
  cuadre: (v) => ({ ...v, cuadre: true }),
  noop: (v) => v,
});

const load = (f = FILE) => JSON.parse(fs.readFileSync(f, 'utf8'));

/* the vectors of one scenario: { [lp]: vector } — every LP on its path, the fold of effects up to it */
function vectorsOf(S, brand, doc = load()) {
  const sc = doc.scenarios[S];
  if (!sc) throw new Error(`scenario-state: no path for ${S}`);
  if (!(sc.brands || doc.defaultBrands).includes(brand)) throw new Error(`scenario-state: ${S} does not run for ${brand}`);
  let v = { brand, ...doc.defaults, ...sc.constants };
  const out = {};
  for (const step of sc.path) {
    const [effect, lp] = Array.isArray(step) ? step : [step, null];
    if (!EFFECTS[effect]) throw new Error(`scenario-state: ${S}: unknown effect ${effect}`);
    v = effect === 'noop' ? v : { ...EFFECTS[effect](v), lpAction: effect };
    if (lp) { if (out[lp]) throw new Error(`scenario-state: ${S}: LP ${lp} marked twice`); out[lp] = Object.freeze({ ...v, phase: lp }); }
  }
  return out;
}
function vectorOf(S, brand, lp, doc = load()) {
  const all = vectorsOf(S, brand, doc);
  if (!all[lp]) throw new Error(`scenario-state: ${S}/${brand} has no LP ${lp}`);
  return all[lp];
}
// a vector is well-formed: exactly the declared fields, each in its domain
function vectorProblems(v) {
  const p = [];
  for (const k of Object.keys(FIELDS)) if (!(k in v)) p.push(`missing field ${k}`);
  for (const [k, val] of Object.entries(v)) {
    if (!(k in FIELDS)) { p.push(`unknown field ${k}`); continue; }
    if (Array.isArray(FIELDS[k]) && !FIELDS[k].includes(val)) p.push(`${k}=${JSON.stringify(val)} is outside its domain`);
  }
  return p;
}

/* CHECKS — each field ASSERTED from run evidence (never fixture intent alone; LP names are never evidence). Each entry
 * records its EVIDENCE SOURCE and comparison. evidence = { persisted, steps, routed, kdsActions, kdsEvents, kdsHttp, kdsTickets,
 * lpAction, ackLog, formEvents, formStorageAtBoot }.
 * Returns true (established), false (CONTRADICTED → RED) or { unknown: true } (this LP cannot establish it → an exclusion
 * depending on it never applies; the cell stays required). Missing evidence is never `false`. */
const unknown = { unknown: true };
const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
const PAY_PERSISTED = { cash: 'cash', card_delivery: 'card_delivery', empty: '', online: 'online' };
const CHECKS = Object.freeze({
  brand: { source: 'persisted order restaurant_id', check: (v, ev) => (ev.persisted ? ev.persisted.restaurant_id === v.brand : unknown) },
  fulfil: { source: 'persisted order order_type', check: (v, ev) => (ev.persisted && has(ev.persisted, 'order_type') ? ev.persisted.order_type === v.fulfil : unknown) },
  pay: { source: 'persisted order payment_method (free: persisted free_order)', check: (v, ev) => { if (!ev.persisted) return unknown; if (v.pay === 'free') return has(ev.persisted, 'free_order') ? ev.persisted.free_order === true : unknown; return has(PAY_PERSISTED, v.pay) && has(ev.persisted, 'payment_method') ? ev.persisted.payment_method === PAY_PERSISTED[v.pay] : unknown; } },
  redemption: { source: 'persisted order redemption', check: (v, ev) => (ev.persisted ? Boolean(ev.persisted.redemption) === v.redemption : unknown) },
  scheduled: { source: 'persisted order scheduled_for', check: (v, ev) => (ev.persisted ? Boolean(ev.persisted.scheduled_for) === v.scheduled : unknown) },
  cancelled: { source: 'persisted order status / cancelled_at', check: (v, ev) => (ev.persisted ? (ev.persisted.status === 'cancelled' || Boolean(ev.persisted.cancelled_at)) === v.cancelled : unknown) },
  refund: { source: 'persisted order refunded_at / payment_status', check: (v, ev) => (ev.persisted ? (Boolean(ev.persisted.refunded_at) || /refund/.test(String(ev.persisted.payment_status || ''))) === v.refund : unknown) },
  inbound: { source: 'routed calls (onIncomingWhatsApp)', check: (v, ev) => (Array.isArray(ev.routed) ? ev.routed.some((x) => x.fn === 'onIncomingWhatsApp') === v.inbound : unknown) },
  otp: { source: 'routed calls (requestOtp)', check: (v, ev) => (Array.isArray(ev.routed) ? ev.routed.some((x) => x.fn === 'requestOtp') === v.otp : unknown) },
  kitchen: { source: 'KDS event recorder (kitchen actions observed on tickets)', check: (v, ev) => (Array.isArray(ev.kdsActions) && v.kitchen === 'none' ? ev.kdsActions.length === 0 : unknown) },
  driver: { source: 'persisted order assignment fields', check: (v, ev) => (ev.persisted && v.driver === 'none' ? !ev.persisted.driver_id && !ev.persisted.assigned_driver && !ev.persisted.driver_uid : unknown) },
  outForDelivery: { source: 'persisted order status (out_for_delivery / delivered ⇒ picked up)', check: (v, ev) => (ev.persisted && has(ev.persisted, 'status') ? ['out_for_delivery', 'delivered'].includes(ev.persisted.status) === v.outForDelivery : unknown) },
  terminal: { source: 'persisted order status', check: (v, ev) => (ev.persisted && has(ev.persisted, 'status') ? (v.terminal === 'none' ? !['delivered', 'completed'].includes(ev.persisted.status) : ev.persisted.status === v.terminal) : unknown) },
  status: { source: 'persisted order status (must equal the contract status expected at this LP)', check: (v, ev) => (ev.persisted && has(ev.persisted, 'status') ? ev.persisted.status === v.status : unknown) },
  lpAction: { source: "the runner's RECORDED executed action for this LP + the writer's ack (never the LP name)", check: (v, ev) => (ev.lpAction && typeof ev.lpAction.action === 'string' ? (ev.lpAction.action === v.lpAction && ev.lpAction.ack === true) : unknown) },
  writeFailure: { source: 'the ack log of every write / call in the run (COMPLETE: every call answered)', check: (v, ev) => { const a = ev.ackLog; if (!a || a.complete !== true) return unknown; return (a.failures > 0) === v.writeFailure; } },
  // customer form actions — OBSERVED on the form page (a capture-phase event recorder: the element each event hit) or in
  // persisted / storage evidence; no recorder → unknown (codex P1-b mech r1 P1-2: never step labels)
  reorder: { source: 'form event recorder (no event on a reorder control: [data-ord] / reorder)', check: (v, ev) => (Array.isArray(ev.formEvents) ? ev.formEvents.some((e) => e.reorder) === v.reorder : unknown) },
  restore: { source: 'form event recorder (no restoreOrderForm control) + form storage at boot (no snapshot to restore)', check: (v, ev) => (Array.isArray(ev.formEvents) && Array.isArray(ev.formStorageAtBoot) ? (ev.formEvents.some((e) => e.restore) || ev.formStorageAtBoot.some((k) => /snapshot|pending_pay|self_update|selfupdate/i.test(k))) === v.restore : unknown) },
  anotherOrder: { source: 'form event recorder (no startAnotherOrder control)', check: (v, ev) => (Array.isArray(ev.formEvents) ? ev.formEvents.some((e) => e.anotherOrder) === v.anotherOrder : unknown) },
  sheetEdit: { source: 'form event recorder (no [data-act=review-inc|review-dec] in the cart sheet)', check: (v, ev) => (Array.isArray(ev.formEvents) ? ev.formEvents.some((e) => e.sheetEdit) === v.sheetEdit : unknown) },
  extras: { source: 'form event recorder (no [data-act=extra] toggle) + persisted items (no extras)', check: (v, ev) => (Array.isArray(ev.formEvents) && ev.persisted ? (ev.formEvents.some((e) => e.extras) || (ev.persisted.items || []).some((i) => i && (i.extras || i.options))) === v.extras : unknown) },
});
// context conditions (non-vector, asserted from run evidence) — e.g. P1-a's ticket count
const CONTEXT = Object.freeze({
  'single-live-order': { source: 'KDS board ticket count', check: (ev) => (typeof ev.kdsTickets === 'number' ? ev.kdsTickets === 1 : unknown) },
  'kds-no-log-tap': { source: 'KDS event recorder (no tap on a ticket log button .h-log)', check: (ev) => (Array.isArray(ev.kdsEvents) ? !ev.kdsEvents.some((e) => e.logTap) : unknown) },
  'kds-no-item-check': { source: 'KDS event recorder (no tap on a ticket item .card-item)', check: (ev) => (Array.isArray(ev.kdsEvents) ? !ev.kdsEvents.some((e) => e.itemCheck) : unknown) },
  'kds-no-http': { source: 'KDS page fetch recorder', check: (ev) => (Array.isArray(ev.kdsHttp) ? ev.kdsHttp.length === 0 : unknown) },
  'createorder-configured': { source: 'routed calls (createOrder answered 200)', check: (ev) => (Array.isArray(ev.routed) ? ev.routed.some((x) => x.fn === 'createOrder' && x.status === 200) : unknown) },
});
// assert a vector against evidence: { checked, unknown, failed } (field names)
function assertVector(v, ev) {
  const r = { checked: [], unknown: [], failed: [] };
  for (const [k, c] of Object.entries(CHECKS)) {
    let x; try { x = c.check(v, ev); } catch (_) { x = unknown; }
    if (x && typeof x === 'object' && x.unknown) r.unknown.push(k); else if (x === true) r.checked.push(k); else r.failed.push(k);
  }
  return r;
}
function checkContext(name, ev) { const c = CONTEXT[name]; if (!c) return false; let x; try { x = c.check(ev); } catch (_) { x = unknown; } return x; }

module.exports = { FILE, FIELDS, EFFECTS, CHECKS, CONTEXT, load, vectorsOf, vectorOf, vectorProblems, assertVector, checkContext };
