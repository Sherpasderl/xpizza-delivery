'use strict';

// Pure decision core for the P3 status-sync trigger (mirrorStatusToHistory). UPDATE-ONLY-IF-EXISTS
// (codex R1 HIGH-1): mirror an order's status into its history entry ONLY when the customer is
// attributed AND the entry ALREADY exists (written by createOrder at intake / materialize at confirm).
// It NEVER creates an entry — so a pending_payment / unpaid checkout (no entry yet) is never indexed
// into history, and a guest order (no customer_uid) is a no-op. The trigger writes a DIFFERENT subtree
// (user_orders) than it listens on (orders/*/status) → no feedback loop; and is fail-open (a mirror
// failure never affects the order-status write).
function decideStatusMirror(orderId, customer_uid, entryExists, status) {
  if (!orderId || !customer_uid || !entryExists) return null;   // guest OR no history entry → never create
  if (status == null || status === '') return null;
  return { path: `user_orders/${customer_uid}/${orderId}/status`, value: status };
}

module.exports = { decideStatusMirror };
