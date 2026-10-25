'use strict';
// STACKED-DELIVERY SEQUENCING (BUILD-stacked-seq-server r5 T9) — the test-only INVERSE of this slice's index.js footprint: the
// Routes secret + sequencing requires, pickEligibleDriver's {stackFilter} option, and the autoAssign + sweep hunks (flag read,
// pre-claim planning, post-claim re-check, the task copies in the ONE finalize). monitorAssignmentTimeout has NO hunk (D12).
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
  "    // stacked-seq r5 T5(iii): a sequenced placement re-checks under its OWN 3 s budget, inside the claim's rollback region —\n    // changed → roll back + return; confirm false → roll back + the existing alert; a throw / expiry → the existing rollbackOrAlert.\n    if (seq) {\n      let pc;\n      try { pc = await SEQ.postClaimSeq({ db, uid: chosen.driverId, newOid: orderId, decision: seq.decision, reassert: reassertAssignable, isAssignable: (o) => AUTO_ASSIGNABLE_STATUSES.has(o.status), isHeld: (o) => merchantHooks.heldByReject(o) }); }\n      catch (e) { console.error(`autoAssign: ${orderId} stack re-check failed`, e && e.message); await rollbackOrAlert(db, claim, orderId, 'autoAssign'); return; }\n      if (pc.changed) { console.log(`autoAssign: ${orderId} changed during planning (${pc.changed}), rolling back`); await claim.rollback(); return; }\n      if (!pc.ok) {\n        await claim.rollback();\n        await db.ref('dispatcher_alerts').push({ type: 'no_drivers_available', order_id: orderId, customer_name: after.recipient_name || 'Cliente', total: after.total || null, created_at: ServerValue.TIMESTAMP });\n        return;\n      }\n      Object.assign(updates, stackCopies(seq.decision, chosen.driverId));   // the copies ride in the ONE finalize update()\n    }\n",
  ""
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
  "        // stacked-seq r5 T5(iii): a sequenced placement re-checks under its OWN 3 s budget (a throw / expiry → the catch below →\n        // rollbackOrAlert); changed or confirm false → roll back, skip\n        if (seq) {\n          const pc = await SEQ.postClaimSeq({ db, uid: chosen.driverId, newOid: orderId, decision: seq.decision, reassert: reassertAssignable, sweep: true, isAssignable: (o) => AUTO_ASSIGNABLE_STATUSES.has(o.status), isHeld: (o) => merchantHooks.heldByReject(o) });\n          if (pc.changed || !pc.ok) { await claim.rollback(); continue; }\n        }\n",
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
