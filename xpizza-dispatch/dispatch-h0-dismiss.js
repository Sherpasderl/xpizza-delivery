// PLAN-H0 (ruling B) — dismissing a payment alert is DURABLE STATE on its evidence, not the alert's absence. One atomic
// multi-path update removes the alert AND records {dismissed_kind, dismissed_version} on
// orders/{order_id}/paid_evidence/{attempt_id}; the server never re-alerts that (kind, version) — a changed version
// re-alerts. Pure (no Firebase import) so the server tests apply the SAME update the × sends. → the update map, or null
// (not an H0 payment alert, or a record missing its ids/version → the caller removes the alert exactly as before).
const H0_ALERT_TYPES = new Set(['paid_superseded', 'reversal_uncertain']);
export function h0DismissUpdate(alertId, rec) {
  if (!rec || !H0_ALERT_TYPES.has(rec.type)) return null;
  if (typeof rec.order_id !== 'string' || !rec.order_id || typeof rec.attempt_id !== 'string' || !rec.attempt_id || typeof rec.version !== 'string' || !rec.version) return null;
  const ev = `orders/${rec.order_id}/paid_evidence/${rec.attempt_id}`;
  return { [`dispatcher_alerts/${alertId}`]: null, [`${ev}/dismissed_kind`]: rec.type, [`${ev}/dismissed_version`]: rec.version };
}
