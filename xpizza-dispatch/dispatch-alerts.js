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
};

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
