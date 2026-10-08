'use strict';
// D4-c4 — the test-only INVERSE of the "Pausar pedidos" slice (the split-file fold pattern, as tools/d4c5-inverse.js; PLAN-D4c4
// rev 13 §0.4): every hunk this slice made to index.js, put back to its e1aeb3f text. Proof (i): unapplyD4c4(index.js) ===
// e1aeb3f:index.js byte-for-byte. Proof (ii): the guards that pin index.js to its integration parent apply it FIRST, on the
// portal fold, then the D4-c5 inverse — reproducing the bb37684 pin, so "nothing else changed" holds for this slice too.
// The hunks: the requires, the createOrder control read + decision, the chargeOnlineOrder armed-kind variable / control
// read / pre-gate / race-guard flag / handler branch, the scheduled-release deps and the manual-release check.
// Each candidate hunk must occur EXACTLY once, else this throws (a moved, duplicated or edited hunk is never tolerated).
// GENERATED from `git diff -U1 e1aeb3f -- index.js`; JSON-quoted strings.

const HUNKS = [
  ["const OE = require('./order-exists');   // D4-c5 P1: every existing-order refusal → typed 409 order_exists (no form auto-mints on it)\nconst OC = require('./order-control');   // D4-c4: \"Pausar pedidos\" — the per-restaurant pause switch (fresh intake only)\nconst OCS = require('./order-control-state');\nconst { redemptionFingerprint } = require('./rewards-redeem');   // F1 residual: recompute a redemption order's fp from the RESOLVED reserve (guaranteed present) if the top-level compute blipped\n",
   "const OE = require('./order-exists');   // D4-c5 P1: every existing-order refusal → typed 409 order_exists (no form auto-mints on it)\nconst { redemptionFingerprint } = require('./rewards-redeem');   // F1 residual: recompute a redemption order's fp from the RESOLVED reserve (guaranteed present) if the top-level compute blipped\n"],
  ["\n  // D4-c4 §3/§0.5 — \"Pausar pedidos\": this request is NEW work (every existing-order answer and the :839 race returned\n  // above, unchanged). The control read starts HERE, alongside the identity read just below; it is decided after it.\n  const ctlP = OC.orderControlFor(db, restaurantId);\n\n  // Config-plane identity (ADR-0002): fail-closed read, gate intake on active, zone-check from\n",
   "\n  // Config-plane identity (ADR-0002): fail-closed read, gate intake on active, zone-check from\n"],
  ["  }\n  {\n    const ctl = await ctlP;   // D4-c4: PAUSED → 423 ordering_paused; UNKNOWN → the retryable 503 — before any write\n    if (ctl) {\n      console.warn(`createOrder: ${orderId} — ${OCS.REFUSALS[ctl].status} (order control: ${ctl})`);\n      return OC.respond(res, ctl);\n    }\n  }\n  if (!restIdentity.active) {\n",
   "  }\n  if (!restIdentity.active) {\n"],
  ["  let classifyFailed = false;\n  let controlArmed = null;   // D4-c4 §0.2: the race guard's refusal kind ('paused' | 'unavailable'), armed by the pre-gate below\n  let canonicalFpG = null;   // the canonical recompute for the classify + probe checks — a request-local memoizer (the reserve/acquire\n",
   "  let classifyFailed = false;\n  let canonicalFpG = null;   // the canonical recompute for the classify + probe checks — a request-local memoizer (the reserve/acquire\n"],
  ["      schedExtra: isScheduledG ? SCHED.fingerprintExtra({ scheduled_for: schedForRawG, order_type: orderType }) : '' }));\n    const ctlP = OC.orderControlFor(db, restaurantId);   // D4-c4: read alongside the classify below; decided at the pre-gate\n    try {\n",
   "      schedExtra: isScheduledG ? SCHED.fingerprintExtra({ scheduled_for: schedForRawG, order_type: orderType }) : '' }));\n    try {\n"],
  ["    if (floorBelow && !(clsG && clsG.outcome === 'reuse')) return CF.updateRequired(res, 'orders', ordersFloor);\n    /* D4-c4 §3/§0.2 — the PAUSE PRE-GATE: after the client-floor / classify step, BEFORE the availability read, the\n       bookkeeping writes, the probe refusals and the reward reserve — a refusal here reserved and released NOTHING. A fresh\n       classification is refused with this request's decision (PAUSED 423 / UNKNOWN 503); a failed classifier → 503 (a\n       retry re-classifies); anything else (reuse, in_progress, …) is honoured and ARMS the race guard with the decision. */\n    {\n      const g = OCS.chargePreGate(await ctlP, clsG);\n      if (g.refuse) {\n        console.warn(`chargeOnlineOrder: ${orderId} — ${OCS.REFUSALS[g.refuse].status} (order control pre-gate: ${g.refuse}; classify ${clsG ? (clsG.outcome || 'fresh') : 'failed'})`);\n        return OC.respond(res, g.refuse);\n      }\n      controlArmed = g.arm;\n    }\n    // Skip the read ONLY for a MONOTONIC-terminal order — one that provably can't drift into a fresh-URL\n",
   "    if (floorBelow && !(clsG && clsG.outcome === 'reuse')) return CF.updateRequired(res, 'orders', ordersFloor);\n    // Skip the read ONLY for a MONOTONIC-terminal order — one that provably can't drift into a fresh-URL\n"],
  ["  try {\n    acq = await acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, nowTs, cartBlocked, undefined, undefined, canonicalChargeFp, floorBelow, controlArmed !== null);   // P-SELFUPDATE §5 (2): refuseFresh; D4-c4: the race guard\n  } catch (e) {\n",
   "  try {\n    acq = await acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, nowTs, cartBlocked, undefined, undefined, canonicalChargeFp, floorBelow);   // P-SELFUPDATE §5 (2): refuseFresh\n  } catch (e) {\n"],
  ["    await releaseHoldIfOwned();   // abandoned: order_id used for a different cart/total\n    if (acq.reason === 'order_control') {   // D4-c4 §0.2: the race guard refused a drift to a fresh URL — this request's kind\n      console.warn(`chargeOnlineOrder: ${orderId} — ${OCS.REFUSALS[controlArmed].status} (order control race guard: ${controlArmed})`);\n      return OC.respond(res, controlArmed);\n    }\n    // 1D D4-b: a TYPED conflict (binding_format_invalid / cart_unverifiable) keeps its reason; a legacy mismatch → the neutral 'conflict'\n",
   "    await releaseHoldIfOwned();   // abandoned: order_id used for a different cart/total\n    // 1D D4-b: a TYPED conflict (binding_format_invalid / cart_unverifiable) keeps its reason; a legacy mismatch → the neutral 'conflict'\n"],
  ["function scheduledReleaseDeps(db) {\n  return { db, alert: (kind, detail) => paymentAlert(db, kind, detail), genToken: () => generateTrackingToken(),\n    orderControl: (rid) => OC.orderControlFor(db, rid) };   // D4-c4 §3a: the pause hold\n}\n",
   "function scheduledReleaseDeps(db) {\n  return { db, alert: (kind, detail) => paymentAlert(db, kind, detail), genToken: () => generateTrackingToken() };\n}\n"],
  ["    if (order.status !== 'scheduled') return res.status(409).json({ error: 'not_releasable', detail: `order is ${order.status}, not scheduled` });\n    // D4-c4 §3a: the pause check runs BEFORE the override clears anything — a refused manual release changes nothing\n    {\n      const ctl = await OC.orderControlFor(db, order.restaurant_id || 'x_pizza');\n      if (ctl) {\n        console.warn(`releaseScheduledOrder: ${orderId} — ${OCS.REFUSALS[ctl].status} (order control: ${ctl})`);\n        return OC.respond(res, ctl);\n      }\n    }\n\n",
   "    if (order.status !== 'scheduled') return res.status(409).json({ error: 'not_releasable', detail: `order is ${order.status}, not scheduled` });\n\n"],
];

function unapplyD4c4(src) {
  let out = src;
  for (const [now, was] of HUNKS) {
    const i = out.indexOf(now);
    if (i < 0 || out.indexOf(now, i + 1) !== -1) throw new Error(`d4c4-inverse: hunk not found exactly once: ${now.slice(0, 80)}`);
    out = out.slice(0, i) + was + out.slice(i + now.length);
  }
  return out;
}

module.exports = { unapplyD4c4, HUNKS };
