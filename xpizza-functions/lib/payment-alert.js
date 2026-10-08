// PORTAL SPEED P1 (PLAN-portal-speed rev 3 §1) — paymentAlert, moved UNCHANGED from index.js so the full load and the
// isolated portal entrypoints share ONE function object. Sloppy mode on purpose (index.js's semantics).
const { ServerValue } = require('firebase-admin/database');

// Write a dispatcher alert (best-effort) for money-safety events that need a human.
async function paymentAlert(db, kind, detail) {
  console.warn(`paymentAlert[${kind}]`, JSON.stringify(detail));
  try {
    await db.ref('dispatcher_alerts').push({
      type: `payment_${kind}`,
      detail: detail || null,
      created_at: ServerValue.TIMESTAMP
    });
  } catch (e) {
    console.error('paymentAlert: failed to write alert', e.message);
  }
}

module.exports = { paymentAlert };
