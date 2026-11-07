'use strict';
// BUILD-stacked-seq-server r5 T7 — the out-of-sequence detector. Delivery-time evidence ONLY: a missed alert is acceptable, a
// false one is not (advisor ruling). It acts on a DELIVERY task's completion write — the completion batch sets the task
// `completed` in the same write as orders/{oid}/status = delivered (driver-complete.js), so `after` IS the delivered member's
// copy at the delivered transition, and it survives the later task deletion.
//
// Flagged iff ALL hold (any read failure or missing evidence → no alert):
//   1. `after` is a VALID rank-2 copy (§1 provenance);  2. stacks/{id} is committed, ranks it 2, and names this driver;
//   3. this driver delivered it;  4. the rank-1 sibling's delivery task is still VALID for this stack and not done;
//   5. the sibling ORDER is non-terminal — read AFTER (4): cancel commits the order status before its task cleanup.
// Publication: the alert IS the record — ONE create-only dispatcher_alerts/oos_<stack_id>, read FIRST so a retry (or a
// duplicate event) exits with one read and never needs the sibling evidence again.
const { validCopy } = require('./validity');

const TERMINAL_ORDER = new Set(['delivered', 'completed', 'cancelled', 'refund_pending']);

const isDeliveryCompletion = (taskId, before, after) => typeof taskId === 'string' && taskId.endsWith('_delivery')
  && !!before && !!after && before.status !== 'completed' && after.status === 'completed';

async function detectOutOfSequence({ db, taskId, before, after }) {
  if (!isDeliveryCompletion(taskId, before, after)) return 'skip';   // no reads
  if (!validCopy(after) || after.stop_seq !== 2) return 'none';
  const stackId = after.stack_id; const oid = after.order_id; const uid = after.stack_uid;
  const alertRef = db.ref(`dispatcher_alerts/oos_${stackId}`);
  try {
    if ((await alertRef.once('value')).val() !== null) return 'exists';
    const rec = (await db.ref(`stacks/${stackId}`).once('value')).val();
    if (!rec || rec.state !== 'committed' || !rec.ranks || rec.ranks[oid] !== 2 || rec.driver_uid !== uid || !Array.isArray(rec.pair)) return 'none';
    const sib = rec.pair.find((o) => o !== oid && rec.ranks[o] === 1);
    if (!sib) return 'none';
    if ((await db.ref(`orders/${oid}/delivered_by_driver_uid`).once('value')).val() !== uid) return 'none';
    const st = (await db.ref(`tasks/${sib}_delivery`).once('value')).val();
    if (!validCopy(st) || st.stack_id !== stackId || st.stop_seq !== 1 || st.stack_uid !== uid || st.status === 'completed' || st.status === 'cancelled') return 'none';
    const sibStatus = (await db.ref(`orders/${sib}/status`).once('value')).val();
    if (typeof sibStatus !== 'string' || TERMINAL_ORDER.has(sibStatus)) return 'none';
    const alert = { type: 'out_of_sequence', order_id: oid, stack_id: stackId, driver_uid: uid, at: after.completed_at ?? null };
    const r = await alertRef.transaction((cur) => (cur === null ? alert : undefined));
    return r && r.committed ? 'alerted' : 'exists';
  } catch (e) {
    console.warn(`stackseq detector: no alert for ${oid} (${(e && e.message) || e})`);
    return 'none';
  }
}

module.exports = { detectOutOfSequence, isDeliveryCompletion };
