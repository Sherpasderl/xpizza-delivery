'use strict';
// STACKED-DELIVERY SEQUENCING (BUILD-stacked-seq-server r5 T9) — the test-only INVERSE of this slice's index.js footprint: the
// Routes secret + sequencing requires, pickEligibleDriver's {stackFilter} option, and the autoAssign + sweep hunks (flag read,
// pre-claim planning, post-claim re-check, the task copies in the ONE finalize) and the out-of-sequence detector export (T7). monitorAssignmentTimeout has NO hunk (D12).
// unapplyStackseqIndex(index.js) === acf32fc8:index.js byte-for-byte (stackseq-wiring.guard). Newest layer → applied INNERMOST in
// every index.js fold consumer: unapplyPortalUiIndex(unapplyStackseqIndex(<source>)).
// Each hunk must occur EXACTLY once, else this throws. GENERATED from base (acf32fc8) vs candidate; JSON-quoted [now, was] pairs.

const BASE = 'acf32fc8';
const INDEX_HUNKS = [
 [
  "const { defineSecret } = require('firebase-functions/params');\nconst ROUTES_API_KEY = defineSecret('ROUTES_API_KEY');   // stacked-seq r5 T3: bound to autoAssign + sweep ONLY (D12: timeout never stacks)\nconst SEQ = require('./sequencing/writer');   // stacked-seq r5 T5: flag, D7 candidate filter, planning, post-claim checks\nconst { stackCopies } = require('./sequencing/plan-stack');\nconst routesKey = () => { try { return ROUTES_API_KEY.value() || ''; } catch (_) { return ''; } };   // empty → planStack refuses no_key\n",
  ""
 ],
 [
  "// stacked-seq r5 T7: the out-of-sequence detector — a whole-node task trigger that returns after ONE in-memory check unless the\n// write is a DELIVERY task's completion; then delivery-time evidence only, and ONE create-only alert (sequencing/detector.js)\nexports.detectOutOfSequence = onValueWritten({ ref: '/tasks/{taskId}', region: 'us-central1', retry: true }, async (event) => {\n  const before = event.data.before.val(); const after = event.data.after.val();\n  if (!require('./sequencing/detector').isDeliveryCompletion(event.params.taskId, before, after)) return;\n  await require('./sequencing/detector').detectOutOfSequence({ db: getDatabase(), taskId: event.params.taskId, before, after });\n});\n",
  ""
 ],
 [
  "async function pickEligibleDriver(db, excludeDriverIds, hubLat, hubLng, opts) {\n",
  "async function pickEligibleDriver(db, excludeDriverIds, hubLat, hubLng) {\n"
 ],
 [
  "  // stacked-seq r5 T5(i): ONLY with {stackFilter} (autoAssign / sweep, flag ON) — a 1-order driver stays a candidate iff the pair is\n  // cross-hub (D7: today's rule) or same-hub AND the cheap gate passes. Without the option (flag OFF, timeout) nothing changes.\n  if (opts && opts.stackFilter) eligible.splice(0, eligible.length, ...(await SEQ.filterEligible(db, tasks, eligible, activeOrdersByDriver, opts.stackFilter.newOid)));\n",
  ""
 ],
 [
  "    timeoutSeconds: 90,  // 30s sleep + ample headroom for the assignment query\n    secrets: [ROUTES_API_KEY]   // stacked-seq r5 T3\n",
  "    timeoutSeconds: 90  // 30s sleep + ample headroom for the assignment query\n"
 ],
 [
  "    const seqInvocationDeadline = Date.now() + 90 * 1000;   // stacked-seq r5 T5: the 90 s invocation budget INCLUDES the grace sleep\n",
  ""
 ],
 [
  "    const seqOn = await SEQ.readSeqFlag(db);   // stacked-seq r5 T5: read ONCE per invocation; OFF → every line below is today's\n    const chosen = await pickEligibleDriver(db, [], hubLat, hubLng, seqOn ? { stackFilter: { newOid: orderId } } : undefined);\n",
  "    const chosen = await pickEligibleDriver(db, [], hubLat, hubLng);\n"
 ],
 [
  "    // stacked-seq r5 T5(ii): a same-hub pair is planned BEFORE the claim (no claim is held across Routes). Cross-hub / not one\n    // other order → today's path (D7). Any same-hub refusal, a deadline or no time left → SINGLE: the existing no-taker alert,\n    // no claim. The deadline is checked again right before the claim.\n    let seq = null;\n    if (seqOn && recheck.orderCount === 1) {\n      const p = await SEQ.planForWriter({ db, uid: chosen.driverId, newOid: orderId, invocationDeadline: seqInvocationDeadline, key: routesKey() });\n      if (p.mode === 'stack') seq = p;\n      if (p.mode === 'single' || (seq && Date.now() >= seq.deadlineAt)) {\n        console.warn(`autoAssign: ${orderId} not stacked on ${chosen.driverId} (${p.reason || 'deadline'}) — single, alerting`);\n        await db.ref('dispatcher_alerts').push({ type: 'no_drivers_available', order_id: orderId, customer_name: after.recipient_name || 'Cliente', total: after.total || null, created_at: ServerValue.TIMESTAMP });\n        return;\n      }\n    }\n\n",
  ""
 ],
 [
  "    // stacked-seq r5 T5(iii) (r1 P1 ×2): a SEQUENCED placement runs its post-claim checks — the hold check, then the stack re-check\n    // — under ONE 3 s deadline started HERE, right after the claim; held / changed / confirm false / a throw / the deadline each roll\n    // back through rollbackOrAlert (retry + assignment_strand alert); confirm false also raises the existing no-taker alert.\n    if (seq) {\n      const v = await SEQ.sequencedPostClaim({ budget: SEQ.claimBudget(seq), hold: () => merchantHooks.holdAfterClaim(db, orderId, (o) => !AUTO_ASSIGNABLE_STATUSES.has(o.status)), rollback: () => rollbackOrAlert(db, claim, orderId, 'autoAssign'), db, uid: chosen.driverId, newOid: orderId, decision: seq.decision, reassert: reassertAssignable, isAssignable: (o) => AUTO_ASSIGNABLE_STATUSES.has(o.status), isHeld: (o) => merchantHooks.heldByReject(o) });\n      if (v === 'refused') await db.ref('dispatcher_alerts').push({ type: 'no_drivers_available', order_id: orderId, customer_name: after.recipient_name || 'Cliente', total: after.total || null, created_at: ServerValue.TIMESTAMP });\n      if (v !== 'ok') { console.log(`autoAssign: ${orderId} stack post-claim check → ${v}, rolled back`); return; }\n    }\n\n",
  ""
 ],
 [
  "    if (!seq && await merchantHooks.holdAfterClaim(db, orderId, (o) => !AUTO_ASSIGNABLE_STATUSES.has(o.status))) { console.log(`autoAssign: ${orderId} held or gone after the claim, rolling back`); await claim.rollback(); return; } const updates = buildAssignmentUpdates(orderId, chosen.driverId, 1, true, isStacked);   // h1 A-R1\n    if (seq) Object.assign(updates, stackCopies(seq.decision, chosen.driverId));   // stacked-seq r5: the copies ride in the ONE finalize update()\n",
  "    if (await merchantHooks.holdAfterClaim(db, orderId, (o) => !AUTO_ASSIGNABLE_STATUSES.has(o.status))) { console.log(`autoAssign: ${orderId} held or gone after the claim, rolling back`); await claim.rollback(); return; } const updates = buildAssignmentUpdates(orderId, chosen.driverId, 1, true, isStacked);   // h1 A-R1\n"
 ],
 [
  "  { schedule: 'every 1 minutes', region: 'us-central1', timeoutSeconds: 120, memory: '256MiB', secrets: [ROUTES_API_KEY] },   // stacked-seq r5 T3\n",
  "  { schedule: 'every 1 minutes', region: 'us-central1', timeoutSeconds: 120, memory: '256MiB' },\n"
 ],
 [
  "    const seqStart = now; let seqPlans = 0; let seqOn = null;   // stacked-seq r5 T5: ≤ 2 plans per tick, only while < 60 s of 120 elapsed\n",
  ""
 ],
 [
  "      if (seqOn === null) seqOn = await SEQ.readSeqFlag(db);   // stacked-seq r5 T5: read ONCE per invocation, only when an order is swept\n      const chosen = await pickEligibleDriver(db, [], hubLat, hubLng, seqOn ? { stackFilter: { newOid: orderId } } : undefined);\n",
  "      const chosen = await pickEligibleDriver(db, [], hubLat, hubLng);\n"
 ],
 [
  "      // stacked-seq r5 T5(ii): plan a same-hub pair BEFORE the claim; cross-hub → today (D7); a same-hub refusal / deadline / no\n      // plan budget left → single (waiting++, no claim)\n      let seq = null;\n      if (seqOn && chosen.orderCount === 1) {\n        const mayPlan = seqPlans < 2 && Date.now() - seqStart < 60 * 1000;\n        const p = await SEQ.planForWriter({ db, uid: chosen.driverId, newOid: orderId, invocationDeadline: seqStart + 120 * 1000, key: routesKey(), mayPlan });\n        if (mayPlan && p.reason !== 'cross_hub' && p.reason !== 'not_one') seqPlans++;\n        if (p.mode === 'stack') seq = p;\n        if (p.mode === 'single' || (seq && Date.now() >= seq.deadlineAt)) { waiting++; continue; }\n      }\n",
  ""
 ],
 [
  "        const pcb = SEQ.claimBudget(seq);   // stacked-seq r5 (r1 P1): sequenced → ONE 3 s deadline from the claim over every read below; else the identity\n        const recheck = await pcb(reassertAssignable(db, chosen.driverId, orderId));\n        const [parkedSnap, orderNowSnap, delNowSnap, pickupNowSnap] = await pcb(Promise.all([\n",
  "        const recheck = await reassertAssignable(db, chosen.driverId, orderId);\n        const [parkedSnap, orderNowSnap, delNowSnap, pickupNowSnap] = await Promise.all([\n"
 ],
 [
  "        ]));\n",
  "        ]);\n"
 ],
 [
  "        // stacked-seq r5 T5(iii): a sequenced placement re-checks under the SAME deadline (a throw / expiry → the catch below →\n        // rollbackOrAlert); changed or confirm false → roll back, skip\n        if (seq) {\n          const pc = await SEQ.postClaimSeq({ db, uid: chosen.driverId, newOid: orderId, decision: seq.decision, reassert: reassertAssignable, sweep: true, isAssignable: (o) => AUTO_ASSIGNABLE_STATUSES.has(o.status), isHeld: (o) => merchantHooks.heldByReject(o), end: pcb.end });\n          if (pc.changed || !pc.ok) { await claim.rollback(); continue; }\n        }\n",
  ""
 ],
 [
  "        if (seq) Object.assign(updates, stackCopies(seq.decision, chosen.driverId));   // stacked-seq r5: the copies ride in the ONE finalize\n",
  ""
 ]
];

function unapplyStackseqIndex(src) {
  let out = src;
  for (const [now, was] of INDEX_HUNKS) {
    const n = out.split(now).length - 1;
    if (n !== 1) throw new Error(`stackseq-inverse index.js: a hunk occurs ${n}× (expected exactly once): ${JSON.stringify(now.slice(0, 120))}`);
    out = out.replace(now, () => was);
  }
  return out;
}

module.exports = { unapplyStackseqIndex, INDEX_HUNKS, BASE };
