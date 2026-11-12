'use strict';
// C6 / W2 (PLAN-sdk-d4-r5): ONE unresolved SDK checkout per member / guest phone. sdk_checkout_subject/{subject} = { order_id, at }
// (server-only). Claimed AFTER the pending order exists and is enrolled (W2), right before the attempt claim. Another held order
// is replaced only when the caller's isResolved(heldOrderId) says placed / safe_to_switch — by a CAS on the EXACT inspected claim,
// so a claim written meanwhile is never deleted. Elapsed time never releases a claim.
const subjectKey = ({ uid, phoneHash }) => (typeof uid === 'string' && uid ? `u_${uid}` : typeof phoneHash === 'string' && phoneHash ? `p_${phoneHash}` : null);
async function claimSubject(deps, subject, orderId, isResolved) {
  const ref = deps.db.ref(`sdk_checkout_subject/${subject}`);
  let held = null;
  const t = await ref.transaction((cur) => {
    held = null;
    if (cur == null) return { order_id: orderId, at: deps.clock() };
    if (cur.order_id === orderId) return undefined;
    held = cur;
    return undefined;
  });
  if (!held) { const v = t && t.snapshot ? t.snapshot.val() : null; return v && v.order_id === orderId ? { ok: true } : { ok: false, held: v ? v.order_id : null }; }
  if (!(await isResolved(held.order_id))) return { ok: false, held: held.order_id };
  let swapped = false;
  await ref.transaction((cur) => {
    swapped = false;
    if (cur == null) return null;   // the speculative first pass (Admin): null stays null — never an abort on null
    if (cur.order_id !== held.order_id || cur.at !== held.at) return undefined;
    swapped = true;
    return { order_id: orderId, at: deps.clock() };
  });
  if (swapped) return { ok: true };
  const now = (await ref.once('value')).val();
  return now && now.order_id === orderId ? { ok: true } : { ok: false, held: now ? now.order_id : null };
}
async function releaseSubject(deps, subject, orderId) {
  let released = false;
  await deps.db.ref(`sdk_checkout_subject/${subject}`).transaction((cur) => { released = false; if (cur == null) return null; if (cur.order_id !== orderId) return undefined; released = true; return null; });
  return released;
}
module.exports = { subjectKey, claimSubject, releaseSubject };
