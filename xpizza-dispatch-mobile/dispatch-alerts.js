// xpizza-dispatch/dispatch-alerts.js
/**
 * Pure alert registry for the Torre de Control (dispatch Phase 1).
 * Classifies a raw dispatcher alert into a category/severity/icon for the
 * exceptions-first queue. Unknown / no-type / factura_* alerts fall into a
 * generic bucket so NOTHING is ever dropped (visibility guarantee).
 * No DOM, no globals — Node-testable.
 */
const SEV_ORDER = { red: 0, amber: 1, neutral: 2 };

const REGISTRY = {
  driver_freshness_stale:          { category: 'driver-dark', severity: 'red',     iconId: 'i-signaloff' },
  no_drivers_available:            { category: 'no-driver',   severity: 'red',     iconId: 'i-userx' },
  no_response_takeover:            { category: 'takeover',    severity: 'amber',   iconId: 'i-phoneoff' },
  assignment_strand:               { category: 'takeover',    severity: 'amber',   iconId: 'i-phoneoff' },
  payment_hosted_stale_no_callback:{ category: 'payment',     severity: 'amber',   iconId: 'i-card' },
  payment_reconcile_breaches:      { category: 'payment',     severity: 'neutral', iconId: 'i-card' },
  payment_aged_refund_pending:     { category: 'payment',     severity: 'neutral', iconId: 'i-card' },
  paid_superseded:                 { category: 'payment',     severity: 'red',     iconId: 'i-card' },   // PLAN-H0
  reversal_uncertain:              { category: 'payment',     severity: 'red',     iconId: 'i-card' },   // PLAN-H0
  driver_problem:                  { category: 'driver-problem', severity: 'amber', iconId: 'i-alert' },  // DRIVER F
};

// DRIVER F — «Problema con este pedido»: the driver app's six reasons (the APPROVED prototype copy, verbatim), keyed by the ids
// the server validates. The alert carries the id; the Torre shows the label. An id outside the six never renders raw.
const DRIVER_PROBLEM_REASON_LABELS = Object.freeze({
  waiting_restaurant:   'Estoy esperando en el restaurante',
  not_ready_incomplete: 'El pedido no está listo o está incompleto',
  customer_no_answer:   'El cliente no contesta',
  address_not_found:    'No encuentro la dirección',
  restaurant_closed:    'El local está cerrado',
  other:                'Otro',
});
export function driverProblemReasonLabel(reason) {
  return Object.prototype.hasOwnProperty.call(DRIVER_PROBLEM_REASON_LABELS, reason) ? DRIVER_PROBLEM_REASON_LABELS[reason] : DRIVER_PROBLEM_REASON_LABELS.other;
}

// DRIVER F — the title/detail for a driver_problem alert, ONE pure builder for BOTH Torres. Injection-based
// (no DOM, no firebase, no globals): `label(ordRef)` → the FULL, escaped «Pedido #N» order label (the caller
// owns the whole phrase, so mobile can make it the violet tap-cue while desktop renders it plain — both
// byte-identical), `resolveDriverName(alert)` → the raw driver name from the caller's own store, `escapeHtml`
// → the escaper. Desktop's alertContent and the mobile sheet both call this, so content lives in one place.
export function driverProblemContent(alert, { label, resolveDriverName, escapeHtml }) {
  const a = alert || {};
  const name = escapeHtml(resolveDriverName(a));
  const note = typeof a.note === 'string' && a.note ? ` — ${escapeHtml(a.note)}` : '';
  const ord = Number.isFinite(a.display_number) ? { order_id: a.order_id, display_number: a.display_number } : a.order_id;
  return {
    title: 'Problema con el pedido',
    detail: `${label(ord)} · ${escapeHtml(driverProblemReasonLabel(a.reason))} · ${name}${note}`,
  };
}

export function classifyAlert(alert) {
  const type = alert && typeof alert.type === 'string' ? alert.type : '';
  const hit = REGISTRY[type];
  if (hit) return { ...hit, order: SEV_ORDER[hit.severity], known: true };
  // fallback bucket — surfaced, never dropped
  const category = type.startsWith('factura') ? 'fiscal' : 'otros';
  return { category, severity: 'amber', order: SEV_ORDER.amber, iconId: 'i-alert', known: false };
}

// Operates on the keyed RTDB object; preserves each alert's id (needed for dismiss).
export function sortAlertEntries(alertsObj) {
  return Object.entries(alertsObj || {})
    .map(([id, alert], i) => {
      const c = classifyAlert(alert);
      return { id, alert, category: c.category, severity: c.severity, iconId: c.iconId, known: c.known, _o: c.order, _i: i };
    })
    .sort((x, y) => x._o - y._o || x._i - y._i)   // stable within severity
    .map(({ _o, _i, ...rest }) => rest);
}
