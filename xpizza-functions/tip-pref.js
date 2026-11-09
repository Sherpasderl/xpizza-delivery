'use strict';
// PLAN-capp-tip-step r6 §1 — the member's LAST TIP: a UX hint (the tip step preselects it), never money.
//
// Written best-effort AFTER an order is accepted, at user_private/{uid}/last_tip = { cents, at } (owner-read, server-write
// only: database.rules.json user_private), and ONLY when:
//   · the caller passes the VERIFIED-TOKEN uid (intake's own customer_uid; a body uid is never consulted),
//   · the order is a delivery,
//   · the body carries the explicit marker tip_choice === true (the capp tip step; absent never means zero),
//   · the tip normalizes (tip.js normTip): absent / 0 ⇒ 0 («Sin propina»), 1..TIP_MAX ⇒ itself, anything else ⇒ none.
// `at` is the accepted order's RESOLVED numeric created_at (read back after commit — never the ServerValue placeholder), so
// a retry of an older order can never replace a newer choice (the transaction keeps the newer `at`).
// Non-fatal by contract: any failure is logged and swallowed; the order response never depends on it.
const { normTip } = require('./tip');

function prefOf({ uid, body, orderType }) {
  if (typeof uid !== 'string' || !uid) return null;
  if (orderType !== 'delivery') return null;
  if (!body || typeof body !== 'object' || body.tip_choice !== true) return null;
  const t = normTip(body.tip_cents);
  return Number.isNaN(t) ? null : { cents: t };
}

// the transaction updater: replace only when nothing valid is stored or the stored `at` is strictly older
function newer(cur, next) {
  const curAt = cur && typeof cur === 'object' && Number.isFinite(cur.at) ? cur.at : null;
  return curAt === null || next.at > curAt ? next : undefined;
}

async function recordLastTip(db, { uid, body, orderType, orderId, createdAtPath }) {
  const p = prefOf({ uid, body, orderType });
  if (!p) return { written: false, reason: 'not_eligible' };
  try {
    const snap = await db.ref(createdAtPath || `orders/${orderId}/created_at`).once('value');
    const at = snap.val();
    if (!Number.isFinite(at)) return { written: false, reason: 'no_created_at' };
    const next = { cents: p.cents, at };
    const tx = await db.ref(`user_private/${uid}/last_tip`).transaction((cur) => newer(cur, next));
    return { written: !!(tx && tx.committed) };
  } catch (e) {
    console.warn('tip-pref: last_tip not recorded (non-fatal)', e && e.message);
    return { written: false, reason: 'error' };
  }
}

module.exports = { prefOf, newer, recordLastTip };
