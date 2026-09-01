'use strict';

/**
 * Bound a best-effort side-effect promise so it can never hold (or fail) the caller.
 *
 * WHY: createOrder writes the order to the DB, THEN sends a best-effort "order received"
 * WhatsApp inline before returning the customer's 200. That send's fetch is unbounded
 * (node-fetch v2, no timeout) — when the WhatsApp gateway (UltraMsg) lags, the customer's
 * confirmation was held up to the 30s function timeout. This wrapper resolves as soon as the
 * send settles OR after `ms`, whichever comes first, so the response is bounded to `ms`.
 *
 * CONTRACT: RESOLVES either way, NEVER rejects. A notification failure must never throw into,
 * nor hang, an order that is already written. Past the deadline the send is fire-and-forget
 * (it may still land — a one-shot "received" is idempotent enough). The timer is always cleared.
 *
 * @param {Promise<any>} p   the best-effort side-effect (e.g. the WhatsApp notify block)
 * @param {number} ms        deadline in milliseconds
 * @returns {Promise<void>}  resolves on settle-or-deadline; never rejects
 */
function notifyWithinDeadline(p, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    const t = setTimeout(finish, ms);
    // Settle the wrapper when `p` resolves OR rejects — both map to finish() (never rethrow).
    // clearTimeout runs whichever path fires first (deadline already resolved → clear is a no-op).
    Promise.resolve(p).then(finish, finish).finally(() => clearTimeout(t));
  });
}

module.exports = { notifyWithinDeadline };
